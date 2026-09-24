/**
 * B13 — lib/membershipPanel. Pure; runs with `npm run test:membership-panel`.
 * The panel's five states and the cancel sentences, from rows shaped like
 * production (Orson Chorba's Stripe row, Colton's quarterly, a cash row, a
 * comp, a saved setup, nothing).
 */
import { derivePanel, pickCurrent, cancelPreview, type PanelSub, type PanelInput } from "../lib/membershipPanel";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const d = (s: string) => new Date(s + "T00:00:00.000Z");
const NOW = d("2026-09-24");

function sub(over: Partial<PanelSub>): PanelSub {
  return {
    id: "s1", planName: "MS/HS", optionLabel: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY", billingType: "RECURRING",
    status: "active", stripeStatus: "active", hasStripe: true, startDate: d("2026-07-22"), endDate: null, currentPeriodEnd: d("2026-10-22"),
    paidThroughDate: null, autoRenew: true, minimumTermEndsAt: null, deliberateFree: false, cancelAt: null,
    card: { brand: "visa", last4: "4242" }, createdAt: d("2026-07-22"), ...over,
  };
}
function input(over: Partial<PanelInput>): PanelInput {
  return { firstName: "Orson", memberStatus: "ACTIVE", subs: [], draft: null, hasCard: true, cardLabel: "Visa ····4242", requestedPaymentMethod: null, payerName: "Adam Chorba", passProcessingFees: true, now: NOW, ...over };
}

console.log("Active · Stripe:");
const v1 = derivePanel(input({ subs: [sub({})] }));
check("state + pill", v1.state === "ACTIVE_STRIPE" && v1.pill.label === "Active", v1);
check("headline is plan · option", v1.headline === "MS/HS · Monthly Full Membership");
check("money line has the fee-inclusive charge and the next charge", v1.moneyLine === "$180.08 monthly on the saved card · next charge Oct 22", v1.moneyLine);
check("facts", v1.facts?.paysWith === "Visa ····4242" && v1.facts.renews === "Yes · auto" && v1.facts.payer === "Adam Chorba", v1.facts);
check("actions", v1.actions.primary === "change_plan" && JSON.stringify(v1.actions.others) === JSON.stringify(["change_dates", "pause", "cancel"]) && v1.actions.more.includes("sync_stripe"), v1.actions);
const v1b = derivePanel(input({ subs: [sub({ cancelAt: d("2026-10-22"), autoRenew: false, endDate: d("2026-10-22") })] }));
check("scheduled cancel at the period end → 'ends' pill, Keep membership offered, Cancel not", v1b.pill.label === "Ends Oct 22" && v1b.moneyLine.endsWith("ends Oct 22 — no renewal") && v1b.actions.others.includes("keep") && !v1b.actions.others.includes("cancel"), v1b);
const v1c = derivePanel(input({ subs: [sub({ optionLabel: "3 months Upfront", price: 450, billingPeriod: "QUARTERLY", endDate: d("2026-12-10"), autoRenew: false, cancelAt: d("2026-12-10"), minimumTermEndsAt: d("2026-12-10"), currentPeriodEnd: d("2026-12-23") })] }));
check("Colton: quarterly ending Dec 10, committed through Dec 10", v1c.moneyLine === "$463.05 quarterly on the saved card · ends Dec 10 — no renewal" && !!v1c.committedThrough?.toISOString().startsWith("2026-12-10"), v1c.moneyLine);
const v1d = derivePanel(input({ subs: [sub({ status: "past_due", stripeStatus: "past_due" })] }));
check("past due → own state, retry primary", v1d.state === "PAST_DUE" && v1d.actions.primary === "retry_payment" && v1d.pill.tone === "bad");
check("no fee club → plain price", derivePanel(input({ passProcessingFees: false, subs: [sub({})] })).moneyLine.startsWith("$175.00 monthly"));

console.log("Active · offline:");
const cash = sub({ hasStripe: false, stripeStatus: null, card: null, billingType: "MANUAL", paidThroughDate: d("2026-11-30"), startDate: d("2026-03-01") });
const v2 = derivePanel(input({ subs: [cash], requestedPaymentMethod: "CASH" }));
check("state + money line", v2.state === "ACTIVE_OFFLINE" && v2.moneyLine === "$175 monthly, paid by cash · paid through Nov 30", v2.moneyLine);
check("primary is Record payment", v2.actions.primary === "record_payment" && v2.actions.others.includes("change_plan"));
check("pays with", v2.facts?.paysWith === "Cash / check" && v2.facts.renews === "When paid");
const v2b = derivePanel(input({ subs: [sub({ ...cash, paidThroughDate: d("2026-09-01") })] }));
check("paid-through in the past → 'Payment due' pill, 'was paid through'", v2b.pill.label === "Payment due" && v2b.moneyLine.includes("was paid through Sep 1"), v2b);
const v2c = derivePanel(input({ subs: [sub({ ...cash, price: 0, deliberateFree: true })] }));
check("comp → 'Free — comped on purpose', no Record payment", v2c.moneyLine === "Free — comped on purpose" && v2c.actions.primary !== "record_payment" && !v2c.actions.more.includes("comp"));
const v2d = derivePanel(input({ subs: [sub({ ...cash, price: 0, deliberateFree: false })] }));
check("$0 not marked → says so", v2d.moneyLine.startsWith("$0 — not marked as a comp"));

