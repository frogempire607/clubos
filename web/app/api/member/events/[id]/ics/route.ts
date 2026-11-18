import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_EVENT_INCLUDE, loadMemberEventContext, memberVisibleEventWhere, shapeForMember } from "@/lib/memberEventsServer";
import { buildIcs } from "@/lib/calendarFeed";

// GET /api/member/events/[id]/ics — "Add to calendar" on the details screen.
// One event (one entry per session when it has several days), under the same
// visibility rules as the screen itself.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clubId = session.user.clubId;

  const [row, ctx, club] = await Promise.all([
    prisma.event.findFirst({
      where: { id, ...memberVisibleEventWhere(clubId, new Date(), { upcomingOnly: false }) },
      include: MEMBER_EVENT_INCLUDE,
    }),
    loadMemberEventContext(session, null),
    prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true } }),
  ]);
  const [event] = row ? await shapeForMember(clubId, [row], ctx) : [];
  if (!event || !club) return NextResponse.json({ error: "This event isn't available to your account." }, { status: 404 });

  const where = event.location?.name ?? null;
  const items = event.sessions.length > 1
    ? event.sessions.map((s) => ({
        uid: `event-${event.id}-${s.id}`,
        title: s.name ? `${event.name} · ${s.name}` : event.name,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        description: event.description,
        location: where,
        kind: "event" as const,
      }))
    : [{ uid: `event-${event.id}`, title: event.name, startsAt: event.startsAt, endsAt: event.endsAt, description: event.description, location: where, kind: "event" as const }];

  const ics = buildIcs(club.name, "MEMBER", items, club.timezone, event.name);
  const fileName = event.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60) || "event";
  return new NextResponse(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}.ics"`,
      "cache-control": "no-store",
    },
  });
}
