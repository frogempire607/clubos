import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// GET /api/member/events
// Upcoming events visible to members. Filters out STAFF_ONLY visibility,
// staff-only purchase access, and respects publish/unpublish windows.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();

  const [events, user] = await Promise.all([
    prisma.event.findMany({
      where: {
        clubId: session.user.clubId,
        deletedAt: null,
        startsAt: { gte: now },
        visibility: { in: ["PUBLIC", "MEMBERS_ONLY"] },
        purchaseAccess: "ANYONE",
        AND: [
          { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
          { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        ],
      },
      orderBy: { startsAt: "asc" },
      include: {
        location: { select: { name: true } },
        customEventType: { select: { id: true, name: true, color: true, textColor: true } },
        sessions: { orderBy: { sortOrder: "asc" } },
        _count: { select: { bookings: true } },
      },
    }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } }),
  ]);

  // Auto-link by email if no userId-linked member exists yet
  const member = user
    ? await findOrAutoLinkMember(session.user.id, session.user.clubId, user.email)
    : null;

  // Fetch bookings + subscriptions after resolving the member record
  const [bookings, subscriptions] = member
    ? await Promise.all([
        prisma.booking.findMany({
          where: { memberId: member.id, status: { in: ["CONFIRMED", "WAITLISTED"] } },
          select: { eventId: true, status: true },
        }),
        prisma.memberSubscription.findMany({
          where: { memberId: member.id, status: "active" },
          select: { membershipId: true },
        }),
      ])
    : [[], []];

  // An "active member" of the club = has at least one active membership
  // subscription (manual or Stripe), or the profile is marked ACTIVE.
  // Drives member vs non-member event pricing automatically.
  const isActiveMember = subscriptions.length > 0 || member?.status === "ACTIVE";

  return NextResponse.json({
    events,
    bookings,
    activeMembershipIds: subscriptions.map((s) => s.membershipId),
    isActiveMember,
    hasMemberProfile: !!member,
  });
}
