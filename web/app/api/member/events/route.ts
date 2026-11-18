import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_EVENT_INCLUDE, loadMemberEventContext, memberVisibleEventWhere, shapeForMember } from "@/lib/memberEventsServer";

// GET /api/member/events
// Upcoming events visible to members. Which events, and the rules for it, live
// in lib/memberEventsServer — shared with the event details screen
// (GET /api/member/events/[id]) so the two can never disagree.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const requestedMemberId = new URL(req.url).searchParams.get("memberId");

  const [rows, ctx] = await Promise.all([
    prisma.event.findMany({
      where: memberVisibleEventWhere(session.user.clubId, now, { upcomingOnly: true }),
      orderBy: { startsAt: "asc" },
      include: MEMBER_EVENT_INCLUDE,
    }),
    loadMemberEventContext(session, requestedMemberId),
  ]);

  return NextResponse.json({
    events: await shapeForMember(session.user.clubId, rows, ctx),
    bookings: ctx.bookings,
    activeMembershipIds: ctx.subscriptions.map((s) => s.membershipId),
    isActiveMember: ctx.isActiveMember,
    accessible: ctx.accessible,
    contextMemberId: ctx.member?.id ?? null,
    hasMemberProfile: ctx.accessible.length > 0,
  });
}
