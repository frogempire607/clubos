// The writes behind lib/offlineSupersede.ts. Called by the Stripe webhook when
// a membership card checkout completes. Never throws: a tidy-up must not stop
// the webhook from recording the payment that triggered it.

import { prisma } from "@/lib/prisma";
import { MEMBERSHIP_PURCHASE_KIND } from "@/lib/approvals";
import { writeBillingAudit } from "@/lib/billingAudit";
import { recordSubscriptionEvent, SUBSCRIPTION_EVENT_KIND, SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";
import { approvalSupersededByCard, supersedePlan, SUPERSEDED_NOTE } from "@/lib/offlineSupersede";

export async function closeOfflineRequestsPaidByCard(input: {
  clubId: string; memberId: string; membershipId: string; paidSubscriptionId: string; checkoutSessionId: string | null;
}): Promise<{ approvals: number; rows: number; transactions: number }> {
  const done = { approvals: 0, rows: 0, transactions: 0 };
  try {
    const now = new Date();
    // 1. Unanswered cash/check requests for this plan.
    const waiting = await prisma.pendingApproval.findMany({
      where: { clubId: input.clubId, memberId: input.memberId, kind: MEMBERSHIP_PURCHASE_KIND, status: "PENDING" },
      select: { id: true, payload: true },
    });
    const approvalIds = waiting.filter((a) => approvalSupersededByCard(a.payload, input.membershipId)).map((a) => a.id);
    if (approvalIds.length) {
      // EXPIRED is the schema's "no longer actionable". Conditional on PENDING
      // so a request staff answered in the same second keeps their answer.
      const r = await prisma.pendingApproval.updateMany({ where: { id: { in: approvalIds }, status: "PENDING" }, data: { status: "EXPIRED", respondedAt: now } });
      done.approvals = r.count;
    }

    // 2 + 3. Offline rows nobody paid for, and what they said was owed.
    const rows = await prisma.memberSubscription.findMany({
      where: { memberId: input.memberId, membershipId: input.membershipId, id: { not: input.paidSubscriptionId }, status: { in: ["pending", "active"] }, billingType: "MANUAL", stripeSubscriptionId: null },
      select: { id: true, membershipId: true, status: true, billingType: true, stripeSubscriptionId: true, price: true, paidThroughDate: true, createdAt: true, optionLabel: true },
    });
    if (rows.length) {
      const txs = await prisma.transaction.findMany({
        where: { clubId: input.clubId, memberId: input.memberId, status: "PENDING", manual: true, category: "memberships" },
        select: { id: true, amount: true, status: true, manual: true, category: true, paymentSource: true, paymentMethod: true, createdAt: true },
      });
      const plan = supersedePlan({
        membershipId: input.membershipId, paidSubscriptionId: input.paidSubscriptionId,
        rows: rows.map((r) => ({ ...r, price: Number(r.price) })),
        pendingTxs: txs.map((t) => ({ ...t, amount: Number(t.amount) })),
      });
      for (const id of plan.cancelRowIds) {
        const row = rows.find((r) => r.id === id)!;
        const r = await prisma.memberSubscription.updateMany({
          where: { id, status: { in: ["pending", "active"] }, stripeSubscriptionId: null, paidThroughDate: null },
          data: { status: "canceled", canceledAt: now, cancelReason: SUPERSEDED_NOTE },
        });
        if (!r.count) continue;
        done.rows += 1;
        await recordSubscriptionEvent({
          clubId: input.clubId, memberSubscriptionId: id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.CANCELED,
          fromPlan: row.optionLabel, fromAmount: String(row.price), source: SUBSCRIPTION_EVENT_SOURCE.STRIPE_WEBHOOK,
          detail: { reason: "superseded-by-card-checkout", paidSubscriptionId: input.paidSubscriptionId, checkoutSessionId: input.checkoutSessionId },
        });
      }
      if (plan.voidTxIds.length) {
        // Same shape the event and bundle branches write when an offline
        // amount due is paid online instead: kept, VOID, never revenue.
        const r = await prisma.transaction.updateMany({
          where: { id: { in: plan.voidTxIds }, status: "PENDING" },
          data: { status: "FAILED", reconciliationStatus: "VOID", notes: "Superseded — membership paid by card instead." },
        });
        done.transactions = r.count;
      }
    }

    if (done.approvals || done.rows || done.transactions) {
      await writeBillingAudit({
        clubId: input.clubId, memberId: input.memberId, actorUserId: null, action: "OFFLINE_REQUEST_CLOSED_BY_CARD",
        before: { pendingApprovals: done.approvals, unpaidOfflineMemberships: done.rows, pendingOfflinePayments: done.transactions },
        after: { paidSubscriptionId: input.paidSubscriptionId, checkoutSessionId: input.checkoutSessionId },
        note: `The family paid for this membership by card. Closed automatically: ${done.approvals} waiting cash/check request(s), ${done.rows} unpaid offline membership(s), ${done.transactions} amount-due record(s). Nothing was deleted.`,
      });
      // No status recompute here: the webhook activates the member right
      // after this returns, once the card membership it just confirmed counts.
    }
  } catch (e) {
    console.error("[offlineSupersede] could not close offline requests after card checkout", input.paidSubscriptionId, e);
  }
  return done;
}
