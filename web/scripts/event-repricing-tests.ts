/**
 * Regression tests for event repricing — the Frog Empire Road Trip bug.
 *
 * A CAMP priced at $450 invoiced $533.33 per family because every registration
 * carried a per-head snapshot (variableCostTotal ÷ variableCostEstimatedSignups)
 * taken while the event was still variable-cost. Turning variable cost OFF
 * changed the event columns and nothing else, so the orphaned snapshot won at
 * invoice time and five families were emailed the wrong number.
 *
 * The centerpiece here is the true→false transition. Pure-function tests only —
 * no DB, no Stripe, no network. Run with:
 *   npx tsx scripts/event-repricing-tests.ts
 * Exits non-zero on any failure.
 */
import {
  amountMismatch,
  amountToCollect,
  expectedAmount,
  isCanceledRegistration,
  planReprice,
  pricingChanged,
  pricingLockReason,
  variableCostTurnedOff,
  variablePerHead,
  type PricingEvent,
  type PricingRegistration,
} from "../lib/eventRepricing";
import { CHECKOUT_HOLD_MS } from "../lib/eventPayments";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

// The real event, before and after the owner switched it to a flat price.
const VARIABLE_CAMP: PricingEvent = {
  variableCostEnabled: true,
  variableCostMode: "ESTIMATED",
  variableCostTotal: 8000,
  variableCostEstimatedSignups: 15,
  publicPricingOption: "MEMBER",
  memberPrice: 450,
  nonMemberPrice: 450,
};
const FIXED_CAMP: PricingEvent = {
  variableCostEnabled: false,
  variableCostMode: null,
  variableCostTotal: null,
  variableCostEstimatedSignups: null,
  variableCostEstimatedTotal: null,
  publicPricingOption: "MEMBER",
  memberPrice: 450,
  nonMemberPrice: 450,
};

const reg = (over: Partial<PricingRegistration> = {}): PricingRegistration => ({
  id: over.id ?? "r1",
  name: over.name ?? "Registrant",
  status: over.status ?? "REGISTERED",
  amountDue: "amountDue" in over ? over.amountDue : 533.33,
  amountPaid: over.amountPaid ?? null,
  transactionId: over.transactionId ?? null,
  createdAt: over.createdAt ?? null,
});

console.log("\n— the variable-cost split that produced $533.33 —");
{
  const { perHead, divisor, total } = variablePerHead(VARIABLE_CAMP, 13);
  check("8000 ÷ 15 expected signups = 533.33", perHead === 533.33, perHead);
  check("ESTIMATED splits by the estimate, not by actual signups", divisor === 15, divisor);
  check("total is carried through", total === 8000, total);

  // The Butler rows: same divisor, a total the owner lowered mid-session.
  const lowered = variablePerHead({ ...VARIABLE_CAMP, variableCostTotal: 5000 }, 13);
  check("5000 ÷ 15 = 333.33 (the second snapshot)", lowered.perHead === 333.33, lowered.perHead);

  const official = variablePerHead({ ...VARIABLE_CAMP, variableCostMode: "OFFICIAL" }, 16);
  check("OFFICIAL splits across actual attendees", official.perHead === 500 && official.divisor === 16, official);

  const noEstimate = variablePerHead({ ...VARIABLE_CAMP, variableCostEstimatedSignups: null }, 10);
  check("no estimate falls back to actual attendees", noEstimate.perHead === 800, noEstimate.perHead);

  check(
    "no total set = no share (never invoice $0 by accident)",
    variablePerHead({ ...VARIABLE_CAMP, variableCostTotal: null }, 13).perHead === null,
  );
  check("fixed-price event has no per-head", variablePerHead(FIXED_CAMP, 13).perHead === null);
}

