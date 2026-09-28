// §8.6.6 — where a non-renewing membership actually stops. PURE: no Prisma,
// no Stripe, `now` injected. Extracted from lib/autopay.ts (2026-09-28) so the
// member portal's auto-renew sentences (lib/autoRenewCopy) use the SAME rule as
// the write path; lib/autopay re-exports both functions.

export type NonRenewalPlan =
  /** Bill out the commitment, then stop. Absolute `cancel_at`. */
  | { mode: "TERM_END"; at: Date }
  /** No commitment left to serve — stop at the end of the paid period. */
  | { mode: "PERIOD_END"; at: Date | null };

export type NonRenewalInput = {
  minimumTermEndsAt: Date | null;
  /**
   * Legacy rows written before §8.8.1 carry no `minimumTermEndsAt`, and this is
   * where their commitment date already lives: activation, approve and
   * reactivation all COPY `Member.commitmentEndDate` onto the subscription's
   * `endDate` at purchase. Reading it here instead of the member row is the
   * whole fix — see the note above `planNonRenewal`.
   */
  endDate: Date | null;
  currentPeriodEnd: Date | null;
  paidThroughDate: Date | null;
};

/**
 * Where a non-renewing subscription should actually stop. Pure — `now` is
 * injected so every branch is testable without waiting for a date to pass.
 *
 * ── Why this no longer reads `Member.commitmentEndDate` (2026-09-03) ────────
 *
 * It used to, as a fallback for rows with no `minimumTermEndsAt`, and the date
 * it produced was written to STRIPE as `cancel_at`. That made this the last
 * live path where a member-level field decided a subscription-level fact.
 *
 * A member holds one membership, ends it, buys another — or holds two at once.
 * One date on the member row cannot say which of those it meant. Measured
 * against production on 2026-09-03: 28 of 33 live subscriptions had no term of
 * their own, 17 would have taken their Stripe stop date from the member row,
 * and three of those disagreed with the subscription they would have stopped.
 * One member held TWO live subscriptions behind a single member-level date;
 * turning auto-renew off on the second would have handed Stripe a date five
 * months early.
 *
 * `endDate` is the same value, per subscription. Activation, approve and
 * reactivation all copy `Member.commitmentEndDate` onto it at purchase, so
 * legacy rows keep the behaviour §8.6.6 gave them — a 3-month commitment billed
 * monthly still stops at the term, not after one month — while a second
 * membership now stops on its own date instead of its predecessor's.
 *
 * When `endDate` is null there is no term, and PERIOD_END sends
 * `cancel_at_period_end: true`, which lets STRIPE supply the period boundary.
 * A stale local `currentPeriodEnd` is never the date Stripe acts on.
 */
export function planNonRenewal(sub: NonRenewalInput, now: Date): NonRenewalPlan {
  const term = sub.minimumTermEndsAt ?? sub.endDate ?? null;
  // A term already served is not a boundary — it is history. Falling back to
  // the period end is right: they are month-to-month from here.
  if (term && term.getTime() > now.getTime()) return { mode: "TERM_END", at: term };
  return { mode: "PERIOD_END", at: sub.currentPeriodEnd ?? sub.paidThroughDate ?? null };
}

/**
 * The stop date for an OFFLINE (cash/check) row whose auto-renew goes off.
 * Pure. Inside a commitment: the commitment end, or the paid-through date if
 * the family already paid past it (never cut paid time short). Outside one:
 * the row's own end date, else how far the money reaches.
 */
export function offlineStopDate(sub: NonRenewalInput, now: Date): Date | null {
  const plan = planNonRenewal(sub, now);
  if (plan.mode === "TERM_END") {
    const paid = sub.paidThroughDate;
    return paid && paid.getTime() > plan.at.getTime() ? paid : plan.at;
  }
  return sub.endDate ?? sub.paidThroughDate ?? sub.currentPeriodEnd ?? null;
}

