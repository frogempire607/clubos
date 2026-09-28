// The portal's auto-renew consequence, in plain dates (2026-09-28).
//
// Julian: "If a parent wants to toggle auto renew they should be able to … do
// it through their profile if they want ANY membership to auto renew." The
// toggle is only safe if the family reads exactly what it does before they
// press it, so every sentence here is built from the subscription's own dates:
//
//   Auto-renew off: your membership ends Nov 20, 2026, after your 3-month
//   commitment. You won't be charged after that.
//   On: renews every month on the 27th for $164.64.
//
// The stop date is the SAME one the write path uses — planNonRenewal for a
// Stripe row (cancel_at at the commitment end, else the period end) and
// offlineStopDate for a cash/check row — so the sentence cannot promise a date
// the change will not produce. During a commitment, off never ends early.
//
// No Prisma here (lib/nonRenewal is pure). Verified by
// scripts/billing-retire-tests.ts.

import { planNonRenewal, offlineStopDate } from "./nonRenewal";

export type AutoRenewBilling = "CARD" | "OFFLINE";

export type AutoRenewInput = {
  billing: AutoRenewBilling;
  autoRenew: boolean;
  status: string;
  startDate: Date | null;
  minimumTermEndsAt: Date | null;
  endDate: Date | null;
  currentPeriodEnd: Date | null;
  paidThroughDate: Date | null;
  /** What each renewal actually costs the family (fee passthrough included). */
  amount: number;
  /** WEEKLY | BIWEEKLY | MONTHLY | QUARTERLY | SEMI_ANNUAL | ANNUAL | … */
  billingPeriod: string | null;
  /** Option/plan contract length when known; otherwise derived from dates. */
  commitmentMonths?: number | null;
};

export type AutoRenewCopy = {
  /** The commitment end while one is still running, else null. */
  commitmentEndsOn: Date | null;
  commitmentMonths: number | null;
  /** When the membership would stop if auto-renew is (or goes) off. */
  stopsOn: Date | null;
  /** The next date money is due (card charge or cash due). */
  nextChargeOn: Date | null;
  /** Sentence for turning it OFF (or for its current state if already off). */
  offSentence: string;
  /** Sentence for turning it ON (or for its current state if already on). */
  onSentence: string;
  /** The sentence that describes what is true right now. */
  currentSentence: string;
  /** Can the family flip it right now, and if not, why. */
  canToggle: boolean;
  blockedReason: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Nov 20, 2026" — billing dates are date-only 00:00 UTC values. */
export function dayLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
/** "Oct 27" */
export function shortDayLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}
export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "every month on the 27th", "every week on Tuesdays", "every year on Oct 27". */
export function cadencePhrase(period: string | null, anchor: Date | null): string {
  const p = (period ?? "MONTHLY").toUpperCase();
  const dom = anchor ? ` on the ${ordinal(anchor.getUTCDate())}` : "";
  switch (p) {
    case "WEEKLY": return `every week${anchor ? ` on ${WEEKDAYS[anchor.getUTCDay()]}s` : ""}`;
    case "BIWEEKLY": return `every 2 weeks${anchor ? ` on ${WEEKDAYS[anchor.getUTCDay()]}s` : ""}`;
    case "MONTHLY": return `every month${dom}`;
    case "QUARTERLY": return `every 3 months${dom}`;
    case "SEMI_ANNUAL": return `every 6 months${dom}`;
    case "ANNUAL": return `every year${anchor ? ` on ${shortDayLabel(anchor)}` : ""}`;
    default: return "each period";
  }
}

/** Whole months between two dates, rounded (a 3-month term is 3, not 2.97). */
export function monthsBetween(a: Date, b: Date): number {
  const whole = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  const dayDiff = b.getUTCDate() - a.getUTCDate();
  return Math.max(0, whole + (dayDiff > 15 ? 1 : dayDiff < -15 ? -1 : 0));
}

const LIVE = new Set(["active", "past_due", "pending"]);

