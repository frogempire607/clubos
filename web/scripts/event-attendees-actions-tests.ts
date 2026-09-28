// What the Attendees screen may do with a row (B11 slice 3) — the pure rules
// in lib/eventAttendeeActions.ts: tiles + filter counts from the one ledger,
// the collect panel's unpaid selection, cash-for-selected, row actions, the
// remove plan (roster and bill leave together, paid money is never touched),
// and "Paying by" = only the event's own methods. PURE: no database.
//
//   npx tsx scripts/event-attendees-actions-tests.ts

import { buildAttendeeLedger, type LedgerBooking, type LedgerRegistration } from "../lib/eventAttendees";
import {
  attendeeTiles,
  buildAddRequest,
  cashRecordable,
  collectAmount,
  collectSummary,
  filterChips,
  isSelectable,
  ledgerGrandTotal,
  mismatchedRows,
  removePlan,
  rowActions,
  selectedCash,
  selectedCollect,
  sellableSessions,
  sessionsTotal,
  staffAddPaymentPlan,
  staffMethodAllowed,
  takingOptions,
  visibleRows,
} from "../lib/eventAttendeeActions";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date("2026-09-22T12:00:00Z");
const reg = (over: Partial<LedgerRegistration> & { id: string }): LedgerRegistration => ({
  memberId: null, name: over.id, email: `${over.id}@x.test`, phone: null, status: "REGISTERED",
  amountDue: null, amountPaid: null, createdAt: "2026-09-01T00:00:00Z", ...over,
});
const booking = (over: Partial<LedgerBooking> & { id: string; memberId: string }): LedgerBooking => ({
  status: "CONFIRMED", member: { id: over.memberId, firstName: "M", lastName: over.memberId, email: null, phone: null }, createdAt: "2026-09-01T00:00:00Z", ...over,
});
const EV = { capacity: 20, coveredOrFree: false, categoryKey: "weight", categoryLabel: "Weight", sessionCount: 3 };

// One ledger with every state the screen acts on.
const ledger = buildAttendeeLedger(EV, [
  reg({ id: "paid", memberId: "m1", status: "PAID", amountDue: 200, amountPaid: 200 }),
  reg({ id: "cash", status: "AWAITING_CASH", amountDue: 200 }),
  reg({ id: "check", status: "AWAITING_CHECK", amountDue: 65, sessionIds: ["s1", "s2"] }),
  reg({ id: "owes", status: "REGISTERED", amountDue: 180 }),
  reg({ id: "nodue", status: "REGISTERED", amountDue: null }),
  reg({ id: "failed", status: "PAYMENT_FAILED", amountDue: 200 }),
  reg({ id: "abandoned", status: "PENDING_PAYMENT", amountDue: 200 }),
  reg({ id: "sched-due", status: "SCHEDULED", amountDue: 200, scheduledChargeAt: "2026-09-20T00:00:00Z" }),
  reg({ id: "sched-later", status: "SCHEDULED", amountDue: 200, scheduledChargeAt: "2026-10-20T00:00:00Z" }),
  reg({ id: "review", status: "PENDING_REVIEW", approvalStatus: "PENDING", amountDue: 200 }),
  reg({ id: "proposed", status: "PENDING_REVIEW", approvalStatus: "PENDING", amountDue: 200, proposedChange: { changes: { weight: "126" } } }),
  reg({ id: "gone", status: "CANCELED", amountDue: null }),
], [
  booking({ id: "b1", memberId: "m1" }),
  booking({ id: "b-free", memberId: "m9" }),
], { now: NOW });
const row = (id: string) => ledger.rows.find((r) => r.registrationId === id || r.bookingId === id)!;
const FIXED = { isVariable: false, perHead: null, publicPrice: 200 };

