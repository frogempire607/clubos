import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { readPreviewCookie, canStartPreview } from "@/lib/preview";
import { trialCoversClass } from "@/lib/freeTrial";

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

function parsePricingOptions(value: unknown): PricingOption[] {
  return Array.isArray(value) ? (value as PricingOption[]) : [];
}

function money(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

async function resolveMemberContext(userId: string, clubId: string, requestedMemberId: string | null) {
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      memberProfile: { select: { id: true, firstName: true, lastName: true, status: true, trialEndsAt: true } },
      guardianOf: {
        select: { member: { select: { id: true, firstName: true, lastName: true, status: true, trialEndsAt: true } } },
      },
    },
  });
  if (!viewer) return null;

  let self = viewer.memberProfile;
  if (!self) {
    const linked = await findOrAutoLinkMember(userId, clubId, viewer.email);
    if (linked) {
      self = { id: linked.id, firstName: linked.firstName, lastName: linked.lastName, status: linked.status, trialEndsAt: linked.trialEndsAt };
    }
  }

  const accessible = [
    ...(self ? [{ ...self, kind: "self" as const }] : []),
    ...viewer.guardianOf.map((g) => ({ ...g.member, kind: "child" as const })),
  ];

  if (requestedMemberId) {
    const requested = accessible.find((m) => m.id === requestedMemberId);
    if (!requested) return "FORBIDDEN" as const;
    return { context: requested, accessible };
  }

  const context = accessible[0] ?? null;
  return { context, accessible };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sessionRole = session.user.role as string;
  const previewing =
    sessionRole !== "MEMBER" &&
    canStartPreview(sessionRole) &&
    readPreviewCookie(cookies()) === "member";

  // Preview mode for owner/staff: render the schedule UI but without a
  // member context so the page shows "Sign in as a member to see real data"
  // empty states instead of a 401.
  if (sessionRole !== "MEMBER" && !previewing) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (previewing) {
    return NextResponse.json({
      contextMember: null,
      accessibleMembers: [],
      activeMembershipIds: [],
      activeMembershipNames: [],
      items: [],
      privateOfferings: [],
      preview: { mode: "member" },
    });
  }

  const url = new URL(req.url);
  const requestedMemberId = url.searchParams.get("memberId");
  const days = Math.min(Math.max(Number(url.searchParams.get("days") || 45), 7), 120);
  const now = new Date();
  const to = new Date(now.getTime() + days * 86400000);
  const clubId = session.user.clubId;

  const resolved = await resolveMemberContext(session.user.id, clubId, requestedMemberId);
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (resolved === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { context, accessible } = resolved;

  // COPPA: don't surface a minor's schedule/attendance to a guardian until consent is on file.
  if (context && (await guardianActionBlocked(session.user.id, context.id))) {
    return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
  }

  const [activeSubs, eventBookings, classAttendance, events, classes, privateOfferings] = await Promise.all([
    context
      ? prisma.memberSubscription.findMany({
          where: { memberId: context.id, status: "active" },
          select: { membershipId: true, membership: { select: { name: true } } },
        })
      : Promise.resolve([]),
    context
      ? prisma.booking.findMany({
          where: { memberId: context.id, status: { in: ["CONFIRMED", "WAITLISTED"] } },
          select: { eventId: true, status: true },
        })
      : Promise.resolve([]),
    context
      ? prisma.attendanceRecord.findMany({
          where: { memberId: context.id, classSessionId: { not: null } },
          select: { classSessionId: true, status: true },
        })
      : Promise.resolve([]),
    prisma.event.findMany({
      where: {
        clubId,
        deletedAt: null,
        startsAt: { lte: to },
        endsAt: { gte: now },
        visibility: { in: ["PUBLIC", "MEMBERS_ONLY"] },
        AND: [
          { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
          { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        ],
      },
      orderBy: { startsAt: "asc" },
      include: {
        location: { select: { name: true } },
        customEventType: { select: { name: true, color: true, textColor: true } },
        staffAssignments: {
          select: { user: { select: { firstName: true, lastName: true } } },
          take: 4,
        },
        sessions: { orderBy: { sortOrder: "asc" } },
        _count: { select: { bookings: true } },
      },
    }),
    prisma.classSession.findMany({
      where: {
        clubId,
        canceled: false,
        startsAt: { gte: now, lte: to },
        recurringClass: {
          active: true,
          deletedAt: null,
          // PRIVATE classes are invite/roster-only — hide from the member
          // schedule. PUBLIC + MEMBERS_ONLY both show to signed-in members.
          visibility: { in: ["PUBLIC", "MEMBERS_ONLY"] },
        },
      },
      orderBy: { startsAt: "asc" },
      include: {
        recurringClass: {
          select: {
            id: true,
            name: true,
            description: true,
            capacity: true,
            pricingOptions: true,
            assignedStaffIds: true,
            color: true,
            textColor: true,
            location: { select: { name: true } },
          },
        },
        _count: { select: { attendance: true } },
      },
    }),
    prisma.privateLessonType.findMany({
      where: { clubId, deletedAt: null, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, durationMin: true, basePrice: true },
      take: 6,
    }),
  ]);

  const activeMembershipIds = activeSubs.map((s) => s.membershipId);
  // Staff-granted trial window: while active, the trial behaves like a
  // membership scoped to the plans the club's Free Trial offer is attached
  // to — classes those plans cover book free (all classes when the offer
  // isn't scoped).
  const trialActive =
    activeMembershipIds.length === 0 &&
    !!context?.trialEndsAt &&
    new Date(context.trialEndsAt) > new Date();
  const trialClub = trialActive
    ? await prisma.club.findUnique({
        where: { id: clubId },
        select: { freeTrialConfig: true },
      })
    : null;
  const activeMembershipNames = activeSubs.map((s) => s.membership.name);
  const eventBookingById = new Map(eventBookings.map((b) => [b.eventId, b.status]));
  const classAttendanceById = new Map(classAttendance.map((a) => [a.classSessionId, a.status]));
  const staffIds = new Set<string>();
  for (const cls of classes) {
    const ids = Array.isArray(cls.recurringClass.assignedStaffIds)
      ? (cls.recurringClass.assignedStaffIds as string[])
      : [];
    ids.forEach((id) => staffIds.add(id));
  }
  const staff = staffIds.size
    ? await prisma.user.findMany({
        where: { id: { in: Array.from(staffIds) }, clubId },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const staffById = new Map(staff.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

  // My Schedule is the club's what's-on surface: classes AND events (the
  // page's Events filter chip was dead while this was false — events also
  // still have their own /member/events surface for registration detail).
  const INCLUDE_EVENTS_IN_SCHEDULE = true;
  const items = [
    ...(INCLUDE_EVENTS_IN_SCHEDULE ? events : []).flatMap((event) => {
      const acceptedMembershipIds = parsePricingOptions(event.pricingOptions)
        .filter((opt): opt is { type: "membership"; membershipId: string } => opt.type === "membership" && !!opt.membershipId)
        .map((opt) => opt.membershipId);
      const covered = acceptedMembershipIds.some((id) => activeMembershipIds.includes(id));
      const bookedStatus = eventBookingById.get(event.id) ?? null;
      const isFull = event.capacity != null && event._count.bookings >= event.capacity;
      const isMembersOnly = event.visibility === "MEMBERS_ONLY" && !context;
      const registrationClosed = event.purchaseAccess === "STAFF_ONLY" || (event.registrationDeadline ? event.registrationDeadline < now : false);
      const price = covered
        ? null
        : money(event.memberPrice) ?? money(event.nonMemberPrice) ?? money(event.dropInFee);
      const statusText = bookedStatus
        ? bookedStatus === "WAITLISTED" ? "Waitlisted" : "Registered"
        : registrationClosed
          ? "Registration closed"
          : isMembersOnly
            ? "Members only"
            : isFull
              ? "Waitlist available"
              : covered
                ? "Included in your membership"
                : price
                  ? "Purchase required"
                  : "Available";
      const sessions = event.sessions.length
        ? event.sessions.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt }))
        : [{ id: event.id, startsAt: event.startsAt, endsAt: event.endsAt }];

      return sessions.map((sessionItem) => ({
        id: event.sessions.length ? `${event.id}:${sessionItem.id}` : event.id,
        refId: event.id,
        kind: "event" as const,
        title: event.name,
        typeLabel: event.customEventType?.name ?? event.type.charAt(0) + event.type.slice(1).toLowerCase(),
        startsAt: sessionItem.startsAt.toISOString(),
        endsAt: sessionItem.endsAt.toISOString(),
        description: event.description,
        location: event.location?.name ?? null,
        coach: event.staffAssignments.map((a) => `${a.user.firstName} ${a.user.lastName}`).join(", ") || null,
        capacity: event.capacity,
        filled: event._count.bookings,
        price,
        statusText,
        canBook: !!context && !bookedStatus && !registrationClosed,
        bookingStatus: bookedStatus,
        color: event.customEventType?.color ?? null,
        textColor: event.customEventType?.textColor ?? null,
      }));
    }),
    ...classes.map((sessionItem) => {
      const opts = parsePricingOptions(sessionItem.recurringClass.pricingOptions);
      const acceptedMembershipIds = opts
        .filter((opt): opt is { type: "membership"; membershipId: string } => opt.type === "membership" && !!opt.membershipId)
        .map((opt) => opt.membershipId);
      const covered = acceptedMembershipIds.some((id) => activeMembershipIds.includes(id));
      // Auto-detect which price tier the member qualifies for. Members with
      // any active sub at this club fall back to the MEMBER price even when
      // the class doesn't accept their specific plan; everyone else gets the
      // NON_MEMBER price, then DROP_IN as last resort. This is what powers the
      // member-side Book button on /member/schedule.
      const memberPrice    = opts.find((o): o is { type: "member";    price: number } => o.type === "member");
      const nonMemberPrice = opts.find((o): o is { type: "nonmember"; price: number } => o.type === "nonmember");
      const dropInPrice    = opts.find((o): o is { type: "dropin";    price: number } => o.type === "dropin");
      const hasAnyActiveSub = activeMembershipIds.length > 0;
      let bookingTier: "MEMBERSHIP" | "MEMBER" | "NON_MEMBER" | "DROP_IN" | null = null;
      let bookingPriceNum: number | null = null;
      let bookingLabel: string | null = null;
      const trialCovers = trialActive && trialCoversClass(trialClub?.freeTrialConfig, acceptedMembershipIds);
      if (covered) {
        bookingTier = "MEMBERSHIP";
        bookingLabel = "Included in your membership";
      } else if (trialCovers) {
        bookingTier = "MEMBERSHIP";
        bookingLabel = "Free trial";
      } else if (hasAnyActiveSub && memberPrice) {
        bookingTier = "MEMBER"; bookingPriceNum = memberPrice.price; bookingLabel = "Member price";
      } else if (nonMemberPrice) {
        bookingTier = "NON_MEMBER"; bookingPriceNum = nonMemberPrice.price; bookingLabel = "Non-member price";
      } else if (dropInPrice) {
        bookingTier = "DROP_IN"; bookingPriceNum = dropInPrice.price; bookingLabel = "Drop-in price";
      } else if (memberPrice) {
        bookingTier = "MEMBER"; bookingPriceNum = memberPrice.price; bookingLabel = "Member price";
      }
      const priceOpt = memberPrice || nonMemberPrice || dropInPrice;
      const attendance = classAttendanceById.get(sessionItem.id) ?? null;
      const freeCovered = covered || trialCovers;
      const price = freeCovered ? null : bookingPriceNum != null ? bookingPriceNum.toFixed(2) : priceOpt ? money(priceOpt.price) : null;
      const coachNames = (Array.isArray(sessionItem.recurringClass.assignedStaffIds)
        ? (sessionItem.recurringClass.assignedStaffIds as string[])
        : [])
        .map((id) => staffById.get(id))
        .filter(Boolean)
        .join(", ");
      return {
        id: sessionItem.id,
        refId: sessionItem.recurringClass.id,
        kind: "class" as const,
        title: sessionItem.recurringClass.name,
        typeLabel: "Class",
        startsAt: sessionItem.startsAt.toISOString(),
        endsAt: sessionItem.endsAt.toISOString(),
        description: sessionItem.recurringClass.description,
        location: sessionItem.recurringClass.location?.name ?? null,
        coach: coachNames || null,
        capacity: sessionItem.recurringClass.capacity,
        filled: sessionItem._count.attendance,
        price,
        statusText: attendance
          ? "Booked"
          : covered
            ? "Included in your membership"
            : trialCovers
              ? "Free trial"
              : price
                ? "Purchase required"
                : "Ask staff to book",
        canBook: !!context && !attendance && (freeCovered || bookingPriceNum != null),
        bookingStatus: attendance,
        color: sessionItem.recurringClass.color ?? null,
        textColor: sessionItem.recurringClass.textColor ?? null,
        bookingTier,
        bookingLabel,
      };
    }),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return NextResponse.json({
    contextMember: context,
    accessibleMembers: accessible,
    activeMembershipIds,
    activeMembershipNames,
    items,
    privateOfferings: privateOfferings.map((type) => ({
      id: type.id,
      title: type.title,
      durationMin: type.durationMin,
      basePrice: Number(type.basePrice),
    })),
  });
}
