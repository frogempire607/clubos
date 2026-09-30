/**
 * lib/chargeDate — "When is the card charged?" at Assign, and "Change charge
 * date" after it. Pure; no database, no Stripe.
 *   npx tsx scripts/charge-date-tests.ts
 */
import {
  parseDay, repeatRule, periodBoundary, gap, assignChargeChoices, defaultAssignChargeChoice, assignChargePlan, checkAssignAnchor,
  offerChargeLine, cashNextDueLine, chargeDateMovePlan, chargeDateMoved, displayStripeStatus, moveEventSentence, type MoveRow,
} from "../lib/chargeDate";
import { offerChargePlan } from "../lib/membershipAssignQuote";
import { deriveBillingState } from "../lib/billingAdmin";
import { moneyEventSentence } from "../lib/membershipMoney";

let pass = 0, fail = 0;
function check(name: string, cond: boolean | undefined | null, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const d = (s: string) => new Date(s + "T00:00:00.000Z");
const NOW = new Date("2026-09-30T15:00:00Z");
const key = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);

console.log("Calendar + Stripe's day-of-month rule:");
check("parseDay rejects junk and impossible days", parseDay("10/15/2026") === null && parseDay("2026-02-30") === null && key(parseDay("2026-10-15")) === "2026-10-15");
check("Jan 31 → Feb 28 → Mar 31 → Apr 30 (Stripe's anchor rule, from the anchor each time)",
  key(periodBoundary(d("2027-01-31"), "MONTHLY", 1)) === "2027-02-28" && key(periodBoundary(d("2027-01-31"), "MONTHLY", 2)) === "2027-03-31" && key(periodBoundary(d("2027-01-31"), "MONTHLY", 3)) === "2027-04-30");
check("monthly on the 15th", repeatRule(d("2026-10-15"), "MONTHLY") === "then monthly on the 15th", repeatRule(d("2026-10-15"), "MONTHLY"));
check("31st says what shorter months do", repeatRule(d("2026-10-31"), "MONTHLY") === "then monthly on the 31st (the last day of shorter months)");
check("29th too", repeatRule(d("2026-10-29"), "MONTHLY").endsWith("(the last day of shorter months)"));
check("quarterly names the next one", repeatRule(d("2026-10-15"), "QUARTERLY") === "then every 3 months on the 15th (next Jan 15, 2027)", repeatRule(d("2026-10-15"), "QUARTERLY"));
check("weekly names the weekday", repeatRule(d("2026-10-15"), "WEEKLY") === "then every Thursday");
check("yearly", repeatRule(d("2026-10-15"), "ANNUAL") === "then yearly on Oct 15");
check("Feb 29 yearly", repeatRule(d("2028-02-29"), "ANNUAL") === "then yearly on Feb 29 (Feb 28 in other years)");
const g = gap(d("2026-10-01"), d("2026-10-15"));
check("gap Oct 1 → Oct 15 = 14 days, Oct 1 – Oct 14", g?.days === 14 && g.range === "Oct 1 – Oct 14", g);
check("no gap on the same day", gap(d("2026-10-01"), d("2026-10-01")) === null);

console.log("Assign — which choices, and the default:");
check("start today: Today · Pick a date", JSON.stringify(assignChargeChoices("2026-09-30", NOW)) === '["today","date"]');
check("start in the past: Today · Pick a date", JSON.stringify(assignChargeChoices("2026-09-01", NOW)) === '["today","date"]');
check("start in the future: Today · On the start date · Pick a date", JSON.stringify(assignChargeChoices("2026-10-15", NOW)) === '["today","start","date"]');
check("default = Today when Starts is today/past", defaultAssignChargeChoice("2026-09-30", NOW) === "today" && defaultAssignChargeChoice("2026-09-01", NOW) === "today");
check("default = the start date when Starts is in the future", defaultAssignChargeChoice("2026-10-15", NOW) === "start");

