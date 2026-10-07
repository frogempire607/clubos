import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive, hasPermissionLive } from "@/lib/apiGuard";
import { ymdUTC } from "@/lib/staffAssignments";
import { listScheduleStaff } from "@/lib/staffAssignmentsServer";
import { loadSessionStaffResolver } from "@/lib/classStaffServer";
import { richStaffRows, type RichStaffRow } from "@/lib/classStaff";
import { cancelSummary, type CancelSummary } from "@/lib/classStaffApi";

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
  // Dashboard feed: staff names, private-lesson athletes, staff-only events.
  // Must be current staff (live) — a removed or demoted login gets nothing.
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  // 2026-10-07 — was role-only. schedule:view (live) sees the club's calendar;
  // without it the feed is reduced to the caller's OWN items (classes/events
  // they are on, private lessons they coach) and carries no other person's
  // name — no co-coaches, no staff picker.
  const seesAll = await hasPermissionLive(session, "schedule", "view");
  const canAssign = seesAll && (await hasPermissionLive(session, "schedule", "edit"));
  const me = session.user.id;

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
  // Canceled class days are left out unless asked for (?includeCanceled=1) —
  // the grid that does not ask keeps showing exactly what it did.
  const includeCanceled = ["1", "true"].includes(url.searchParams.get("includeCanceled") ?? "");

  // Owner overrides for built-in EventType badge colors (Phase 1).
  const clubMeta = await prisma.club.findUnique({
    where: { id: clubId },
    select: { builtInEventColors: true },
  });
  // Only emit an override colour when the owner actually set one. Letting
  // null fall through preserves the calendar grid's existing default colors.
  function builtInOverride(type: string): { bg: string; fg: string } | null {
    const map = clubMeta?.builtInEventColors;
    if (!map || typeof map !== "object") return null;
    const o = (map as Record<string, { bg?: string; fg?: string } | undefined>)[type];
    if (o && typeof o.bg === "string" && typeof o.fg === "string") {
      return { bg: o.bg, fg: o.fg };
    }
    return null;
  }

  const [staffList, events, classSessions, privateBookings] = await Promise.all([
    listScheduleStaff(clubId),
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
        description: true,
        memberPrice: true,
        nonMemberPrice: true,
        location: { select: { name: true } },
        customEventTypeId: true,
        customEventType: { select: { name: true, color: true, textColor: true } },
        // The whole roster (was capped at 3) — the calendar edits it now.
        staffAssignments: { select: { userId: true } },
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
        ...(includeCanceled ? {} : { canceled: false }),
        startsAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        classId: true,
        date: true,
        startsAt: true,
        endsAt: true,
        staffOverride: true,
        staffManual: true,
        canceled: true,
        canceledAt: true, canceledByUserId: true, cancelReason: true, cancelNotifyAudience: true,
        cancelNotifiedCount: true, cancelPaid: true, cancelPaidByUserId: true, cancelPaidAt: true,
        recurringClass: {
          select: {
            name: true,
            assignedStaffIds: true,
            description: true,
            capacity: true,
            color: true,
            textColor: true,
            location: { select: { name: true } },
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
        ...(seesAll ? {} : { coachId: me }),
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
    description?: string | null;
    location?: string | null;
    coach?: string | null;
    price?: string | null;
    // Who is on it (lib/staffAssignments). Events: EventStaffAssignment.
    // Classes: this session's staffOverride when set, else the series.
    staff?: { id: string; name: string }[];
    staffIsOverride?: boolean;   // class only — a one-day change is in effect
    seriesStaffIds?: string[];   // class only
    date?: string;               // class only — YYYY-MM-DD occurrence day
    // Class only. On/after the club's switch-on date `staffRows` are the day's
    // real coach rows (status, role, late call-out, who covers whom); before
    // it, one plain row per coach from the legacy lists.
    switched?: boolean;
    staffRows?: RichStaffRow[];
    needsCoverage?: boolean;
    canceled?: boolean;          // only ever true with ?includeCanceled=1
    cancel?: CancelSummary | null;
    myStatus?: string | null;    // the viewer's own row on that day
    myRowId?: string | null;
  };

  const nameById = new Map(staffList.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const staffOf = (ids: string[]) =>
    ids
      .filter((id) => nameById.has(id) && (seesAll || id === me))
      .map((id) => ({ id, name: nameById.get(id)! }));

  const items: CalItem[] = [];

  for (const e of events) {
    if (!seesAll && !e.staffAssignments.some((sa) => sa.userId === me)) continue;
    const eventStaff = staffOf(e.staffAssignments.map((sa) => sa.userId));
    const coachNames = eventStaff.map((x) => x.name).join(", ");
    const priceParts: string[] = [];
    if (e.memberPrice != null) priceParts.push(`Member $${Number(e.memberPrice).toFixed(2)}`);
    if (e.nonMemberPrice != null) priceParts.push(`Non-member $${Number(e.nonMemberPrice).toFixed(2)}`);
    const base = {
      kind: "event" as const,
      refId: e.id,
      name: e.name,
      typeKey: e.customEventTypeId ?? e.type,
      typeLabel: e.customEventType?.name ?? (e.type.charAt(0) + e.type.slice(1).toLowerCase()),
      // Custom event-type color wins; otherwise built-in override from Club;
      // otherwise the calendar grid falls back to its own default.
      color: e.customEventType?.color ?? builtInOverride(e.type)?.bg ?? null,
      textColor: e.customEventType?.textColor ?? builtInOverride(e.type)?.fg ?? null,
      capacity: e.capacity,
      filled: e._count.bookings,
      description: e.description ?? null,
      location: e.location?.name ?? null,
      coach: coachNames || null,
      price: priceParts.join(" · ") || null,
      staff: eventStaff,
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
  // Who is on each class day: the legacy lists before the club's assignment
  // start date, that day's coach rows on/after it (lib/classStaff.ts).
  const staffOn = await loadSessionStaffResolver(clubId, classSessions);
  for (const s of classSessions) {
    const eff = staffOn.forSession(s, s.recurringClass.assignedStaffIds);
    // Own-only view: a class day is the viewer's when they are coaching it OR
    // still attached in any state but Removed (a coach who called out keeps
    // seeing it, as "Needs coverage").
    const myRow = eff.rows.find((r) => r.userId === me && r.status !== "REMOVED") ?? null;
    if (!seesAll && !eff.staffIds.includes(me) && !myRow) continue;
    const classStaff = staffOf(eff.staffIds);
    const nameOf = (id: string) => nameById.get(id) ?? "Former staff";
    const allRows = richStaffRows(eff.switched ? staffOn.rowsFor(s.id) : eff.rows, nameOf);
    const staffRows = seesAll
      ? allRows
      : allRows.filter((r) => r.userId === me).map((r) => ({ ...r, coveredByName: null, calledOutByName: null, coverageFilledByName: null }));
    const cancel = cancelSummary(s, nameOf);
    items.push({
      kind: "class",
      id: s.id,
      refId: s.classId,
      name: s.recurringClass.name,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      typeKey: "class",
      typeLabel: "Class",
      color: s.recurringClass.color ?? null,
      textColor: s.recurringClass.textColor ?? null,
      capacity: s.recurringClass.capacity,
      filled: s._count.attendance,
      description: s.recurringClass.description ?? null,
      location: s.recurringClass.location?.name ?? null,
      coach: classStaff.map((x) => x.name).join(", ") || null,
      staff: classStaff,
      staffIsOverride: eff.isSubstitute,
      seriesStaffIds: eff.seriesStaffIds.filter((x) => seesAll || x === me),
      date: ymdUTC(s.date),
      switched: eff.switched,
      staffRows,
      needsCoverage: seesAll ? eff.needsCoverage : myRow?.status === "NEEDS_COVERAGE",
      canceled: s.canceled,
      cancel: cancel && !seesAll ? { ...cancel, canceledByName: null, paidByName: null } : cancel,
      myStatus: myRow?.status ?? null,
      myRowId: myRow?.id ?? null,
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
      coach: b.coach ? `${b.coach.firstName} ${b.coach.lastName}` : null,
      detail: [
        b.coach ? `Coach ${b.coach.firstName} ${b.coach.lastName}` : null,
        `${b.member.firstName} ${b.member.lastName}`,
      ].filter(Boolean).join(" · "),
    });
  }

  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  // What the viewer may change from the calendar — the SAME rule the write
  // APIs enforce: every assignment write is schedule:edit, read live
  // (lib/staffSelf.ts "Assignments"). The three keys are kept for the client.
  const can = {
    editEventStaff: canAssign,
    editClassSeriesStaff: canAssign,
    editClassDayStaff: canAssign,
  };

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    items,
    can,
    // OWNER + STAFF — the "+ Add coach" picker. Owners coach too.
    staffOptions: (seesAll ? staffList : []).map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim() })),
    viewer: { userId: me, seesAll },
  });
}
