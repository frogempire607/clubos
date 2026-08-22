// The Prisma half of coverage. lib/entitlements.ts stays pure; this loads the
// rows it needs and hands back a verdict per member.
//
// One loader, deliberately: the attendance panel, the member schedule and
// (later) the write paths all ask the same question, and the way they came to
// disagree in the first place was each one writing its own version of
// "does this member have an active sub on an accepted plan".

import { prisma } from "@/lib/prisma";
import { parseOptions } from "@/lib/membershipOptions";
import {
  resolveSessionCoverage,
  shouldWarn,
  type CoverageSubscription,
  type CoverageVerdict,
} from "@/lib/entitlements";

/**
 * What crosses the wire. `warn` is computed HERE, not in the client, so the
 * rule for when a shortfall is worth showing lives in one place
 * (lib/entitlements.shouldWarn) and cannot drift between server and browser.
 */
export type CoverageVerdictWire = CoverageVerdict & { warn: boolean };

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

export function parsePricingOptions(raw: unknown): PricingOption[] {
  return (raw as PricingOption[] | null) || [];
}

export function acceptedMembershipIdsFrom(raw: unknown): string[] {
  return parsePricingOptions(raw)
    .filter((o): o is Extract<PricingOption, { type: "membership" }> =>
      o?.type === "membership" && !!o.membershipId)
    .map((o) => o.membershipId);
}

/**
 * What a non-covered attendee would owe.
 *
 * `dropin` first, then `nonmember` — the drop-in tier is the one a class
 * configures for exactly this case. Returns null when the class sets neither,
 * so the verdict can say "no drop-in price is set" instead of inventing a
 * number somebody might then collect.
 */
export function dropInFrom(raw: unknown): { amount: number; source: "dropin" | "nonmember" } | null {
  const opts = parsePricingOptions(raw);
  const dropin = opts.find((o) => o.type === "dropin") as { price?: number } | undefined;
  if (typeof dropin?.price === "number") return { amount: dropin.price, source: "dropin" };
  const nonmember = opts.find((o) => o.type === "nonmember") as { price?: number } | undefined;
  if (typeof nonmember?.price === "number") return { amount: nonmember.price, source: "nonmember" };
  return null;
}

/**
 * The weekday a session falls on.
 *
 * `getUTCDay()` on `ClassSession.date`, with NO timezone conversion —
 * lib/classSessions.ts builds sessions by walking UTC midnights and selecting on
 * exactly this, and stamps wall-clock times as UTC. Converting through
 * `Club.timezone` here would introduce an off-by-one day rather than fix one.
 */
export function sessionWeekday(date: Date): number {
  return date.getUTCDay();
}

export type SessionCoverageContext = {
  acceptedMembershipIds: string[];
  weekday: number;
  startsAt: Date;
  dropIn: { amount: number; source: "dropin" | "nonmember" } | null;
};

/** Load everything about the session that coverage depends on, once. */
export async function loadSessionCoverageContext(
  classSessionId: string,
  clubId: string,
): Promise<SessionCoverageContext | null> {
  const cs = await prisma.classSession.findFirst({
    where: { id: classSessionId, clubId },
    select: {
      date: true,
      startsAt: true,
      recurringClass: { select: { pricingOptions: true } },
    },
  });
  if (!cs) return null;
  const raw = cs.recurringClass.pricingOptions;
  return {
    acceptedMembershipIds: acceptedMembershipIdsFrom(raw),
    weekday: sessionWeekday(cs.date),
    startsAt: cs.startsAt,
    dropIn: dropInFrom(raw),
  };
}

/**
 * A verdict per member, keyed by memberId.
 *
 * Two queries regardless of how many members are asked about — the attendance
 * panel calls this for a whole roster plus every search result, and one query
 * per member would make the panel slower the busier the class is.
 */
export async function coverageForMembers(
  memberIds: string[],
  ctx: SessionCoverageContext,
  clubId: string,
): Promise<Map<string, CoverageVerdictWire>> {
  const out = new Map<string, CoverageVerdictWire>();
  if (memberIds.length === 0) return out;

  const subs = await prisma.memberSubscription.findMany({
    where: { memberId: { in: memberIds }, member: { clubId, deletedAt: null } },
    select: {
      id: true,
      memberId: true,
      membershipId: true,
      status: true,
      optionId: true,
      optionLabel: true,
      billingPeriod: true,
      price: true,
      endDate: true,
      membership: { select: { id: true, name: true, options: true } },
    },
  });

  // Parse each plan's options ONCE, not once per subscription. A roster of 30
  // on one plan would otherwise re-parse the same JSON 30 times.
  const planCache = new Map<string, { id: string; name: string; options: ReturnType<typeof parseOptions> }>();
  const planFor = (m: { id: string; name: string; options: unknown } | null) => {
    if (!m) return null;
    const hit = planCache.get(m.id);
    if (hit) return hit;
    const parsed = { id: m.id, name: m.name, options: parseOptions(m.options) };
    planCache.set(m.id, parsed);
    return parsed;
  };

  const byMember = new Map<string, CoverageSubscription[]>();
  for (const s of subs) {
    const row: CoverageSubscription = {
      id: s.id,
      membershipId: s.membershipId,
      status: s.status,
      optionId: s.optionId,
      optionLabel: s.optionLabel,
      billingPeriod: s.billingPeriod,
      price: s.price,
      endDate: s.endDate,
      plan: planFor(s.membership),
    };
    byMember.set(s.memberId, [...(byMember.get(s.memberId) ?? []), row]);
  }

  for (const memberId of memberIds) {
    const verdict = resolveSessionCoverage({
      subscriptions: byMember.get(memberId) ?? [],
      acceptedMembershipIds: ctx.acceptedMembershipIds,
      sessionWeekday: ctx.weekday,
      sessionAt: ctx.startsAt,
      dropIn: ctx.dropIn,
    });
    out.set(memberId, { ...verdict, warn: shouldWarn(verdict) });
  }
  return out;
}
