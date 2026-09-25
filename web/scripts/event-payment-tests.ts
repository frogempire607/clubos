/**
 * Targeted tests for the event-registration payment-decision rules.
 * Pure-function tests only — no DB, no Stripe, no network. Run with:
 *   npx tsx scripts/event-payment-tests.ts
 * Exits non-zero on any failure.
 */
import { bundleAllowedPaymentMethods, bundleOfflineStatus, BUNDLE_STATUS_LABELS } from "../lib/bundlePurchases";
import {
  eventAllowedPaymentMethods,
  offlineStatusForMethod,
  eventScheduledChargeAt,
  checkinPaymentBlock,
  capacityWhere,
  CHECKOUT_HOLD_MS,
  ACTIVE_REGISTRATION_STATUSES,
  UNPAID_REGISTRATION_STATUSES,
  AWAITING_OFFLINE_STATUSES,
  CHECKIN_BLOCKING_STATUSES,
  EVENT_PAYMENT_METHOD_LABELS,
  REGISTRATION_STATUS_LABELS,
  REGISTRATION_STATUSES,
  isEventPaymentMethod,
  publicSignupRequiresAccount,
  approvalOptionsFromEventMethods,
  approvedAutoCardChargeAt,
} from "../lib/eventPayments";
import { eventFormFields, validateFormResponses } from "../lib/eventForm";

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

  // Regression: the legacy "registered but never paid" row (the College
  // Combine case) MUST stay in the owner's money-owed signal. Filtering it out
  // would hide the exact row this whole feature exists to collect.
  check("legacy REGISTERED is still chased for money", UNPAID_REGISTRATION_STATUSES.includes("REGISTERED"));
  check("awaiting-offline is cash+check only", JSON.stringify(AWAITING_OFFLINE_STATUSES) === '["AWAITING_CASH","AWAITING_CHECK"]');
}

