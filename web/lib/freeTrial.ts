import { prisma } from "@/lib/prisma";

// The club's SINGLE free-trial offer, stored on Club.freeTrialConfig.
//
// Semantics:
// - config null      → the club never opened the new editor. Legacy fallback:
//                      each membership's own trialEnabled/trialDays columns
//                      still drive subscription trials (nothing breaks).
// - config.active    → one central offer. membershipIds [] = applies to every
//   true               membership; otherwise only the listed plans get the
//                      subscription trial. The public signup link grants a
//                      Member.trialEndsAt class-trial window for `days`.
// - config.active    → the owner explicitly offers NO free trial anywhere —
//   false              legacy membership flags are ignored too.

export type FreeTrialConfig = {
  name: string;
  days: number;
  membershipIds: string[];
  // Can the window be granted again after a previous one expired
  // (e.g. a returning prospect gets a fresh trial)?
  renewable: boolean;
  // Can the same client use the SUBSCRIPTION trial again on a plan they
  // already had a subscription on before?
  allowRepeatUse: boolean;
  active: boolean;
};

export function normalizeFreeTrialConfig(raw: unknown): FreeTrialConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const days = Number(o.days);
  if (!Number.isFinite(days)) return null;
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Free trial",
    days: Math.min(365, Math.max(1, Math.round(days))),
    membershipIds: Array.isArray(o.membershipIds)
      ? (o.membershipIds.filter((id) => typeof id === "string") as string[])
      : [],
    renewable: o.renewable !== false,
    allowRepeatUse: o.allowRepeatUse === true,
    active: o.active !== false,
  };
}

export type MembershipTrialFields = {
  id: string;
  trialEnabled: boolean;
  trialDays: number | null;
  trialAppliesToReturning: boolean;
};

/**
 * The subscription trial (Stripe trial_period_days) that applies when buying
 * a given membership. Central config wins when it exists; legacy
 * per-membership flags apply only for clubs that never configured it.
 */
export function trialForMembership(
  freeTrialConfig: unknown,
  membership: MembershipTrialFields,
): { days: number; allowRepeatUse: boolean } | null {
  const config = normalizeFreeTrialConfig(freeTrialConfig);
  if (config) {
    if (!config.active) return null;
    if (config.membershipIds.length > 0 && !config.membershipIds.includes(membership.id)) return null;
    return { days: config.days, allowRepeatUse: config.allowRepeatUse };
  }
  if (membership.trialEnabled && (membership.trialDays ?? 0) > 0) {
    return { days: membership.trialDays!, allowRepeatUse: membership.trialAppliesToReturning };
  }
  return null;
}

/**
 * Repeat-use gate for subscription trials: a member who already had a
 * subscription on this plan only trials again when the offer allows it.
 */
export async function eligibleForSubscriptionTrial(
  memberId: string,
  membershipId: string,
  trial: { days: number; allowRepeatUse: boolean },
): Promise<number | null> {
  if (trial.allowRepeatUse) return trial.days;
  const prior = await prisma.memberSubscription.findFirst({
    where: { memberId, membershipId, status: { in: ["active", "past_due", "canceled", "expired"] } },
    select: { id: true },
  });
  return prior ? null : trial.days;
}

/**
 * Whether an active trial window covers a given class. The trial behaves like
 * a membership limited to the plans the offer is attached to: an offer with
 * no attached plans covers every class; otherwise the class must accept one
 * of the attached memberships (classes with no accepted-membership
 * restriction stay covered — they're open to any plan holder).
 */
export function trialCoversClass(
  freeTrialConfig: unknown,
  classAcceptedMembershipIds: string[],
): boolean {
  const config = normalizeFreeTrialConfig(freeTrialConfig);
  if (config && !config.active) return false;
  if (!config || config.membershipIds.length === 0) return true;
  if (classAcceptedMembershipIds.length === 0) return true;
  return classAcceptedMembershipIds.some((id) => config.membershipIds.includes(id));
}

