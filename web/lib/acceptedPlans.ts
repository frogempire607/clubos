// B7 — a class's "Accepted Memberships" can name OPTIONS, not just plans.
//
// A class's pricingOptions lists `{type:"membership", membershipId}` rows. That
// said "anyone on MS/HS is included" — fine while each price point was its own
// plan, wrong once MS/HS holds six options (a $110 two-day option and a $175
// full one on the same plan). A row may now carry `optionIds`:
//
//   { type: "membership", membershipId: "<MS/HS>" }                    every option
//   { type: "membership", membershipId: "<MS/HS>", optionIds: [a, b] } only a, b
//
// Absent or empty `optionIds` = every option, so every class saved before this
// keeps meaning exactly what it meant. PURE — no prisma.
//
// Relationship to day entitlements (lib/entitlements): the two stack. An option
// can be accepted for a class AND still not cover the session's weekday.
// Acceptance answers "does this option get into this class at all"; the day
// set answers "on which days".
//
// Fail OPEN on an option we cannot identify, same asymmetry as the coverage
// resolver: a wrong "accepted" costs one drop-in; a wrong "not accepted" argues
// with a paying family over a row the software could not read.

import { resolveSubscriptionOption, type MembershipOption } from "@/lib/membershipOptions";

export type AcceptedPlan = {
  membershipId: string;
  /** null = every option on the plan. */
  optionIds: string[] | null;
};

type RawRow = { type?: unknown; membershipId?: unknown; optionIds?: unknown };

/** Every plan a class/event accepts, with its option restriction (if any). */
export function acceptedPlansFrom(raw: unknown): AcceptedPlan[] {
  const rows = Array.isArray(raw) ? (raw as RawRow[]) : [];
  const out = new Map<string, AcceptedPlan>();
  for (const r of rows) {
    if (!r || r.type !== "membership" || typeof r.membershipId !== "string" || !r.membershipId) continue;
    const ids = Array.isArray(r.optionIds)
      ? Array.from(new Set((r.optionIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x)))
      : [];
    const prev = out.get(r.membershipId);
    // The same plan listed twice: the union wins ("all" beats any subset).
    if (prev) {
      prev.optionIds = prev.optionIds === null || ids.length === 0 ? null : Array.from(new Set([...prev.optionIds, ...ids]));
      continue;
    }
    out.set(r.membershipId, { membershipId: r.membershipId, optionIds: ids.length ? ids : null });
  }
  return Array.from(out.values());
}

export function acceptedIdsOf(plans: AcceptedPlan[]): string[] {
  return plans.map((p) => p.membershipId);
}

export type OptionAcceptance =
  | { accepted: true; how: "PLAN" | "OPTION" | "UNIDENTIFIED" }
  | { accepted: false; why: "PLAN_NOT_ACCEPTED" | "OPTION_NOT_ACCEPTED"; optionLabel: string | null };

/**
 * Is this subscription's option accepted? `planOptions` are the parsed options
 * of the subscription's own plan (for inference when optionId is not stamped).
 */
export function subscriptionAccepted(
  plans: AcceptedPlan[],
  sub: { membershipId: string; optionId?: string | null; billingPeriod?: string | null; price?: unknown },
  planOptions: MembershipOption[],
): OptionAcceptance {
  const plan = plans.find((p) => p.membershipId === sub.membershipId);
  if (!plan) return { accepted: false, why: "PLAN_NOT_ACCEPTED", optionLabel: null };
  if (plan.optionIds === null) return { accepted: true, how: "PLAN" };
  const res = resolveSubscriptionOption(sub, planOptions);
  if (res.resolution === "unresolved" || !res.option?.id) return { accepted: true, how: "UNIDENTIFIED" };
  return plan.optionIds.includes(res.option.id)
    ? { accepted: true, how: "OPTION" }
    : { accepted: false, why: "OPTION_NOT_ACCEPTED", optionLabel: res.option.label };
}

/**
 * The row to save for one plan in a class editor. `chosen` null or covering
 * every option = the plain plan row (no optionIds), so a class that ticks every
 * option does not silently exclude an option added to the plan later.
 */
export function pricingRowFor(membershipId: string, chosen: string[] | null, planOptionIds: string[]):
  { type: "membership"; membershipId: string; optionIds?: string[] } {
  const ids = chosen ? Array.from(new Set(chosen.filter((id) => planOptionIds.includes(id)))) : null;
  if (!ids || ids.length === 0 || planOptionIds.every((id) => ids.includes(id))) return { type: "membership", membershipId };
  return { type: "membership", membershipId, optionIds: ids };
}

/** Drop a plan (e.g. a deactivated one) from a pricingOptions array. Other rows untouched. */
export function removePlanFromPricing(raw: unknown, membershipId: string): { next: unknown[]; removed: number } {
  const rows = Array.isArray(raw) ? (raw as RawRow[]) : [];
  const next = rows.filter((r) => !(r && r.type === "membership" && r.membershipId === membershipId));
  return { next, removed: rows.length - next.length };
}