console.log("\n— capacity (a spot is a spot) —");
{
  const now = new Date("2026-07-16T12:00:00Z");
  const w = capacityWhere(now) as {
    OR: [{ status: { in: string[] } }, { status: string; createdAt: { gte: Date } }];
  };
  // Before payment decisions every row held a spot from creation, so two
  // people could never both pass a capacity:1 check. An in-flight checkout must
  // keep doing that — otherwise N people check out at once, all pay, and the
  // club owes N-1 refunds.
  check("in-flight checkouts still hold a spot", w.OR[1].status === "PENDING_PAYMENT");
  check(
    "the hold is bounded to the checkout window",
    w.OR[1].createdAt.gte.getTime() === now.getTime() - CHECKOUT_HOLD_MS,
  );
  check("hold window is 30 minutes", CHECKOUT_HOLD_MS === 30 * 60_000);
  check("real registrations always hold a spot", w.OR[0].status.in.includes("PAID") && w.OR[0].status.in.includes("AWAITING_CASH"));
  check("canceled rows never hold a spot", !w.OR[0].status.in.includes("CANCELED"));
  // The abandoned-checkout half: it must eventually release, or an event fills
  // up with people who never paid (the old behavior).
  const stale = new Date(now.getTime() - CHECKOUT_HOLD_MS - 1000);
  check("an abandoned checkout releases its spot", stale < w.OR[1].createdAt.gte);
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

console.log("\n— bundle payment decision —");
{
  check("bundle null config = card-only (legacy)", JSON.stringify(bundleAllowedPaymentMethods({ paymentMethods: null })) === '["CARD"]');
  check("bundle empty config = card-only", JSON.stringify(bundleAllowedPaymentMethods({ paymentMethods: [] })) === '["CARD"]');
  check(
    "bundle config round-trips valid methods",
    JSON.stringify(bundleAllowedPaymentMethods({ paymentMethods: ["CASH", "PAY_LATER"] })) === '["CASH","PAY_LATER"]',
  );
  check(
    "bundle config drops junk values",
    JSON.stringify(bundleAllowedPaymentMethods({ paymentMethods: ["CARD", "BITCOIN", 42] })) === '["CARD"]',
  );
  // One distinct status per method — never a vague shared "pending".
  check("cash claim → AWAITING_CASH", bundleOfflineStatus("CASH") === "AWAITING_CASH");
  check("check claim → AWAITING_CHECK", bundleOfflineStatus("CHECK") === "AWAITING_CHECK");
  check("pay-later claim → PAY_LATER", bundleOfflineStatus("PAY_LATER") === "PAY_LATER");
  check(
    "pay-later label says the club invoices (not a card charge)",
    BUNDLE_STATUS_LABELS.PAY_LATER.includes("invoice"),
  );
  const distinct = new Set([bundleOfflineStatus("CASH"), bundleOfflineStatus("CHECK"), bundleOfflineStatus("PAY_LATER")]);
  check("offline statuses are all distinct", distinct.size === 3);
}

console.log("\n— public link: sign in vs contact the club (Finger Lakes Duals, 2026-09-24) —");
{
  const base = { stripeReady: true, owesMoney: true, billOnApproval: false };
  check("saved-card-only event ⇒ sign in", publicSignupRequiresAccount({ ...base, allowed: ["AUTO_CARD"] }) === true);
  check("saved card + cash ⇒ public can pay cash", publicSignupRequiresAccount({ ...base, allowed: ["AUTO_CARD", "CASH"] }) === false);
  check("saved card + card ⇒ public can pay by card", publicSignupRequiresAccount({ ...base, allowed: ["AUTO_CARD", "CARD"] }) === false);
  check(
    "saved card + card, Stripe not connected ⇒ sign in (card unusable publicly)",
    publicSignupRequiresAccount({ ...base, stripeReady: false, allowed: ["AUTO_CARD", "CARD"] }) === true,
  );
  check(
    "card only, Stripe not connected ⇒ NOT sign in (a real setup problem)",
    publicSignupRequiresAccount({ ...base, stripeReady: false, allowed: ["CARD"] }) === false,
  );
  check("free ⇒ never", publicSignupRequiresAccount({ ...base, owesMoney: false, allowed: ["AUTO_CARD"] }) === false);
  check("bill on approval ⇒ never", publicSignupRequiresAccount({ ...base, billOnApproval: true, allowed: ["AUTO_CARD"] }) === false);
}

console.log("\n— approval with no intent set follows the event's menu —");
{
  check("saved card only, card on file ⇒ AUTO_CARD", JSON.stringify(approvalOptionsFromEventMethods(["AUTO_CARD"], true)) === '["AUTO_CARD"]');
  check("saved card only, NO card ⇒ [] (add a card)", approvalOptionsFromEventMethods(["AUTO_CARD"], false).length === 0);
  check("never invoice when the owner picked saved card", !approvalOptionsFromEventMethods(["AUTO_CARD"], true).includes("INVOICE"));
  check(
    "saved card + cash, no card on file ⇒ cash",
    JSON.stringify(approvalOptionsFromEventMethods(["AUTO_CARD", "CASH"], false)) === '["CASH"]',
  );
  check(
    "card + cash + check keep their order",
    JSON.stringify(approvalOptionsFromEventMethods(["CHECK", "CASH", "CARD"], false)) === '["CARD","CASH","CHECK"]',
  );
}

console.log("\n— approved saved-card charge date —");
{
  const now = new Date("2026-10-01T15:00:00Z");
  const ev = { autoChargeDate: new Date("2026-11-14T12:00:00Z"), startsAt: new Date("2026-11-21T13:00:00Z") };
  check("approved before the date ⇒ the charge date", approvedAutoCardChargeAt(ev, now).toISOString() === "2026-11-14T12:00:00.000Z");
  const late = new Date("2026-11-16T15:00:00Z");
  check("approved after the date ⇒ now", approvedAutoCardChargeAt(ev, late).getTime() === late.getTime());
  check(
    "no charge date ⇒ event start",
    approvedAutoCardChargeAt({ autoChargeDate: null, startsAt: ev.startsAt }, now).getTime() === ev.startsAt.getTime(),
  );
}

console.log("\n— event questions (one validator for public + portal) —");
{
  const fields = eventFormFields([
    { id: "participant_category", type: "select", label: "Weight Class", options: ["56 (K4/K6)", "60 (K4/K6)"], required: true },
    { id: "participant_category:division", type: "select", label: "Division", options: ["K4", "K6", "K8"], required: true },
    { id: "notes", type: "textarea", label: "Notes", required: false },
    { id: "photo", type: "checkbox", label: "Photo ok", required: false },
    "garbage",
    { label: "no id" },
  ]);
  check("malformed entries dropped", fields.length === 4);
  const ok = validateFormResponses(fields, { participant_category: "60 (K4/K6)", "participant_category:division": " K6 ", notes: "" });
  check("valid answers pass, trimmed", ok.ok && ok.answers["participant_category:division"] === "K6");
  check("empty optional answer not stored", ok.ok && !("notes" in ok.answers));
  const missing = validateFormResponses(fields, { participant_category: "60 (K4/K6)" });
  check("missing required ⇒ names the field", !missing.ok && missing.message.includes("Division"));
  const bad = validateFormResponses(fields, { participant_category: "999", "participant_category:division": "K6" });
  check("select answer outside the list refused", !bad.ok && bad.fieldId === "participant_category");
  const injected = validateFormResponses(fields, {
    participant_category: "56 (K4/K6)",
    "participant_category:division": "K4",
    __documentsAcknowledged: "forged",
  });
  check("unknown keys dropped (server-written keys can't be forged)", injected.ok && !("__documentsAcknowledged" in injected.answers));
  check("no form ⇒ always ok, nothing stored", (() => { const r = validateFormResponses([], { x: "y" }); return r.ok && Object.keys(r.answers).length === 0; })());
  const box = eventFormFields([{ id: "w", type: "checkbox", label: "Waiver", required: true }]);
  check("required checkbox unticked refused", !validateFormResponses(box, { w: false }).ok);
  check("required checkbox ticked stored as true", (() => { const r = validateFormResponses(box, { w: true }); return r.ok && r.answers.w === true; })());
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