console.log("\nTiles and chips come off the one ledger:");
{
  const tiles = attendeeTiles(ledger);
  eq("four tiles in handoff order", tiles.map((t) => t.key), ["collected", "outstanding", "scheduled", "waiting"]);
  eq("Collected = ledger.tiles.collected", tiles[0].amount, ledger.tiles.collected);
  eq("Outstanding = ledger.tiles.outstanding", tiles[1].amount, ledger.tiles.outstanding);
  eq("Scheduled = ledger.tiles.scheduled", tiles[2].amount, ledger.tiles.scheduled);
  eq("Waiting on you counts heads", [tiles[3].amount, tiles[3].count], [null, ledger.tiles.waitingOnYou]);
  eq("Outstanding is warn-tinted when owed", tiles[1].tone, "warn");
  const chips = filterChips(ledger);
  for (const c of chips) eq(`chip "${c.label}" count = ledger.filters.${c.key}`, c.count, ledger.filters[c.key]);
  for (const c of chips) {
    eq(`chip "${c.label}" shows exactly its count`, visibleRows(ledger, c.key, false).length, c.count);
  }
  eq("footer grand total = outstanding + collected + scheduled",
    ledgerGrandTotal(ledger), Math.round((ledger.tiles.outstanding + ledger.tiles.collected + ledger.tiles.scheduled) * 100) / 100);
}

console.log("\nWaiting on you excludes a proposal that's with the parent:");
{
  eq("review row is waiting on you", visibleRows(ledger, "waiting", false).map((r) => r.registrationId), ["review"]);
  eq("proposed row's waitingOn is PARENT", row("proposed").waitingOn, "PARENT");
}

console.log("\nRemoved rows:");
{
  eq("hidden by default", visibleRows(ledger, "all", false).some((r) => r.removed), false);
  eq("shown under All when asked", visibleRows(ledger, "all", true).filter((r) => r.removed).map((r) => r.registrationId), ["gone"]);
  eq("never inside another chip", visibleRows(ledger, "owes", true).some((r) => r.removed), false);
}

console.log("\nCollect payment — who a link goes to:");
{
  const s = collectSummary(ledger.rows, FIXED);
  eq("unpaid = owing rows + an abandoned checkout; never paid/scheduled/review/removed",
    [...s.ids].sort(), ["abandoned", "cash", "check", "failed", "nodue", "owes"]);
  eq("count matches ids", s.count, 6);
  eq("amounts: recorded owes first, list price for a null amount", [collectAmount(row("owes"), FIXED), collectAmount(row("nodue"), FIXED), collectAmount(row("abandoned"), FIXED)], [180, 200, 200]);
  eq("total", s.total, 200 + 65 + 180 + 200 + 200 + 200);
  eq("free event (no list price) with a null amount: nothing to send", collectAmount(row("nodue"), { ...FIXED, publicPrice: 0 }), 0);
  eq("split event: per-head share for a row with no amount", collectAmount(row("nodue"), { isVariable: true, perHead: 41.67, publicPrice: null }), 41.67);
  eq("scheduled is never linkable (would collect twice)", collectAmount(row("sched-due"), FIXED), 0);
  eq("pending review is never linkable (skips the coach)", collectAmount(row("review"), FIXED), 0);
}

console.log("\nSelection drives Email selected / Record cash for selected:");
{
  eq("paid row isn't selectable", isSelectable(row("paid"), FIXED), false);
  eq("owing row is selectable", isSelectable(row("owes"), FIXED), true);
  const sel = selectedCollect(["owes", "paid", "sched-due", "cash"], ledger.rows, FIXED);
  eq("Email selected (n) counts only linkable picks", [sel.count, [...sel.ids].sort()], [2, ["cash", "owes"]]);
  eq("nothing selected → 0 (button disabled)", selectedCollect([], ledger.rows, FIXED).count, 0);
  const cash = selectedCash(["cash", "owes", "nodue", "paid"], ledger.rows);
  eq("cash records rows with a recorded amount", [...cash.ids].sort(), ["cash", "owes"]);
  eq("cash total is the recorded amounts", cash.total, 380);
  eq("rows with nothing to settle are named, not silently skipped", [...cash.skipped].sort(), ["nodue", "paid"]);
  eq("pending review can't take cash before approval", cashRecordable(row("review")), false);
}