console.log("\n— THE REGRESSION: variable cost true → false —");
{
  check("transition is detected", variableCostTurnedOff(VARIABLE_CAMP, FIXED_CAMP));
  check("false → true is NOT the transition", !variableCostTurnedOff(FIXED_CAMP, VARIABLE_CAMP));
  check("variable → variable is not the transition", !variableCostTurnedOff(VARIABLE_CAMP, VARIABLE_CAMP));
  check("fixed → fixed is not the transition", !variableCostTurnedOff(FIXED_CAMP, FIXED_CAMP));

  // Before the fix: the snapshot survived the switch and won at invoice time.
  const stale = reg({ amountDue: 533.33 });
  check(
    "a stale snapshot on a now-fixed event is a mismatch, not a price",
    amountMismatch(FIXED_CAMP, stale, 13),
  );
  check(
    "unrepaired, the stale snapshot is what would be collected ($533.33, the bug)",
    amountToCollect(FIXED_CAMP, stale, 13) === 533.33,
  );
  check("the event's own pricing says $450", expectedAmount(FIXED_CAMP, 13) === 450);

  // After the fix: PATCH clears the orphaned amounts, so the fixed price takes
  // over and the mismatch is gone.
  const cleared = reg({ amountDue: null });
  check("cleared snapshot collects the event price", amountToCollect(FIXED_CAMP, cleared, 13) === 450);
  check("cleared snapshot is no longer a mismatch", !amountMismatch(FIXED_CAMP, cleared, 13));

  // The whole roster, as it stood on 2026-08-03.
  const roster: PricingRegistration[] = [
    ...Array.from({ length: 11 }, (_, i) => reg({ id: `a${i}`, amountDue: 533.33 })),
    reg({ id: "b1", name: "Alex Butler", amountDue: 333.33 }),
    reg({ id: "b2", name: "Mikey Butler", amountDue: 333.33 }),
  ];
  const plan = planReprice(FIXED_CAMP, roster);
  check("all 13 rows are repriceable (none committed)", plan.changed.length === 13, plan.changed.length);
  check("nothing is locked", plan.locked.length === 0);
  check("current total is the wrong 6533.29", plan.currentTotal === 6533.29, plan.currentTotal);
  check("expected total is 13 × 450 = 5850", plan.expectedTotal === 5850, plan.expectedTotal);
  check(
    "both the over- and under-charged rows are caught",
    plan.changed.filter((r) => r.current === 533.33).length === 11 &&
      plan.changed.filter((r) => r.current === 333.33).length === 2,
  );
  check("every row targets the flat price", plan.rows.every((r) => r.expected === 450));
  check("fixed price is reported for the UI", plan.fixedPrice === 450 && plan.perHead === null);
}

console.log("\n— committed money is never repriced —");
{
  const now = new Date("2026-08-03T18:00:00Z");
  check("PAID is locked", pricingLockReason(reg({ status: "PAID" }), now) === "already paid");
  check(
    "a recorded payment locks even a non-PAID row",
    pricingLockReason(reg({ status: "REGISTERED", amountPaid: 450 }), now) !== null,
  );
  check("SCHEDULED (card authorized) is locked", pricingLockReason(reg({ status: "SCHEDULED" }), now) !== null);
  check("an open Transaction locks", pricingLockReason(reg({ transactionId: "tx_1" }), now) !== null);
  check("AWAITING_CASH is locked", pricingLockReason(reg({ status: "AWAITING_CASH" }), now) !== null);
  check("AWAITING_CHECK is locked", pricingLockReason(reg({ status: "AWAITING_CHECK" }), now) !== null);
  check("plain REGISTERED is free to reprice", pricingLockReason(reg(), now) === null);
  check("PAYMENT_FAILED is free to reprice", pricingLockReason(reg({ status: "PAYMENT_FAILED" }), now) === null);

  // An in-flight checkout holds a live Stripe session at the old amount.
  const justStarted = reg({ status: "PENDING_PAYMENT", createdAt: new Date(now.getTime() - 60_000) });
  const abandoned = reg({ status: "PENDING_PAYMENT", createdAt: new Date(now.getTime() - CHECKOUT_HOLD_MS - 1000) });
  check("in-flight checkout is locked", pricingLockReason(justStarted, now) === "card checkout in progress");
  check("abandoned checkout is repriceable", pricingLockReason(abandoned, now) === null);

  // A locked row keeps its own number in the expected total — repricing must
  // never quietly restate money someone has already committed.
  const mixed = [reg({ id: "x", amountDue: 533.33 }), reg({ id: "y", status: "PAID", amountDue: 533.33 })];
  const plan = planReprice(FIXED_CAMP, mixed);
  check("locked rows are excluded from the change set", plan.changed.length === 1 && plan.changed[0].id === "x");
  check("locked row is reported with a reason", plan.locked.length === 1 && !!plan.locked[0].lockReason);
  check("locked row keeps its own amount in the total", plan.expectedTotal === 983.33, plan.expectedTotal);
}

