/**
 * B16 — lib/membershipMoney. Pure; no database, no Stripe.
 *   npx tsx scripts/membership-money-tests.ts
 * Rows shaped like the incident that started it: Blake's dad paid one month in
 * cash, and Stripe still charged the family's Cash App on the 27th.
 */
import {
  ordinal, countPeriods, periodBoundary, commitmentView, howTheyPay, paymentMethodLabel, skipPlan, paidAnotherWayPlan,
  waivePlan, refundable, checkRefund, switchToCashPlan, switchToCardPlan, autoRenewPlan, renewsNow, nextPayment, moneyEventSentence,
  type MoneyRow,
} from "../lib/membershipMoney";

let pass = 0, fail = 0;
function check(name: string, cond: boolean | undefined | null, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const d = (s: string) => new Date(s + "T00:00:00.000Z");
const NOW = d("2026-09-28");
const day = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);

function row(over: Partial<MoneyRow>): MoneyRow {
  return {
    hasStripe: true, status: "active", stripeStatus: "active", price: 175, billingPeriod: "MONTHLY",
    startDate: d("2026-08-27"), endDate: null, currentPeriodEnd: d("2026-10-27"), paidThroughDate: d("2026-09-27"),
    minimumTermEndsAt: null, autoRenew: true, cancelAt: null, pausedAt: null, pausedUntil: null, deliberateFree: false, ...over,
  };
}
const blake = row({});
const cashApp = { type: "cashapp" };

console.log("Words:");
check("ordinals", ordinal(1) === "1st" && ordinal(2) === "2nd" && ordinal(3) === "3rd" && ordinal(11) === "11th" && ordinal(22) === "22nd" && ordinal(27) === "27th");
check("month boundaries don't drift (Jan 31 → Feb 28 → Mar 31)", day(periodBoundary(d("2026-01-31"), "MONTHLY", 1)) === "2026-02-28" && day(periodBoundary(d("2026-01-31"), "MONTHLY", 2)) === "2026-03-31");
check("3-month commitment billed monthly = 3 payments", countPeriods(d("2026-08-20"), d("2026-11-20"), "MONTHLY") === 3);
check("a year billed quarterly = 4 payments", countPeriods(d("2026-08-20"), d("2027-08-20"), "QUARTERLY") === 4);
check("weekly for 4 weeks = 4", countPeriods(d("2026-09-01"), d("2026-09-29"), "WEEKLY") === 4);

console.log("How they pay:");
check("Cash App through Stripe, on the 27th", howTheyPay(blake, { pmLabel: paymentMethodLabel(cashApp) }) === "Cash App Pay (via Stripe) · charged automatically on the 27th", howTheyPay(blake, { pmLabel: paymentMethodLabel(cashApp) }));
check("card label", paymentMethodLabel({ type: "card", brand: "visa", last4: "4242" }) === "Visa •••• 4242");
check("wallet card", paymentMethodLabel({ type: "card", brand: "mastercard", last4: "0005", wallet: "apple_pay" }) === "Apple Pay (Mastercard •••• 0005)");
check("bank account", paymentMethodLabel({ type: "us_bank_account", last4: "6789" }) === "Bank account •••• 6789");
check("an explicit label (another worker's field) wins", paymentMethodLabel({ type: "card", label: "Visa ending 4242 (Dad)" }) === "Visa ending 4242 (Dad)");
check("unknown method → nothing, not a guess", paymentMethodLabel(null) === null && paymentMethodLabel({ type: null }) === null);
check("cash row: you collect it", howTheyPay(row({ hasStripe: false }), { pmLabel: null, offlineMethod: "CASH" }) === "Cash — you collect it");
check("quarterly Stripe names the next date", howTheyPay(row({ billingPeriod: "QUARTERLY" }), { pmLabel: "Visa •••• 4242" }) === "Visa •••• 4242 (via Stripe) · charged automatically every 3 months, next on Oct 27");
check("free row", howTheyPay(row({ price: 0, deliberateFree: true }), { pmLabel: null }) === "Free — nothing to collect");

