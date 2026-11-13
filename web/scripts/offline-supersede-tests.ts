/**
 * A card checkout closes the cash/check request it replaces (2026-11, B28).
 *
 *   npx tsx scripts/offline-supersede-tests.ts
 *
 * Before: a family asked to pay cash, then paid by card instead — the cash
 * request (and its amount due) stayed open, and the front desk could collect
 * cash for a membership the card already covered.
 */
import { harness, src, DAY } from "./_followup-harness";
import { approvalSupersededByCard, supersedePlan, txBelongsToRow, isPendingOfflineMembershipTx, type OfflineRowFacts, type PendingTxFacts } from "../lib/offlineSupersede";

const { check, section, done } = harness();
const now = Date.now();
const row = (o: Partial<OfflineRowFacts> = {}): OfflineRowFacts => ({ id: "row1", membershipId: "planA", status: "pending", billingType: "MANUAL", stripeSubscriptionId: null, price: 110, paidThroughDate: null, createdAt: new Date(now - 3 * DAY), ...o });
const tx = (o: Partial<PendingTxFacts> = {}): PendingTxFacts => ({ id: "tx1", amount: 110, status: "PENDING", manual: true, category: "memberships", paymentSource: "CASH", paymentMethod: "CASH", createdAt: new Date(now - 3 * DAY + 5000), ...o });

section("waiting cash/check requests");
check("cash request for the same plan is closed", approvalSupersededByCard({ membershipId: "planA", paymentMethod: "CASH" }, "planA"));
check("check request for the same plan is closed", approvalSupersededByCard({ membershipId: "planA", paymentMethod: "check" }, "planA"));
check("a request for ANOTHER plan is left alone", !approvalSupersededByCard({ membershipId: "planB", paymentMethod: "CASH" }, "planA"));
check("a card request is left alone", !approvalSupersededByCard({ membershipId: "planA", paymentMethod: "CARD" }, "planA"));
check("an empty payload is left alone", !approvalSupersededByCard(null, "planA") && !approvalSupersededByCard({}, "planA"));

section("which amount-due rows belong to the same membership and period");
check("same price, raised with the row → belongs", txBelongsToRow(tx(), row()));
check("approval-style row (type INVOICE, paymentMethod only) → belongs", txBelongsToRow(tx({ paymentSource: null, paymentMethod: "CHECK" }), row()));
check("an OLDER debt from an earlier month → not this period", !txBelongsToRow(tx({ createdAt: new Date(now - 40 * DAY) }), row()));
check("a different amount → not this membership", !txBelongsToRow(tx({ amount: 60 }), row()));
check("already paid → never touched", !isPendingOfflineMembershipTx(tx({ status: "SUCCEEDED" })));
check("an event's cash due → never touched", !isPendingOfflineMembershipTx(tx({ category: "events" })));
check("a Stripe row → never touched", !isPendingOfflineMembershipTx(tx({ manual: false, paymentSource: "STRIPE", paymentMethod: "STRIPE" })));

section("which offline memberships the card payment replaces");
{
  const base = { membershipId: "planA", paidSubscriptionId: "paid" };
  const p1 = supersedePlan({ ...base, rows: [row()], pendingTxs: [tx()] });
  check("a row still waiting for its first cash is closed with its amount due", p1.cancelRowIds.join() === "row1" && p1.voidTxIds.join() === "tx1", p1);
  const p2 = supersedePlan({ ...base, rows: [row({ status: "active" })], pendingTxs: [tx()] });
  check("an activated-on-acceptance row with the money still owed is closed", p2.cancelRowIds.length === 1 && p2.voidTxIds.length === 1, p2);
  const p3 = supersedePlan({ ...base, rows: [row({ status: "active" })], pendingTxs: [] });
  check("an active cash row with NOTHING owed is left alone", p3.cancelRowIds.length === 0 && p3.voidTxIds.length === 0, p3);
  const p4 = supersedePlan({ ...base, rows: [row({ status: "active", paidThroughDate: new Date(now + 10 * DAY) })], pendingTxs: [tx()] });
  check("a cash row somebody PAID for is never closed", p4.cancelRowIds.length === 0 && p4.voidTxIds.length === 0, p4);
  const p5 = supersedePlan({ ...base, rows: [row({ membershipId: "planB" })], pendingTxs: [tx()] });
  check("another plan's row is left alone", p5.cancelRowIds.length === 0 && p5.voidTxIds.length === 0);
  const p6 = supersedePlan({ ...base, rows: [row({ id: "paid" })], pendingTxs: [tx()] });
  check("the row the card just paid for is never closed", p6.cancelRowIds.length === 0);
  const p7 = supersedePlan({ ...base, rows: [row({ stripeSubscriptionId: "sub_x", billingType: "RECURRING" })], pendingTxs: [tx()] });
  check("a card-billed row is never closed", p7.cancelRowIds.length === 0);
  const p8 = supersedePlan({ ...base, rows: [row()], pendingTxs: [tx(), tx({ id: "old", createdAt: new Date(now - 60 * DAY) })] });
  check("an older unpaid month stays owed", p8.voidTxIds.join() === "tx1", p8);
}

section("source guarantees");
{
  const hook = src("app/api/stripe/webhook/route.ts");
  check("the webhook closes them when a membership checkout completes", hook.includes("closeOfflineRequestsPaidByCard({"));
  const server = src("lib/offlineSupersedeServer.ts");
  check("requests are closed only while still PENDING", /updateMany\(\{ where: \{ id: \{ in: approvalIds \}, status: "PENDING" \}/.test(server));
  check("nothing is deleted", !/\.delete(Many)?\(/.test(server));
  check("amounts due are VOIDed, never counted as revenue", server.includes('reconciliationStatus: "VOID"'));
  check("an audit row is written", server.includes("OFFLINE_REQUEST_CLOSED_BY_CARD"));
  check("it can never break the webhook", /catch \(e\) \{\s*console\.error\("\[offlineSupersede\]/.test(server));
}
done();
