// B12 — the pure half of "change a live Stripe membership from inside
// AthletixOS". Two jobs, no I/O:
//
//   1. Mirror a Stripe price back onto a MemberSubscription row. Stripe knows
//      one number (unit_amount, with the processing fee already folded in when
//      the club passes fees) and one interval. The row needs the club's price,
//      the billing period and WHICH option that is. Orson Chorba's price was
//      changed by hand in Stripe on 2026-09-22 and the row kept saying Monthly
//      $175 because nothing translated one vocabulary into the other.
//
//   2. Work out what a plan change means in dates: when it takes effect, when
//      the commitment ends, and whether/when Stripe should cancel.
//
// Everything here is pure so scripts/stripe-plan-change-tests.ts can pin it.

import { computeProcessingFeeCents, recurringUnitWithFee } from "@/lib/fees";
import type { BillingPeriod, MembershipOption, PlanDefaults } from "@/lib/membershipOptions";
import { resolveTerms } from "@/lib/membershipOptions";

// ── Fee inversion ─────────────────────────────────────────────────────────────

/**
 * The club price behind a Stripe unit_amount.
 *
 * With fees passed, recurringUnitWithFee(base) = base + round(base × 2.9%),
 * which is not invertible by division alone (rounding). We search the two or
 * three candidates around unit / 1.029 for the one that round-trips exactly.
 * When none does — someone typed a round number like $150 straight into Stripe
 * without the fee — the unit IS the price and `feeFolded` is false, so the
 * caller can say so instead of inventing a $145.77 nobody agreed to.
 */
export function baseFromUnitAmount(unitCents: number, passProcessingFees: boolean): { baseCents: number; feeFolded: boolean } {
  if (!Number.isFinite(unitCents) || unitCents <= 0) return { baseCents: Math.max(0, unitCents | 0), feeFolded: false };
  if (!passProcessingFees) return { baseCents: unitCents, feeFolded: false };
  const guess = Math.round(unitCents / (1 + 0.029));
  let folded: number | null = null;
  for (const b of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (b > 0 && b + computeProcessingFeeCents(b) === unitCents) { folded = b; break; }
  }
  // Almost every unit inverts to SOMETHING (15000 → $145.77 + $4.23), so an
  // exact round-trip alone can't tell "$150 typed by hand" from "$145.77 +
  // fee". Club prices are whole dollars; fee-inclusive totals almost never
  // are. Prefer the whole-dollar reading when only one side has it.
  if (folded == null) return { baseCents: unitCents, feeFolded: false };
  const foldedWhole = folded % 100 === 0;
  const unitWhole = unitCents % 100 === 0;
  if (unitWhole && !foldedWhole) return { baseCents: unitCents, feeFolded: false };
  return { baseCents: folded, feeFolded: true };
}

// ── Interval ↔ billing period ─────────────────────────────────────────────────

export function stripeIntervalToBillingPeriod(interval: string | null | undefined, count: number | null | undefined): BillingPeriod | null {
  const n = count ?? 1;
  if (interval === "week" && n === 1) return "WEEKLY";
  if (interval === "year" && n === 1) return "ANNUAL";
  if (interval === "month") {
    if (n === 1) return "MONTHLY";
    if (n === 3) return "QUARTERLY";
    if (n === 4) return "QUADRIMESTRAL";
    if (n === 6) return "SEMI_ANNUAL";
    if (n === 12) return "ANNUAL";
  }
  return null;
}

export function sameStripeInterval(a: BillingPeriod | string | null, b: BillingPeriod | string | null): boolean {
  if (!a || !b) return false;
  // ANNUAL is the only period with two Stripe spellings (year/1, month/12);
  // everything else maps 1:1, so period equality is interval equality.
  return a === b;
}

// ── Mirror ────────────────────────────────────────────────────────────────────

export type MirrorInput = {
  unitCents: number | null;
  interval: string | null;
  intervalCount: number | null;
  passProcessingFees: boolean;
  options: MembershipOption[];
  current: { optionId: string | null; optionLabel: string; price: number; billingPeriod: string | null };
};

export type MirrorResult = {
  price: number;
  billingPeriod: BillingPeriod | null;
  optionId: string | null;
  optionLabel: string;
  /** How the option was decided. `kept` = Stripe still matches the row's option. */
  resolution: "kept" | "matched" | "unmatched";
  feeFolded: boolean;
  /** Human field names that differ from the row, for the audit line + UI. */
  changed: string[];
};

