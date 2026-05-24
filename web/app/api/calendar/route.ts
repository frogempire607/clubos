import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Combined calendar feed for the dashboard /calendar page. Returns dated items
// across all offering kinds so the owner can filter to one or many in the UI.
//
// Kinds returned:
//   - "event"   — one-off Events (Camps, Clinics, Tournaments, Privates, etc.)
//   - "class"   — ClassSession instances (already materialized in the DB)
//   - "private" — confirmed PrivateBookings (with confirmedStartAt set)
//
// Range: ?from=YYYY-MM-DD&to=YYYY-MM-DD. Defaults to "the visible month plus
// padding" if missing.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const now = new Date();
  const from = fromStr
    ? new Date(fromStr)
    : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = toStr
    ? new Date(toStr)
    : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);

  const clubId = session.user.clubId;

  const [events, classSessions, privateBookings] = await Promise.all([
    prisma.event.findMany({
      where: {
        clubId,
        deletedAt: null,
        // Overlap, not just "starts inside the window". A 3-day camp whose
        // startsAt was before the visible range still needs to render on
        // the days that fall inside it.
        startsAt: { lte: to },
        endsAt: { gte: from },
      },
      select: {
        id: true,
        name: true,
        type: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        customEventTypeId: true,
        customEventType: { select: { name: true, color: true, textColor: true } },
        sessions: {
          select: { id: true, startsAt: true, endsAt: true, name: true },
          orderBy: { startsAt: "asc" },
        },
        _count: { select: { bookings: true } },
      },
    }),
    prisma.classSession.findMany({
      where: {
        clubId,
        canceled: false,
        startsAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        classId: true,
        startsAt: true,
        endsAt: true,
        recurringClass: {
          select: {
            name: true,
            capacity: true,
          },
        },
        _count: { select: { attendance: true } },
      },
    }),
    prisma.privateBooking.findMany({
      where: {
        clubId,
        status: { in: ["CONFIRMED", "COMPLETED"] },
        confirmedStartAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        confirmedStartAt: true,
        confirmedEndAt: true,
        lessonType: { select: { title: true } },
        coach: { select: { firstName: true, lastName: true } },
        member: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  type CalItem = {
    kind: "event" | "class" | "private";
    id: string;
    refId: string;         // event id / recurring-class id / booking id (for detail fetch + deep links)
    name: string;
    startsAt: string;
    endsAt: string;
    typeKey: string;       // for filtering: event subtype name, "class", or "private"
    typeLabel: string;     // display name
    color: string | null;
    textColor: string | null;
    capacity: number | null;
    filled: number;
    detail?: string;       // secondary line (coach, athlete, etc.)
  };

  const items: CalItem[] = [];

  for (const e of events) {
    const base = {
      kind: "event" as const,
      refId: e.id,
      name: e.name,
      typeKey: e.customEventTypeId ?? e.type,
      typeLabel: e.customEventType?.name ?? (e.type.charAt(0) + e.type.slice(1).toLowerCase()),
      color: e.customEventType?.color ?? null,
      textColor: e.customEventType?.textColor ?? null,
      capacity: e.capacity,
      filled: e._count.bookings,
    };
    if (e.sessions.length > 0) {
      // Multi-session events (e.g. a 3-day camp with one session per day) get
      // one calendar item per session so each day appears on the grid.
      for (const s of e.sessions) {
        items.push({
          ...base,
          id: `${e.id}:${s.id}`,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          detail: s.name ?? undefined,
        });
      }
    } else {
      items.push({
        ...base,
        id: e.id,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
      });
    }
  }
  for (const s of classSessions) {
    items.push({
      kind: "class",
      id: s.id,
      refId: s.classId,
      name: s.recurringClass.name,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      typeKey: "class",
      typeLabel: "Class",
      color: null,
      textColor: null,
      capacity: s.recurringClass.capacity,
      filled: s._count.attendance,
    });
  }
  for (const b of privateBookings) {
    if (!b.confirmedStartAt || !b.confirmedEndAt) continue;
    items.push({
      kind: "private",
      id: b.id,
      refId: b.id,
      name: b.lessonType.title,
      startsAt: b.confirmedStartAt.toISOString(),
      endsAt: b.confirmedEndAt.toISOString(),
      typeKey: "private",
      typeLabel: "Private lesson",
      color: null,
      textColor: null,
      capacity: 1,
      filled: 1,
      detail: [
        b.coach ? `Coach ${b.coach.firstName} ${b.coach.lastName}` : null,
        `${b.member.firstName} ${b.member.lastName}`,
      ].filter(Boolean).join(" · "),
    });
  }

  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    items,
  });
}