export function autoRenewCopy(s: AutoRenewInput, now: Date): AutoRenewCopy {
  const dates = {
    minimumTermEndsAt: s.minimumTermEndsAt,
    endDate: s.endDate,
    currentPeriodEnd: s.currentPeriodEnd,
    paidThroughDate: s.paidThroughDate,
  };
  // Once auto-renew is off, `endDate` holds the STOP date the write path
  // chose, not a commitment — so only a row that still renews may read its
  // endDate as the commitment (legacy rows keep their term there).
  const termSource = s.autoRenew ? dates : { ...dates, endDate: null };
  const plan = planNonRenewal(termSource, now);
  const commitmentEndsOn = plan.mode === "TERM_END" ? plan.at : null;

  // Already off: the row's recorded end date IS the answer. Otherwise, the
  // date the write path would produce.
  const plannedStop = s.billing === "CARD" ? plan.at : offlineStopDate(termSource, now);
  const stopsOn = !s.autoRenew ? s.endDate ?? plannedStop : plannedStop;

  const nextChargeOn = s.billing === "CARD"
    ? s.currentPeriodEnd ?? null
    : s.paidThroughDate ?? s.currentPeriodEnd ?? null;

  const months = commitmentEndsOn
    ? s.commitmentMonths ?? (s.startDate ? monthsBetween(s.startDate, commitmentEndsOn) || null : null)
    : null;

  const after = commitmentEndsOn
    ? `, after your ${months ? `${months}-month ` : ""}commitment`
    : stopsOn
      ? ", at the end of the period you've paid for"
      : "";
  const endsWhen = stopsOn ? `ends ${dayLabel(stopsOn)}` : "ends at the end of the period you've paid for";
  const offSentence = `Auto-renew off: your membership ${endsWhen}${stopsOn ? after : ""}. You won't be charged after that.`;

  const cadence = cadencePhrase(s.billingPeriod, nextChargeOn);
  const price = s.amount > 0 ? ` for ${money(s.amount)}` : "";
  const how = s.billing === "OFFLINE" ? " (paid to the club — no card is charged)" : "";
  const commitmentTail = commitmentEndsOn
    ? ` Your ${months ? `${months}-month ` : ""}commitment runs through ${dayLabel(commitmentEndsOn)}.`
    : "";
  const onSentence = `On: renews ${cadence}${price}${how}.${commitmentTail}`;

  let blockedReason: string | null = null;
  if (!LIVE.has(s.status)) blockedReason = "This membership has already ended.";
  else if (s.billing === "OFFLINE" && s.autoRenew && !plannedStop)
    blockedReason = "Your club hasn't recorded how far this membership is paid, so there's no date to stop it on yet. Ask the club to record your last payment.";

  return {
    commitmentEndsOn,
    commitmentMonths: months,
    stopsOn,
    nextChargeOn,
    offSentence,
    onSentence,
    currentSentence: s.autoRenew ? onSentence : offSentence,
    canToggle: blockedReason === null,
    blockedReason,
  };
}

/**
 * "How you pay: Cash App Pay · next charge Oct 27 · $164.64". Uses the
 * payment-method `label` (or "last paid with") when the card lookup provides
 * one, falling back to brand ···· last4.
 */
export function howYouPayLine(input: {
  billing: AutoRenewBilling;
  methodLabel: string | null;
  nextChargeOn: Date | null;
  amount: number;
  autoRenew: boolean;
  stopsOn: Date | null;
}): string {
  const method = input.billing === "OFFLINE" ? input.methodLabel ?? "Cash or check at the club" : input.methodLabel ?? "Card on file";
  const parts = [`How you pay: ${method}`];
  const nextIsReal = input.nextChargeOn && (input.autoRenew || !input.stopsOn || input.nextChargeOn.getTime() < input.stopsOn.getTime());
  if (nextIsReal) parts.push(`${input.billing === "OFFLINE" ? "next payment due" : "next charge"} ${shortDayLabel(input.nextChargeOn!)}`);
  if (input.amount > 0 && nextIsReal) parts.push(money(input.amount));
  return parts.join(" · ");
}

/** Brand ···· last4, or the label the payment-method lookup supplies. */
export function paymentMethodLabel(pm: {
  label?: string | null;
  type?: string | null;
  brand?: string | null;
  last4?: string | null;
} | null | undefined): string | null {
  if (!pm) return null;
  if (pm.label) return pm.label;
  if (pm.brand && pm.last4) {
    const brand = pm.brand.split(/[_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
    return `${brand} ···· ${pm.last4}`;
  }
  if (pm.type === "link") return "Link";
  return null;
}