console.log("Commitment, spelled out:");
const three = row({ startDate: d("2026-08-20"), minimumTermEndsAt: d("2026-11-20"), currentPeriodEnd: d("2026-10-20") });
const c1 = commitmentView(three, { optionContractMonths: 3, paymentsInTerm: 2, now: NOW });
check("dates, progress, and what happens after", c1.text === "3-month commitment: Aug 20 – Nov 20, 2026 · 2 of 3 payments made · then renews monthly", c1.text);
const c1b = commitmentView(three, { optionContractMonths: 3, paymentsInTerm: null, now: NOW });
check("no ledger count → periods started (Aug 20, Sep 20)", c1b.state === "ACTIVE" && c1b.made === 2 && c1b.total === 3, c1b);
const c2 = commitmentView({ ...three, cancelAt: d("2026-11-20") }, { optionContractMonths: 3, paymentsInTerm: 2, now: NOW });
check("cancel_at at the term end → 'then it ends'", c2.text.endsWith("then it ends"), c2.text);
const c2b = commitmentView({ ...three, hasStripe: false, autoRenew: false }, { optionContractMonths: 3, paymentsInTerm: 9, now: NOW });
check("payments never exceed the total", c2b.state === "ACTIVE" && c2b.made === 3 && c2b.text.includes("3 of 3 payments made") && c2b.text.endsWith("then it ends"), c2b);
const c3 = commitmentView({ ...three, minimumTermEndsAt: null }, { optionContractMonths: 3, paymentsInTerm: null, now: NOW });
check("option has a term, row doesn't → 'Commitment not recorded' with the fix date", c3.state === "MISSING" && c3.text.startsWith("Commitment not recorded") && c3.state === "MISSING" && day(c3.suggestedEnd) === "2026-11-20", c3);
check("no term anywhere → plain words", commitmentView({ ...three, minimumTermEndsAt: null }, { optionContractMonths: null, paymentsInTerm: null, now: NOW }).text === "No commitment — monthly, cancel any time");
const c4 = commitmentView({ ...three, minimumTermEndsAt: d("2026-09-01"), startDate: d("2026-06-01") }, { optionContractMonths: 3, paymentsInTerm: 3, now: NOW });
check("served term → finished, month-to-month now", c4.state === "DONE" && c4.text === "3-month commitment finished Sep 1, 2026 · now monthly", c4.text);
const c5 = commitmentView(row({ startDate: d("2025-11-20"), minimumTermEndsAt: d("2026-11-20") }), { optionContractMonths: 12, paymentsInTerm: 10, now: NOW });
check("span across years shows both years", c5.text.startsWith("12-month commitment: Nov 20, 2025 – Nov 20, 2026 · 10 of 12 payments made"), c5.text);

console.log("Skip exactly one card charge:");
const s1 = skipPlan(blake, { nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW });
check("Blake: the Oct 27 charge, covering Oct 27 – Nov 27", s1.ok && day(s1.at) === "2026-10-27" && day(s1.coversEnd) === "2026-11-27" && day(s1.resumesAt) === "2026-11-27", s1);
check("offline row has no card charge", !skipPlan(row({ hasStripe: false }), { nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW }).ok);
const sPd = skipPlan(row({ status: "past_due", stripeStatus: "past_due" }), { nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW });
check("past due → refused (the retry would still charge)", !sPd.ok && sPd.code === "PAST_DUE", sPd);
const sPa = skipPlan(row({ pausedAt: d("2026-09-20") }), { nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW });
check("paused → refused", !sPa.ok && sPa.code === "PAUSED");
const sEnd = skipPlan(row({ cancelAt: d("2026-10-27") }), { nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW });
check("ends on the charge date → there is no charge to skip", !sEnd.ok && sEnd.code === "ENDS_BEFORE", sEnd);
const sSoon = skipPlan(blake, { nextInvoiceAt: new Date(NOW.getTime() + 30 * 60_000), alreadySkippedAt: null, now: NOW });
check("under an hour away → refused (invoice may be drafted)", !sSoon.ok && sSoon.code === "TOO_SOON");
const sPast = skipPlan(blake, { nextInvoiceAt: d("2026-09-27"), alreadySkippedAt: null, now: NOW });
check("already charged → points at Refund", !sPast.ok && sPast.code === "TOO_SOON" && sPast.error.includes("refund"), sPast);
const sTwice = skipPlan(blake, { nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: new Date(d("2026-10-27").getTime() + 3600_000), now: NOW });
check("already skipped → refused, never two coupons", !sTwice.ok && sTwice.code === "ALREADY_SKIPPED");
check("unknown next date → sync first", (() => { const r = skipPlan(blake, { nextInvoiceAt: null, alreadySkippedAt: null, now: NOW }); return !r.ok && r.code === "NO_NEXT"; })());