/**
 * What the row should say, given what Stripe charges.
 *
 *   - price: the fee-stripped unit amount (see baseFromUnitAmount)
 *   - billingPeriod: from the Stripe interval; unknown intervals keep the row's
 *   - option: if the row's current option still has this price + period, keep
 *     it (a label rename is not a plan change). Otherwise the unique option
 *     with that price + period wins and the row takes its label. No unique
 *     match ⇒ optionId cleared, label kept, `unmatched` — the price is real
 *     even when the catalog has no name for it (a bespoke deal).
 */
export function mirrorFromStripePrice(input: MirrorInput): MirrorResult {
  const cur = input.current;
  if (input.unitCents == null) {
    return {
      price: cur.price, billingPeriod: (cur.billingPeriod as BillingPeriod | null) ?? null,
      optionId: cur.optionId, optionLabel: cur.optionLabel, resolution: "kept", feeFolded: false, changed: [],
    };
  }
  const { baseCents, feeFolded } = baseFromUnitAmount(input.unitCents, input.passProcessingFees);
  const price = baseCents / 100;
  const period = stripeIntervalToBillingPeriod(input.interval, input.intervalCount) ?? ((cur.billingPeriod as BillingPeriod | null) ?? null);

  const stillCurrent = cur.optionId
    ? input.options.find((o) => o.id === cur.optionId && o.price === price && o.billingPeriod === period) ?? null
    : null;
  let optionId = cur.optionId;
  let optionLabel = cur.optionLabel;
  let resolution: MirrorResult["resolution"] = "kept";
  if (!stillCurrent) {
    const matches = input.options.filter((o) => o.id && o.price === price && o.billingPeriod === period);
    if (matches.length === 1) {
      optionId = matches[0].id;
      optionLabel = matches[0].label;
      resolution = "matched";
    } else {
      optionId = null;
      resolution = "unmatched";
    }
  }
  const changed: string[] = [];
  if (price !== cur.price) changed.push("price");
  if (period !== cur.billingPeriod) changed.push("billing period");
  if (optionId !== cur.optionId) changed.push("option");
  if (optionLabel !== cur.optionLabel) changed.push("label");
  return { price, billingPeriod: period, optionId, optionLabel, resolution, feeFolded, changed };
}

// ── Plan change terms ─────────────────────────────────────────────────────────

export type PlanChangeTermsInput = {
  /** When the new price starts billing: the current period end (or trial end). */
  effectiveAt: Date;
  option: MembershipOption;
  plan: PlanDefaults;
  /** Owner override; null = the option's own default. */
  autoRenew: boolean | null;
  addMonths: (d: Date, n: number) => Date;
  addPeriod: (d: Date, period: string) => Date;
};

export type PlanChangeTerms = {
  autoRenew: boolean;
  contractMonths: number | null;
  /** Commitment floor, counted from the day the new price starts. */
  minimumTermEndsAt: Date | null;
  /** Stripe cancel_at. Null = keeps renewing. */
  cancelAt: Date | null;
};

/**
 * Dates for a plan change, counted from the effective date, not today: a
 * member moving to "12 months" on Oct 22 owes twelve months from Oct 22.
 *
 *   auto-renew ON  → no cancel; the term is a floor only
 *   auto-renew OFF → cancel at the end of the term, or after ONE period when
 *                    the option has no term (the same rule cardActivation uses)
 */
export function planChangeTerms(input: PlanChangeTermsInput): PlanChangeTerms {
  const terms = resolveTerms(input.option, input.plan);
  const autoRenew = input.autoRenew ?? terms.autoRenewDefault;
  const months = terms.contractMonths != null && terms.contractMonths > 0 ? terms.contractMonths : null;
  const minimumTermEndsAt = months ? input.addMonths(input.effectiveAt, months) : null;
  const cancelAt = autoRenew ? null : minimumTermEndsAt ?? input.addPeriod(input.effectiveAt, input.option.billingPeriod);
  return { autoRenew, contractMonths: months, minimumTermEndsAt, cancelAt };
}

/** The unit amount Stripe should charge for an option under this club. */
export function unitAmountFor(price: number, passProcessingFees: boolean): number {
  return recurringUnitWithFee(Math.round(price * 100), passProcessingFees);
}

// ── B13 slice 3 — change plan for everyone ───────────────────────────────────
//
// Two new shapes beside B12's same-interval swap:
//
//   OFFLINE  — a cash/check row has no Stripe to tell. The option, price and
//              period change FROM THE NEXT PAYMENT: paid-through is untouched
//              (what was paid for stays paid for), and the commitment counts
//              from the day that next payment is due.
//   SWITCH   — a Stripe row moving to a different billing cycle. Stripe can't
//              change the interval in place without resetting the cycle and
//              prorating, so the current subscription ends at its period end
//              and a new one starts that same day on the same card, first
//              charge that day. Both steps run in one action.

