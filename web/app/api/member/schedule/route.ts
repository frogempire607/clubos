import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { readPreviewCookie, canStartPreview } from "@/lib/preview";
import { trialCoversClass } from "@/lib/freeTrial";
import { wallClockNowUTC } from "@/lib/datetime";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import { FAMILY_SCOPE } from "@/lib/activeProfile";

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

// Family scope: the caller asked for every athlete at once rather than one.
// `context` stays null — there genuinely is no single subject — and the client
// reads the per-item `athletes[]` array instead of the top-level booking
// fields. See lib/activeProfile.ts FAMILY_SCOPE for why this exists.
async function resolveMemberContext(userId: string, clubId: string, requestedMemberId: string | null) {
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      memberProfile: { select: { id: true, firstName: true, lastName: true, status: true, trialEndsAt: true } },
      guardianOf: {
        where: ACTIVE_GUARDIAN_LINK,
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

  if (requestedMemberId === FAMILY_SCOPE) {
    return { context: null, accessible, familyScope: true };
  }

  if (requestedMemberId) {
    const requested = accessible.find((m) => m.id === requestedMemberId);
    if (!requested) return "FORBIDDEN" as const;
    return { context: requested, accessible, familyScope: false };
  }

  const context = accessible[0] ?? null;
  return { context, accessible, familyScope: false };
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

  // Class sessions are wall-clock-UTC stamps: filter them against the club's
  // wall clock, not raw UTC now, so today's classes don't vanish from the
  // schedule hours before they start (see lib/datetime.ts wallClockNowUTC).
  const clubRow = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  const wallNow = wallClockNowUTC(clubRow?.timezone);
  const toWall = new Date(wallNow.getTime() + days * 86400000);

  const resolved = await resolveMemberContext(session.user.id, clubId, requestedMemberId);
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (resolved === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { context, accessible, familyScope } = resolved;

  // COPPA: don't surface a minor's schedule/attendance to a guardian until consent is on file.
  // Single-athlete scope refuses outright. Family scope instead DROPS the
  // blocked athletes — one child awaiting consent must not blank the whole
  // family's schedule, which would look like an outage rather than a gate.
  if (!familyScope && context && (await guardianActionBlocked(session.user.id, context.id))) {
    return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
  }

  // Athletes whose per-person booking state this response covers.
  const scopeAthletes = familyScope
    ? (
        await Promise.all(
          accessible.map(async (a) =>
            (await guardianActionBlocked(session.user.id, a.id)) ? null : a,
          ),
        )
      ).filter((a): a is (typeof accessible)[number] => a !== null)
    : context
      ? [context]
      : [];
  const scopeIds = scopeAthletes.map((a) => a.id);

  const [activeSubs, eventBookings, classAttendance, events, classes, privateOfferings] = await Promise.all([
    // One query per concern across the WHOLE scope, grouped in memory below —
    // a family feed must not become one round-trip per child.
    scopeIds.length
      ? prisma.memberSubscription.findMany({
          where: { memberId: { in: scopeIds }, status: "active" },
          select: { memberId: true, membershipId: true, membership: { select: { name: true } } },
        })
      : Promise.resolve([]),
    scopeIds.length
      ? prisma.booking.findMany({
          where: { memberId: { in: scopeIds }, status: { in: ["CONFIRMED", "WAITLISTED"] } },
          select: { memberId: true, eventId: true, status: true },
        })
      : Promise.resolve([]),
    scopeIds.length
      ? prisma.attendanceRecord.findMany({
          where: { memberId: { in: scopeIds }, classSessionId: { not: null } },
          select: { memberId: true, classSessionId: true, status: true },
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
        // endsAt (not startsAt) so an in-progress class stays visible — its
        // check-in window is still open.
        endsAt: { gte: wallNow },
        startsAt: { lte: toWall },
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

  // Per-athlete booking state. Everything downstream that used to read one
  // member's subscriptions/bookings/attendance now reads one of these.
  type AthleteState = {
    id: string;
    firstName: string;
    lastName: string;
    membershipIds: string[];
    membershipNames: string[];
    /** Staff-granted trial window: behaves like a membership scoped to the
     *  plans the club's Free Trial offer is attached to. */
    trialActive: boolean;
    eventStatus: Map<string, string>;
    classStatus: Map<string, string>;
  };

  const stateById = new Map<string, AthleteState>();
  for (const a of scopeAthletes) {
    const subs = activeSubs.filter((s) => s.memberId === a.id);
    const membershipIds = subs.map((s) => s.membershipId);
    stateById.set(a.id, {
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      membershipIds,
      membershipNames: subs.map((s) => s.membership.name),
      trialActive:
        membershipIds.length === 0 && !!a.trialEndsAt && new Date(a.trialEndsAt) > new Date(),
      eventStatus: new Map(
        eventBookings.filter((b) => b.memberId === a.id).map((b) => [b.eventId, b.status]),
      ),
      classStatus: new Map(
        classAttendance
          .filter((x) => x.memberId === a.id && x.classSessionId)
          .map((x) => [x.classSessionId as string, x.status]),
      ),
    });
  }

  const trialClub = scopeAthletes.some((a) => stateById.get(a.id)?.trialActive)
    ? await prisma.club.findUnique({
        where: { id: clubId },
        select: { freeTrialConfig: true },
      })
    : null;

  // Top-level response fields keep describing the single resolved context so
  // the existing per-athlete contract is unchanged. In family scope there is
  // no single context and these are empty by design — the client reads the
  // per-item `athletes[]` instead.
  const ctxState = context ? stateById.get(context.id) : undefined;
  const activeMembershipIds = ctxState?.membershipIds ?? [];
  const activeMembershipNames = ctxState?.membershipNames ?? [];
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
      const isFull = event.capacity != null && event._count.bookings >= event.capacity;
      // "Members only" means the VIEWER has no athlete at all — not that this
      // particular request asked for the family rather than one child.
      const isMembersOnly = event.visibility === "MEMBERS_ONLY" && scopeAthletes.length === 0;
      const registrationClosed = event.purchaseAccess === "STAFF_ONLY" || (event.registrationDeadline ? event.registrationDeadline < now : false);

      // The same verdict, computed once per athlete in scope.
      const evalFor = (st: AthleteState) => {
        const covered = acceptedMembershipIds.some((id) => st.membershipIds.includes(id));
        const bookedStatus = st.eventStatus.get(event.id) ?? null;
        const p = covered
          ? null
          : money(event.memberPrice) ?? money(event.nonMemberPrice) ?? money(event.dropInFee);
        return {
          price: p,
          bookingStatus: bookedStatus,
          canBook: !bookedStatus && !registrationClosed,
          statusText: bookedStatus
            ? bookedStatus === "WAITLISTED" ? "Waitlisted" : "Registered"
            : registrationClosed
              ? "Registration closed"
              : isMembersOnly
                ? "Members only"
                : isFull
                  ? "Waitlist available"
                  : covered
                    ? "Included in your membership"
                    : p
                      ? "Purchase required"
                      : "Available",
        };
      };

      const athletes = scopeAthletes.map((a) => ({
        memberId: a.id,
        firstName: a.firstName,
        lastName: a.lastName,
        ...evalFor(stateById.get(a.id)!),
      }));

      const ctxEval = ctxState ? evalFor(ctxState) : null;
      const price = ctxEval?.price ?? null;
      const bookedStatus = ctxEval?.bookingStatus ?? null;
      const statusText = ctxEval?.statusText ?? (isMembersOnly ? "Members only" : "Available");

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
        canBook: !!ctxEval && ctxEval.canBook,
        bookingStatus: bookedStatus,
        athletes,
        color: event.customEventType?.color ?? null,
        textColor: event.customEventType?.textColor ?? null,
      }));
    }),
    ...classes.map((sessionItem) => {
      const opts = parsePricingOptions(sessionItem.recurringClass.pricingOptions);
      const acceptedMembershipIds = opts
        .filter((opt): opt is { type: "membership"; membershipId: string } => opt.type === "membership" && !!opt.membershipId)
        .map((opt) => opt.membershipId);
      // Auto-detect which price tier the member qualifies for. Members with
      // any active sub at this club fall back to the MEMBER price even when
      // the class doesn't accept their specific plan; everyone else gets the
      // NON_MEMBER price, then DROP_IN as last resort. This is what powers the
      // member-side Book button on /member/schedule.
      const memberPrice    = opts.find((o): o is { type: "member";    price: number } => o.type === "member");
      const nonMemberPrice = opts.find((o): o is { type: "nonmember"; price: number } => o.type === "nonmember");
      const dropInPrice    = opts.find((o): o is { type: "dropin";    price: number } => o.type === "dropin");
      const priceOpt = memberPrice || nonMemberPrice || dropInPrice;

      // Tier, price and bookability are all per-athlete: two siblings on
      // different plans get different answers for the same class.
      const evalFor = (st: AthleteState) => {
        const covered = acceptedMembershipIds.some((id) => st.membershipIds.includes(id));
        const trialCovers =
          st.trialActive && trialCoversClass(trialClub?.freeTrialConfig, acceptedMembershipIds);
        const hasAnyActiveSub = st.membershipIds.length > 0;
        let bookingTier: "MEMBERSHIP" | "MEMBER" | "NON_MEMBER" | "DROP_IN" | null = null;
        let bookingPriceNum: number | null = null;
        let bookingLabel: string | null = null;
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
        const attendance = st.classStatus.get(sessionItem.id) ?? null;
        const freeCovered = covered || trialCovers;
        const p = freeCovered
          ? null
          : bookingPriceNum != null
            ? bookingPriceNum.toFixed(2)
            : priceOpt
              ? money(priceOpt.price)
              : null;
        return {
          price: p,
          bookingStatus: attendance,
          bookingTier,
          bookingLabel,
          canBook: !attendance && (freeCovered || bookingPriceNum != null),
          statusText: attendance
            ? "Booked"
            : covered
              ? "Included in your membership"
              : trialCovers
                ? "Free trial"
                : p
                  ? "Purchase required"
                  : "Ask staff to book",
        };
      };

      const athletes = scopeAthletes.map((a) => ({
        memberId: a.id,
        firstName: a.firstName,
        lastName: a.lastName,
        ...evalFor(stateById.get(a.id)!),
      }));

      const ctxEval = ctxState ? evalFor(ctxState) : null;
      const price = ctxEval?.price ?? null;
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
        statusText: ctxEval?.statusText ?? "Ask staff to book",
        canBook: !!ctxEval && ctxEval.canBook,
        bookingStatus: ctxEval?.bookingStatus ?? null,
        athletes,
        color: sessionItem.recurringClass.color ?? null,
        textColor: sessionItem.recurringClass.textColor ?? null,
        bookingTier: ctxEval?.bookingTier ?? null,
        bookingLabel: ctxEval?.bookingLabel ?? null,
      };
    }),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return NextResponse.json({
    contextMember: context,
    accessibleMembers: accessible,
    familyScope,
    /** Athletes whose per-item state is in `items[].athletes`. In family scope
     *  this excludes any child still awaiting COPPA consent. */
    scopeMembers: scopeAthletes.map((a) => ({ id: a.id, firstName: a.firstName, lastName: a.lastName })),
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