console.log("\nRow actions per status:");
{
  const a = (id: string, canDecide = true, extra: { transactionId?: string | null; fixMemberId?: string | null } = {}) =>
    rowActions(row(id), { canDecide, now: NOW, detail: extra });
  eq("paid → resend receipt + remove", a("paid"), ["resend", "remove"]);
  eq("awaiting cash → record, discount, remove", a("cash"), ["record", "discount", "remove"]);
  eq("open cash record hides discount", a("cash", true, { transactionId: "tx1" }), ["record", "remove"]);
  eq("charge date arrived → Charge now", a("sched-due"), ["chargeNow", "remove"]);
  eq("charge date in the future → no Charge now", a("sched-later"), ["remove"]);
  eq("waiting on you → decide first", a("review")[0], "decide");
  eq("no permission to decide → no decide", a("review", false).includes("decide"), false);
  eq("proposal with the parent → no decide", a("proposed").includes("decide"), false);
  eq("missing address + fixable member → add an email", rowActions({ ...row("owes"), email: null }, { canDecide: true, now: NOW, detail: { fixMemberId: "m5" } }).includes("addEmail"), true);
  eq("booking-only spot → remove only", a("b-free"), ["remove"]);
  eq("removed row → nothing", a("gone"), []);
}

console.log("\nRemove takes roster and bill together; money is never deleted:");
{
  const p = removePlan(row("owes"));
  eq("owing registration → the registration DELETE (cancels bill + booking)", p.kind === "registration" ? p.registrationId : p.kind, "owes");
  check("its note says both lists", p.kind === "registration" && /roster and the billing list/.test(p.note));
  eq("paid → blocked (refund first)", removePlan(row("paid")).kind, "blocked");
  check("paid reason says money is never deleted", /never deletes money/.test((removePlan(row("paid")) as { reason: string }).reason));
  eq("scheduled → blocked", removePlan(row("sched-due")).kind, "blocked");
  eq("awaiting cash → blocked (void in Financials)", removePlan(row("cash")).kind, "blocked");
  eq("open cash transaction → blocked", removePlan(row("owes"), { transactionId: "tx" }).kind, "blocked");
  const b = removePlan(row("b-free"));
  eq("booking-only spot → the booking DELETE", b.kind === "booking" ? b.memberId : b.kind, "m9");
}

console.log("\nStale amounts:");
{
  const d = (id: string) => (id === "check" ? { sessionIds: ["s1", "s2"] } : id === "owes" ? { discountAmount: 20 } : null);
  eq("a discounted row matching list − discount isn't flagged; per-session rows never are",
    mismatchedRows(ledger.rows, FIXED, d).map((r) => r.registrationId), []);
  eq("a row carrying an old price is flagged", mismatchedRows(ledger.rows, FIXED, () => null).map((r) => r.registrationId).sort(), ["check", "owes"]);
  eq("split events are never flagged", mismatchedRows(ledger.rows, { isVariable: true, perHead: 10, publicPrice: null }, () => null).length, 0);
}

