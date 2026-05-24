import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// GET /api/member/privates/partner-response
// Returns the actionable partner-lesson invites for the current account —
// for the caller's own member profile AND any linked children they manage as
// a guardian. Used by the member privates page to show "X invited you to
// join a partner lesson" cards.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json([], { status: 200 });

  const clubId = session.user.clubId;

  // Caller's own member profile + every child they have portal-guardian
  // access to → set of member IDs we'll surface invites for.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const self = user
    ? await findOrAutoLinkMember(session.user.id, clubId, user.email)
    : null;

  const guardianLinks = await prisma.memberGuardianUser.findMany({
    where: { userId: session.user.id, member: { clubId, deletedAt: null } },
    select: { memberId: true },
  });

  const accessibleMemberIds = [
    ...(self ? [self.id] : []),
    ...guardianLinks.map((g) => g.memberId),
  ];
  if (accessibleMemberIds.length === 0) return NextResponse.json([]);

  const invites = await prisma.privateBookingPartner.findMany({
    where: {
      clubId,
      kind: "MEMBER",
      memberId: { in: accessibleMemberIds },
      // Only actionable invites — already-responded ones drop off the list.
      status: { in: ["INVITED", "PENDING_COACH"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      member: { select: { firstName: true, lastName: true } },
      booking: {
        select: {
          id: true,
          status: true,
          confirmedStartAt: true,
          confirmedEndAt: true,
          member: { select: { firstName: true, lastName: true } },
          lessonType: { select: { title: true } },
        },
      },
    },
  });

  return NextResponse.json(invites);
}
