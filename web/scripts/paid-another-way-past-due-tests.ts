/**
 * "They paid another way" for a PAST-DUE month (2026-11 follow-up, B28).
 *
 *   npx tsx scripts/paid-another-way-past-due-tests.ts
 *
 * Before: a past-due card membership refused the action ("settle the failed
 * payment first"), so cash handed over for the failed month had nowhere to go.
 * Now the cash settles THAT month's unpaid Stripe invoice (marked paid outside
 * Stripe — no charge, retries stop) and the next charge is left alone.
 */
import { harness, src, dayFromNow, DAY } from "./_followup-harness";
import { paidAnotherWayPlan, isPastDue, type MoneyRow } from "../lib/membershipMoney";

const { check, section, done } = harness();
const now = new Date();
const periodStart = dayFromNow(-9);          // the month that failed started 9 days ago
const periodEnd = dayFromNow(21);            // …and runs out in 21 days
const row = (over: Partial<MoneyRow> = {}): MoneyRow => ({
  hasStripe: true, status: "past_due", stripeStatus: "past_due", price: 110, billingPeriod: "MONTHLY",
  startDate: dayFromNow(-200), endDate: null, currentPeriodEnd: periodEnd, paidThroughDate: periodStart,
  minimumTermEndsAt: null, autoRenew: true, cancelAt: null, pausedAt: null, pausedUntil: null, deliberateFree: false, ...over,
});
const inv = { id: "in_test_pastdue", amountDue: 113.19, periodStart, periodEnd };
const opts = { method: "CASH" as const, amount: 110, pmLabel: "Visa •••• 4242", nextInvoiceAt: periodEnd, alreadySkippedAt: null, now };

section("past due → the cash settles the failed month");
{
  const p = paidAnotherWayPlan(row(), { ...opts, pastDueInvoice: inv });
  check("allowed (it used to be refused)", p.ok === true, p);
  if (p.ok) {
    check("mode is SETTLE_PAST_DUE", p.mode === "SETTLE_PAST_DUE");
    check("names the unpaid invoice to mark paid", p.settleInvoiceId === inv.id);
    check("covers the FAILED month, not the upcoming one", p.coversStart.getTime() === periodStart.getTime() && p.coversEnd.getTime() === periodEnd.getTime());
    check("does not skip the next charge", p.skipAt === null);
    check("paid through moves to the end of that month", p.paidThroughAfter.getTime() === periodEnd.getTime());
    check("the sentence says past-due and that the card is not charged", /past-due/.test(p.sentence) && /not charged/.test(p.sentence), p.sentence);
    check("the consequence says nothing is charged and the next charge still runs", /nothing is charged/.test(p.consequence) && /not skipped/.test(p.consequence), p.consequence);
    check("a short cash amount is called out (the whole invoice closes)", /whole payment is closed/.test(p.sentence), p.sentence);
  }
  const full = paidAnotherWayPlan(row(), { ...opts, amount: 113.19, pastDueInvoice: inv });
  check("the full amount carries no shortfall warning", full.ok && !/whole payment is closed/.test(full.sentence));
  const check2 = paidAnotherWayPlan(row(), { ...opts, method: "CHECK", pastDueInvoice: inv });
  check("check works the same way", check2.ok && check2.mode === "SETTLE_PAST_DUE" && /check/.test(check2.sentence));
  const unpaid = paidAnotherWayPlan(row({ status: "active", stripeStatus: "unpaid" }), { ...opts, pastDueInvoice: inv });
  check("Stripe status 'unpaid' counts as past due", unpaid.ok && unpaid.mode === "SETTLE_PAST_DUE");
}