const fmtLong = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const periodWord = (p: string | null | undefined) => (p ? p.toLowerCase().replace("_", "-") : "");

export type OfflinePlanChangeInput = {
  row: { price: number; billingPeriod: string | null; optionLabel: string; paidThroughDate: Date | null; currentPeriodEnd: Date | null };
  option: MembershipOption;
  plan: PlanDefaults;
  autoRenew: boolean | null;
  now: Date;
  addMonths: (d: Date, n: number) => Date;
  addPeriod: (d: Date, period: string) => Date;
};

export type OfflinePlanChange = PlanChangeTerms & {
  /** The next payment's due date — where the new price starts. */
  effectiveAt: Date;
  /** True when the next payment is already overdue. */
  overdue: boolean;
  sameAmount: boolean;
  lines: string[];
};

/**
 * Where the new option starts on an offline row: the next payment. That is
 * the paid-through date (the day money next falls due), else the current
 * period's end, else today for a row that has never recorded a payment.
 */
export function offlinePlanChange(input: OfflinePlanChangeInput): OfflinePlanChange {
  const { row, option } = input;
  const effectiveAt = row.paidThroughDate ?? row.currentPeriodEnd ?? input.now;
  const overdue = effectiveAt.getTime() < input.now.getTime();
  const terms = planChangeTerms({ effectiveAt, option, plan: input.plan, autoRenew: input.autoRenew, addMonths: input.addMonths, addPeriod: input.addPeriod });
  const sameAmount = Math.round(row.price * 100) === Math.round(option.price * 100) && row.billingPeriod === option.billingPeriod;
  const lines: string[] = [];
  lines.push(
    sameAmount
      ? `The price stays $${option.price.toFixed(2)} ${periodWord(option.billingPeriod)}.`
      : `From the next payment${overdue ? ` (overdue since ${fmtLong(effectiveAt)})` : ` (due ${fmtLong(effectiveAt)})`} it's $${option.price.toFixed(2)} ${periodWord(option.billingPeriod)} instead of $${row.price.toFixed(2)} ${periodWord(row.billingPeriod)}.`,
  );
  lines.push(
    row.paidThroughDate
      ? `Paid through ${fmtLong(row.paidThroughDate)} stays as it is — nothing already paid is re-priced.`
      : "No payment is recorded on this membership yet, so the new price applies to the first one.",
  );
  if (terms.minimumTermEndsAt) lines.push(`${terms.contractMonths}-month commitment from ${fmtLong(effectiveAt)} to ${fmtLong(terms.minimumTermEndsAt)}.`);
  lines.push(terms.cancelAt ? `Ends on ${fmtLong(terms.cancelAt)} — no renewal after that.` : "Keeps renewing until you cancel it.");
  lines.push("Stripe: nothing — this membership is billed offline.");
  return { ...terms, effectiveAt, overdue, sameAmount, lines };
}

export type SwitchLinesInput = {
  currentLabel: string;
  /** What the card is charged today per cycle (fee-inclusive). */
  currentTotal: number;
  currentPeriod: string | null;
  effectiveAt: Date;
  option: MembershipOption;
  fee: number;
  total: number;
  passProcessingFees: boolean;
  terms: PlanChangeTerms;
  cardLabel: string | null;
};

/** The confirm dialog's sentences for a cross-cycle switch. */
export function switchLines(input: SwitchLinesInput): string[] {
  const { option, terms, effectiveAt } = input;
  const card = input.cardLabel ? `the saved ${input.cardLabel}` : "the saved card";
  const lines: string[] = [];
  lines.push(
    `"${input.currentLabel}" ($${input.currentTotal.toFixed(2)} ${periodWord(input.currentPeriod)}) ends on ${fmtLong(effectiveAt)} — its last period is already paid for.`,
  );
  lines.push(
    `"${option.label}" starts the same day: ${card} is charged $${input.total.toFixed(2)}${input.passProcessingFees && input.fee > 0 ? ` ($${option.price.toFixed(2)} + $${input.fee.toFixed(2)} processing fee)` : ""} on ${fmtLong(effectiveAt)}, then ${periodWord(option.billingPeriod)}.`,
  );
  lines.push("Nothing is charged or refunded today.");
  if (terms.minimumTermEndsAt) lines.push(`${terms.contractMonths}-month commitment from ${fmtLong(effectiveAt)} to ${fmtLong(terms.minimumTermEndsAt)}.`);
  lines.push(terms.cancelAt ? `The new plan ends on ${fmtLong(terms.cancelAt)} — no renewal after that.` : "The new plan keeps renewing until you cancel it.");
  lines.push("Stripe: the current subscription is set to end on that date and a new one is created on the same card.");
  return lines;
}