console.log("\nPaying by = only the event's methods:");
{
  const base = { pricingModel: "FIXED", memberPrice: 200, nonMemberPrice: 225 };
  const p1 = staffAddPaymentPlan({ ...base, paymentMethods: ["CARD", "CASH"] });
  eq("card + cash → link, reader, cash", p1.kind === "PAID" ? p1.methods : p1.kind, ["INVOICE", "TERMINAL", "CASH"]);
  const p2 = staffAddPaymentPlan({ ...base, paymentMethods: ["CHECK"] });
  eq("check only → check only", p2.kind === "PAID" ? p2.methods : p2.kind, ["CHECK"]);
  const p3 = staffAddPaymentPlan({ ...base, paymentMethods: ["AUTO_CARD", "CASH"] });
  eq("saved card can't be picked by staff, and says why", p3.kind === "PAID" ? [p3.methods, p3.unavailable.map((u) => u.method)] : p3.kind, [["CASH"], ["AUTO_CARD"]]);
  check("the note says options come from the event", p1.kind === "PAID" && /come from the event/.test(p1.note));
  eq("legacy empty config = card only", staffAddPaymentPlan({ ...base, paymentMethods: null }).kind === "PAID" ? (staffAddPaymentPlan({ ...base, paymentMethods: null }) as { methods: string[] }).methods : null, ["INVOICE", "TERMINAL"]);
  eq("split → no payment question", staffAddPaymentPlan({ ...base, variableCostEnabled: true }).kind, "SPLIT");
  eq("free → no payment question", staffAddPaymentPlan({ pricingModel: "FREE" }).kind, "FREE");
  eq("no prices → free", staffAddPaymentPlan({ pricingModel: "FIXED", paymentMethods: ["CARD"] }).kind, "FREE");
  eq("server: cash refused on a card-only event", staffMethodAllowed("CASH", ["CARD"]), false);
  eq("server: link allowed on a card event", staffMethodAllowed("INVOICE", ["CARD"]), true);
  eq("server: check needs CHECK", [staffMethodAllowed("CHECK", ["CASH"]), staffMethodAllowed("CHECK", ["CHECK"])], [false, true]);
}

console.log("\nTaking + the add request:");
{
  const ev = {
    pricingModel: "FIXED", memberPrice: 200, nonMemberPrice: null, paymentMethods: ["CARD", "CASH"], sellIndividualSessions: true,
    sessions: [
      { id: "s1", price: 45, startsAt: "2026-10-01T10:00:00Z" },
      { id: "s2", price: 20, startsAt: "2026-10-02T10:00:00Z" },
      { id: "s0", price: 45, startsAt: "2026-09-01T10:00:00Z" }, // started
      { id: "s3", price: null, startsAt: "2026-10-03T10:00:00Z" }, // not sold alone
    ],
  };
  eq("whole event + pick sessions", takingOptions(ev, NOW).map((o) => o.key), ["MEMBER", "SESSIONS"]);
  eq("only priced, unstarted sessions are sellable", sellableSessions(ev, NOW).map((s) => s.id), ["s1", "s2"]);
  eq("session total", sessionsTotal(ev, ["s1", "s2", "s0"], NOW), 65);
  eq("no pick sessions when the event doesn't sell them", takingOptions({ ...ev, sellIndividualSessions: false }, NOW).map((o) => o.key), ["MEMBER"]);
  const r1 = buildAddRequest(ev, { memberId: "m1", taking: "SESSIONS", sessionIds: ["s1"], method: "CASH" });
  eq("sessions + cash → charge route, DROP_IN + sessionIds", r1.ok ? r1.req : r1, { route: "charge", body: { memberId: "m1", pricingType: "DROP_IN", paymentMethod: "CASH", sessionIds: ["s1"] } });
  const r2 = buildAddRequest(ev, { memberId: "m1", taking: "SESSIONS", sessionIds: [], method: "CASH" });
  eq("sessions with none picked → refused", r2.ok, false);
  const r3 = buildAddRequest(ev, { memberId: "m1", taking: "MEMBER", sessionIds: [], method: "CHECK" });
  eq("a method the event doesn't allow → refused", r3.ok, false);
  const r4 = buildAddRequest({ pricingModel: "FREE" }, { memberId: "m1", taking: null, sessionIds: [], method: null });
  eq("free → the booking route", r4.ok ? r4.req.route : null, "bookings");
  const r5 = buildAddRequest({ ...ev, variableCostEnabled: true }, { memberId: "m1", taking: null, sessionIds: [], method: null });
  eq("split → charge route with no payment method (register now, bill later)", r5.ok ? r5.req : null, { route: "charge", body: { memberId: "m1" } });
  const r6 = buildAddRequest(ev, { memberId: "m1", taking: "MEMBER", sessionIds: [], method: "INVOICE" });
  eq("card link → INVOICE on the charge route", r6.ok && r6.req.route === "charge" ? r6.req.body.paymentMethod : null, "INVOICE");
  eq("no member → refused", buildAddRequest(ev, { memberId: "", taking: "MEMBER", sessionIds: [], method: "CASH" }).ok, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
