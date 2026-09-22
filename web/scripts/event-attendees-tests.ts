// The Attendees ledger — the read-only merge of Booking (roster) and
// EventRegistration (money) behind /api/events/[id]/attendees and the event
// rows' money summary. PURE: no database, runs in milliseconds.
//
//   npx tsx scripts/event-attendees-tests.ts

import {
  buildAttendeeLedger,
  matchesFilter,
  summarizeLedger,
  type LedgerBooking,
  type LedgerRegistration,
} from "../lib/eventAttendees";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date("2026-09-22T12:00:00Z");
const member = (id: string, first: string, last: string): LedgerBooking["member"] => ({ id, firstName: first, lastName: last, email: `${first}@x.test`, phone: null });
const reg = (over: Partial<LedgerRegistration> & { id: string }): LedgerRegistration => ({
  memberId: null, name: "Public Person", email: "p@x.test", phone: null, status: "REGISTERED",
  amountDue: null, amountPaid: null, createdAt: "2026-09-01T00:00:00Z", ...over,
});
const booking = (over: Partial<LedgerBooking> & { id: string; memberId: string }): LedgerBooking => ({
  status: "CONFIRMED", member: member(over.memberId, "M", over.memberId), createdAt: "2026-09-01T00:00:00Z", ...over,
});
const EV = { capacity: 10, coveredOrFree: false, categoryKey: "weight", categoryLabel: "Weight", sessionCount: 1 };

console.log("\nJoin rules:");
{
  const l = buildAttendeeLedger(EV, [reg({ id: "r1", memberId: "m1", name: "Ava Smith", status: "PAID", amountDue: 205.8, amountPaid: 205.8 })], [booking({ id: "b1", memberId: "m1" })], { now: NOW });
  eq("booking + registration for one member = ONE row", l.rows.length, 1);
  eq("that row carries both ids", [l.rows[0].registrationId, l.rows[0].bookingId], ["r1", "b1"]);
  eq("registration wins the status", l.rows[0].status, "PAID");
  eq("paid label carries the amount", l.rows[0].label, "Paid $205.80");
}
{
  const l = buildAttendeeLedger(EV, [reg({ id: "r1", status: "AWAITING_CASH", amountDue: 50 })], [booking({ id: "b1", memberId: "m9" })], { now: NOW });
  eq("public registration with no booking is its own row", l.rows.filter((r) => r.source === "PUBLIC").length, 1);
  eq("booking with no registration is its own row", l.rows.filter((r) => r.registrationId === null).length, 1);
  eq("two rows total", l.rows.length, 2);
}

console.log("\nMoney — registration is the only source of owed dollars:");
{
  const l = buildAttendeeLedger(EV, [
    reg({ id: "cash", status: "AWAITING_CASH", amountDue: 50 }),
    reg({ id: "check", status: "AWAITING_CHECK", amountDue: 40, amountPaid: 10 }),
    reg({ id: "paid", status: "PAID", amountDue: 100, amountPaid: 100 }),
    reg({ id: "sched", status: "SCHEDULED", amountDue: 75, scheduledChargeAt: "2026-10-01T00:00:00Z" }),
    reg({ id: "failed", status: "PAYMENT_FAILED", amountDue: 60 }),
    reg({ id: "abandoned", status: "PENDING_PAYMENT", amountDue: 60 }),
    reg({ id: "gone", status: "CANCELED", amountDue: 60 }),
  ], [booking({ id: "b1", memberId: "m1" })], { now: NOW });
  eq("awaiting cash owes the full amount", l.rows.find((r) => r.id === "cash")!.owes, 50);
  eq("partial payment owes the remainder", l.rows.find((r) => r.id === "check")!.owes, 30);
  eq("PAID owes nothing", l.rows.find((r) => r.id === "paid")!.owes, 0);
  eq("SCHEDULED owes nothing yet (card will run)", l.rows.find((r) => r.id === "sched")!.owes, 0);
  eq("SCHEDULED carries the scheduled amount", l.rows.find((r) => r.id === "sched")!.scheduledAmount, 75);
  eq("PAYMENT_FAILED owes", l.rows.find((r) => r.id === "failed")!.owes, 60);
  eq("abandoned checkout owes nothing (holds no spot, owes nothing)", l.rows.find((r) => r.id === "abandoned")!.owes, 0);
  eq("CANCELED is removed", l.rows.find((r) => r.id === "gone")!.removed, true);
  eq("booking-only row owes nothing", l.rows.find((r) => r.bookingId === "b1")!.owes, 0);
  eq("tile: collected = sum of PAID", l.tiles.collected, 100);
  eq("tile: outstanding = cash 50 + check 30 + failed 60", l.tiles.outstanding, 140);
  eq("tile: outstanding count", l.tiles.outstandingCount, 3);
  eq("tile: scheduled", [l.tiles.scheduled, l.tiles.scheduledCount], [75, 1]);
  eq("visible excludes the canceled row", l.visible, 7);
  eq("removed counts the canceled row", l.removed, 1);
}

