// Closes membership checkouts that were started and never finished. Run from
// the hourly cron (/api/cron/event-charges). Rules: lib/staleCheckouts.ts.
// Writes a billing-audit row and a subscription event for every row it closes;
// never deletes anything; never touches a row Stripe says was paid.

import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { writeBillingAudit } from "@/lib/billingAudit";
import { recordSubscriptionEvent, SUBSCRIPTION_EVENT_KIND, SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";
import { STALE_CHECKOUT_MS, STALE_CHECKOUT_REASON, isStaleCheckoutCandidate, staleCheckoutDecision, type SessionFacts } from "@/lib/staleCheckouts";

export type StaleCheckoutRun = { checked: number; closed: number; needsReview: number; left: number };

export async function closeStaleCheckouts(opts: { limit?: number; now?: Date } = {}): Promise<StaleCheckoutRun> {
  const now = opts.now ?? new Date();
  const run: StaleCheckoutRun = { checked: 0, closed: 0, needsReview: 0, left: 0 };
  const rows = await prisma.memberSubscription.findMany({
    where: {
      status: "pending", stripeSubscriptionId: null, stripeCheckoutSessionId: { not: null },
      updatedAt: { lt: new Date(now.getTime() - STALE_CHECKOUT_MS) },
      member: { deletedAt: null },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(opts.limit ?? 25, 1), 100),
    select: {
      id: true, status: true, memberId: true, optionLabel: true, price: true, updatedAt: true,
      stripeCheckoutSessionId: true, stripeSubscriptionId: true,
      member: { select: { clubId: true, club: { select: { stripeAccountId: true } } } },
    },
  });
  for (const row of rows) {
    if (!isStaleCheckoutCandidate(row, now)) continue;
    run.checked += 1;
    const acct = row.member.club?.stripeAccountId ?? null;
    let facts: SessionFacts = null;
    if (acct) {
      try {
        const s = await stripe.checkout.sessions.retrieve(row.stripeCheckoutSessionId!, {}, { stripeAccount: acct });
        facts = { status: s.status ?? null, paymentStatus: s.payment_status ?? null, created: s.created ? new Date(s.created * 1000) : null };
      } catch (e) {
        console.error("[staleCheckouts] could not read checkout session — row left alone", row.id, e);
      }
    }
    const decision = staleCheckoutDecision(facts, now);
    if (decision === "COMPLETED_NEEDS_REVIEW") {
      run.needsReview += 1;
      // Loud: Stripe says this checkout was PAID and the row is still pending.
      console.error(`[staleCheckouts] checkout ${row.stripeCheckoutSessionId} is COMPLETE in Stripe but membership row ${row.id} is still pending — not closed. Use Sync from Stripe / check the webhook log.`);
      continue;
    }
    if (decision !== "CLOSE") { run.left += 1; continue; }
    // Conditional claim: a payment that lands this very second wins.
    const claimed = await prisma.memberSubscription.updateMany({
      where: { id: row.id, status: "pending", stripeSubscriptionId: null, stripeCheckoutSessionId: row.stripeCheckoutSessionId },
      data: { status: "canceled", canceledAt: now, cancelReason: STALE_CHECKOUT_REASON },
    });
    if (!claimed.count) { run.left += 1; continue; }
    run.closed += 1;
    await recordSubscriptionEvent({
      clubId: row.member.clubId, memberSubscriptionId: row.id, memberId: row.memberId, kind: SUBSCRIPTION_EVENT_KIND.CANCELED,
      fromPlan: row.optionLabel, fromAmount: String(row.price), source: SUBSCRIPTION_EVENT_SOURCE.SYSTEM,
      detail: { reason: "checkout-never-finished", checkoutSessionId: row.stripeCheckoutSessionId, sessionStatus: facts?.status ?? null, startedAt: row.updatedAt.toISOString() },
    });
    await writeBillingAudit({
      clubId: row.member.clubId, memberId: row.memberId, actorUserId: null, action: "STALE_CHECKOUT_CLOSED",
      before: { subscriptionId: row.id, status: "pending", checkoutSessionId: row.stripeCheckoutSessionId, lastTouched: row.updatedAt.toISOString() },
      after: { status: "canceled", stripeSessionStatus: facts?.status ?? null, stripePaymentStatus: facts?.paymentStatus ?? null },
      note: `"${row.optionLabel}" checkout was started and never finished (Stripe: ${facts?.status ?? "unknown"}, unpaid). Closed automatically after 24 hours — nothing was charged and nothing was deleted.`,
    });
  }
  return run;
}
