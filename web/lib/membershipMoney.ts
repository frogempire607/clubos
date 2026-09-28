// B16 — the money side of the Membership panel, in plain words with real dates.
//
// Julian (owner), 2026-09-28: "If I click 3 month commitment I'm not trying to
// do the math in my head what is 3 months." And the incident behind it: Blake's
// dad paid one month in cash, staff changed "payment method" to Cash on the
// Advanced billing setup form — which only edits a migration draft — and Stripe
// charged his Cash App on the 27th anyway.
//
// Everything the panel SAYS about money is decided here, and the routes under
// app/api/members/[id]/membership/** re-derive the same answers from live values
// before they act, so the sentence the owner confirmed is the thing that runs.
// Pure: no prisma, no Stripe, `now` injected. Tests: scripts/membership-money-tests.ts.

import { addUTCMonths, addUTCDays } from "@/lib/billingAdmin";
import { resolveCoverage } from "@/lib/paidThrough";

// ── Words ────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
export const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const fmtShort = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const money = (n: number) => `$${Math.abs(n % 1) < 0.005 ? n.toFixed(0) : n.toFixed(2)}`;
export const money2 = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 1 → "1st", 22 → "22nd", 27 → "27th". */
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

const PERIOD_MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, QUADRIMESTRAL: 4, SEMI_ANNUAL: 6, ANNUAL: 12 };
const PERIOD_WORD: Record<string, string> = { WEEKLY: "weekly", MONTHLY: "monthly", QUARTERLY: "every 3 months", QUADRIMESTRAL: "every 4 months", SEMI_ANNUAL: "every 6 months", ANNUAL: "yearly" };
const PERIOD_NOUN: Record<string, string> = { WEEKLY: "week", MONTHLY: "month", QUARTERLY: "3 months", QUADRIMESTRAL: "4 months", SEMI_ANNUAL: "6 months", ANNUAL: "year" };
export const periodWord = (p: string | null | undefined) => PERIOD_WORD[p ?? "MONTHLY"] ?? "each period";
export const periodNoun = (p: string | null | undefined) => PERIOD_NOUN[p ?? "MONTHLY"] ?? "period";

/**
 * The k-th period boundary after `start`, computed from `start` every time
 * (never by stepping), so Jan 31 → Feb 28 → Mar 31, not Mar 28.
 */
export function periodBoundary(start: Date, period: string | null | undefined, k: number): Date {
  const p = period ?? "MONTHLY";
  if (p === "WEEKLY") return addUTCDays(start, 7 * k);
  return addUTCMonths(start, (PERIOD_MONTHS[p] ?? 1) * k);
}

/** How many billing periods START inside [start, end). A 3-month commitment billed monthly = 3. */
export function countPeriods(start: Date, end: Date, period: string | null | undefined): number {
  let k = 0;
  // Half a day of slack: dates are stored at 00:00Z but Stripe's are to the second.
  while (k < 400 && periodBoundary(start, period, k).getTime() < end.getTime() - DAY / 2) k++;
  return k;
}

function monthsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (DAY * 30.44)));
}

// ── The row, as this module sees it ──────────────────────────────────────────

export type MoneyRow = {
  hasStripe: boolean;
  status: string;
  stripeStatus: string | null;
  price: number;
  billingPeriod: string | null;
  startDate: Date | null;
  endDate: Date | null;
  currentPeriodEnd: Date | null;
  paidThroughDate: Date | null;
  minimumTermEndsAt: Date | null;
  autoRenew: boolean;
  /** Stripe cancel_at (live when known, else the snapshot). */
  cancelAt: Date | null;
  pausedAt: Date | null;
  pausedUntil: Date | null;
  deliberateFree: boolean;
};

/** When a Stripe row stops, if it does. cancel_at wins; a non-renewing row's end date otherwise. */
export function stripeEndsAt(row: MoneyRow): Date | null {
  return row.cancelAt ?? (!row.autoRenew ? row.endDate : null);
}

