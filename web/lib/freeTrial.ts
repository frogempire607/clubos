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
