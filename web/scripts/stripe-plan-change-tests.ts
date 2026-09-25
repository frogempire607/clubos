/**
 * B12 — lib/stripePlanChange. Pure; runs with `npm run test:stripe-plan-change`.
 * Pins the fee inversion (Stripe unit → club price), the option mirror, and
 * the plan-change date rules. Orson Chorba is the worked example throughout.
 */
import {
  baseFromUnitAmount, stripeIntervalToBillingPeriod, mirrorFromStripePrice, planChangeTerms, unitAmountFor,
  offlinePlanChange, switchLines,
} from "../lib/stripePlanChange";
import { parseOptions } from "../lib/membershipOptions";
import { addUTCMonths, addBillingPeriod } from "../lib/billingAdmin";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

// The real MS/HS options (prod, 2026-09-24).
const MSHS = parseOptions([
  { id: "opt_vavjt5xoqc", label: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY", contractMonths: 1, autoRenewDefault: false },
  { id: "opt_mqk8430i59", label: "Monthly 2 days (Tue/Thu)", price: 110, billingPeriod: "MONTHLY", contractMonths: 1, autoRenewDefault: false },
  { id: "opt_078e5udfsb", label: "3 months Upfront", price: 450, billingPeriod: "QUARTERLY", contractMonths: 3, autoRenewDefault: false },
  { id: "opt_ngs7w3hu1e", label: "1 year Upfront", price: 1500, billingPeriod: "ANNUAL", contractMonths: 12, autoRenewDefault: false },
  { id: "opt_yci81fy0r7", label: "3 Months", price: 160, billingPeriod: "MONTHLY", contractMonths: 3, autoRenewDefault: false },
  { id: "opt_3xh5n1p2ax", label: "12 months", price: 150, billingPeriod: "MONTHLY", contractMonths: 12, autoRenewDefault: false },
]);

console.log("baseFromUnitAmount:");
check("round-trips every whole-dollar price 1..2000 with fees on", (() => {
  for (let d = 1; d <= 2000; d++) {
    const unit = unitAmountFor(d, true);
    const r = baseFromUnitAmount(unit, true);
    if (r.baseCents !== d * 100 || !r.feeFolded) return false;
  }
  return true;
})());
check("round-trips cents prices too (e.g. $12.34)", baseFromUnitAmount(unitAmountFor(12.34, true), true).baseCents === 1234);
check("$175 + fee = 18008 → $175, feeFolded", JSON.stringify(baseFromUnitAmount(18008, true)) === JSON.stringify({ baseCents: 17500, feeFolded: true }));
check("a hand-typed 15000 with fees on is NOT inverted — it is $150, fee not folded", JSON.stringify(baseFromUnitAmount(15000, true)) === JSON.stringify({ baseCents: 15000, feeFolded: false }));
check("fees off: unit is the price", JSON.stringify(baseFromUnitAmount(15000, false)) === JSON.stringify({ baseCents: 15000, feeFolded: false }));
check("$1000 + fee = 102900 (both readings whole) → folded wins", JSON.stringify(baseFromUnitAmount(102900, true)) === JSON.stringify({ baseCents: 100000, feeFolded: true }));
check("$12.34 typed by hand (neither whole) → folded reading, since nothing says otherwise", baseFromUnitAmount(1234, true).feeFolded === true);
check("zero / negative → 0", baseFromUnitAmount(0, true).baseCents === 0 && baseFromUnitAmount(-5, true).baseCents === 0);

console.log("stripeIntervalToBillingPeriod:");
check("month/1 → MONTHLY", stripeIntervalToBillingPeriod("month", 1) === "MONTHLY");
check("month/3 → QUARTERLY", stripeIntervalToBillingPeriod("month", 3) === "QUARTERLY");
check("month/4 → QUADRIMESTRAL", stripeIntervalToBillingPeriod("month", 4) === "QUADRIMESTRAL");
check("month/6 → SEMI_ANNUAL", stripeIntervalToBillingPeriod("month", 6) === "SEMI_ANNUAL");
check("year/1 and month/12 → ANNUAL", stripeIntervalToBillingPeriod("year", 1) === "ANNUAL" && stripeIntervalToBillingPeriod("month", 12) === "ANNUAL");
check("week/1 → WEEKLY; null count = 1", stripeIntervalToBillingPeriod("week", null) === "WEEKLY");
check("day, month/5, unknown → null", stripeIntervalToBillingPeriod("day", 1) === null && stripeIntervalToBillingPeriod("month", 5) === null && stripeIntervalToBillingPeriod(null, null) === null);

console.log("mirrorFromStripePrice (Orson):");
const orson = { optionId: "opt_vavjt5xoqc", optionLabel: "Monthly", price: 175, billingPeriod: "MONTHLY" };
const m1 = mirrorFromStripePrice({ unitCents: 15435, interval: "month", intervalCount: 1, passProcessingFees: true, options: MSHS, current: orson });
check("Stripe $154.35 (=$150+fee) monthly → price 150, option '12 months'", m1.price === 150 && m1.optionId === "opt_3xh5n1p2ax" && m1.optionLabel === "12 months" && m1.resolution === "matched", m1);
check("…changed lists price, option, label", JSON.stringify(m1.changed) === JSON.stringify(["price", "option", "label"]), m1.changed);
const m2 = mirrorFromStripePrice({ unitCents: 15000, interval: "month", intervalCount: 1, passProcessingFees: true, options: MSHS, current: orson });
check("Stripe 15000 flat (fee not folded) → still price 150 + '12 months', feeFolded false", m2.price === 150 && m2.optionId === "opt_3xh5n1p2ax" && m2.feeFolded === false, m2);
const m3 = mirrorFromStripePrice({ unitCents: 18008, interval: "month", intervalCount: 1, passProcessingFees: true, options: MSHS, current: orson });
check("Stripe still $175 → nothing changes, option KEPT (label 'Monthly' not renamed)", m3.changed.length === 0 && m3.resolution === "kept" && m3.optionLabel === "Monthly", m3);
const m4 = mirrorFromStripePrice({ unitCents: unitAmountFor(190, true), interval: "month", intervalCount: 1, passProcessingFees: true, options: MSHS, current: orson });
check("bespoke $190 (no option) → price 190, optionId cleared, label kept, unmatched", m4.price === 190 && m4.optionId === null && m4.optionLabel === "Monthly" && m4.resolution === "unmatched", m4);
const m5 = mirrorFromStripePrice({ unitCents: null, interval: null, intervalCount: null, passProcessingFees: true, options: MSHS, current: orson });
check("no Stripe price → row untouched", m5.changed.length === 0 && m5.price === 175);
const m6 = mirrorFromStripePrice({ unitCents: unitAmountFor(450, true), interval: "month", intervalCount: 3, passProcessingFees: true, options: MSHS, current: orson });
check("interval moved to quarterly $450 → QUARTERLY + '3 months Upfront'", m6.billingPeriod === "QUARTERLY" && m6.optionId === "opt_078e5udfsb" && m6.changed.includes("billing period"), m6);
const twoAt160 = parseOptions([
  { id: "a", label: "A", price: 160, billingPeriod: "MONTHLY" },
  { id: "b", label: "B", price: 160, billingPeriod: "MONTHLY" },
]);
const m7 = mirrorFromStripePrice({ unitCents: unitAmountFor(160, true), interval: "month", intervalCount: 1, passProcessingFees: true, options: twoAt160, current: { optionId: null, optionLabel: "X", price: 100, billingPeriod: "MONTHLY" } });
check("ambiguous price match → unmatched, never a guess", m7.optionId === null && m7.resolution === "unmatched");
const m8 = mirrorFromStripePrice({ unitCents: unitAmountFor(160, true), interval: "month", intervalCount: 1, passProcessingFees: true, options: twoAt160, current: { optionId: "b", optionLabel: "B", price: 160, billingPeriod: "MONTHLY" } });
check("…but the row's own option among the ambiguous ones is kept", m8.optionId === "b" && m8.resolution === "kept");

console.log("planChangeTerms:");
const eff = new Date("2026-10-22T00:00:00.000Z");
const twelve = MSHS.find((o) => o.id === "opt_3xh5n1p2ax")!;
const t1 = planChangeTerms({ effectiveAt: eff, option: twelve, plan: { contractMonths: null, autoRenewDefault: true }, autoRenew: null, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
check("'12 months' from Oct 22: term ends Oct 22 2027, option default auto-renew OFF ⇒ cancel there", t1.minimumTermEndsAt?.toISOString() === "2027-10-22T00:00:00.000Z" && t1.cancelAt?.toISOString() === "2027-10-22T00:00:00.000Z" && t1.autoRenew === false, t1);
const t2 = planChangeTerms({ effectiveAt: eff, option: twelve, plan: {}, autoRenew: true, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
check("owner overrides auto-renew ON ⇒ floor kept, no cancel", t2.minimumTermEndsAt !== null && t2.cancelAt === null && t2.autoRenew === true);
const noTerm = parseOptions([{ id: "nt", label: "Open", price: 100, billingPeriod: "MONTHLY", autoRenewDefault: false }])[0];
const t3 = planChangeTerms({ effectiveAt: eff, option: noTerm, plan: {}, autoRenew: null, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
check("no term + auto-renew OFF ⇒ cancels after ONE period", t3.minimumTermEndsAt === null && t3.cancelAt?.toISOString() === "2026-11-22T00:00:00.000Z", t3);
const t4 = planChangeTerms({ effectiveAt: eff, option: noTerm, plan: { contractMonths: 3 }, autoRenew: null, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
check("term inherited from the plan (3) ⇒ Jan 22", t4.minimumTermEndsAt?.toISOString() === "2027-01-22T00:00:00.000Z" && t4.contractMonths === 3);
const t5 = planChangeTerms({ effectiveAt: new Date("2026-01-31T00:00:00.000Z"), option: twelve, plan: {}, autoRenew: null, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
check("month-end clamps (Jan 31 + 12 = Jan 31; Jan 31 + 1 would be Feb 28)", t5.minimumTermEndsAt?.toISOString() === "2027-01-31T00:00:00.000Z");

console.log("\nB13 slice 3 — offline change plan (from the next payment):");
{
  const opt = (id: string) => MSHS.find((o) => o.id === id)!;
  const now = new Date("2026-09-24T15:00:00.000Z");
  const row = { price: 175, billingPeriod: "MONTHLY", optionLabel: "Monthly Full Membership", paidThroughDate: new Date("2026-10-10T00:00:00.000Z"), currentPeriodEnd: null };
  const r = offlinePlanChange({ row, option: opt("opt_3xh5n1p2ax"), plan: {}, autoRenew: null, now, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  check("effective = paid-through (the next payment)", r.effectiveAt.toISOString() === "2026-10-10T00:00:00.000Z");
  check("not overdue", r.overdue === false);
  check("12-month commitment counted from the next payment", r.minimumTermEndsAt?.toISOString() === "2027-10-10T00:00:00.000Z");
  check("auto-renew off by option ⇒ ends at the term end", r.cancelAt?.toISOString() === "2027-10-10T00:00:00.000Z");
  check("says the price moves", r.lines[0].includes("$150.00 monthly instead of $175.00 monthly"), r.lines[0]);
  check("says paid-through is untouched", r.lines.some((l) => l.includes("Paid through Oct 10, 2026 stays")));
  check("says Stripe hears nothing", r.lines.some((l) => l.startsWith("Stripe: nothing")));

  const keep = offlinePlanChange({ row, option: opt("opt_3xh5n1p2ax"), plan: {}, autoRenew: true, now, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  check("keeps renewing ⇒ no end, commitment still a floor", keep.cancelAt === null && keep.minimumTermEndsAt !== null);

  const overdue = offlinePlanChange({ row: { ...row, paidThroughDate: new Date("2026-09-10T00:00:00.000Z") }, option: opt("opt_mqk8430i59"), plan: {}, autoRenew: null, now, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  check("overdue: the overdue payment takes the new price", overdue.overdue && overdue.lines[0].includes("overdue since Sep 10, 2026"), overdue.lines[0]);
  check("no term, renew off ⇒ ends one period after the next payment", overdue.cancelAt?.toISOString() === "2026-10-10T00:00:00.000Z");

  const neverPaid = offlinePlanChange({ row: { ...row, paidThroughDate: null }, option: opt("opt_078e5udfsb"), plan: {}, autoRenew: null, now, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  check("never paid ⇒ from today, and says so", neverPaid.effectiveAt.getTime() === now.getTime() && neverPaid.lines.some((l) => l.startsWith("No payment is recorded")));
  check("cross-period offline move is just a local change (quarterly)", neverPaid.lines[0].includes("$450.00 quarterly"));

  const same = offlinePlanChange({ row, option: { ...opt("opt_vavjt5xoqc") }, plan: {}, autoRenew: true, now, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  check("same option + price ⇒ 'price stays'", same.sameAmount && same.lines[0].startsWith("The price stays"));
}

console.log("\nB13 slice 3 — cross-cycle switch sentences:");
{
  const quarterly = MSHS.find((o) => o.id === "opt_078e5udfsb")!;
  const eff = new Date("2026-10-23T00:00:00.000Z");
  const terms = planChangeTerms({ effectiveAt: eff, option: quarterly, plan: {}, autoRenew: null, addMonths: addUTCMonths, addPeriod: addBillingPeriod });
  const lines = switchLines({
    currentLabel: "12 months", currentTotal: 154.35, currentPeriod: "MONTHLY", effectiveAt: eff, option: quarterly,
    fee: 13.05, total: 463.05, passProcessingFees: true, terms, cardLabel: "Visa ····4242",
  });
  check("old plan ends on the switch date", lines[0].includes("ends on Oct 23, 2026"), lines[0]);
  check("new plan charged that day on the same card, fee spelled out", lines[1].includes("the saved Visa ····4242 is charged $463.05 ($450.00 + $13.05 processing fee) on Oct 23, 2026"), lines[1]);
  check("nothing today", lines.includes("Nothing is charged or refunded today."));
  check("3-month commitment from the switch date", lines.some((l) => l.includes("3-month commitment from Oct 23, 2026 to Jan 23, 2027")));
  check("ends at the term (auto-renew off by option)", lines.some((l) => l.includes("ends on Jan 23, 2027")));
  check("names both Stripe steps", lines[lines.length - 1].includes("set to end") && lines[lines.length - 1].includes("new one is created"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