console.log("They paid another way this time:");
const p1 = paidAnotherWayPlan(blake, { method: "CASH", amount: 175, pmLabel: "Cash App Pay", nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW });
check("Stripe row: records cash AND skips the matching charge", p1.ok && p1.mode === "SKIP_CARD_CHARGE" && day(p1.skipAt) === "2026-10-27" && day(p1.coversStart) === "2026-10-27" && day(p1.paidThroughAfter) === "2026-11-27", p1);
check("…in words", p1.ok && p1.sentence === "Records $175 cash for Oct 27 – Nov 27, 2026, and skips the Oct 27 charge on Cash App Pay so they are not charged twice.", p1.ok ? p1.sentence : p1);
check("…and says the plan/anchor don't move", p1.ok && p1.consequence.includes("Card billing picks up again on Nov 27, 2026") && p1.consequence.includes("don't change"));
const p2 = paidAnotherWayPlan(row({ hasStripe: false, paidThroughDate: d("2026-10-20"), currentPeriodEnd: d("2026-10-20") }), { method: "CHECK", amount: 175, pmLabel: null, nextInvoiceAt: null, alreadySkippedAt: null, now: NOW });
check("cash row: next period from paid-through", p2.ok && p2.mode === "OFFLINE" && day(p2.coversStart) === "2026-10-20" && day(p2.coversEnd) === "2026-11-20" && p2.sentence.startsWith("Records $175 check for Oct 20 – Nov 20, 2026"), p2);
const p3 = paidAnotherWayPlan(row({ hasStripe: false, paidThroughDate: d("2026-09-01"), currentPeriodEnd: d("2026-09-01") }), { method: "CASH", amount: 175, pmLabel: null, nextInvoiceAt: null, alreadySkippedAt: null, now: NOW });
check("lapsed cash row: never sells time already gone — starts today", p3.ok && day(p3.coversStart) === "2026-09-28" && day(p3.coversEnd) === "2026-10-28", p3);
check("amount required", !paidAnotherWayPlan(blake, { method: "CASH", amount: 0, pmLabel: null, nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW }).ok);
check("past due Stripe row refuses rather than double-charging", !paidAnotherWayPlan(row({ stripeStatus: "past_due" }), { method: "CASH", amount: 175, pmLabel: null, nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW }).ok);

console.log("Waive a payment:");
check("reason required", (() => { const r = waivePlan(blake, { reason: "  ", pmLabel: null, nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW }); return !r.ok && r.code === "REASON"; })());
const w1 = waivePlan(blake, { reason: "Volunteer help", pmLabel: "Cash App Pay", nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW });
check("Stripe: skip the Oct 27 charge, label for history", w1.ok && w1.mode === "SKIP_CARD_CHARGE" && w1.label === "Waived Oct 27 payment" && day(w1.paidThroughAfter) === "2026-11-27" && w1.sentence.includes("nothing is recorded as paid"), w1);
const w2 = waivePlan(row({ hasStripe: false, paidThroughDate: d("2026-10-27") }), { reason: "Volunteer help", pmLabel: null, nextInvoiceAt: null, alreadySkippedAt: null, now: NOW });
check("cash: paid-through moves one period", w2.ok && w2.mode === "OFFLINE" && day(w2.paidThroughAfter) === "2026-11-27" && w2.sentence.includes("Paid through moves from Oct 27 to Nov 27, 2026"), w2);
check("free row can't be waived", !waivePlan(row({ price: 0 }), { reason: "x", pmLabel: null, nextInvoiceAt: d("2026-10-27"), alreadySkippedAt: null, now: NOW }).ok);

