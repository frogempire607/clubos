/**
 * Targeted tests for the event-registration payment-decision rules.
 * Pure-function tests only — no DB, no Stripe, no network. Run with:
 *   npx tsx scripts/event-payment-tests.ts
 * Exits non-zero on any failure.
 */
import {
  eventAllowedPaymentMethods,
  offlineStatusForMethod,
  eventScheduledChargeAt,
  checkinPaymentBlock,
  ACTIVE_REGISTRATION_STATUSES,
  UNPAID_REGISTRATION_STATUSES,
  CHECKIN_BLOCKING_STATUSES,
  EVENT_PAYMENT_METHOD_LABELS,
  REGISTRATION_STATUS_LABELS,
  REGISTRATION_STATUSES,
  isEventPaymentMethod,
} from "../lib/eventPayments";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

console.log("\n— allowed methods (owner config) —");
{
  // The back-compat contract: every event that predates this feature keeps
  // charging card-at-registration exactly as before.
  check("null config = card only (legacy behavior)", JSON.stringify(eventAllowedPaymentMethods({})) === '["CARD"]');
  check("null paymentMethods = card only", JSON.stringify(eventAllowedPaymentMethods({ paymentMethods: null })) === '["CARD"]');
  check("empty array = card only (never zero methods)", JSON.stringify(eventAllowedPaymentMethods({ paymentMethods: [] })) === '["CARD"]');
  check("non-array garbage = card only", JSON.stringify(eventAllowedPaymentMethods({ paymentMethods: "CASH" })) === '["CARD"]');
  check(
    "configured methods pass through",
    JSON.stringify(eventAllowedPaymentMethods({ paymentMethods: ["CARD", "CASH"] })) === '["CARD","CASH"]',
  );
  check(
    "unknown methods are dropped",
    JSON.stringify(eventAllowedPaymentMethods({ paymentMethods: ["CASH", "CRYPTO", "CHECK"] })) === '["CASH","CHECK"]',
  );
  check(
    "all-garbage array falls back to card (never empty)",
    JSON.stringify(eventAllowedPaymentMethods({ paymentMethods: ["CRYPTO", "VENMO"] })) === '["CARD"]',
  );
  check("isEventPaymentMethod accepts known", isEventPaymentMethod("AUTO_CARD"));
  check("isEventPaymentMethod rejects unknown", !isEventPaymentMethod("VENMO"));
  check("every method has a label", Object.keys(EVENT_PAYMENT_METHOD_LABELS).length === 4);
}

console.log("\n— status model —");
{
  check("cash → AWAITING_CASH", offlineStatusForMethod("CASH") === "AWAITING_CASH");
  check("check → AWAITING_CHECK", offlineStatusForMethod("CHECK") === "AWAITING_CHECK");
  check("every status has a label", REGISTRATION_STATUSES.every((s) => !!REGISTRATION_STATUS_LABELS[s]));

  // The load-bearing rule from the College Combine bug: an abandoned card
  // checkout is not a registration and owes nothing until it completes.
  check("PENDING_PAYMENT is not an active registration", !ACTIVE_REGISTRATION_STATUSES.includes("PENDING_PAYMENT"));
  check("PENDING_PAYMENT is not counted as money owed", !UNPAID_REGISTRATION_STATUSES.includes("PENDING_PAYMENT"));
  check("CANCELED is not active", !(ACTIVE_REGISTRATION_STATUSES as string[]).includes("CANCELED"));
  check("SCHEDULED holds a spot", ACTIVE_REGISTRATION_STATUSES.includes("SCHEDULED"));
  check("SCHEDULED is NOT money to chase (charge is committed)", !UNPAID_REGISTRATION_STATUSES.includes("SCHEDULED"));
  check("AWAITING_CASH is owed", UNPAID_REGISTRATION_STATUSES.includes("AWAITING_CASH"));
  check("AWAITING_CHECK is owed", UNPAID_REGISTRATION_STATUSES.includes("AWAITING_CHECK"));
  check("PAYMENT_FAILED is owed", UNPAID_REGISTRATION_STATUSES.includes("PAYMENT_FAILED"));
  check("PAID owes nothing", !UNPAID_REGISTRATION_STATUSES.includes("PAID"));
  check("PAID still holds the spot", ACTIVE_REGISTRATION_STATUSES.includes("PAID"));
}

console.log("\n— auto-charge timing —");
{
  const startsAt = new Date("2026-08-01T18:00:00Z");
  check("no autoChargeDate → charges on the event start", eventScheduledChargeAt({ startsAt }).getTime() === startsAt.getTime());
  const custom = new Date("2026-07-25T12:00:00Z");
  check(
    "explicit autoChargeDate wins",
    eventScheduledChargeAt({ startsAt, autoChargeDate: custom }).getTime() === custom.getTime(),
  );
  check(
    "null autoChargeDate falls back to start",
    eventScheduledChargeAt({ startsAt, autoChargeDate: null }).getTime() === startsAt.getTime(),
  );
}

console.log("\n— check-in payment gate —");
{
  const gated = { requirePaymentBeforeCheckin: true };
  const ungated = { requirePaymentBeforeCheckin: false };
  const cashOwed = { status: "AWAITING_CASH", amountDue: 120 };

  check("setting off → never blocks", checkinPaymentBlock(ungated, cashOwed) === null);
  check("setting null → never blocks", checkinPaymentBlock({}, cashOwed) === null);
  check("owed cash blocks when gated", checkinPaymentBlock(gated, cashOwed) !== null);
  check("block message names the amount", (checkinPaymentBlock(gated, cashOwed) ?? "").includes("$120.00"));
  check(
    "owed check blocks and says check",
    (checkinPaymentBlock(gated, { status: "AWAITING_CHECK", amountDue: 50 }) ?? "").includes("check"),
  );
  check("failed charge blocks", checkinPaymentBlock(gated, { status: "PAYMENT_FAILED", amountDue: 50 }) !== null);
  check("abandoned checkout blocks", checkinPaymentBlock(gated, { status: "PENDING_PAYMENT", amountDue: 50 }) !== null);

  // A consented auto-charge is committed money — the door is not the place to
  // relitigate it.
  check("SCHEDULED never blocks (charge already authorized)", checkinPaymentBlock(gated, { status: "SCHEDULED", amountDue: 120 }) === null);
  check("PAID never blocks", checkinPaymentBlock(gated, { status: "PAID", amountDue: 120 }) === null);
  check("plain REGISTERED never blocks", checkinPaymentBlock(gated, { status: "REGISTERED", amountDue: null }) === null);

  // Fail-open cases — a payment setting must not become a door lock for people
  // who legitimately have no registration row or owe nothing.
  check("no registration row → allowed (membership-covered, staff-added, free)", checkinPaymentBlock(gated, null) === null);
  check("$0 due → allowed even if status says awaiting", checkinPaymentBlock(gated, { status: "AWAITING_CASH", amountDue: 0 }) === null);
  check("null amountDue → allowed", checkinPaymentBlock(gated, { status: "AWAITING_CASH", amountDue: null }) === null);
  check("every blocking status is a real status", CHECKIN_BLOCKING_STATUSES.every((s) => (REGISTRATION_STATUSES as readonly string[]).includes(s)));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
