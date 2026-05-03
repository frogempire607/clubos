import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/events
// Upcoming events visible to members. Filters out STAFF_ONLY visibility,
// staff-only purchase access, and respects publish/unpublish windows.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();

  const events = await prisma.event.findMany({
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
  });

  // Member's existing bookings to flag "registered" state
  const member = await prisma.member.findFirst({
    where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true,
      bookings: {
        where: { status: { in: ["CONFIRMED", "WAITLISTED"] } },
        select: { eventId: true, status: true },
      },
      subscriptions: {
        where: { status: "active" },
        select: { membershipId: true },
      },
    },
  });

  return NextResponse.json({
    events,
    bookings: member?.bookings ?? [],
    activeMembershipIds: (member?.subscriptions ?? []).map((s) => s.membershipId),
    hasMemberProfile: !!member,
  });
}