// ── How they pay ─────────────────────────────────────────────────────────────

export type PmFacts = { type: string | null; brand?: string | null; last4?: string | null; wallet?: string | null; label?: string | null };

const PM_TYPE_WORDS: Record<string, string> = {
  cashapp: "Cash App Pay", link: "Link", us_bank_account: "Bank account", paypal: "PayPal", amazon_pay: "Amazon Pay",
  klarna: "Klarna", affirm: "Affirm", sepa_debit: "Bank debit", acss_debit: "Bank debit", bacs_debit: "Bank debit",
  au_becs_debit: "Bank debit", revolut_pay: "Revolut Pay",
};
const WALLET_WORDS: Record<string, string> = { apple_pay: "Apple Pay", google_pay: "Google Pay", samsung_pay: "Samsung Pay", link: "Link" };
const title = (s: string) => s.split(/[_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** "Visa •••• 4242", "Cash App Pay", "Apple Pay (Visa •••• 4242)", "Bank account •••• 6789". */
export function paymentMethodLabel(pm: PmFacts | null | undefined): string | null {
  if (!pm) return null;
  if (pm.label) return pm.label;
  const t = (pm.type ?? (pm.last4 ? "card" : "")).toLowerCase();
  if (t === "card" || (!t && pm.last4)) {
    const card = `${pm.brand ? title(pm.brand) : "Card"}${pm.last4 ? ` •••• ${pm.last4}` : ""}`;
    const w = pm.wallet ? WALLET_WORDS[pm.wallet] ?? title(pm.wallet) : null;
    return w ? `${w} (${card})` : card;
  }
  if (!t) return null;
  const word = PM_TYPE_WORDS[t] ?? title(t);
  return pm.last4 ? `${word} •••• ${pm.last4}` : word;
}

/** "Cash App Pay (via Stripe) · charged automatically on the 27th" / "Cash — you collect it". */
export function howTheyPay(row: MoneyRow, opts: { pmLabel: string | null; offlineMethod?: "CASH" | "CHECK" | null }): string {
  if (row.price <= 0) return row.deliberateFree ? "Free — nothing to collect" : "$0 — nothing to collect";
  if (row.hasStripe) {
    const who = `${opts.pmLabel ?? "Saved payment method"} (via Stripe)`;
    const at = row.currentPeriodEnd;
    if (!at) return `${who} · charged automatically`;
    const when = row.billingPeriod === "WEEKLY"
      ? `every ${at.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}`
      : row.billingPeriod === "MONTHLY" || !row.billingPeriod
        ? `on the ${ordinal(at.getUTCDate())}`
        : `${periodWord(row.billingPeriod)}, next on ${fmtShort(at)}`;
    return `${who} · charged automatically ${when}`;
  }
  const m = opts.offlineMethod === "CHECK" ? "Check" : opts.offlineMethod === "CASH" ? "Cash" : "Cash or check";
  return `${m} — you collect it`;
}

// ── Commitment ───────────────────────────────────────────────────────────────

export type CommitmentView =
  | { state: "NONE"; text: string }
  | { state: "MISSING"; text: string; suggestedStart: Date; suggestedEnd: Date; months: number }
  | { state: "ACTIVE" | "DONE"; text: string; start: Date | null; end: Date; months: number; total: number | null; made: number | null; then: "renews" | "ends"; progress: string | null };

/**
 * "3-month commitment: Aug 20 – Nov 20, 2026 · 2 of 3 payments made · then renews monthly".
 *
 * `optionContractMonths` is what the option SAYS (the plan's promise);
 * `minimumTermEndsAt` is what the ROW recorded. When the option promises a
 * term and the row has none, say so — that is the "Commitment not recorded"
 * the owner can fix in one tap (set_dates → minimumTermEndsAt).
 */
export function commitmentView(
  row: MoneyRow,
  opts: { optionContractMonths: number | null; paymentsInTerm: number | null; now: Date },
): CommitmentView {
  const period = row.billingPeriod ?? "MONTHLY";
  const end = row.minimumTermEndsAt;
  const contract = opts.optionContractMonths && opts.optionContractMonths > 0 ? opts.optionContractMonths : null;
  if (!end) {
    if (contract && row.startDate && row.price > 0) {
      const suggestedEnd = addUTCMonths(row.startDate, contract);
      return {
        state: "MISSING",
        text: `Commitment not recorded — this option is a ${contract}-month commitment (${fmtShort(row.startDate)} – ${fmtDate(suggestedEnd)}). Set the dates so it's on file.`,
        suggestedStart: row.startDate, suggestedEnd, months: contract,
      };
    }
    return { state: "NONE", text: `No commitment — ${periodWord(period)}, cancel any time` };
  }
  const start = row.startDate;
  const months = contract ?? (start ? monthsBetween(start, end) : 0);
  const label = months > 0 ? `${months}-month commitment` : "Commitment";
  const span = start ? `${fmtShort(start)}${start.getUTCFullYear() !== end.getUTCFullYear() ? `, ${start.getUTCFullYear()}` : ""} – ${fmtDate(end)}` : `through ${fmtDate(end)}`;
  const total = start ? Math.max(1, countPeriods(start, end, period)) : null;
  const ends = row.hasStripe
    ? (() => { const e = stripeEndsAt(row); return !!e && e.getTime() <= end.getTime() + DAY; })()
    : !row.autoRenew || (!!row.endDate && row.endDate.getTime() <= end.getTime() + DAY);
  const then: "renews" | "ends" = ends ? "ends" : "renews";
  if (end.getTime() <= opts.now.getTime()) {
    return { state: "DONE", text: `${label} finished ${fmtDate(end)} · now ${periodWord(period)}`, start, end, months, total, made: total, then, progress: null };
  }
  // Payments made: counted from the money when we have it, else the periods that
  // have started. Never above the total, never below zero.
  const elapsed = start ? Math.min(total ?? 0, countPeriods(start, new Date(Math.min(opts.now.getTime() + DAY / 2, end.getTime())), period)) : null;
  const made = opts.paymentsInTerm != null ? Math.min(total ?? opts.paymentsInTerm, Math.max(0, opts.paymentsInTerm)) : elapsed;
  const progress = total != null && made != null ? `${made} of ${total} payment${total === 1 ? "" : "s"} made` : null;
  const thenText = then === "ends" ? "then it ends" : `then renews ${periodWord(period)}`;
  return { state: "ACTIVE", text: [`${label}: ${span}`, progress, thenText].filter(Boolean).join(" · "), start, end, months, total, made, then, progress };
}

// ── Skipping exactly one card charge ─────────────────────────────────────────
//
// THE MECHANISM (chosen in lib/membershipMoneyServer.skipNextInvoice, explained
// there): a one-time 100%-off coupon on the subscription. It zeroes the NEXT
// invoice and then falls off by itself. This function only decides WHICH
// invoice that is and whether it is safe to try.

export type SkipPlan =
  | { ok: true; at: Date; coversStart: Date; coversEnd: Date; resumesAt: Date }
  | { ok: false; code: "NOT_STRIPE" | "PAUSED" | "PAST_DUE" | "NO_NEXT" | "TOO_SOON" | "ENDS_BEFORE" | "ALREADY_SKIPPED" | "FREE"; error: string };

export function skipPlan(
  row: MoneyRow,
  opts: { nextInvoiceAt: Date | null; alreadySkippedAt: Date | null; now: Date },
): SkipPlan {
  if (!row.hasStripe) return { ok: false, code: "NOT_STRIPE", error: "This membership isn't billed by Stripe — there is no card charge to skip." };
  if (row.price <= 0) return { ok: false, code: "FREE", error: "This membership is free — there is no charge to skip." };
  if (row.pausedAt) return { ok: false, code: "PAUSED", error: "Billing is paused — nothing will be charged until you resume it." };
  if (row.status === "past_due" || row.stripeStatus === "past_due" || row.stripeStatus === "unpaid") {
    return { ok: false, code: "PAST_DUE", error: "The last card payment failed and Stripe is retrying it. Skipping the next one won't stop that retry — settle the failed payment first." };
  }
  const at = opts.nextInvoiceAt;
  if (!at) return { ok: false, code: "NO_NEXT", error: "Stripe hasn't told us the next charge date. Sync from Stripe, then try again." };
  if (opts.alreadySkippedAt && Math.abs(opts.alreadySkippedAt.getTime() - at.getTime()) < DAY) {
    return { ok: false, code: "ALREADY_SKIPPED", error: `The ${fmtShort(at)} charge is already set to be skipped.` };
  }
  // Stripe drafts the renewal invoice AT the period end and finalizes it about
  // an hour later; a discount added after the draft exists does not reach it.
  if (at.getTime() <= opts.now.getTime() + 60 * 60_000) {
    return { ok: false, code: "TOO_SOON", error: at.getTime() <= opts.now.getTime() ? `The ${fmtShort(at)} charge has already happened — refund it from the payment list instead.` : `The ${fmtShort(at)} charge is less than an hour away and may already be in progress. Refund it after it goes through instead.` };
  }
  const ends = stripeEndsAt(row);
  if (ends && ends.getTime() <= at.getTime() + 60_000) {
    return { ok: false, code: "ENDS_BEFORE", error: `This membership ends ${fmtDate(ends)} — there is no charge on ${fmtShort(at)} to skip.` };
  }
  const coversEnd = periodBoundary(at, row.billingPeriod, 1);
  return { ok: true, at, coversStart: at, coversEnd, resumesAt: coversEnd };
}

// ── "They paid another way" / "Record a payment" ─────────────────────────────

export type PaidAnotherWayPlan =
  | { ok: true; mode: "SKIP_CARD_CHARGE" | "OFFLINE"; coversStart: Date; coversEnd: Date; paidThroughAfter: Date; skipAt: Date | null; sentence: string; consequence: string }
  | { ok: false; code: string; error: string };

export function paidAnotherWayPlan(
  row: MoneyRow,
  opts: { method: "CASH" | "CHECK"; amount: number; pmLabel: string | null; nextInvoiceAt: Date | null; alreadySkippedAt: Date | null; now: Date },
): PaidAnotherWayPlan {
  if (!(opts.amount > 0)) return { ok: false, code: "AMOUNT", error: "Enter the amount they handed over." };
  const m = opts.method === "CHECK" ? "check" : "cash";
  if (row.hasStripe) {
    const s = skipPlan(row, { nextInvoiceAt: opts.nextInvoiceAt, alreadySkippedAt: opts.alreadySkippedAt, now: opts.now });
    if (!s.ok) return s;
    return {
      ok: true, mode: "SKIP_CARD_CHARGE", coversStart: s.coversStart, coversEnd: s.coversEnd, paidThroughAfter: s.coversEnd, skipAt: s.at,
      sentence: `Records ${money(opts.amount)} ${m} for ${fmtShort(s.coversStart)} – ${fmtDate(s.coversEnd)}, and skips the ${fmtShort(s.at)} charge on ${opts.pmLabel ?? "their saved payment method"} so they are not charged twice.`,
      consequence: `the ${fmtShort(s.at)} invoice is $0 (a one-time 100% discount) — nothing is charged. Card billing picks up again on ${fmtDate(s.resumesAt)}. Plan, price, commitment and billing date don't change.`,
    };
  }
  const c = resolveCoverage({ paidThroughDate: row.paidThroughDate, currentPeriodEnd: row.currentPeriodEnd, startDate: row.startDate, billingPeriod: row.billingPeriod, periods: 1, now: opts.now });
  return {
    ok: true, mode: "OFFLINE", coversStart: c.start, coversEnd: c.end, paidThroughAfter: c.end, skipAt: null,
    sentence: `Records ${money(opts.amount)} ${m} for ${fmtShort(c.start)} – ${fmtDate(c.end)}. Paid through moves ${row.paidThroughDate ? `from ${fmtShort(row.paidThroughDate)} ` : ""}to ${fmtDate(c.end)}.`,
    consequence: "nothing — billed offline. The payment shows in Financials and Reports as cash received.",
  };
}

// ── Waive a payment ──────────────────────────────────────────────────────────

export type WaivePlan =
  | { ok: true; mode: "SKIP_CARD_CHARGE" | "OFFLINE"; waivedStart: Date; waivedEnd: Date; paidThroughAfter: Date; skipAt: Date | null; label: string; sentence: string; consequence: string }
  | { ok: false; code: string; error: string };

export function waivePlan(
  row: MoneyRow,
  opts: { reason: string; pmLabel: string | null; nextInvoiceAt: Date | null; alreadySkippedAt: Date | null; now: Date },
): WaivePlan {
  if (!opts.reason.trim()) return { ok: false, code: "REASON", error: "Say why — it shows in the history and in Reports." };
  if (row.price <= 0) return { ok: false, code: "FREE", error: "This membership is already free." };
  if (row.hasStripe) {
    const s = skipPlan(row, { nextInvoiceAt: opts.nextInvoiceAt, alreadySkippedAt: opts.alreadySkippedAt, now: opts.now });
    if (!s.ok) return s;
    return {
      ok: true, mode: "SKIP_CARD_CHARGE", waivedStart: s.coversStart, waivedEnd: s.coversEnd, paidThroughAfter: s.coversEnd, skipAt: s.at,
      label: `Waived ${fmtShort(s.at)} payment`,
      sentence: `The ${fmtShort(s.at)} payment (${fmtShort(s.coversStart)} – ${fmtDate(s.coversEnd)}) is waived. Nothing is charged and nothing is recorded as paid.`,
      consequence: `the ${fmtShort(s.at)} invoice is $0 (a one-time 100% discount). Card billing picks up again on ${fmtDate(s.resumesAt)} on ${opts.pmLabel ?? "the saved payment method"}.`,
    };
  }
  const c = resolveCoverage({ paidThroughDate: row.paidThroughDate, currentPeriodEnd: row.currentPeriodEnd, startDate: row.startDate, billingPeriod: row.billingPeriod, periods: 1, now: opts.now });
  return {
    ok: true, mode: "OFFLINE", waivedStart: c.start, waivedEnd: c.end, paidThroughAfter: c.end, skipAt: null,
    label: `Waived ${fmtShort(c.start)} payment`,
    sentence: `The ${fmtShort(c.start)} – ${fmtDate(c.end)} ${periodNoun(row.billingPeriod)} is free. Paid through moves ${row.paidThroughDate ? `from ${fmtShort(row.paidThroughDate)} ` : ""}to ${fmtDate(c.end)}; nothing to collect for it.`,
    consequence: "nothing — billed offline. Reports show it as a $0 comp, not as income.",
  };
}

// ── Refund ───────────────────────────────────────────────────────────────────

/** What is left to refund on a payment: paid minus already refunded, never negative. */
export function refundable(tx: { amount: number; refundedAmount: number | null; status: string }): number {
  if (tx.status !== "SUCCEEDED") return 0;
  return Math.max(0, round2(tx.amount - (tx.refundedAmount ?? 0)));
}

export function checkRefund(requested: number, left: number): { ok: true; amount: number; full: boolean } | { ok: false; error: string } {
  if (!Number.isFinite(requested) || requested <= 0) return { ok: false, error: "Enter an amount above $0." };
  if (Math.abs(requested * 100 - Math.round(requested * 100)) > 1e-6) return { ok: false, error: "Use dollars and cents — no more than two decimals." };
  if (left <= 0) return { ok: false, error: "This payment has already been refunded in full." };
  if (requested > left + 0.005) return { ok: false, error: `You can refund at most ${money2(left)} — that's what's left after earlier refunds.` };
  return { ok: true, amount: round2(requested), full: Math.abs(requested - left) < 0.005 };
}

// ── Switch how they pay ──────────────────────────────────────────────────────

export type SwitchPlan =
  | { ok: true; direction: "to_cash" | "to_card"; effectiveAt: Date; chargesToday: boolean; endsAt?: Date | null; sentence: string; consequence: string }
  | { ok: false; code: string; error: string };

/**
 * Card → cash for good: Stripe stops at the end of the PAID period
 * (cancel_at_period_end, lib/autopay.turnAutopayOff) and the same row carries
 * on offline from that day — plan, price and commitment unchanged.
 */
export function switchToCashPlan(row: MoneyRow, opts: { pmLabel: string | null; now: Date }): SwitchPlan {
  if (!row.hasStripe) return { ok: false, code: "ALREADY_OFFLINE", error: "They already pay by cash or check." };
  if (row.status === "past_due" || row.stripeStatus === "past_due" || row.stripeStatus === "unpaid") {
    return { ok: false, code: "PAST_DUE", error: "The last card payment failed. Settle it (or record it as paid another way) before switching to cash." };
  }
  const at = row.currentPeriodEnd;
  if (!at || at.getTime() <= opts.now.getTime()) return { ok: false, code: "NO_PERIOD_END", error: "Stripe hasn't told us when the paid period ends. Sync from Stripe first." };
  const ends = stripeEndsAt(row);
  if (ends && ends.getTime() <= at.getTime() + DAY) return { ok: false, code: "ENDS", error: `This membership already ends ${fmtDate(ends)} — there's nothing to carry on in cash.` };
  return {
    ok: true, direction: "to_cash", effectiveAt: at, chargesToday: false,
    sentence: `${opts.pmLabel ?? "The saved payment method"} is not charged again — the period to ${fmtDate(at)} is already paid. From ${fmtDate(at)} you collect ${money(row.price)} ${periodWord(row.billingPeriod)} in cash or check. Same plan, price${row.minimumTermEndsAt ? " and commitment" : ""}.`,
    consequence: `the subscription is set to stop at the period end (${fmtShort(at)}) — no more automatic charges. The membership itself continues.`,
  };
}

/**
 * Cash → card: a Stripe subscription whose FIRST charge is the day the cash
 * runs out (lib/autopay.turnAutopayOn → trial_end = paid-through). If nothing
 * is paid ahead, the first charge is today, and the owner must say so.
 */
export function switchToCardPlan(row: MoneyRow, opts: { pmLabel: string | null; chargeAmount: number; now: Date }): SwitchPlan {
  if (row.hasStripe) return { ok: false, code: "ALREADY_CARD", error: "They already pay by card through Stripe." };
  if (row.price <= 0) return { ok: false, code: "FREE", error: "This membership is free — there's nothing to charge." };
  const anchor = row.paidThroughDate ?? row.currentPeriodEnd;
  const future = !!anchor && anchor.getTime() > opts.now.getTime() + 60_000;
  const at = future ? anchor! : opts.now;
  // A cash row that already has a stop date keeps it: the card subscription
  // gets the same date as cancel_at, so going automatic never extends a
  // membership the owner set to end.
  const endsAt = row.endDate && row.endDate.getTime() > at.getTime() + 60_000 ? row.endDate : null;
  if (row.endDate && !endsAt) return { ok: false, code: "ENDS", error: `This membership ends ${fmtDate(row.endDate)} — there's no payment left to automate.` };
  const who = opts.pmLabel ?? "the saved payment method";
  const then = `then ${periodWord(row.billingPeriod)} automatically${endsAt ? ` until it ends ${fmtDate(endsAt)}` : ""}`;
  return {
    ok: true, direction: "to_card", effectiveAt: at, chargesToday: !future, endsAt,
    sentence: future
      ? `${who} is charged ${money2(opts.chargeAmount)} on ${fmtDate(at)} — the day the cash runs out — ${then}.`
      : `Nothing is paid ahead, so ${who} is charged ${money2(opts.chargeAmount)} today, ${then}.`,
    consequence: (future ? `a subscription starts with its first charge on ${fmtShort(at)}. Nothing is charged today.` : `a subscription starts and charges ${money2(opts.chargeAmount)} now.`) + (endsAt ? ` It stops on ${fmtShort(endsAt)}.` : ""),
  };
}

// ── Auto-renew ───────────────────────────────────────────────────────────────

/** Is it renewing, as the family would understand it: no stop date on the way. */
export function renewsNow(row: MoneyRow): boolean {
  if (row.hasStripe) return !stripeEndsAt(row);
  return row.autoRenew && !row.endDate;
}

export type AutoRenewPlan =
  | { ok: true; on: boolean; endsAt: Date | null; mode: "TERM_END" | "PERIOD_END" | "RENEWS"; sentence: string }
  | { ok: false; code: string; error: string };

/**
 * The switch's consequence, spelled out. Mirrors lib/autopay.planNonRenewal
 * (Stripe rows) and lib/autopay.offlineStopDate (cash rows) — the rules
 * setAutoRenew runs: with a commitment still ahead, OFF bills out the
 * commitment and stops at its end; with none, it stops at the end of the paid
 * period. A cash family on a 3-month commitment isn't cut off after one month.
 * (Mirrored, not imported: lib/autopay pulls in prisma and Stripe.)
 */
export function autoRenewPlan(row: MoneyRow, on: boolean, now: Date): AutoRenewPlan {
  const period = periodWord(row.billingPeriod);
  if (on) {
    const was = row.hasStripe ? stripeEndsAt(row) : row.endDate;
    return { ok: true, on, endsAt: null, mode: "RENEWS", sentence: `On: keeps renewing ${period} until someone cancels.${was ? ` The ${fmtDate(was)} end date is removed.` : ""}` };
  }
  // Same term rule as lib/autopay.planNonRenewal: the row's own commitment,
  // else (legacy rows) the end date the commitment was copied onto.
  const term = row.minimumTermEndsAt ?? row.endDate ?? null;
  const tail = row.hasStripe ? "no more charges after that." : "nothing more to collect after that.";
  if (term && term.getTime() > now.getTime()) {
    // Offline (lib/autopay.offlineStopDate): never cut short time already paid for.
    const at = !row.hasStripe && row.paidThroughDate && row.paidThroughDate.getTime() > term.getTime() ? row.paidThroughDate : term;
    return { ok: true, on, endsAt: at, mode: "TERM_END", sentence: `Off: ends ${fmtDate(at)} after the commitment — ${tail}` };
  }
  const pe = row.hasStripe ? row.currentPeriodEnd ?? row.paidThroughDate : row.endDate ?? row.paidThroughDate ?? row.currentPeriodEnd;
  if (!pe) return { ok: false, code: "NO_PERIOD_END", error: "There's no paid-through date on record, so there's no date to stop on. Set the dates first." };
  return { ok: true, on, endsAt: pe, mode: "PERIOD_END", sentence: `Off: ends ${fmtDate(pe)} at the end of the paid period — ${tail}` };
}

// ── Next payment ─────────────────────────────────────────────────────────────

export type NextPayment = { at: Date | null; amount: number | null; text: string; overdue: boolean };

export function nextPayment(row: MoneyRow, opts: { chargeAmount: number; skippedAt: Date | null; now: Date }): NextPayment {
  if (row.price <= 0) return { at: null, amount: null, text: "None — free", overdue: false };
  if (row.pausedAt) return { at: null, amount: null, text: row.pausedUntil ? `None while paused — resumes ${fmtDate(row.pausedUntil)}` : "None while paused", overdue: false };
  if (row.hasStripe) {
    let at = row.currentPeriodEnd;
    const ends = stripeEndsAt(row);
    let skippedNote = "";
    if (at && opts.skippedAt && Math.abs(opts.skippedAt.getTime() - at.getTime()) < DAY) {
      skippedNote = ` (${fmtShort(at)} skipped)`;
      at = periodBoundary(at, row.billingPeriod, 1);
    }
    if (!at) return { at: null, amount: null, text: "Not known — sync from Stripe", overdue: false };
    if (ends && ends.getTime() <= at.getTime() + 60_000) return { at: null, amount: null, text: `None — ends ${fmtDate(ends)}${skippedNote}`, overdue: false };
    return { at, amount: opts.chargeAmount, text: `${money2(opts.chargeAmount)} on ${fmtDate(at)}, automatically${skippedNote}`, overdue: false };
  }
  const due = row.paidThroughDate ?? row.currentPeriodEnd;
  if (row.endDate && (!due || row.endDate.getTime() <= due.getTime() + 60_000)) return { at: null, amount: null, text: `None — ends ${fmtDate(row.endDate)}`, overdue: false };
  if (!due) return { at: null, amount: row.price, text: `${money(row.price)} — no paid-through date on record`, overdue: false };
  const overdue = due.getTime() < opts.now.getTime();
  return { at: due, amount: row.price, text: `${money(row.price)} ${overdue ? "was due" : "due"} ${fmtDate(due)} — you collect it`, overdue };
}

// ── History lines ────────────────────────────────────────────────────────────

export type MoneyEvent = { kind: string; at: Date; detail: Record<string, unknown> | null; actorName: string | null };

const d = (v: unknown) => (typeof v === "string" && v ? new Date(v) : null);

/** "Waived Oct 27 payment — Volunteer help — by Julian Ramirez". Null for events that aren't about money. */
export function moneyEventSentence(e: MoneyEvent): string | null {
  const x = e.detail ?? {};
  const by = e.actorName ? ` — by ${e.actorName}` : "";
  const reason = typeof x.reason === "string" && x.reason ? ` — ${x.reason}` : "";
  const amt = typeof x.amount === "number" ? money(x.amount) : null;
  switch (e.kind) {
    case "PAYMENT_WAIVED": {
      const at = d(x.waivedStart);
      return `Waived ${at ? `${fmtShort(at)} ` : ""}payment${reason}${by}`;
    }
    case "PAYMENT_RECORDED": {
      const s = d(x.coversStart), en = d(x.coversEnd), skip = d(x.skippedChargeAt);
      const method = typeof x.method === "string" ? x.method.toLowerCase() : "cash";
      return `${amt ?? "Payment"} ${method} for ${s ? fmtShort(s) : "?"} – ${en ? fmtShort(en) : "?"}${skip ? ` · ${fmtShort(skip)} card charge skipped` : ""}${by}`;
    }
    case "PAYMENT_REFUNDED":
      return `Refunded ${amt ?? ""}${x.full ? " (full)" : " (partial)"}${typeof x.via === "string" ? ` · ${x.via}` : ""}${reason}${by}`;
    case "RENEWAL_CHANGED": {
      const ends = d(x.stopsOn);
      return x.autoRenew ? `Auto-renew turned on${by}` : `Auto-renew turned off — ends ${ends ? fmtDate(ends) : "at the period end"}${by}`;
    }
    case "PLAN_CHANGED": {
      if (x.autopay === "off") { const at = d(x.endsAt); return `Switched to cash from ${at ? fmtDate(at) : "the period end"}${by}`; }
      if (x.autopay === "on") { const at = d(x.firstChargeAt); return `Switched to automatic payments — first charge ${at ? fmtDate(at) : "at the next cycle"}${by}`; }
      return null;
    }
    default:
      return null;
  }
}