console.log("\nFilters are the tiles counted again:");
{
  const l = buildAttendeeLedger(EV, [
    reg({ id: "cash", status: "AWAITING_CASH", amountDue: 50 }),
    reg({ id: "paid", status: "PAID", amountDue: 100, amountPaid: 100 }),
    reg({ id: "review", status: "PENDING_REVIEW", approvalStatus: "PENDING" }),
    reg({ id: "sched", status: "SCHEDULED", amountDue: 75 }),
  ], [booking({ id: "b1", memberId: "m1" })], { now: NOW });
  eq("all", l.filters.all, 5);
  eq("owes", l.filters.owes, 1);
  eq("waiting on you", l.filters.waiting, 1);
  eq("scheduled", l.filters.scheduled, 1);
  eq("settled = PAID + COVERED", l.filters.settled, 1);
  eq("matchesFilter agrees with the counts", l.rows.filter((r) => !r.removed && matchesFilter(r, "owes")).length, l.filters.owes);
  eq("waiting on you tile matches the filter", l.tiles.waitingOnYou, l.filters.waiting);
}

console.log("\nCapacity segments:");
{
  const l = buildAttendeeLedger(EV, [
    reg({ id: "paid", memberId: "m1", status: "PAID", amountDue: 100, amountPaid: 100 }),
    reg({ id: "cash", status: "AWAITING_CASH", amountDue: 50 }),
    reg({ id: "review", status: "PENDING_REVIEW", approvalStatus: "PENDING" }),
    reg({ id: "abandoned", status: "PENDING_PAYMENT", amountDue: 60 }),
  ], [booking({ id: "b1", memberId: "m1" }), booking({ id: "b2", memberId: "m2", status: "WAITLISTED" })], { now: NOW });
  eq("attendees = spot-holding rows (paid+cash), not review, not abandoned, not waitlist", l.capacity.attendees, 2);
  eq("settled segment", l.capacity.settled, 1);
  eq("owe segment", l.capacity.owe, 1);
  eq("review segment counts PENDING_REVIEW", l.capacity.review, 1);
  eq("spots left = capacity − holders", l.capacity.spotsLeft, 8);
  const s = summarizeLedger(l);
  eq("summary mirrors the ledger", [s.attendees, s.owe, s.review, s.outstanding, s.waitlisted], [2, 1, 1, 50, 1]);
}

console.log("\nCovered vs registered booking-only rows:");
{
  const free = buildAttendeeLedger({ ...EV, coveredOrFree: true }, [], [booking({ id: "b1", memberId: "m1" })], { now: NOW });
  eq("free/covered event → booking reads COVERED", free.rows[0].status, "COVERED");
  eq("…and counts as settled", free.filters.settled, 1);
  const paid = buildAttendeeLedger(EV, [], [booking({ id: "b1", memberId: "m1" })], { now: NOW });
  eq("priced event with no registration → booking reads REGISTERED (no money spine yet)", paid.rows[0].status, "REGISTERED");
  eq("…and owes nothing — a booking never carries money", paid.rows[0].owes, 0);
}

console.log("\nCategory + contact:");
{
  const l = buildAttendeeLedger(EV, [reg({ id: "r1", formResponses: { weight: "132" }, recipientEmail: "mom@x.test", recipientName: "Dana Smith (guardian)", email: "" })], [], { now: NOW });
  eq("category value read from formResponses by key", l.rows[0].categoryValue, "132");
  eq("contact is the family-resolved recipient, not the snapshot", l.rows[0].email, "mom@x.test");
  eq("contact note names the guardian", l.rows[0].emailNote, "Dana Smith (guardian)");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
