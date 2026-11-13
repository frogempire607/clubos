// A membership card checkout creates its MemberSubscription row BEFORE the
// family reaches Stripe, as `pending`. If they close the tab, nothing ever
// finishes the row — it sat `pending` forever, showing as a membership "in
// progress" on the profile and in Approvals.
//
// PURE — the decision only. lib/staleCheckoutsServer.ts does the reads/writes.
//
// The rule is deliberately narrow, because the cost of a wrong close is a
// family who PAID and lost their membership:
//   · only a row that is still `pending`, has a checkout session id, and has
//     no Stripe subscription — an offline row waiting for cash has no session
//     id and is never looked at;
//   · only after 24 hours (Stripe expires a Checkout session at 24h at most,
//     so an older one can no longer be paid);
//   · only when STRIPE says the session was not completed. "complete" is never
//     closed — it is reported, because it means a payment our webhook missed.
//     If Stripe can't be asked, the row is left alone.

export const STALE_CHECKOUT_MS = 24 * 60 * 60 * 1000;

export type StaleCandidate = { status: string; stripeCheckoutSessionId: string | null; stripeSubscriptionId: string | null; updatedAt: Date };

/** Old enough, and the right kind of row, to be worth asking Stripe about. */
export function isStaleCheckoutCandidate(row: StaleCandidate, now: Date): boolean {
  if (row.status !== "pending") return false;
  if (!row.stripeCheckoutSessionId || row.stripeSubscriptionId) return false;
  return now.getTime() - row.updatedAt.getTime() >= STALE_CHECKOUT_MS;
}

export type SessionFacts = { status: string | null; paymentStatus: string | null; created: Date | null } | null;
export type StaleDecision = "CLOSE" | "COMPLETED_NEEDS_REVIEW" | "LEAVE";

/**
 * What to do with a candidate once Stripe has answered (null = it didn't).
 * Anything that looks paid is never closed.
 */
export function staleCheckoutDecision(session: SessionFacts, now: Date): StaleDecision {
  if (!session) return "LEAVE";
  if (session.status === "complete" || session.paymentStatus === "paid" || session.paymentStatus === "no_payment_required") return "COMPLETED_NEEDS_REVIEW";
  if (session.status === "expired") return "CLOSE";
  // Still "open": only a session Stripe itself can no longer take payment on.
  if (session.status === "open" && session.created && now.getTime() - session.created.getTime() >= STALE_CHECKOUT_MS) return "CLOSE";
  return "LEAVE";
}

export const STALE_CHECKOUT_REASON = "Checkout was started but never finished — closed automatically after 24 hours. Nothing was charged.";