console.log("Refund:");
check("left = paid − refunded", refundable({ amount: 175, refundedAmount: 50, status: "SUCCEEDED" }) === 125);
check("fully refunded row → 0", refundable({ amount: 175, refundedAmount: 175, status: "REFUNDED" }) === 0);
check("failed payment → 0", refundable({ amount: 175, refundedAmount: null, status: "FAILED" }) === 0);
check("can't refund more than is left", (() => { const r = checkRefund(130, 125); return !r.ok && r.error.includes("$125.00"); })());
check("exact remainder = full", (() => { const r = checkRefund(125, 125); return r.ok && r.full; })());
check("partial", (() => { const r = checkRefund(40, 125); return r.ok && !r.full && r.amount === 40; })());
check("sub-cent refused", !checkRefund(10.005, 125).ok);
check("zero refused", !checkRefund(0, 125).ok);
check("nothing left refused", !checkRefund(10, 0).ok);

console.log("Switch how they pay:");
const sc = switchToCashPlan(blake, { pmLabel: "Cash App Pay", now: NOW });
check("card → cash: effective at the end of the paid period", sc.ok && day(sc.effectiveAt) === "2026-10-27" && !sc.chargesToday && sc.sentence.startsWith("Cash App Pay is not charged again") && sc.sentence.includes("From Oct 27, 2026 you collect $175 monthly"), sc);
check("card → cash refuses a past-due row", !switchToCashPlan(row({ stripeStatus: "past_due" }), { pmLabel: null, now: NOW }).ok);
check("card → cash refuses a row that already ends then", !switchToCashPlan(row({ cancelAt: d("2026-10-27") }), { pmLabel: null, now: NOW }).ok);
check("already cash", !switchToCashPlan(row({ hasStripe: false }), { pmLabel: null, now: NOW }).ok);
const sk = switchToCardPlan(row({ hasStripe: false, paidThroughDate: d("2026-10-20") }), { pmLabel: "Visa •••• 4242", chargeAmount: 180.08, now: NOW });
check("cash → card: first charge the day the cash runs out, nothing today", sk.ok && day(sk.effectiveAt) === "2026-10-20" && !sk.chargesToday && sk.sentence.startsWith("Visa •••• 4242 is charged $180.08 on Oct 20, 2026"), sk);
const sk2 = switchToCardPlan(row({ hasStripe: false, paidThroughDate: d("2026-09-01") }), { pmLabel: null, chargeAmount: 175, now: NOW });
const sk3 = switchToCardPlan(row({ hasStripe: false, paidThroughDate: d("2026-10-20"), endDate: d("2026-11-20"), autoRenew: false }), { pmLabel: "Visa •••• 4242", chargeAmount: 175, now: NOW });
check("cash → card keeps the row's end date (never extends it)", sk3.ok && day(sk3.endsAt) === "2026-11-20" && sk3.sentence.endsWith("until it ends Nov 20, 2026."), sk3);
check("cash → card on a row that ends before the next payment → refused", !switchToCardPlan(row({ hasStripe: false, paidThroughDate: d("2026-10-20"), endDate: d("2026-10-20") }), { pmLabel: null, chargeAmount: 175, now: NOW }).ok);
check("cash → card with nothing paid ahead: charges today, flagged", sk2.ok && sk2.chargesToday && sk2.sentence.includes("charged $175.00 today"), sk2);

