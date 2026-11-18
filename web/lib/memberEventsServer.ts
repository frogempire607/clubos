// Which events a family may see in the member portal, and the shape each one
// is sent in. ONE definition, used by the Events list (GET /api/member/events)
// and the event details screen (GET /api/member/events/[id]), so a link to an
// event can never open something the list would hide.
//
// The rules (unchanged from the list route that used to hold them):
//   - this club, not deleted
//   - visibility PUBLIC or MEMBERS_ONLY (PRIVATE / staff-only never)
//   - purchase access ANYONE (staff-only and invite-only never)
//   - inside its publish window
//   - an event limited to an age, level or group is shown only when one of
//     the athletes this login acts for is someone it is for
// The list adds "not started yet"; the details screen does not, so a family
// can still open an event they are registered for on the day.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { rosterForSignup } from "@/lib/eventRosterServer";
import { autoDiscountView } from "@/lib/eventAutoDiscounts";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { eventLinksForRead } from "@/lib/eventLinks";
import { athleteMatches, describeAudience, normalizeAudience } from "@/lib/eventAudience";

export function memberVisibleEventWhere(clubId: string, now: Date, opts: { upcomingOnly: boolean }): Prisma.EventWhereInput {
  return {
    clubId,
    deletedAt: null,
    ...(opts.upcomingOnly ? { startsAt: { gte: now } } : {}),
    visibility: { in: ["PUBLIC", "MEMBERS_ONLY"] },
    purchaseAccess: "ANYONE",
    AND: [
      { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
      { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
    ],
  };
}

export const MEMBER_EVENT_INCLUDE = {
  location: { select: { name: true } },
  customEventType: { select: { id: true, name: true, color: true, textColor: true, defaultPolicy: true } },
  sessions: { orderBy: { sortOrder: "asc" } },
  _count: { select: { bookings: true } },
} as const satisfies Prisma.EventInclude;

type MemberEventRow = Prisma.EventGetPayload<{ include: typeof MEMBER_EVENT_INCLUDE }>;

export type MemberEventContext = Awaited<ReturnType<typeof loadMemberEventContext>>;

/** Who is looking: the athletes this login acts for, and the one in focus. */
export async function loadMemberEventContext(session: { user: { id: string; clubId: string } }, requestedMemberId: string | null) {
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  const resolved = user ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email, requestedMemberId) : null;
  const accessible = resolved && resolved !== "FORBIDDEN" ? resolved.accessible : [];
  const member = resolved && resolved !== "FORBIDDEN" ? resolved.context : null;
  const [bookings, subscriptions] = member
    ? await Promise.all([
        prisma.booking.findMany({
          where: { memberId: member.id, status: { in: ["CONFIRMED", "WAITLISTED"] } },
          select: { eventId: true, status: true },
        }),
        prisma.memberSubscription.findMany({ where: { memberId: member.id, status: "active" }, select: { membershipId: true } }),
      ])
    : [[], []];
  return {
    forbidden: resolved === "FORBIDDEN",
    accessible,
    member,
    bookings,
    subscriptions,
    // Subscription rows, never Member.status: this must agree with what the
    // register route will actually charge (member vs non-member price).
    isActiveMember: subscriptions.length > 0,
  };
}

/**
 * The events from `rows` this family may see, in the shape the portal reads.
 * Drops any event limited to an audience none of the family's athletes is in.
 */
export async function shapeForMember(clubId: string, rows: MemberEventRow[], ctx: MemberEventContext) {
  const audienced = rows.filter((e) => normalizeAudience(e.audience));
  const ids = ctx.accessible.map((a: { id: string }) => a.id);
  const [facts, famSubs, plans] = audienced.length && ids.length
    ? await Promise.all([
        prisma.member.findMany({ where: { id: { in: ids }, clubId }, select: { id: true, dateOfBirth: true, gender: true, tags: true } }),
        prisma.memberSubscription.findMany({ where: { memberId: { in: ids }, status: "active" }, select: { memberId: true, membershipId: true } }),
        prisma.membership.findMany({ where: { clubId, id: { in: audienced.flatMap((e) => normalizeAudience(e.audience)?.membershipIds ?? []) } }, select: { id: true, name: true } }),
      ])
    : [[], [], []];
  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? "selected";
  const fitsSomeone = (e: MemberEventRow) => {
    const aud = normalizeAudience(e.audience);
    if (!aud) return true;
    return facts.some((f) => athleteMatches(aud, {
      dateOfBirth: f.dateOfBirth, gender: f.gender, tags: f.tags,
      activeMembershipIds: famSubs.filter((s) => s.memberId === f.id).map((s) => s.membershipId),
    }, e.startsAt, planName).ok);
  };

  return Promise.all(
    rows.filter(fitsSomeone).map(async (e) => {
      // The type's policy decides approval; it's resolved here and not sent.
      const approvalGated = resolveEventPolicy(e).requiresCoachApproval;
      const customEventType = e.customEventType
        ? { id: e.customEventType.id, name: e.customEventType.name, color: e.customEventType.color, textColor: e.customEventType.textColor }
        : null;
      return {
        ...e,
        customEventType,
        approvalGated,
        // B16 — the roster families pick a spot from: labels and open counts only.
        roster: await rosterForSignup(e.id, e.holdSpotDuringReview),
        // B3 slice 1 — the rule lines + group question, never the raw blob.
        autoDiscounts: autoDiscountView(e.autoDiscounts),
        // Labeled outside links, normalized (old registrationLink included).
        externalLinks: eventLinksForRead(e),
        audienceLabel: describeAudience(normalizeAudience(e.audience), planName),
      };
    }),
  );
}
