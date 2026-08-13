// Offline "how far does the money reach" model.
//
// PURE — no prisma, no IO, injected `now`. The offline-payment route and any
// future cash surface resolve through here so the receipt, the subscription and
// the audit trail can never disagree about what a payment bought.
//
// ── Why paidThroughDate is not currentPeriodEnd ─────────────────────────────
//
// `currentPeriodEnd` answers "when does the period they are in finish".
// `paidThroughDate` answers "how far has money actually been received".
//
// Those are the same number right up until somebody hands over two quarters at
// once, which is routine at a front desk. Collapsing them would make a
// prepayment indistinguishable from an early renewal, and the club would chase
// a family that is paid up six months ahead.

import { addBillingPeriod } from "@/lib/billingAdmin";

export type CoverageInput = {
  /** How far money already reaches. Null = nothing recorded yet. */
  paidThroughDate: Date | null;
  /** End of the period the subscription is currently in, if known. */
  currentPeriodEnd: Date | null;
  /** When the membership began. Last resort anchor. */
  startDate: Date | null;
  billingPeriod: string | null;
  /** Whole billing periods this payment buys. 1 = the usual single period. */
  periods: number;
  now: Date;
};

export type Coverage = {
  /** Where this payment's coverage begins. */
  start: Date;
  /** Where it ends — the subscription's new paidThroughDate. */
  end: Date;
  /**
   * End of the FIRST period this payment covers. Equals `end` for a single
   * period. This is what currentPeriodEnd becomes: prepaying two quarters must
   * not drag the billing period forward as though both were already consumed.
   */
  firstPeriodEnd: Date;
  periods: number;
  /** Which field the start was anchored to, for the audit trail. */
  basis: "paidThroughDate" | "currentPeriodEnd" | "startDate" | "now";
  /** True when we had nothing but `now` to anchor to — the date is a floor, not a fact. */
  anchorAssumed: boolean;
};

export const MAX_PERIODS_PER_PAYMENT = 24;

/**
 * Resolve what a payment of N periods buys.
 *
 * Coverage continues from wherever money already reaches, so two separate
 * single-quarter payments land in the same place as one two-quarter payment.
 * It never starts in the past: a family paying today after a lapse buys
 * forward from today, not retroactively — the lapse is a collection question,
 * and silently backdating coverage would erase it.
 */
export function resolveCoverage(input: CoverageInput): Coverage {
  const { paidThroughDate, currentPeriodEnd, startDate, billingPeriod, now } = input;
  const periods = Math.max(1, Math.min(MAX_PERIODS_PER_PAYMENT, Math.floor(input.periods || 1)));

  let start: Date;
  let basis: Coverage["basis"];
  if (paidThroughDate) { start = paidThroughDate; basis = "paidThroughDate"; }
  else if (currentPeriodEnd) { start = currentPeriodEnd; basis = "currentPeriodEnd"; }
  else if (startDate) { start = startDate; basis = "startDate"; }
  else { start = now; basis = "now"; }

  // Never sell time that has already elapsed.
  let anchorAssumed = basis === "now";
  if (start.getTime() < now.getTime()) {
    start = now;
    anchorAssumed = true;
  }

  let end = new Date(start);
  let firstPeriodEnd = start;
  for (let i = 0; i < periods; i++) {
    end = addBillingPeriod(end, billingPeriod ?? "MONTHLY");
    if (i === 0) firstPeriodEnd = new Date(end);
  }

  return { start, end, firstPeriodEnd, periods, basis, anchorAssumed };
}

/**
 * Human sentence for the receipt and the audit note. Deliberately states the
 * period count when it is more than one — "paid through March" alone hides
 * that the family handed over two quarters.
 */
export function describeCoverage(c: Coverage, billingPeriod: string | null): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  const unit = PERIOD_NOUN[billingPeriod ?? ""] ?? "period";
  const plural = c.periods === 1 ? unit : `${unit}s`;
  const head = `${c.periods} ${plural} — paid through ${fmt(c.end)}`;
  return c.anchorAssumed
    ? `${head}. Coverage starts today; nothing was on record for the period before this payment.`
    : head;
}

const PERIOD_NOUN: Record<string, string> = {
  WEEKLY: "week",
  MONTHLY: "month",
  QUADRIMESTRAL: "four-month period",
  QUARTERLY: "quarter",
  SEMI_ANNUAL: "half-year",
  ANNUAL: "year",
  ONE_TIME: "term",
};
