import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { PREVIEW_COOKIE, readPreviewCookie, canStartPreview } from "@/lib/preview";
import { wallClockNowUTC } from "@/lib/datetime";

async function fetchUser(userId: string, clubTimezone: string | null) {
  // Class registrations live in AttendanceRecord, not Booking, so we pull
  // upcoming class sessions per-member separately and surface them as a
  // sibling `classBookings` field on each accessible member. The member
  // portal's "My Bookings" page merges them with the event bookings below.
  // Class stamps are wall-clock-UTC, so compare against the club's wall
  // clock — raw UTC now drops today's booked classes hours early.
  const classWhere = {
    classSessionId: { not: null },
    status: { in: ["PRESENT", "LATE", "DROP_IN", "TRIAL"] },
    classSession: { startsAt: { gte: wallClockNowUTC(clubTimezone) }, canceled: false },
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
  // Private lessons live in PrivateBooking. Surface them per accessible
  // member so the bookings page + home widget can merge them with events +
  // classes. We include REQUESTED / PENDING_COACH so the athlete sees
  // their pending requests, not only fully-confirmed lessons.
  const privateWhere = {
    status: { in: ["REQUESTED", "PENDING_COACH", "CONFIRMED"] },
  };
  const privateSelect = {
    id: true,
    status: true,
    createdAt: true,
    confirmedStartAt: true,
    confirmedEndAt: true,
    requestedSlots: true,
    lessonType: { select: { id: true, title: true, durationMin: true } },
    coach: { select: { id: true, firstName: true, lastName: true } },
  };
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberProfile: {
        include: {
          membership: true,
          subscriptions: {
            // include pending so the portal can show the upcoming/first-charge
            // date and a "purchase in progress" status (migrated + card flows).
            where: { status: { in: ["active", "past_due", "pending"] } },
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
          privateBookings: {
            where: privateWhere,
            select: privateSelect,
            orderBy: { createdAt: "desc" },
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
              // Who co-manages each child (names only) — powers the guardian
              // avatars on the Account page. The viewer is one of these
              // guardians, so this is data about their own family.
              guardianLinks: {
                orderBy: { createdAt: "asc" },
                select: {
                  userId: true,
                  user: { select: { id: true, firstName: true, lastName: true } },
                },
              },
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
              privateBookings: {
                where: privateWhere,
                select: privateSelect,
                orderBy: { createdAt: "desc" },
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
          memberBillingVisibility: true, timezone: true,
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

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      id: true, name: true, slug: true, sport: true,
      primaryColor: true, logoUrl: true, tier: true,
      memberBillingVisibility: true, timezone: true,
    },
  });

  let user = await fetchUser(session.user.id, club?.timezone ?? null);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Auto-link by email if no userId-linked member profile found, then re-fetch
  if (!user.memberProfile) {
    const linked = await findOrAutoLinkMember(session.user.id, session.user.clubId, user.email);
    if (linked) {
      user = await fetchUser(session.user.id, club?.timezone ?? null);
    }
  }

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
    const [attCounts, upcomingCounts, subs, trialMembers] = await Promise.all([
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
      // Active free-trial windows show as the profile's plan until they expire.
      prisma.member.findMany({
        where: { id: { in: accessibleIds }, trialEndsAt: { gt: now } },
        select: { id: true, trialEndsAt: true },
      }),
    ]);
    for (const id of accessibleIds) {
      const trial = trialMembers.find((t) => t.id === id);
      summaries[id] = {
        attendanceLast30d: attCounts.find((r) => r.memberId === id)?._count._all ?? 0,
        upcomingBookings: upcomingCounts.find((r) => r.memberId === id)?._count._all ?? 0,
        activeMembershipName:
          subs.find((s) => s.memberId === id)?.membership.name ??
          (trial
            ? `Free trial (ends ${trial.trialEndsAt!.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
            : null),
      };
    }
  }

  return NextResponse.json({ user, club, summaries });
}