section("past due, but refusing rather than guessing");
{
  const none = paidAnotherWayPlan(row(), { ...opts, pastDueInvoice: null });
  check("no unpaid invoice found → refused, told to sync", !none.ok && none.code === "PAST_DUE" && /Sync from Stripe/.test(none.error), none);
  const noPeriod = paidAnotherWayPlan(row({ currentPeriodEnd: null }), { ...opts, pastDueInvoice: { ...inv, periodStart: null, periodEnd: null } });
  check("no period known anywhere → refused", !noPeriod.ok && noPeriod.code === "NO_PERIOD", noPeriod);
  const fallback = paidAnotherWayPlan(row(), { ...opts, pastDueInvoice: { ...inv, periodStart: null, periodEnd: null } });
  check("invoice without a line period falls back to the row's period end", fallback.ok && fallback.coversEnd.getTime() === periodEnd.getTime());
  check("…and the start is one billing period earlier", fallback.ok && fallback.coversStart.getTime() < fallback.coversEnd.getTime() && fallback.coversEnd.getTime() - fallback.coversStart.getTime() <= 32 * DAY);
  const zero = paidAnotherWayPlan(row(), { ...opts, amount: 0, pastDueInvoice: inv });
  check("no amount → refused", !zero.ok && zero.code === "AMOUNT");
}

section("everything else behaves as before");
{
  const upcoming = paidAnotherWayPlan(row({ status: "active", stripeStatus: "active" }), { ...opts, pastDueInvoice: null });
  check("a healthy card membership still skips the NEXT charge", upcoming.ok && upcoming.mode === "SKIP_CARD_CHARGE" && upcoming.skipAt?.getTime() === periodEnd.getTime() && upcoming.settleInvoiceId === null, upcoming);
  const cash = paidAnotherWayPlan(row({ hasStripe: false, status: "active", stripeStatus: null }), { ...opts, pastDueInvoice: null });
  check("a cash membership is still a plain offline payment", cash.ok && cash.mode === "OFFLINE" && cash.settleInvoiceId === null);
  check("isPastDue reads both the row and Stripe", isPastDue({ status: "past_due", stripeStatus: null }) && isPastDue({ status: "active", stripeStatus: "unpaid" }) && !isPastDue({ status: "active", stripeStatus: "active" }));
}

section("source guarantees");
{
  const server = src("lib/membershipMoneyServer.ts");
  check("the invoice is marked paid OUTSIDE Stripe (no charge)", /invoices\.pay\(plan\.settleInvoiceId, \{ paid_out_of_band: true \}/.test(server));
  check("…with an idempotency key per invoice", server.includes("idempotencyKey: `aox-oob-${plan.settleInvoiceId}`"));
  check("the cash row is written BEFORE Stripe is told", server.indexOf("txId = tx.id;") < server.indexOf("paid_out_of_band: true") && server.indexOf("txId = tx.id;") > 0);
  check("a Stripe refusal takes the cash row back out", /prisma\.transaction\.delete\(\{ where: \{ id: txId \} \}\)/.test(server));
  check("a stale sheet is refused (invoice id must match the preview)", /plan\.settleInvoiceId !== \(input\.expectedInvoiceId \?\? null\)/.test(server));
  check("an audit row names the settled invoice", server.includes("PAID_ANOTHER_WAY_PAST_DUE_SETTLED"));
  const hook = src("app/api/stripe/webhook/route.ts");
  const paidCase = hook.slice(hook.indexOf('case "invoice.paid"'));
  check("invoice.paid checks for an out-of-band payment before writing money", paidCase.indexOf("settledOutsideStripe(invoice)") > 0 && paidCase.indexOf("settledOutsideStripe(invoice)") < paidCase.indexOf("prisma.transaction.create"));
  const oob = src("lib/invoiceOutOfBand.ts");
  check("two signals: Stripe's flag, and our own cash row's note", oob.includes("paid_out_of_band") && oob.includes("SETTLED_INVOICE_MARK"));
  const sheet = src("components/members/MembershipMoney.tsx");
  check("the sheet sends back the invoice it previewed", sheet.includes("expectedInvoiceId: settleInvoiceId"));
  check("the route accepts it", src("app/api/members/[id]/membership/paid-another-way/route.ts").includes("expectedInvoiceId"));
}
done();
