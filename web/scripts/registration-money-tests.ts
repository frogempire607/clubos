// lib/registrationMoney — what staff are told about one registration's money,
// and what Approve / Decline will do to it. PURE: no database.
//
//   npx tsx scripts/registration-money-tests.ts
//
// Fixtures are the row shapes on the real Finger Lakes Duals event (one
// approval-gated event carrying AUTO_CARD, INVOICE and APPROVAL_CHARGE at
// once), plus CARD / CASH / CHECK.

import { describeRegistrationMoney, approveBatchSummary, type MoneyRegistration, type MoneyClub } from "../lib/registrationMoney";
import { nameKey, linkBookingNeeded } from "../lib/registrationLink";
import { ACTIVE_REGISTRATION_STATUSES } from "../lib/eventPayments";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date("2026-09-29T15:00:00Z");
// Charge date saved from a date input → midnight UTC.
const EV = { startsAt: "2026-11-15T13:00:00Z", autoChargeDate: "2026-11-14T00:00:00Z", sessionCount: 1, summaryFields: [{ id: "division", label: "Division" }], groupLabel: "School" };
const CLUB: MoneyClub = { passProcessingFees: true, timezone: "America/New_York" };
const reg = (over: Partial<MoneyRegistration>): MoneyRegistration => ({
  name: "Someone Here", paymentMethod: null, status: "REGISTERED", approvalStatus: "APPROVED",
  amountDue: 85, amountPaid: null, ...over,
});
const d = (r: MoneyRegistration, now = NOW, club = CLUB, ev = EV) => describeRegistrationMoney(r, ev, club, now);

