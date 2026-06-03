import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { PREVIEW_COOKIE, readPreviewCookie, canStartPreview } from "@/lib/preview";

async function fetchUser(userId: string) {
  // Class registrations live in AttendanceRecord, not Booking, so we pull
  // upcoming class sessions per-member separately and surface them as a
  // sibling `classBookings` field on each accessible member. The member
  // portal's "My Bookings" page merges them with the event bookings below.
  const now = new Date();
  const classWhere = {
    classSessionId: { not: null },
    status: { in: ["PRESENT", "LATE", "DROP_IN", "TRIAL"] },
    classSession: { startsAt: { gte: now }, canceled: false },
  };
  const classInclude = {
    classSession: {
      include: {
        recurringClass: {
          select: { id: true, name: true, color: true, textColor: true, assignedStaffIds: true },
        },
      },
    },
  };
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
          attendanceRecords: {
            where: classWhere,
            include: classInclude,
            orderBy: { classSession: { startsAt: "asc" } },
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
              // `user: { id }` lets the client tell whether a linked child
              // has their own member login (which is required for the
              // child to receive DMs from coaches). Used by the messages
              // page to render an explanatory note when no child threads
              // exist because the kids have no logins.
              user: { select: { id: true } },
              bookings: {
                where: { status: { in: ["CONFIRMED", "WAITLISTED"] } },
                include: { event: { include: { customEventType: true } } },
                orderBy: { event: { startsAt: "asc" } },
                take: 10,
              },
              attendanceRecords: {
                where: classWhere,
                include: classInclude,
                orderBy: { classSession: { startsAt: "asc" } },
                take: 20,
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
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sessionRole = session.user.role as string;
  const previewMode = readPreviewCookie(cookies());

  // Preview mode: owner/staff can browse the member portal layout but we
  // never leak real member data. Return a sanitized stub that hydrates the
  // club brand + makes it clear this is a preview view.
  if (sessionRole !== "MEMBER") {
    if (canStartPreview(sessionRole) && previewMode === "member") {
      const club = await prisma.club.findUnique({
        where: { id: session.user.clubId },
        select: {
          id: true, name: true, slug: true, sport: true,
          primaryColor: true, logoUrl: true, tier: true,
          memberBillingVisibility: true,
        },
      });
      return NextResponse.json({
        user: {
          id: session.user.id,
          firstName: session.user.name?.split(" ")[0] || "Preview",
          lastName: session.user.name?.split(" ").slice(1).join(" ") || "User",
          email: session.user.email || "preview@example.com",
          memberProfile: null,
          guardianOf: [],
        },
        club,
        summaries: {},
        preview: { mode: "member" },
      });
    }
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
