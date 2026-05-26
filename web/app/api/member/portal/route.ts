import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

async function fetchUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberProfile: {
        include: {
          membership: true,
          subscriptions: {
            where: { status: { in: ["active", "past_due"] } },
            include: { membership: true },
          },
          bookings: {
            where: { status: { in: ["CONFIRMED", "WAITLISTED"] } },
            include: { event: { include: { customEventType: true } } },
            orderBy: { event: { startsAt: "asc" } },
            take: 20,
          },
          guardianLinks: {
            include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
          },
          guardian: true,
        },
      },
      guardianOf: {
        include: {
          member: {
            include: {
              bookings: {
                where: { status: { in: ["CONFIRMED", "WAITLISTED"] } },
                include: { event: { include: { customEventType: true } } },
                orderBy: { event: { startsAt: "asc" } },
                take: 10,
              },
            },
          },
        },
      },
    },
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let user = await fetchUser(session.user.id);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Auto-link by email if no userId-linked member profile found, then re-fetch
  if (!user.memberProfile) {
    const linked = await findOrAutoLinkMember(session.user.id, session.user.clubId, user.email);
    if (linked) {
      user = await fetchUser(session.user.id);
    }
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      id: true, name: true, slug: true, sport: true,
      primaryColor: true, logoUrl: true, tier: true,
      memberBillingVisibility: true,
    },
  });

  // Per-managed-athlete summary: attendance count (last 30d), upcoming
  // bookings count, active membership name. Powers the parent quick
  // dashboard on /member/profile.
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const accessibleIds: string[] = [
    ...(user?.memberProfile ? [user.memberProfile.id] : []),
    ...(user?.guardianOf ?? []).map((g) => g.member.id),
  ];
  const summaries: Record<string, {
    attendanceLast30d: number;
    upcomingBookings: number;
    activeMembershipName: string | null;
  }> = {};
  if (accessibleIds.length > 0) {
    const [attCounts, upcomingCounts, subs] = await Promise.all([
      prisma.attendanceRecord.groupBy({
        by: ["memberId"],
        where: {
          memberId: { in: accessibleIds },
          createdAt: { gte: thirtyDaysAgo },
          status: { in: ["PRESENT", "LATE", "DROP_IN", "TRIAL"] },
        },
        _count: { _all: true },
      }),
      prisma.booking.groupBy({
        by: ["memberId"],
        where: {
          memberId: { in: accessibleIds },
          status: { in: ["CONFIRMED", "WAITLISTED"] },
          event: { startsAt: { gte: now } },
        },
        _count: { _all: true },
      }),
      prisma.memberSubscription.findMany({
        where: { memberId: { in: accessibleIds }, status: "active" },
        select: { memberId: true, membership: { select: { name: true } } },
      }),
    ]);
    for (const id of accessibleIds) {
      summaries[id] = {
        attendanceLast30d: attCounts.find((r) => r.memberId === id)?._count._all ?? 0,
        upcomingBookings: upcomingCounts.find((r) => r.memberId === id)?._count._all ?? 0,
        activeMembershipName:
          subs.find((s) => s.memberId === id)?.membership.name ?? null,
      };
    }
  }

  return NextResponse.json({ user, club, summaries });
}