console.log("\nFinger Lakes rows:");
{
  // Fasulo — AUTO_CARD approved, SCHEDULED for the charge date.
  const m = d(reg({ name: "Jaden Fasulo", paymentMethod: "AUTO_CARD", status: "SCHEDULED", scheduledChargeAt: "2026-11-14T00:00:00Z" }));
  eq("Fasulo timing", m.timing, "Saved card · charged Nov 14 · $87.47");
  eq("Fasulo method", m.methodLabel, "Saved card");
  eq("Fasulo amount carries the card fee", m.amountLabel, "$87.47 ($85.00 + $2.47 card fee)");
  eq("Fasulo tone", m.tone, "scheduled");
  eq("Fasulo is not decidable", m.decidable, false);
  eq("Fasulo approve does nothing", m.approveEffect.kind, "NONE");
}
{
  // Titus — INVOICE approved, link sent, unpaid.
  const m = d(reg({ name: "Titus Reyes", paymentMethod: "INVOICE", status: "REGISTERED", invoicedAt: "2026-09-25T16:30:00Z", invoiceCount: 1 }));
  eq("Titus timing", m.timing, "Payment link sent Sep 25 · unpaid");
  eq("Titus method", m.methodLabel, "Billed after approval");
  eq("Titus tone", m.tone, "owed");
}
{
  // Jackson — INVOICE, paid through the link.
  const m = d(reg({ name: "Jackson Lee", paymentMethod: "INVOICE", status: "PAID", amountPaid: 87.47, paidAt: "2026-09-26T18:00:00Z", paidVia: "STRIPE" }));
  eq("Jackson timing", m.timing, "Paid by link Sep 26 · $87.47");
  eq("Jackson amount", m.amountLabel, "$87.47 paid");
  eq("Jackson tone", m.tone, "paid");
}
{
  // Bergen — APPROVAL_CHARGE, charged when approved.
  const m = d(reg({ name: "Ava Bergen", paymentMethod: "APPROVAL_CHARGE", status: "PAID", amountPaid: 87.47, paidAt: "2026-09-28T14:45:00Z", paidVia: "STRIPE" }));
  eq("Bergen timing", m.timing, "Charged Sep 28 · $87.47");
  eq("Bergen method", m.methodLabel, "Saved card, charged on approval");
  eq("Bergen decline (already decided) refunds", m.declineEffect.kind, "REFUND");
}
{
  // Colton — APPROVAL_CHARGE, PENDING_REVIEW: one click charges him.
  const m = d(reg({ name: "Colton Waite", paymentMethod: "APPROVAL_CHARGE", status: "PENDING_REVIEW", approvalStatus: "PENDING", formResponses: { division: "Varsity" }, groupValue: "Lincoln High" }));
  eq("Colton timing", m.timing, "Charges $87.47 the moment you approve");
  eq("Colton marker", [m.chargesOnApprove, m.tone], [true, "chargeOnApprove"]);
  eq("Colton approve effect", m.approveEffect, { kind: "CHARGE_NOW", sentence: "Approving Colton charges their saved card $87.47 now.", chargeNowCents: 8747 });
  eq("Colton decline", m.declineEffect.sentence, "Declining charges nothing — Colton's saved card is never charged.");
  eq("Colton registered for", m.registeredFor, "Whole event · Division: Varsity · School: Lincoln High");
}
{
  // AUTO_CARD pending, approved BEFORE the charge date → scheduled.
  const m = d(reg({ name: "Eli Fasulo", paymentMethod: "AUTO_CARD", status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  eq("AUTO_CARD pending timing", m.timing, "Saved card · charged Nov 14 after approval · $87.47");
  eq("AUTO_CARD pending approve schedules", m.approveEffect, { kind: "SCHEDULE", sentence: "Approving Eli schedules their saved card for $87.47 on Nov 14. Nothing is charged today.", chargeNowCents: 0 });
  eq("AUTO_CARD pending is not a charge-on-approve row", m.chargesOnApprove, false);
}
{
  // AUTO_CARD approved AFTER the charge date → charged now.
  const late = new Date("2026-11-14T17:00:00Z");
  const m = d(reg({ name: "Eli Fasulo", paymentMethod: "AUTO_CARD", status: "PENDING_REVIEW", approvalStatus: "PENDING" }), late);
  eq("late AUTO_CARD charges now", m.approveEffect.kind, "CHARGE_NOW");
  eq("late AUTO_CARD sentence", m.approveEffect.sentence, "Approving Eli charges their saved card $87.47 now — the event's charge date (Nov 14) has already passed.");
  eq("late AUTO_CARD marker", m.chargesOnApprove, true);
}
{
  // INVOICE pending.
  const m = d(reg({ name: "Titus Reyes", paymentMethod: "INVOICE", status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  eq("INVOICE pending timing", m.timing, "Payment link sent when you approve · $87.47");
  eq("INVOICE pending approve", m.approveEffect.kind, "SEND_LINK");
  eq("INVOICE pending approve sentence", m.approveEffect.sentence, "Approving Titus emails them a payment link for $87.47. Nothing is charged until they pay it.");
}

console.log("\nCARD / CASH / CHECK:");
{
  const m = d(reg({ name: "Mia Card", paymentMethod: "CARD", status: "PAID", approvalStatus: "PENDING", amountPaid: 87.47, paidAt: "2026-09-20T12:00:00Z" }));
  eq("CARD pending timing", m.timing, "Paid by card at signup · $87.47 · refunded if declined");
  eq("CARD approve", m.approveEffect.kind, "REFUND_ON_DECLINE");
  eq("CARD decline refunds", [m.declineEffect.kind, m.declineEffect.refundCents], ["REFUND", 8747]);
  eq("CARD decline sentence", m.declineEffect.sentence, "Declining refunds Mia's $87.47 in full to the card they paid with.");
}
{
  const m = d(reg({ name: "Sam Cash", paymentMethod: "CASH", status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  eq("CASH pending timing (no card fee)", m.timing, "Pays $85.00 cash at the event");
  eq("CASH amount", m.amountLabel, "$85.00");
  eq("CASH approve", m.approveEffect, { kind: "NONE", sentence: "Approving Sam confirms their spot. They owe $85.00 cash at the event — nothing is charged.", chargeNowCents: 0 });
  eq("CASH decline voids", m.declineEffect.kind, "VOID_OFFLINE");
}
{
  const m = d(reg({ name: "Pat Check", paymentMethod: "CHECK", status: "AWAITING_CHECK" }));
  eq("CHECK awaiting", m.timing, "Pays $85.00 by check at the event");
  const p = d(reg({ name: "Pat Check", paymentMethod: "CHECK", status: "PAID", amountPaid: 85, paidVia: "CHECK", paidAt: "2026-09-27T20:00:00Z" }));
  eq("CHECK paid", p.timing, "Paid $85.00 by check Sep 27");
}

console.log("\nFailed / retry / other states:");
{
  const m = d(reg({ name: "Fail Case", paymentMethod: "AUTO_CARD", status: "PAYMENT_FAILED", lastChargeError: "Your card was declined." }));
  eq("failed", m.timing, "Card charge failed · $87.47 still due — Your card was declined.");
  eq("failed tone", m.tone, "warn");
  const s = d(reg({ name: "Due Now", paymentMethod: "AUTO_CARD", status: "SCHEDULED", scheduledChargeAt: "2026-09-28T00:00:00Z" }));
  eq("scheduled date passed → charging now", s.timing, "Saved card · charging now · $87.47");
  const nm = d(reg({ name: "No Method", paymentMethod: null, status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  eq("no method pending is BLOCKED", nm.approveEffect.kind, "BLOCKED");
  const free = d(reg({ name: "Free One", paymentMethod: null, status: "PENDING_REVIEW", approvalStatus: "PENDING", amountDue: 0 }));
  eq("free approve", free.approveEffect.sentence, "Approving Free confirms their spot. Nothing is owed.");
  const nofee = d(reg({ name: "Colton Waite", paymentMethod: "APPROVAL_CHARGE", status: "PENDING_REVIEW", approvalStatus: "PENDING" }), NOW, { passProcessingFees: false, timezone: null });
  eq("club not passing fees", nofee.approveEffect.chargeNowCents, 8500);
  const dec = d(reg({ name: "Gone", paymentMethod: "CARD", status: "CANCELED", approvalStatus: "DECLINED", amountPaid: 87.47 }));
  eq("declined + refunded", dec.timing, "Declined · $87.47 refunded");
  const sessions = describeRegistrationMoney(reg({ sessionIds: ["a", "b"], entries: [{ status: "ACTIVE", positionLabel: "145", rosterLabel: "Team A" }] }), { ...EV, sessionCount: 6 }, CLUB, NOW);
  eq("entries + sessions", sessions.registeredFor, "145 · Team A · 2 of 6 sessions");
}

console.log("\nBulk approve summary:");
{
  const colton = d(reg({ name: "Colton Waite", paymentMethod: "APPROVAL_CHARGE", status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  const other = d(reg({ name: "Ava Bergen", paymentMethod: "APPROVAL_CHARGE", status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  const eli = d(reg({ name: "Eli Fasulo", paymentMethod: "AUTO_CARD", status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  const s = approveBatchSummary([{ money: colton }, { money: other }, { money: eli }]);
  eq("charged-now line", s.chargedLine, "Charged now: $174.94 (2 people)");
  eq("button", s.buttonLabel, "Approve 3 · charge $174.94 now");
  const q = approveBatchSummary([{ money: eli }]);
  eq("nothing today", q.buttonLabel, "Approve 1 · nothing charged today");
  const nm = d(reg({ name: "No Method", paymentMethod: null, status: "PENDING_REVIEW", approvalStatus: "PENDING" }));
  const b = approveBatchSummary([{ money: eli }, { money: nm }]);
  eq("blocked rows are left out", [b.count, b.blocked], [1, 1]);
}

console.log("\nLink to member:");
{
  eq("name match ignores case and spacing", nameKey("  Eli   FASULO ") === nameKey("eli fasulo"), true);
  eq("different names differ", nameKey("Eli Fasulo") === nameKey("Jaden Fasulo"), false);
  eq("approved scheduled reg → booking", linkBookingNeeded({ status: "SCHEDULED", approvalStatus: "APPROVED" }, ACTIVE_REGISTRATION_STATUSES), true);
  eq("no-approval paid reg → booking", linkBookingNeeded({ status: "PAID", approvalStatus: null }, ACTIVE_REGISTRATION_STATUSES), true);
  eq("under review → no booking (approval makes it)", linkBookingNeeded({ status: "PENDING_REVIEW", approvalStatus: "PENDING" }, ACTIVE_REGISTRATION_STATUSES), false);
  eq("CARD paid but pending approval → no booking", linkBookingNeeded({ status: "PAID", approvalStatus: "PENDING" }, ACTIVE_REGISTRATION_STATUSES), false);
  eq("abandoned checkout → no booking", linkBookingNeeded({ status: "PENDING_PAYMENT", approvalStatus: null }, ACTIVE_REGISTRATION_STATUSES), false);
  eq("canceled → no booking", linkBookingNeeded({ status: "CANCELED", approvalStatus: "DECLINED" }, ACTIVE_REGISTRATION_STATUSES), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
