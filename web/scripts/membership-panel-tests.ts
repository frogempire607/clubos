/**
 * B13 — lib/membershipPanel. Pure; runs with `npm run test:membership-panel`.
 * The panel's five states and the cancel sentences, from rows shaped like
 * production (Orson Chorba's Stripe row, Colton's quarterly, a cash row, a
 * comp, a saved setup, nothing).
 */
import { derivePanel, pickCurrent, cancelPreview, resumeShift, pausePreview, resolveDatesEdit, datesEditable, type PanelSub, type PanelInput } from "../lib/membershipPanel";

let pass = 0, fail = 0;
function check(name: string, cond: boolean | undefined | null, detail?: unknown) {
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
    card: { brand: "visa", last4: "4242" }, createdAt: d("2026-07-22"), pausedAt: null, pausedUntil: null, ...over,
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
check("legacy owner label (no row dates) → PAUSED, Resume primary, honest about billing", v3.state === "PAUSED" && v3.actions.primary === "resume" && v3.moneyLine.includes("card billing continues"));
check("PAUSED with no row is not paused — it's None", derivePanel(input({ memberStatus: "PAUSED" })).state === "NONE");
const v3b = derivePanel(input({ memberStatus: "PAUSED", subs: [sub({ pausedAt: d("2026-09-23"), pausedUntil: d("2027-01-05") })] }));
check("row pause with a date → 'Paused since Sep 23 · resumes Jan 5 · card billing paused'", v3b.moneyLine === "Paused since Sep 23 · resumes Jan 5 · card billing paused" && v3b.pill.label === "Paused · until Jan 5" && v3b.facts?.renews === "Resumes Jan 5", v3b);
const v3c = derivePanel(input({ memberStatus: "PAUSED", subs: [sub({ pausedAt: d("2026-09-23"), hasStripe: false, stripeStatus: null, paidThroughDate: d("2026-11-30") })] }));
check("offline open-ended pause", v3c.moneyLine === "Paused since Sep 23 · until you resume it · paid-through moves out by the paused days", v3c.moneyLine);
check("row pause wins even if the label lags", derivePanel(input({ memberStatus: "ACTIVE", subs: [sub({ pausedAt: d("2026-09-23") })] })).state === "PAUSED");

console.log("resumeShift:");
const rs = resumeShift({ pausedAt: d("2026-09-01"), paidThroughDate: d("2026-11-30"), endDate: d("2026-12-31"), hasStripe: false }, d("2026-09-24"));
check("offline: 23 paused days pushed onto paid-through and end", rs.pausedDays === 23 && rs.paidThroughDate?.toISOString().startsWith("2026-12-23") && rs.endDate?.toISOString().startsWith("2027-01-23"), rs);
const rs2 = resumeShift({ pausedAt: d("2026-09-01"), paidThroughDate: null, endDate: d("2026-12-31"), hasStripe: true }, d("2026-09-24"));
check("Stripe: days counted, dates untouched", rs2.pausedDays === 23 && rs2.endDate?.toISOString().startsWith("2026-12-31"));
check("not paused → no shift", resumeShift({ pausedAt: null, paidThroughDate: d("2026-11-30"), endDate: null, hasStripe: false }, NOW).pausedDays === 0);

console.log("pausePreview:");
const pp = pausePreview({ hasStripe: true, paidThroughDate: null, currentPeriodEnd: d("2026-10-22") }, d("2027-01-05"), NOW);
check("Stripe with a date", pp.days === 103 && pp.consequence === "collection paused — invoices are voided until Jan 5, then billing resumes automatically." && pp.sentence.startsWith("No charges and no class access from Sep 24 to Jan 5 (103 days)."), pp);
check("offline open-ended", pausePreview({ hasStripe: false, paidThroughDate: d("2026-11-30"), currentPeriodEnd: null }, null, NOW).consequence === "nothing. When you resume, paid-through moves out by the paused days.");

console.log("Change dates:");
check("Stripe rows expose only end + commitment", JSON.stringify(datesEditable(true)) === JSON.stringify({ startDate: false, paidThroughDate: false, endDate: true, minimumTermEndsAt: true }));
const base = { startDate: d("2026-07-22"), paidThroughDate: null, endDate: d("2026-12-10"), minimumTermEndsAt: d("2026-12-10"), hasStripe: true };
const e1 = resolveDatesEdit(base, { endDate: d("2027-01-10") });
check("move the end → cancel_at moves", e1.ok && e1.changed.join() === "endDate" && e1.consequence === "cancel date moves to Jan 10; charges continue until then.", e1);
const e2 = resolveDatesEdit(base, { endDate: null });
check("clear the end → renews", e2.ok && e2.consequence === "cancel date removed — renews until cancelled.");
const e3 = resolveDatesEdit(base, { startDate: d("2026-08-01") });
check("Stripe start is refused with the reason", !e3.ok && e3.error.includes("set by Stripe"));
const e4 = resolveDatesEdit(base, { endDate: d("2026-11-01") });
check("commitment capped at the new end", e4.ok && e4.next.minimumTermEndsAt?.toISOString().startsWith("2026-11-01") && e4.changed.includes("minimumTermEndsAt"), e4);
const e5 = resolveDatesEdit({ ...base, hasStripe: false, paidThroughDate: d("2026-11-30") }, { startDate: d("2027-01-01") });
check("start after end refused", !e5.ok);
const e6 = resolveDatesEdit({ ...base, hasStripe: false, paidThroughDate: d("2026-11-30") }, { paidThroughDate: d("2026-12-31") });
check("offline paid-through edit → 'nothing — billed offline'", e6.ok && e6.consequence.startsWith("nothing — billed offline") && e6.changed.join() === "paidThroughDate");
check("no change → 'unchanged' on Stripe", resolveDatesEdit(base, { minimumTermEndsAt: d("2026-12-10") }).ok && (resolveDatesEdit(base, {}) as { consequence: string }).consequence === "nothing — the cancel date is unchanged.");

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