console.log("Assign — the card's first charge:");
{
  const today = assignChargePlan({ choice: "today", startISO: "2026-09-30", amount: 56.25, period: "MONTHLY", now: NOW });
  check("Today: immediate, no anchor sent", today.ok && today.immediate && today.anchorISO === null, today);
  check("Today: words", today.ok && today.line === "Charged $56.25 today · then monthly on the 30th (the last day of shorter months)", today.ok && today.line);
  check("Today: button", today.ok && today.short === "$56.25 today");
  const onStart = assignChargePlan({ choice: "start", startISO: "2026-10-15", amount: 56.25, period: "MONTHLY", now: NOW });
  check("On the start date: anchor = start, not immediate", onStart.ok && !onStart.immediate && onStart.anchorISO === "2026-10-15", onStart);
  check("…the owner's sentence", onStart.ok && onStart.line === "First charge $56.25 on Oct 15, 2026 · then monthly on the 15th", onStart.ok && onStart.line);
  check("…button 'Assign · $56.25 on Oct 15'", onStart.ok && `Assign · ${onStart.short}` === "Assign · $56.25 on Oct 15");
  check("…no free days when it's the start", onStart.ok && onStart.freeLine === null);
  const later = assignChargePlan({ choice: "date", startISO: "2026-10-01", pickedISO: "2026-10-15", amount: 56.25, period: "MONTHLY", now: NOW });
  check("a date after Starts says which days are free", later.ok && later.freeLine === "Oct 1 – Oct 14 (14 days) aren't charged — the first charge is Oct 15.", later.ok && later.freeLine);
  const before = assignChargePlan({ choice: "date", startISO: "2026-10-15", pickedISO: "2026-10-10", amount: 56.25, period: "MONTHLY", now: NOW });
  check("a date before Starts is refused", !before.ok && before.error.includes("can't come before the membership starts (Oct 15, 2026)"), before);
  const past = assignChargePlan({ choice: "date", startISO: "2026-09-01", pickedISO: "2026-09-20", amount: 56.25, period: "MONTHLY", now: NOW });
  check("a past date is refused", !past.ok && past.error.startsWith("That date is in the past"), past);
  const pickToday = assignChargePlan({ choice: "date", startISO: "2026-09-30", pickedISO: "2026-09-30", amount: 56.25, period: "MONTHLY", now: NOW });
  check("picking today = charged now (anchor null → needs the tick)", pickToday.ok && pickToday.immediate && pickToday.anchorISO === null);
  const early = assignChargePlan({ choice: "today", startISO: "2026-10-15", amount: 56.25, period: "MONTHLY", now: NOW });
  check("Today with a future start says it's before the start", early.ok && early.line.startsWith("Charged $56.25 today — before the Oct 15 start"), early.ok && early.line);
  const staleStart = assignChargePlan({ choice: "start", startISO: "2026-09-30", amount: 56.25, period: "MONTHLY", now: NOW });
  check("'On the start date' with a start of today is refused (choose Today)", !staleStart.ok);
  const ends = assignChargePlan({ choice: "date", startISO: "2026-10-01", pickedISO: "2026-11-01", amount: 56.25, period: "MONTHLY", endsAt: d("2026-11-01"), now: NOW });
  check("first charge on/after the option's end is refused", !ends.ok && ends.error.includes("ends Nov 1, 2026"), ends);
  const q = assignChargePlan({ choice: "start", startISO: "2026-10-15", amount: 150, period: "QUARTERLY", now: NOW });
  check("quarterly first charge wording", q.ok && q.line === "First charge $150.00 on Oct 15, 2026 · then every 3 months on the 15th (next Jan 15, 2027)", q.ok && q.line);
}

console.log("Assign — the server's check at commit:");
check("null anchor (charge now) passes", checkAssignAnchor({ anchor: null, start: d("2026-10-15"), now: NOW }).ok);
check("today passes", checkAssignAnchor({ anchor: d("2026-09-30"), start: d("2026-09-30"), now: NOW }).ok);
const chkPast = checkAssignAnchor({ anchor: d("2026-09-29"), start: null, now: NOW });
check("yesterday refused", !chkPast.ok && chkPast.error.includes("is in the past"), chkPast);
const chkBefore = checkAssignAnchor({ anchor: d("2026-10-10"), start: d("2026-10-15"), now: NOW });
check("before start refused", !chkBefore.ok && chkBefore.error.includes("can't come before the membership starts"), chkBefore);
check("on start passes", checkAssignAnchor({ anchor: d("2026-10-15"), start: d("2026-10-15"), now: NOW }).ok);

