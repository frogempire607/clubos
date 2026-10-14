import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { rosterForSignup } from "@/lib/eventRosterServer";
import { autoDiscountView } from "@/lib/eventAutoDiscounts";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { eventLinksForRead } from "@/lib/eventLinks";
import { athleteMatches, describeAudience, normalizeAudience } from "@/lib/eventAudience";

// GET /api/member/events
// Upcoming events visible to members. Filters out STAFF_ONLY visibility,
// staff-only purchase access, and respects publish/unpublish windows.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const requestedMemberId = new URL(req.url).searchParams.get("memberId");

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
        customEventType: { select: { id: true, name: true, color: true, textColor: true, defaultPolicy: true } },
        sessions: { orderBy: { sortOrder: "asc" } },
        _count: { select: { bookings: true } },
      },
    }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } }),
  ]);

  // Family-aware: self or a child the viewer guardians (chosen via memberId).
  const resolved = user
    ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email, requestedMemberId)
    : null;
  const accessible = resolved && resolved !== "FORBIDDEN" ? resolved.accessible : [];
  const member = resolved && resolved !== "FORBIDDEN" ? resolved.context : null;

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
  // subscription row (manual or Stripe). NOT Member.status — that is a label
  // that lags the rows, and this flag must agree with what the register route
  // will actually charge. Drives member vs non-member event pricing.
  const isActiveMember = subscriptions.length > 0;

  // Event audience (lib/eventAudience.ts): an event with one is listed only
  // when an athlete this login can act for is someone it's for.
  const audienced = events.filter((e) => normalizeAudience(e.audience));
  const ids = accessible.map((a: { id: string }) => a.id);
  const [facts, famSubs, plans] = audienced.length && ids.length
    ? await Promise.all([
        prisma.member.findMany({ where: { id: { in: ids }, clubId: session.user.clubId }, select: { id: true, dateOfBirth: true, gender: true, tags: true } }),
        prisma.memberSubscription.findMany({ where: { memberId: { in: ids }, status: "active" }, select: { memberId: true, membershipId: true } }),
        prisma.membership.findMany({ where: { clubId: session.user.clubId, id: { in: audienced.flatMap((e) => normalizeAudience(e.audience)?.membershipIds ?? []) } }, select: { id: true, name: true } }),
      ])
    : [[], [], []];
  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? "selected";
  const fitsSomeone = (e: (typeof events)[number]) => {
    const aud = normalizeAudience(e.audience);
    if (!aud) return true;
    return facts.some((f) => athleteMatches(aud, {
      dateOfBirth: f.dateOfBirth, gender: f.gender, tags: f.tags,
      activeMembershipIds: famSubs.filter((s) => s.memberId === f.id).map((s) => s.membershipId),
    }, e.startsAt, planName).ok);
  };

  // B16 — the roster families pick a spot from: labels and open counts only.
  const withRoster = await Promise.all(
    events.filter(fitsSomeone).map(async (e) => {
      // The type's policy decides approval; it's resolved here and not sent.
      const approvalGated = resolveEventPolicy(e).requiresCoachApproval;
      const customEventType = e.customEventType
        ? { id: e.customEventType.id, name: e.customEventType.name, color: e.customEventType.color, textColor: e.customEventType.textColor }
        : null;
      return {
        ...e,
        customEventType,
        approvalGated,
        roster: await rosterForSignup(e.id, e.holdSpotDuringReview),
        // B3 slice 1 — the rule lines + group question, never the raw blob.
        autoDiscounts: autoDiscountView(e.autoDiscounts),
        // Labeled outside links, normalized (old registrationLink included).
        externalLinks: eventLinksForRead(e),
        audienceLabel: describeAudience(normalizeAudience(e.audience), planName),
      };
    }),
  );

  return NextResponse.json({
    events: withRoster,
    bookings,
    activeMembershipIds: subscriptions.map((s) => s.membershipId),
    isActiveMember,
    accessible,
    contextMemberId: member?.id ?? null,
    hasMemberProfile: accessible.length > 0,
  });
}