/** Staff-facing view of the offer (attendance panel confirmation copy). */
export function freeTrialSummary(freeTrialConfig: unknown): {
  active: boolean;
  name: string;
  days: number;
  renewable: boolean;
} {
  const config = normalizeFreeTrialConfig(freeTrialConfig);
  if (!config) return { active: true, name: "Free trial", days: 7, renewable: true };
  return { active: config.active, name: config.name, days: config.days, renewable: config.renewable };
}

/**
 * The class-trial window (Member.trialEndsAt) a staff TRIAL check-in or the
 * public trial signup link grants. Returns the number of days, or null when
 * the club offers no trial / this member can't have (another) one.
 */
export function trialWindowDays(
  freeTrialConfig: unknown,
  member: { trialEndsAt: Date | null },
): number | null {
  const config = normalizeFreeTrialConfig(freeTrialConfig);
  if (config && !config.active) return null;
  const days = config?.days ?? 7;
  const now = new Date();
  if (member.trialEndsAt && member.trialEndsAt > now) return null; // window already running
  if (member.trialEndsAt && member.trialEndsAt <= now && config && !config.renewable) return null;
  return days;
}

// ── Charge today, or after the free trial (2026-10-15) ──────────────────────
//
// Families kept asking why they had not been charged: a first purchase of a
// trial plan silently started a Stripe trial (charge N days later) — including
// families moved over from the old system, and families who were ALREADY in
// their class-trial window and so got a second trial stacked on top. Now the
// buyer picks: pay today, or start paying when the free trial is over.
//
// "When the trial is over" means:
//  · already in a class-trial window (Member.trialEndsAt in the future) → the
//    day that window ends. Never a fresh trial on top of it.
//  · otherwise, when the plan's subscription trial applies to them → N days
//    from today (unchanged from before).
// Stripe Checkout needs a trial_end at least 48 hours away, so a window ending
// sooner than that offers "pay today" only.

export type ChargeTiming = "TODAY" | "AFTER_TRIAL";

export const CHECKOUT_TRIAL_MIN_MS = 48 * 3600 * 1000 + 10 * 60 * 1000;

export type TrialStart =
  | { kind: "DAYS"; days: number; firstChargeAt: Date }
  | { kind: "WINDOW"; days: number; firstChargeAt: Date };

/** PURE. What "after the trial" would mean for this buyer, or null when there is no trial to wait for. */
export function trialStartFor(eligibleDays: number | null, classTrialEndsAt: Date | null, now: Date): TrialStart | null {
  if (classTrialEndsAt && classTrialEndsAt.getTime() > now.getTime()) {
    const left = classTrialEndsAt.getTime() - now.getTime();
    if (left < CHECKOUT_TRIAL_MIN_MS) return null;
    return { kind: "WINDOW", days: Math.ceil(left / 86_400_000), firstChargeAt: classTrialEndsAt };
  }
  if (eligibleDays && eligibleDays > 0) {
    return { kind: "DAYS", days: eligibleDays, firstChargeAt: new Date(now.getTime() + eligibleDays * 86_400_000) };
  }
  return null;
}

/** PURE. The Checkout `subscription_data` trial fields for the buyer's choice. */
export function trialCheckoutFields(t: TrialStart | null, timing: ChargeTiming): { trial_period_days?: number; trial_end?: number } {
  if (!t || timing === "TODAY") return {};
  if (t.kind === "WINDOW") return { trial_end: Math.floor(t.firstChargeAt.getTime() / 1000) };
  return { trial_period_days: t.days };
}

/** The trial a given member could start on a given plan right now (server). */
export async function purchaseTrialFor(
  freeTrialConfig: unknown,
  membership: MembershipTrialFields,
  member: { id: string; trialEndsAt: Date | null },
  now: Date = new Date(),
): Promise<TrialStart | null> {
  const trial = trialForMembership(freeTrialConfig, membership);
  const eligible = trial ? await eligibleForSubscriptionTrial(member.id, membership.id, trial) : null;
  return trialStartFor(eligible, member.trialEndsAt, now);
}