console.log("Paused:");
const v3 = derivePanel(input({ memberStatus: "PAUSED", subs: [sub({})] }));
check("owner label wins → PAUSED, Resume primary", v3.state === "PAUSED" && v3.actions.primary === "resume" && v3.pill.tone === "warn");
check("…and is honest that card billing isn't paused yet (slice 2)", v3.moneyLine.includes("card billing continues"));
check("PAUSED with no row is not paused — it's None", derivePanel(input({ memberStatus: "PAUSED" })).state === "NONE");

console.log("Pending:");
const v4 = derivePanel(input({ draft: { planName: "MS/HS", optionLabel: "12 months", price: 150, period: "MONTHLY", offerSentAt: null } }));
check("saved setup → PENDING with Activate now", v4.state === "PENDING" && v4.headline === "MS/HS · 12 months" && v4.actions.primary === "activate" && v4.moneyLine.includes("card on file"), v4);
const v4b = derivePanel(input({ hasCard: false, requestedPaymentMethod: "CASH", draft: { planName: "MS/HS", optionLabel: null, price: null, period: null, offerSentAt: d("2026-09-20") } }));
check("cash setup, offer sent", v4b.moneyLine.includes("pays by cash/check") && v4b.moneyLine.includes("offer sent Sep 20") && v4b.facts?.paysWith === "Cash / check");
const v4c = derivePanel(input({ subs: [sub({ status: "pending", stripeStatus: "incomplete" })] }));
check("pending ROW → purchase in progress", v4c.state === "PENDING" && v4c.moneyLine.startsWith("Purchase in progress") && v4c.currentSubId === "s1");

console.log("None:");
const v5 = derivePanel(input({ subs: [sub({ status: "expired", price: 530, endDate: d("2026-09-08"), hasStripe: false, billingType: "MANUAL" })] }));
check("expired row → NONE with the last membership line", v5.state === "NONE" && v5.moneyLine === "Last: MS/HS · Monthly Full Membership · $530 monthly · ended Sep 8" && v5.actions.primary === "assign", v5.moneyLine);
check("never had one", derivePanel(input({})).moneyLine === "Orson has never had a membership here.");

console.log("pickCurrent:");
const future = sub({ id: "comp", price: 0, deliberateFree: true, hasStripe: false, startDate: d("2026-10-22"), createdAt: d("2026-09-24") });
const pc = pickCurrent([future, sub({})], NOW);
check("a future-dated active row is 'upcoming', not current", pc.current?.id === "s1" && pc.upcoming?.id === "comp");
const v6 = derivePanel(input({ subs: [future, sub({ cancelAt: d("2026-10-22"), endDate: d("2026-10-22"), autoRenew: false })] }));
check("…and the panel shows it as what comes next", v6.upcoming?.label === "Free" && v6.state === "ACTIVE_STRIPE");
const twoStarted = pickCurrent([sub({ id: "old", startDate: d("2026-01-01") }), sub({ id: "new", startDate: d("2026-08-01") })], NOW);
check("two started rows → the latest start is current", twoStarted.current?.id === "new");

console.log("cancelPreview:");
const cp = cancelPreview(sub({}), NOW);
check("Stripe, period end in the future → offered, keeps access to Oct 22", cp.atPeriodEndAvailable && cp.keepsAccessUntil("period_end").toISOString().startsWith("2026-10-22"));
check("…consequence at period end", cp.consequence("period_end").text === "cancels at the period end, Oct 22 — no further charges." && cp.consequence("period_end").tone === "info");
check("…consequence now names the unrefunded period", cp.consequence("now").text.includes("not refunded") && cp.consequence("now").tone === "danger");
const cpo = cancelPreview(cash, NOW);
check("offline → 'nothing — billed offline', ends on paid-through", cpo.consequence("period_end").text === "nothing — billed offline. The record ends on Nov 30." && cpo.keepsAccessUntil("period_end").toISOString().startsWith("2026-11-30"));
const cpp = cancelPreview(sub({ currentPeriodEnd: d("2026-09-01") }), NOW);
check("period end already passed → only 'now', access ends today", !cpp.atPeriodEndAvailable && cpp.keepsAccessUntil("period_end").getTime() === NOW.getTime());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