console.log("Offer + cash wording:");
{
  const o = offerChargePlan({ cardMode: true, date: "2026-10-15", cardCharge: 57.88, billingPeriod: "MONTHLY", now: NOW, startDate: "2026-10-15" });
  check("offer: same words as the card block", o.ok && o.line === "Nothing is charged until they accept — then first charge $57.88 on Oct 15, 2026 · then monthly on the 15th.", o.line);
  const ob = offerChargePlan({ cardMode: true, date: "2026-10-10", cardCharge: 57.88, billingPeriod: "MONTHLY", now: NOW, startDate: "2026-10-15" });
  check("offer: a future date before Starts is refused", !ob.ok && ob.firstChargeDate === null, ob);
  const oi = offerChargePlan({ cardMode: true, date: "2026-09-30", cardCharge: 57.88, billingPeriod: "MONTHLY", now: NOW, startDate: "2026-09-30" });
  check("offer: today = charged as soon as they accept", oi.ok && oi.immediate && oi.line.includes("as soon as they accept"), oi);
  const old = offerChargePlan({ cardMode: true, date: "2026-10-15", cardCharge: 56.25, billingPeriod: "MONTHLY", now: NOW });
  check("offer without startDate keeps its old words (assign-discount-tests pins them)", old.line === "Nothing is charged until they accept — then the card is charged $56.25 on Oct 15, 2026, monthly after.");
  const later = offerChargeLine({ dateISO: "2026-10-20", startISO: "2026-10-15", amount: 50, period: "MONTHLY", now: NOW });
  check("offer: free days after Starts said", later.ok && later.line.endsWith("Oct 15 – Oct 19 (5 days) aren't charged."), later);
  check("cash: next payment due, and what it means for a card later",
    cashNextDueLine({ paidThrough: d("2026-11-01"), amount: 56.25, hasCardOnFile: false }) === "Next payment due Nov 1, 2026 — you collect it. If they switch to automatic payments later, that's the day the card is first charged.");
}