console.log("Auto-renew:");
const a1 = autoRenewPlan(three, false, NOW);
check("off inside a commitment: ends at the term, spelled out", a1.ok && a1.mode === "TERM_END" && a1.sentence === "Off: ends Nov 20, 2026 after the commitment — no more charges after that.", a1);
const a2 = autoRenewPlan(blake, false, NOW);
check("off with no term: end of the paid period", a2.ok && a2.mode === "PERIOD_END" && day(a2.endsAt) === "2026-10-27", a2);
const a3 = autoRenewPlan(row({ hasStripe: false, minimumTermEndsAt: d("2026-11-20"), paidThroughDate: d("2026-12-01") }), false, NOW);
check("cash: never cut short time already paid past the term", a3.ok && day(a3.endsAt) === "2026-12-01" && a3.sentence.includes("nothing more to collect"), a3);
const a4 = autoRenewPlan(row({ hasStripe: false, paidThroughDate: null, currentPeriodEnd: null }), false, NOW);
check("cash with no dates → refused, no invented stop date", !a4.ok && a4.code === "NO_PERIOD_END");
const a5 = autoRenewPlan(row({ cancelAt: d("2026-11-20") }), true, NOW);
check("on: names the end date it removes", a5.ok && a5.sentence === "On: keeps renewing monthly until someone cancels. The Nov 20, 2026 end date is removed.", a5);
check("renews: Stripe reads cancel_at, cash reads the end date", renewsNow(blake) && !renewsNow(row({ cancelAt: d("2026-11-20") })) && !renewsNow(row({ hasStripe: false, endDate: d("2026-11-20") })) && renewsNow(row({ hasStripe: false })));

console.log("Next payment:");
const n1 = nextPayment(blake, { chargeAmount: 180.08, skippedAt: null, now: NOW });
check("Stripe: amount + date", n1.text === "$180.08 on Oct 27, 2026, automatically" && day(n1.at) === "2026-10-27", n1);
const n2 = nextPayment(blake, { chargeAmount: 180.08, skippedAt: d("2026-10-27"), now: NOW });
check("a skipped charge moves 'next' one period and says so", day(n2.at) === "2026-11-27" && n2.text.endsWith("(Oct 27 skipped)"), n2);
const n3 = nextPayment(row({ cancelAt: d("2026-10-27") }), { chargeAmount: 175, skippedAt: null, now: NOW });
check("ending → none", n3.at === null && n3.text === "None — ends Oct 27, 2026", n3);
const n4 = nextPayment(row({ hasStripe: false, paidThroughDate: d("2026-09-20") }), { chargeAmount: 175, skippedAt: null, now: NOW });
check("cash overdue", n4.overdue && n4.text === "$175 was due Sep 20, 2026 — you collect it", n4);
check("paused", nextPayment(row({ pausedAt: d("2026-09-01"), pausedUntil: d("2026-10-15") }), { chargeAmount: 175, skippedAt: null, now: NOW }).text === "None while paused — resumes Oct 15, 2026");

console.log("History lines:");
check("waived", moneyEventSentence({ kind: "PAYMENT_WAIVED", at: NOW, detail: { waivedStart: "2026-10-27T00:00:00.000Z", reason: "Volunteer help" }, actorName: "Julian Ramirez" }) === "Waived Oct 27 payment — Volunteer help — by Julian Ramirez");
check("paid another way", moneyEventSentence({ kind: "PAYMENT_RECORDED", at: NOW, detail: { amount: 175, method: "CASH", coversStart: "2026-10-27T00:00:00.000Z", coversEnd: "2026-11-27T00:00:00.000Z", skippedChargeAt: "2026-10-27T00:00:00.000Z" }, actorName: "Sal" }) === "$175 cash for Oct 27 – Nov 27 · Oct 27 card charge skipped — by Sal");
check("refund", moneyEventSentence({ kind: "PAYMENT_REFUNDED", at: NOW, detail: { amount: 50, full: false, via: "Stripe", reason: "Missed week" }, actorName: null }) === "Refunded $50 (partial) · Stripe — Missed week");
check("auto-renew off", moneyEventSentence({ kind: "RENEWAL_CHANGED", at: NOW, detail: { autoRenew: false, stopsOn: "2026-11-20T00:00:00.000Z" }, actorName: "Sal" }) === "Auto-renew turned off — ends Nov 20, 2026 — by Sal");
check("switch to cash (turnAutopayOff's event)", moneyEventSentence({ kind: "PLAN_CHANGED", at: NOW, detail: { autopay: "off", endsAt: "2026-10-27T00:00:00.000Z" }, actorName: null }) === "Switched to cash from Oct 27, 2026");
check("a real plan change isn't a money line", moneyEventSentence({ kind: "PLAN_CHANGED", at: NOW, detail: { route: "x" }, actorName: null }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