console.log("\n— canceled registrants are out of everything —");
{
  check("CANCELED is recognised", isCanceledRegistration({ status: "CANCELED" }));
  check("REGISTERED is not canceled", !isCanceledRegistration({ status: "REGISTERED" }));

  // Removing someone from the event must drop them from the split AND from the
  // billing list — a removed kid still counted in the divisor would quietly
  // change everyone else's share.
  const roster = [
    reg({ id: "a", amountDue: null }),
    reg({ id: "b", amountDue: null }),
    reg({ id: "c", amountDue: null, status: "CANCELED" }),
  ];
  const plan = planReprice({ ...VARIABLE_CAMP, variableCostEstimatedSignups: null, variableCostTotal: 900 }, roster);
  check("canceled rows are not priced", plan.rows.length === 2, plan.rows.length);
  check("canceled rows are not in the divisor (900 ÷ 2 = 450)", plan.perHead === 450, plan.perHead);
}

console.log("\n— variable-cost events always use the live split —");
{
  // On a variable event the snapshot is only ever a preview: the real number
  // is recomputed at invoice time, so the estimate can be adjusted freely.
  const stale = reg({ amountDue: 533.33 });
  check(
    "adjusting the estimate reprices everyone (6000 ÷ 15 = 400)",
    amountToCollect({ ...VARIABLE_CAMP, variableCostTotal: 6000 }, stale, 13) === 400,
  );
  check(
    "the stale snapshot is ignored entirely on variable events",
    amountToCollect(VARIABLE_CAMP, reg({ amountDue: 1 }), 13) === 533.33,
  );
  const plan = planReprice({ ...VARIABLE_CAMP, variableCostTotal: 6000 }, [stale]);
  check("preview shows the new share", plan.perHead === 400 && plan.rows[0].expected === 400);
  check("preview shows what they're carrying now", plan.rows[0].current === 533.33);
}

console.log("\n— per-registrant prices on fixed events are preserved —");
{
  // A non-member charged the non-member price is NOT a bug, so a recorded
  // amount still wins on a fixed-price event. It is surfaced for confirmation,
  // never silently overwritten by the send path.
  const event: PricingEvent = { ...FIXED_CAMP, memberPrice: 450, nonMemberPrice: 600 };
  const nonMember = reg({ amountDue: 600 });
  check("recorded per-registrant price is what gets collected", amountToCollect(event, nonMember, 5) === 600);
  check("but it is flagged as differing from the event price", amountMismatch(event, nonMember, 5));
  check("a zero/absent amount falls back to the event price", amountToCollect(event, reg({ amountDue: 0 }), 5) === 450);
}

console.log("\n— pricing-change detection (what triggers the preview) —");
{
  check("estimate adjusted", pricingChanged(VARIABLE_CAMP, { ...VARIABLE_CAMP, variableCostTotal: 6000 }));
  check("expected signups adjusted", pricingChanged(VARIABLE_CAMP, { ...VARIABLE_CAMP, variableCostEstimatedSignups: 20 }));
  check("variable cost switched off", pricingChanged(VARIABLE_CAMP, FIXED_CAMP));
  check("flat price changed", pricingChanged(FIXED_CAMP, { ...FIXED_CAMP, memberPrice: 500 }));
  check("public pricing option switched", pricingChanged(FIXED_CAMP, { ...FIXED_CAMP, publicPricingOption: "NON_MEMBER" }));
  check("no pricing change on an unrelated edit", !pricingChanged(FIXED_CAMP, { ...FIXED_CAMP }));
  check(
    "string vs number decimals are the same price (Prisma returns strings)",
    !pricingChanged({ ...FIXED_CAMP, memberPrice: "450.00" }, { ...FIXED_CAMP, memberPrice: 450 }),
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