console.log("Change charge date — Stripe, a paying member:");
function stripeRow(over: Partial<MoveRow> = {}): MoveRow {
  return {
    hasStripe: true, status: "active", stripeStatus: "active", chargeAmount: 56.25, billingPeriod: "MONTHLY",
    startDate: d("2026-08-27"), endDate: null, autoRenew: true, cancelAt: null, paused: false,
    nextChargeAt: d("2026-11-27"), paidThroughDate: null, movedPaidThrough: null, onceDiscountAt: null, ...over,
  };
}
{
  const later = chargeDateMovePlan(stripeRow(), { newDateISO: "2026-12-05", pmLabel: "Visa •••• 4242", now: NOW });
  check("later: allowed, 8 free days", later.ok && later.mode === "STRIPE" && later.freeDays === 8, later);
  check("…the sheet says 'Nov 27 → Dec 5: 8 days at no charge'", later.ok && later.sentence === "The next charge moves from Nov 27 to Dec 5, 2026. Nov 27 → Dec 5: 8 days at no charge. Then $56.25 on Dec 5 on Visa •••• 4242 · then monthly on the 5th.", later.ok && later.sentence);
  check("…records the paid-through marker (Nov 27)", later.ok && key(later.paidThroughMarker) === "2026-11-27");
  check("…Stripe line names trial_end, no proration, and the trialing display", later.ok && later.consequence.includes("trial_end, no proration") && later.consequence.includes('"trialing"'));
  const earlier = chargeDateMovePlan(stripeRow(), { newDateISO: "2026-11-20", pmLabel: null, now: NOW });
  check("earlier than paid-through: refused, never a double charge", !earlier.ok && earlier.code === "PAID_THROUGH" && earlier.error === "They've paid through Nov 27, 2026. Pick Nov 27 or later, or use Refund or Waive a payment.", earlier);
  const handPaid = chargeDateMovePlan(stripeRow({ paidThroughDate: d("2026-12-27") }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("a hand-recorded paid-through further out is respected", !handPaid.ok && handPaid.code === "PAID_THROUGH" && handPaid.error.includes("Dec 27"), handPaid);
  const same = chargeDateMovePlan(stripeRow(), { newDateISO: "2026-11-27", pmLabel: null, now: NOW });
  check("same day: refused", !same.ok && same.code === "SAME");
  const pd = chargeDateMovePlan(stripeRow({ stripeStatus: "past_due" }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("past_due: refused — fix the payment first", !pd.ok && pd.code === "PAST_DUE");
  const up = chargeDateMovePlan(stripeRow({ stripeStatus: "unpaid" }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("unpaid: refused", !up.ok && up.code === "PAST_DUE");
  const pz = chargeDateMovePlan(stripeRow({ paused: true }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("paused: refused", !pz.ok && pz.code === "PAUSED");
  const sk = chargeDateMovePlan(stripeRow({ onceDiscountAt: d("2026-11-27") }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("pending skip: refused, and says why", !sk.ok && sk.code === "SKIP_PENDING" && sk.error.includes("use up that skip"), sk);
  const ca = chargeDateMovePlan(stripeRow({ cancelAt: d("2026-12-01") }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("on/after cancel_at: refused", !ca.ok && ca.code === "ENDS_BEFORE" && ca.error.includes("ends Dec 1, 2026"), ca);
  const caOk = chargeDateMovePlan(stripeRow({ cancelAt: d("2027-02-01") }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("before cancel_at: allowed (cancel_at kept — the route never sends it)", caOk.ok);
  const nr = chargeDateMovePlan(stripeRow({ autoRenew: false, endDate: d("2026-12-01") }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("non-renewing row's end date counts as the end", !nr.ok && nr.code === "ENDS_BEFORE");
  const tdy = chargeDateMovePlan(stripeRow(), { newDateISO: "2026-09-30", pmLabel: null, now: NOW });
  check("today/past: refused", !tdy.ok && tdy.code === "PAST");
  const free = chargeDateMovePlan(stripeRow({ chargeAmount: 0 }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("free: refused", !free.ok && free.code === "FREE");
  const nn = chargeDateMovePlan(stripeRow({ nextChargeAt: null }), { newDateISO: "2026-12-05", pmLabel: null, now: NOW });
  check("no next charge known: sync first", !nn.ok && nn.code === "NO_NEXT");
}

console.log("Change charge date — Stripe, already moved (trialing with the marker):");
{
  const moved = stripeRow({ stripeStatus: "trialing", nextChargeAt: new Date("2026-12-05T12:00:00Z"), movedPaidThrough: new Date("2026-11-27T00:00:00Z") });
  const further = chargeDateMovePlan(moved, { newDateISO: "2026-12-12", pmLabel: null, now: NOW });
  check("moving further: 7 more free days, keeps the ORIGINAL paid-through marker", further.ok && further.freeDays === 7 && key(further.paidThroughMarker) === "2026-11-27", further);
  const back = chargeDateMovePlan(moved, { newDateISO: "2026-11-30", pmLabel: null, now: NOW });
  check("moving back toward (not before) what's paid: allowed", back.ok && back.freeDays === -5 && back.sentence.includes("5 days fewer at no charge"), back);
  const tooFar = chargeDateMovePlan(moved, { newDateISO: "2026-11-26", pmLabel: null, now: NOW });
  check("…but never before the paid-through", !tooFar.ok && tooFar.code === "PAID_THROUGH" && tooFar.error.includes("Nov 27"), tooFar);
  const activeAgain = chargeDateMovePlan(stripeRow({ nextChargeAt: d("2027-01-05"), movedPaidThrough: d("2026-11-27") }), { newDateISO: "2027-01-10", pmLabel: null, now: NOW });
  check("an old marker on a sub that's billing normally again is replaced by today's paid-through", activeAgain.ok && key(activeAgain.paidThroughMarker) === "2027-01-05", activeAgain);
}

console.log("Change charge date — Stripe, first charge still to come:");
{
  const sched = stripeRow({ stripeStatus: "trialing", nextChargeAt: d("2026-10-15"), startDate: d("2026-10-01") });
  const earlier = chargeDateMovePlan(sched, { newDateISO: "2026-10-05", pmLabel: null, now: NOW });
  check("nothing paid yet: earlier is fine (no marker written)", earlier.ok && earlier.mode === "STRIPE_FIRST_CHARGE" && earlier.paidThroughMarker === null, earlier);
  check("…and says nothing has been charged", earlier.ok && earlier.sentence.startsWith("Nothing has been charged yet. The first charge moves from Oct 15 to Oct 5, 2026"), earlier.ok && earlier.sentence);
  const beforeStart = chargeDateMovePlan(sched, { newDateISO: "2026-10-01", pmLabel: null, now: NOW });
  check("…the start day itself is allowed", beforeStart.ok);
  const bs = chargeDateMovePlan(stripeRow({ stripeStatus: "trialing", nextChargeAt: d("2026-10-15"), startDate: d("2026-10-10") }), { newDateISO: "2026-10-05", pmLabel: null, now: NOW });
  check("…but not before the membership starts", !bs.ok && bs.code === "BEFORE_START");
}

console.log("Change due date — cash/check:");
{
  const cash: MoveRow = { ...stripeRow(), hasStripe: false, stripeStatus: null, nextChargeAt: null, paidThroughDate: d("2026-11-01") };
  const later = chargeDateMovePlan(cash, { newDateISO: "2026-11-15", pmLabel: null, now: NOW });
  check("later: allowed, 14 days at no charge", later.ok && later.mode === "OFFLINE" && later.freeDays === 14, later);
  check("…words", later.ok && later.sentence === "The next payment is due Nov 15, 2026 instead of Nov 1 — you collect it. Nov 1 → Nov 15: 14 days at no charge.", later.ok && later.sentence);
  check("…and what it means for a card later", later.ok && later.consequence.includes("that's the day the card is first charged"));
  const earlier = chargeDateMovePlan(cash, { newDateISO: "2026-10-20", pmLabel: null, now: NOW });
  check("earlier than paid-through: refused, points at Change dates for typos", !earlier.ok && earlier.code === "PAID_THROUGH" && earlier.error.includes("Change dates"), earlier);
  const noPt = chargeDateMovePlan({ ...cash, paidThroughDate: null }, { newDateISO: "2026-10-20", pmLabel: null, now: NOW });
  check("no paid-through on record: sets one", noPt.ok && noPt.sentence === "The next payment is due Oct 20, 2026 — you collect it.");
  const end = chargeDateMovePlan({ ...cash, endDate: d("2026-11-10") }, { newDateISO: "2026-11-15", pmLabel: null, now: NOW });
  check("after the end date: refused", !end.ok && end.code === "ENDS_BEFORE");
  const pz = chargeDateMovePlan({ ...cash, paused: true }, { newDateISO: "2026-11-15", pmLabel: null, now: NOW });
  check("paused: refused", !pz.ok && pz.code === "PAUSED");
}

console.log("trialing ≠ trialist when the date was moved:");
{
  const snapMoved = { trialEnd: "2026-12-05T12:00:00.000Z", chargeDateMovedFrom: "2026-11-27T00:00:00.000Z" };
  const snapFirst = { trialEnd: "2026-10-15T00:00:00.000Z", chargeDateMovedFrom: null };
  check("marker read from the synced snapshot", chargeDateMoved(snapMoved) && !chargeDateMoved(snapFirst) && !chargeDateMoved(null));
  check("family page shows 'active' for a moved date", displayStripeStatus("trialing", snapMoved) === "active");
  check("…and 'trialing' for a real first charge still to come", displayStripeStatus("trialing", snapFirst) === "trialing");
  check("…other statuses pass through", displayStripeStatus("past_due", snapMoved) === "past_due" && displayStripeStatus(null, snapMoved) === null);
  const base = { configuredPrice: 56.25 };
  const sub = { billingType: "RECURRING", status: "active", stripeStatus: "trialing", price: 56.25, hasStripe: true };
  check("billing centre: moved date = Active Stripe subscription, not 'Scheduled — nothing charged yet'", deriveBillingState({ ...base, sub: { ...sub, chargeDateMoved: true } }) === "ACTIVE_STRIPE");
  check("billing centre: a first charge still to come stays SCHEDULED", deriveBillingState({ ...base, sub }) === "SCHEDULED");
}

console.log("History:");
check("Stripe", moveEventSentence({ mode: "STRIPE", from: "2026-11-27T00:00:00.000Z", to: "2026-12-05T00:00:00.000Z" }, "Julian Ramirez") === "Charge date moved Nov 27 → Dec 5 — by Julian Ramirez");
check("cash", moveEventSentence({ mode: "OFFLINE", from: "2026-11-01T00:00:00.000Z", to: "2026-11-15T00:00:00.000Z" }, null) === "Payment due date moved Nov 1 → Nov 15");
check("the panel's history reads it", moneyEventSentence({ kind: "CHARGE_DATE_MOVED", at: NOW, detail: { mode: "STRIPE", from: "2026-11-27T00:00:00.000Z", to: "2026-12-05T00:00:00.000Z" }, actorName: "Sal" }) === "Charge date moved Nov 27 → Dec 5 — by Sal");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
