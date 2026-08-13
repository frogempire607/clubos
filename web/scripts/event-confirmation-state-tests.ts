/**
 * Phase 5 spine tests — the opt-in policy, the waitingOn resolver, the
 * confirmation render matrix, the reminder scheduler, and the confirmation
 * code. Pure-function tests only — no DB, no Stripe, no network. Run with:
 *   npx tsx scripts/event-confirmation-state-tests.ts
 * Exits non-zero on any failure.
 *
 * The matrix walk at the bottom is the point of the file: it asserts every
 * render key produces a headline, a charge-timing sentence in one of the six
 * shapes §5.2.6 allows, a waitingOn, and a confirmation URL — so a state can
 * never reach a registrant as a blank line.
 */
import {
  resolveEventPolicy,
  registrationWaitingOn,
  capacityWhere,
  escalationDays,
  DEFAULT_EVENT_POLICY,
  ACTIVE_REGISTRATION_STATUSES,
  UNPAID_REGISTRATION_STATUSES,
  CHECKIN_BLOCKING_STATUSES,
  REGISTRATION_STATUSES,
  REGISTRATION_STATUS_LABELS,
  checkinPaymentBlock,
} from "../lib/eventPayments";
import {
  renderableRegistrationState,
  registrationRenderKey,
  REGISTRATION_RENDER_KEYS,
  type RegistrationRenderKey,
} from "../lib/registrationRenderState";
import { amountToCollect, registrationListPrice } from "../lib/eventRepricing";
import { applyProcessingFee } from "../lib/fees";
import { computeNextReminderAt, resolveReminderAnchor } from "../lib/eventReminders";
import { confirmationCodeFor, isConfirmationCode } from "../lib/confirmationCode";
import { registrationUrl, registrationReturnUrl } from "../lib/registrationUrl";
import {
  resolveCategoryFields,
  resolveExtraEntryLabel,
  proposableKeys,
  proposalNotePlaceholder,
  labelForChangeKey,
  categoryFieldsFromForm,
  fieldIdForKey,
  PARTICIPANT_FIELD_ID,
  DEFAULT_EXTRA_ENTRY_LABEL,
} from "../lib/eventCategories";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-09-01T12:00:00Z");
const START = new Date("2026-10-01T15:00:00Z");
const END = new Date("2026-10-01T20:00:00Z");

const CLUB = { name: "Frog Empire", contactEmail: "info@frogempire.test", timezone: "America/Chicago" };

const baseEvent = {
  id: "evt_1",
  name: "Fall Duals",
  startsAt: START,
  endsAt: END,
  publicSlug: "fall-duals",
  memberPrice: 100,
  nonMemberPrice: 100,
  registrationDeadline: new Date("2026-09-20T00:00:00Z"),
};

const baseReg = {
  id: "reg_abc12345",
  name: "Cameron Hall",
  status: "REGISTERED",
  amountDue: 100,
  createdAt: new Date("2026-08-20T00:00:00Z"),
};

function ctx(reg: Record<string, unknown>, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return renderableRegistrationState({
    registration: { ...baseReg, ...reg } as never,
    event: { ...baseEvent, ...event } as never,
    club: CLUB,
    activeCount: 10,
    baseUrl: "https://athletix-os.com",
    now: NOW,
    ...extra,
  });
}

console.log("\n— policy resolution (§5.3) —");
{
  check("no config = everything off", JSON.stringify(resolveEventPolicy({})) === JSON.stringify(DEFAULT_EVENT_POLICY));
  check("null event = everything off", resolveEventPolicy(null).requiresCoachApproval === false);
  check(
    "event type default turns approval on",
    resolveEventPolicy({ customEventType: { defaultPolicy: { requiresCoachApproval: true } } }).requiresCoachApproval,
  );
  check(
    "an explicit false on the event beats a true on the type",
    resolveEventPolicy({
      requiresCoachApproval: false,
      customEventType: { defaultPolicy: { requiresCoachApproval: true } },
    }).requiresCoachApproval === false,
  );
  check(
    "null on the event inherits the type (not 'off')",
    resolveEventPolicy({
      requiresCoachApproval: null,
      customEventType: { defaultPolicy: { requiresCoachApproval: true } },
    }).requiresCoachApproval,
  );
  check(
    "proposals can't be on without approval",
    resolveEventPolicy({ allowProposedChanges: true }).allowProposedChanges === false,
  );
  check(
    "proposals resolve on when approval is on",
    resolveEventPolicy({ requiresCoachApproval: true, allowProposedChanges: true }).allowProposedChanges,
  );
  check("garbage intent falls back", resolveEventPolicy({ approvalPaymentIntent: "VENMO" }).approvalPaymentIntent === "PARENT_CHOOSES");
  check(
    "a half-written type blob degrades instead of throwing",
    resolveEventPolicy({ customEventType: { defaultPolicy: "not-an-object" } }).requiresCoachApproval === false,
  );
  check("holdSpotDuringReview never inherits", resolveEventPolicy({ customEventType: { defaultPolicy: { holdSpotDuringReview: true } } }).holdSpotDuringReview === false);
  check("default cadence is the tournament one", escalationDays(DEFAULT_EVENT_POLICY).join(",") === "-14,-7,-3,-1,0,2");
  check(
    "CUSTOM reads the event's own days, sorted",
    escalationDays(resolveEventPolicy({ escalationSchedule: "CUSTOM", escalationCustomDays: [0, -30, -2] })).join(",") ===
      "-30,-2,0",
  );
}

console.log("\n— status model + capacity (§5.4.1, §5.4.2) —");
{
  check("PENDING_REVIEW is a real status", (REGISTRATION_STATUSES as readonly string[]).includes("PENDING_REVIEW"));
  check("every status still has a label", REGISTRATION_STATUSES.every((s) => !!REGISTRATION_STATUS_LABELS[s]));
  check("PENDING_REVIEW is NOT a spot", !(ACTIVE_REGISTRATION_STATUSES as string[]).includes("PENDING_REVIEW"));
  check("PENDING_REVIEW owes nothing yet", !(UNPAID_REGISTRATION_STATUSES as string[]).includes("PENDING_REVIEW"));
  check("PENDING_REVIEW blocks the door", (CHECKIN_BLOCKING_STATUSES as string[]).includes("PENDING_REVIEW"));
  check(
    "check-in copy names the real problem",
    checkinPaymentBlock({ requirePaymentBeforeCheckin: true }, { status: "PENDING_REVIEW", amountDue: 100 })?.includes(
      "coach approval",
    ) === true,
  );
  const off = capacityWhere(NOW) as { OR: Array<Record<string, unknown>> };
  const on = capacityWhere(NOW, { holdSpotDuringReview: true }) as { OR: Array<Record<string, unknown>> };
  check("by default a review request holds no spot", off.OR.every((c) => c.status !== "PENDING_REVIEW"));
  check("with the opt-in it does", on.OR.some((c) => c.status === "PENDING_REVIEW"));
}

console.log("\n— waitingOn (§5.4.4) —");
{
  const w = (reg: Record<string, unknown>) => registrationWaitingOn({ ...baseReg, ...reg } as never, { now: NOW });
  check("pending approval waits on the coach", w({ status: "PENDING_REVIEW", approvalStatus: "PENDING" }) === "COACH");
  check(
    "paid up front but unapproved STILL waits on the coach",
    w({ status: "PAID", approvalStatus: "PENDING" }) === "COACH",
  );
  check(
    "an open proposal outranks the pending approval",
    w({ status: "PENDING_REVIEW", approvalStatus: "PENDING", proposedChange: { proposedAt: "x" } }) === "PARENT",
  );
  check(
    "an answered proposal doesn't",
    w({
      status: "PENDING_REVIEW",
      approvalStatus: "PENDING",
      proposedChange: { proposedAt: "x" },
      proposedChangeRespondedAt: NOW,
    }) === "COACH",
  );
  check("declined is terminal", w({ status: "PAID", approvalStatus: "DECLINED" }) === "CANCELED");
  check("cash owed waits on payment", w({ status: "AWAITING_CASH" }) === "PAYMENT");
  check("a scheduled charge is still payment", w({ status: "SCHEDULED" }) === "PAYMENT");
  check("paid is complete", w({ status: "PAID", amountDue: 0 }) === "COMPLETE");
  check("free is complete", w({ status: "REGISTERED", amountDue: 0 }) === "COMPLETE");
  check("registered owing money waits on payment", w({ status: "REGISTERED", amountDue: 100 }) === "PAYMENT");
  check(
    "an expired checkout is not money to chase",
    w({ status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 60 * 60_000) }) === "CANCELED",
  );
  check(
    "a live checkout is",
    w({ status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 10_000) }) === "PAYMENT",
  );
}

console.log("\n— render keys (§5.2.6) —");
{
  const k = (reg: Record<string, unknown>, event: Record<string, unknown> = {}, o: Record<string, unknown> = {}) =>
    registrationRenderKey({ ...baseReg, ...reg } as never, { ...baseEvent, ...event } as never, { now: NOW, ...o });
  check("pending review", k({ status: "PENDING_REVIEW", approvalStatus: "PENDING" }) === "PENDING_REVIEW");
  check("paid-then-pending renders as the request, not the receipt", k({ status: "PAID", approvalStatus: "PENDING" }) === "PENDING_REVIEW");
  check(
    "open proposal",
    k({ status: "PENDING_REVIEW", approvalStatus: "PENDING", proposedChange: { proposedAt: NOW.toISOString() } }) ===
      "PROPOSED_CHANGE_PENDING",
  );
  check("coach decline", k({ status: "CANCELED", approvalStatus: "DECLINED" }) === "DECLINED_BY_COACH");
  check(
    "proposal decline reads differently from a plain cancel",
    k({ status: "CANCELED", proposedChangeAccepted: false }) === "CANCELED_PROPOSAL_DECLINED",
  );
  check("plain cancel", k({ status: "CANCELED" }) === "CANCELED_BY_PARENT");
  check("approval charge in flight", k({ status: "SCHEDULED", paymentMethod: "APPROVAL_CHARGE", approvalStatus: "APPROVED" }) === "SCHEDULED_APPROVAL_CHARGE");
  check("event-day charge", k({ status: "SCHEDULED", paymentMethod: "AUTO_CARD" }) === "SCHEDULED_EVENT_DATE");
  check("checkout just started", k({ status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 5_000) }) === "PENDING_PAYMENT_INFLIGHT");
  check("checkout dragging", k({ status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 120_000) }) === "PENDING_PAYMENT_INFLIGHT_SLOW");
  check("checkout expired", k({ status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 60 * 60_000) }) === "PENDING_PAYMENT_EXPIRED");
  check("cash", k({ status: "AWAITING_CASH" }) === "AWAITING_CASH");
  check("check", k({ status: "AWAITING_CHECK" }) === "AWAITING_CHECK");
  check("declined card", k({ status: "PAYMENT_FAILED" }) === "PAYMENT_FAILED");
  check("paid", k({ status: "PAID" }) === "PAID");
  check("free", k({ status: "REGISTERED", amountDue: 0 }, { memberPrice: 0, nonMemberPrice: 0 }) === "FREE_CONFIRMED");
  check(
    "membership-covered",
    k({ status: "REGISTERED", amountDue: 0 }, { memberPrice: 0, nonMemberPrice: 0 }, { membershipName: "Full Season" }) ===
      "COVERED_BY_MEMBERSHIP",
  );
  check("registered owing money", k({ status: "REGISTERED", amountDue: 100 }) === "REGISTERED_AMOUNT_DUE");
}

console.log("\n— copy discipline (§5.2.6 rule) —");
{
  // Every state's charge-timing sentence must be one of the six shapes, so no
  // registrant is ever told something ambiguous about their money.
  const SHAPES = [
    /charged today/i,
    /the moment your coach approves|when your coach approves|is being charged|charged .* on /i,
    /bring .* in (cash|check)|check for/i,
    /was charged/i,
    /nothing (owed|charged)|no card required|isn't charged|wasn't charged|nothing to refund|refunded/i,
    /payment (of|will be)|estimated share|declined|processing|waiting for Stripe|wasn't completed|taking longer/i,
    // A seventh shape the matrix didn't anticipate: the misconfiguration state,
    // where the honest sentence is "nothing charged, and we can't tell you the
    // amount yet". It is still one of the enumerated shapes — it just had to be
    // enumerated (2026-08-12).
    /nothing has been charged/i,
  ];
  const cases: Array<[RegistrationRenderKey, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
    ["PENDING_REVIEW", { status: "PENDING_REVIEW", approvalStatus: "PENDING", paymentMethod: "APPROVAL_CHARGE" }, {}, {}],
    ["PENDING_REVIEW", { status: "PENDING_REVIEW", approvalStatus: "PENDING", paymentMethod: "INVOICE" }, {}, {}],
    ["PENDING_REVIEW", { status: "AWAITING_CASH", approvalStatus: "PENDING", paymentMethod: "CASH" }, {}, {}],
    ["PENDING_REVIEW", { status: "PAID", approvalStatus: "PENDING", paymentMethod: "CARD", amountPaid: 100 }, {}, {}],
    ["PROPOSED_CHANGE_PENDING", { status: "PENDING_REVIEW", approvalStatus: "PENDING", proposedChange: { proposedAt: NOW.toISOString(), priceDelta: 25, changes: { division: "16U" } } }, {}, {}],
    ["SCHEDULED_APPROVAL_CHARGE", { status: "SCHEDULED", paymentMethod: "APPROVAL_CHARGE", approvalStatus: "APPROVED" }, {}, {}],
    ["SCHEDULED_EVENT_DATE", { status: "SCHEDULED", paymentMethod: "AUTO_CARD", scheduledChargeAt: START }, {}, {}],
    ["PENDING_PAYMENT_INFLIGHT", { status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 5_000) }, {}, {}],
    ["PENDING_PAYMENT_INFLIGHT_SLOW", { status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 120_000) }, {}, {}],
    ["PENDING_PAYMENT_EXPIRED", { status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 60 * 60_000) }, {}, {}],
    ["AWAITING_CASH", { status: "AWAITING_CASH" }, {}, {}],
    ["AWAITING_CHECK", { status: "AWAITING_CHECK" }, {}, {}],
    ["PAYMENT_FAILED", { status: "PAYMENT_FAILED", paymentUrl: "https://checkout.stripe.com/x" }, {}, {}],
    ["PAID", { status: "PAID", amountPaid: 100, paidAt: NOW, transactionId: "tx_1" }, {}, {}],
    ["FREE_CONFIRMED", { status: "REGISTERED", amountDue: 0 }, { memberPrice: 0, nonMemberPrice: 0 }, {}],
    ["COVERED_BY_MEMBERSHIP", { status: "REGISTERED", amountDue: 0 }, { memberPrice: 0, nonMemberPrice: 0 }, { membershipName: "Full Season" }],
    ["REGISTERED_AMOUNT_DUE", { status: "REGISTERED", amountDue: 100 }, {}, {}],
    ["PRICE_UNRESOLVED", { status: "REGISTERED", amountDue: 0 }, { variableCostEnabled: true, variableCostTotal: null }, {}],
    ["CANCELED_BY_PARENT", { status: "CANCELED" }, {}, {}],
    ["DECLINED_BY_COACH", { status: "CANCELED", approvalStatus: "DECLINED", declinedReason: "Weight class is full." }, {}, {}],
    ["CANCELED_PROPOSAL_DECLINED", { status: "CANCELED", proposedChangeAccepted: false }, {}, {}],
  ];
  const seen = new Set<string>();
  for (const [expected, reg, event, extra] of cases) {
    const c = ctx(reg, event, extra);
    seen.add(c.key);
    check(`${expected}: key`, c.key === expected, c.key);
    check(`${expected}: has a headline`, c.headline.length > 3);
    check(`${expected}: charge timing is one of the allowed shapes`, SHAPES.some((r) => r.test(c.chargeTiming)), c.chargeTiming);
    check(`${expected}: badge label`, c.waitingOnLabel.length > 0);
    check(`${expected}: live URL, not a snapshot`, c.confirmationUrl === "https://athletix-os.com/e/fall-duals/registered/reg_abc12345");
    check(`${expected}: confirmation number present`, c.meta.confirmationCode.length > 0);
  }
  check("every render key is exercised", REGISTRATION_RENDER_KEYS.every((k) => seen.has(k)), [...seen]);
}

console.log("\n— money comes from one resolver (§5.0 ownership) —");
{
  const discounted = ctx({
    status: "AWAITING_CASH",
    amountDue: 90,
    discountCode: "SIBLING10",
    discountType: "PERCENT",
    discountValue: 10,
    discountAmount: 10,
  });
  check("the discounted number is the one printed", discounted.chargeTiming.includes("$90.00"), discounted.chargeTiming);
  check("the code is surfaced", discounted.meta.discountLabel === "SIBLING10 — $10.00 off");
  const paid = ctx({ status: "PAID", amountPaid: 90, amountDue: 90 });
  check("a settled row shows no amount due", paid.meta.amountDue === null);
  check("a settled row shows what was paid", paid.meta.amountPaid === 90);
  const owed = ctx({ status: "AWAITING_CASH", amountDue: 90 });
  check("an unsettled row shows the amount due", owed.meta.amountDue === 90);
}

console.log("\n— proximity + escalation display —");
{
  const due = new Date("2026-09-03T12:00:00Z");
  const c = ctx({ status: "AWAITING_CASH", reminderStage: 3 }, { paymentDueBy: due });
  check("due date surfaces on a payment state", c.meta.dueDate?.toISOString() === due.toISOString());
  check("proximity badge reads in club time", c.meta.proximityBadge === "3_DAYS", c.meta.proximityBadge);
  check("stage carries through", c.meta.escalationStage === 3);
  const paid = ctx({ status: "PAID", amountPaid: 100 }, { paymentDueBy: due });
  check("a paid row shows no due date", paid.meta.dueDate === null);
}

console.log("\n— refund copy (§5.2.9) —");
{
  const full = ctx({ status: "CANCELED", amountPaid: 100 }, {}, { amountRefunded: 100, refundedAt: NOW });
  check("full refund names the amount", full.chargeTiming.includes("$100.00") && /refunded/i.test(full.chargeTiming));
  const partial = ctx({ status: "CANCELED", amountPaid: 100 }, {}, { amountRefunded: 40, refundedAt: NOW });
  check("partial refund shows both sides", partial.chargeTiming.includes("$40.00") && partial.chargeTiming.includes("$60.00"), partial.chargeTiming);
  const never = ctx({ status: "CANCELED", amountPaid: null });
  check("never charged says so", /nothing to refund/i.test(never.chargeTiming), never.chargeTiming);
  const owed = ctx({ status: "CANCELED", amountPaid: 100 });
  check("charged but unrefunded points at a human", /contact/i.test(owed.chargeTiming), owed.chargeTiming);
}

console.log("\n— reminder scheduling (§5.6.3–§5.6.5) —");
{
  const on = resolveEventPolicy({ escalationEnabled: true, requiresCoachApproval: true });
  const off = resolveEventPolicy({});
  const anchorEvent = { registrationDeadline: new Date("2026-09-20T00:00:00Z"), startsAt: START };
  const owing = { status: "AWAITING_CASH", amountDue: 100, createdAt: new Date("2026-08-01T00:00:00Z") };

  check("escalation off = never scheduled", computeNextReminderAt(owing, anchorEvent, off, { now: NOW }) === null);
  check(
    "paymentDueBy outranks everything",
    resolveReminderAnchor({ ...anchorEvent, paymentDueBy: new Date("2026-09-10T00:00:00Z") }, on)?.toISOString() ===
      "2026-09-10T00:00:00.000Z",
  );
  check(
    "eventStart anchor is honored",
    resolveReminderAnchor(anchorEvent, resolveEventPolicy({ escalationEnabled: true, escalationAnchor: "eventStart" }))?.toISOString() ===
      START.toISOString(),
  );
  check("no dates at all = no schedule", resolveReminderAnchor({}, on) === null);

  const next = computeNextReminderAt(owing, anchorEvent, on, { now: NOW });
  // Anchor 2026-09-20; DEFAULT_TOURNAMENT stages -14/-7/-3/-1/0/+2; now is 09-01,
  // so the first stage still in the future is -14 = 09-06.
  check("the next stage is the first one still ahead", next?.toISOString() === "2026-09-06T00:00:00.000Z", next);

  const late = computeNextReminderAt(
    { ...owing, createdAt: new Date("2026-09-18T00:00:00Z") },
    anchorEvent,
    on,
    { now: new Date("2026-09-18T00:00:00Z") },
  );
  check("stages already past when they registered never fire", late?.toISOString() === "2026-09-19T00:00:00.000Z", late);

  check(
    "a paid registration is never scheduled",
    computeNextReminderAt({ status: "PAID", amountDue: 0 }, anchorEvent, on, { now: NOW }) === null,
  );
  check(
    "a review request is never scheduled — money isn't the blocker",
    computeNextReminderAt({ status: "PENDING_REVIEW", approvalStatus: "PENDING", amountDue: 100 }, anchorEvent, on, { now: NOW }) === null,
  );
  check(
    "a scheduled card charge is never reminded",
    computeNextReminderAt({ status: "SCHEDULED", amountDue: 100 }, anchorEvent, on, { now: NOW }) === null,
  );
  check(
    "a canceled row is never reminded",
    computeNextReminderAt({ status: "CANCELED", amountDue: 100 }, anchorEvent, on, { now: NOW }) === null,
  );
  check(
    "after a send, the next stage is the one after it",
    computeNextReminderAt(
      { ...owing, lastReminderAt: new Date("2026-09-06T00:00:00Z"), reminderStage: 1 },
      anchorEvent,
      on,
      { now: new Date("2026-09-06T01:00:00Z") },
    )?.toISOString() === "2026-09-13T00:00:00.000Z",
  );
}


console.log("\n— a priced event is never free (2026-08-12 regression) —");
{
  // The exact shape that shipped the bug: a tournament with a MEMBER price and
  // no non-member price, shared cost off, registrant approved on a saved card.
  // publicFixedPrice reads nonMemberPrice, so this used to resolve to $0 —
  // the approval charged nothing and the email said "this event is free".
  const memberOnlyEvent = {
    ...baseEvent,
    memberPrice: 1,
    nonMemberPrice: null,
    dropInFee: null,
    publicPricingOption: null,
    variableCostEnabled: false,
  };
  const approved = {
    id: "reg_p5_memberprice",
    name: "John Doe",
    memberId: "m_john",
    status: "SCHEDULED",
    approvalStatus: "APPROVED",
    paymentMethod: "APPROVAL_CHARGE",
    amountDue: null,
    createdAt: baseReg.createdAt,
  };

  check(
    "member-linked registration is quoted the member price, not zero",
    amountToCollect(memberOnlyEvent as never, approved as never, 10) === 1,
    amountToCollect(memberOnlyEvent as never, approved as never, 10),
  );
  check(
    "a walk-in on the same event is quoted it too (the owner set A price)",
    registrationListPrice(memberOnlyEvent as never, { memberId: null }) === 1,
    registrationListPrice(memberOnlyEvent as never, { memberId: null }),
  );
  check(
    "a non-member still prefers the non-member price when it exists",
    registrationListPrice({ ...memberOnlyEvent, nonMemberPrice: 25 } as never, { memberId: null }) === 25,
  );
  check(
    "a member still prefers the member price when both exist",
    registrationListPrice({ ...memberOnlyEvent, nonMemberPrice: 25 } as never, { memberId: "m_john" }) === 1,
  );
  check(
    "publicPricingOption is still honored for a walk-in",
    registrationListPrice(
      { ...memberOnlyEvent, nonMemberPrice: 25, dropInFee: 10, publicPricingOption: "DROP_IN" } as never,
      { memberId: null },
    ) === 10,
  );
  check(
    "a genuinely free event is still free",
    registrationListPrice({ ...baseEvent, memberPrice: null, nonMemberPrice: null, dropInFee: null } as never) === 0,
  );

  // What the charge engine will actually send Stripe on approval: the resolved
  // $1.00 through the shared fee helper, with the club passing fees on.
  const fee = applyProcessingFee(Math.round(amountToCollect(memberOnlyEvent as never, approved as never, 10) * 100), true);
  check("the approval charge totals $1.03 at Stripe", fee.totalCents === 103, fee);
  check("…of which $0.03 is the passed-through processing fee", fee.feeCents === 3, fee);
  check(
    "and with fees absorbed it is exactly the ticket price",
    applyProcessingFee(100, false).totalCents === 100,
  );

  const c = ctx(approved, memberOnlyEvent, { cardLabel: "Amex ····1005 (Julian G Ramirez)" });
  check("approved saved-card registration does NOT render as free", c.key !== "FREE_CONFIRMED", c.key);
  check("it renders as the in-flight approval charge", c.key === "SCHEDULED_APPROVAL_CHARGE", c.key);
  check("and it names the real amount", c.chargeTiming.includes("$1.00"), c.chargeTiming);

  // The misconfiguration guard: a priced event that somehow resolves to zero
  // says so instead of reassuring the family.
  const brokenPricing = ctx(
    { status: "REGISTERED", amountDue: 0, memberId: "m_john" },
    { ...baseEvent, memberPrice: 0, nonMemberPrice: 0, dropInFee: 0, variableCostEnabled: true, variableCostTotal: null },
  );
  check("shared cost with no total is NOT free", brokenPricing.key === "PRICE_UNRESOLVED", brokenPricing.key);
  check("and it reads as a warning", brokenPricing.severity === "warn");
  check(
    "and it promises nothing about the money",
    /couldn't work out|confirm the amount/i.test(`${brokenPricing.subheadline} ${brokenPricing.chargeTiming}`),
    brokenPricing.chargeTiming,
  );
}

console.log("\n— a card never appears next to 'nothing owed' —");
{
  // The pair that shipped: "Nothing owed — this event is free" with
  // "Card on file: Amex ····1005" in the table underneath. Walk every key with
  // a card resolved and assert the two can never co-render.
  const CARD = "Amex ····1005 (Julian G Ramirez)";
  const freeish = /nothing owed|this event is free|nothing to refund|no card required/i;
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
    ["free event", { status: "REGISTERED", amountDue: 0 }, { memberPrice: 0, nonMemberPrice: 0 }, {}],
    ["membership-covered", { status: "REGISTERED", amountDue: 0 }, { memberPrice: 0, nonMemberPrice: 0 }, { membershipName: "Full Season" }],
    ["cash at the door", { status: "AWAITING_CASH", paymentMethod: "CASH" }, {}, {}],
    ["check at the door", { status: "AWAITING_CHECK", paymentMethod: "CHECK" }, {}, {}],
    ["invoiced later", { status: "REGISTERED", amountDue: 100, paymentMethod: "INVOICE" }, {}, {}],
    ["awaiting a coach on cash", { status: "AWAITING_CASH", approvalStatus: "PENDING", paymentMethod: "CASH" }, {}, {}],
    ["awaiting a coach on an invoice", { status: "PENDING_REVIEW", approvalStatus: "PENDING", paymentMethod: "INVOICE" }, {}, {}],
    ["canceled with nothing charged", { status: "CANCELED", amountPaid: null }, {}, {}],
    ["checkout expired", { status: "PENDING_PAYMENT", createdAt: new Date(NOW.getTime() - 60 * 60_000) }, {}, {}],
  ];
  for (const [label, reg, event, extra] of cases) {
    const c = ctx(reg, event, { cardLabel: CARD, ...extra });
    check(`${label}: no card rendered`, c.meta.cardLabel === null, c.meta.cardLabel);
  }

  // …and it IS kept where the card is the story.
  const kept: Array<[string, Record<string, unknown>]> = [
    ["paid by card", { status: "PAID", amountPaid: 100, paidAt: NOW }],
    ["charge failed", { status: "PAYMENT_FAILED" }],
    ["charging on approval", { status: "SCHEDULED", paymentMethod: "APPROVAL_CHARGE", approvalStatus: "APPROVED" }],
    ["scheduled for the event date", { status: "SCHEDULED", paymentMethod: "AUTO_CARD", scheduledChargeAt: START }],
    ["awaiting a coach on a saved card", { status: "PENDING_REVIEW", approvalStatus: "PENDING", paymentMethod: "APPROVAL_CHARGE" }],
  ];
  for (const [label, reg] of kept) {
    const c = ctx(reg, {}, { cardLabel: CARD });
    check(`${label}: card kept`, c.meta.cardLabel === CARD, c.meta.cardLabel);
  }

  // The invariant itself, over every key the matrix can produce.
  for (const [label, reg, event, extra] of [...cases, ...kept.map((k) => [k[0], k[1], {}, {}] as [string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>])]) {
    const c = ctx(reg, event, { cardLabel: CARD, ...extra });
    const saysFree = freeish.test(c.chargeTiming);
    check(
      `${label} (${c.key}): never "nothing owed" AND a card`,
      !(saysFree && c.meta.cardLabel !== null),
      { chargeTiming: c.chargeTiming, cardLabel: c.meta.cardLabel },
    );
  }
}


console.log("\n— entry categories are the club's words, not a sport's —");
{
  // A wrestling club: two categories, both with value lists.
  const wrestling = {
    registrationForm: [
      { id: PARTICIPANT_FIELD_ID, label: "Weight Class", type: "select", required: true, options: ["106", "113"] },
      { id: fieldIdForKey("division"), label: "Division", type: "select", required: true, options: ["14U", "16U"] },
    ],
  };
  // A judo club: a belt and a weight, different words, same code.
  const judo = {
    registrationForm: [
      { id: PARTICIPANT_FIELD_ID, label: "Belt", type: "select", required: true, options: ["White", "Yellow"] },
      { id: fieldIdForKey("weight"), label: "Weight", type: "select", required: true, options: ["-38kg", "-42kg"] },
    ],
  };
  // A soccer club: one category, no value list — free text is the fallback.
  const soccer = {
    registrationForm: [{ id: PARTICIPANT_FIELD_ID, label: "Position", type: "text", required: false, options: [] }],
  };

  check("two categories resolve in order", resolveCategoryFields(wrestling).map((f) => f.label).join(",") === "Weight Class,Division");
  check("a different sport resolves its own", resolveCategoryFields(judo).map((f) => f.label).join(",") === "Belt,Weight");
  check("one category is fine", resolveCategoryFields(soccer).length === 1);
  check(
    "no categories at all is fine",
    resolveCategoryFields({ registrationForm: [] }).length === 0,
  );
  check(
    "a value list makes it a picker, no list makes it free text",
    resolveCategoryFields(wrestling)[0].options.length === 2 && resolveCategoryFields(soccer)[0].options.length === 0,
  );
  check(
    "the first field keeps the legacy reserved id, so old events round-trip",
    categoryFieldsFromForm([{ id: PARTICIPANT_FIELD_ID, label: "Weight Class", options: ["106"] }])[0].key === "category",
  );
  check(
    "type defaults are the fallback when the event's form has none",
    resolveCategoryFields({ registrationForm: [] }, { categoryFields: [{ key: "belt", label: "Belt", options: [] }] })[0].label === "Belt",
  );
  check(
    "the event's own form always wins over the type default",
    resolveCategoryFields(soccer, { categoryFields: [{ key: "belt", label: "Belt", options: [] }] })[0].label === "Position",
  );

  // What a coach may propose is the club's fields plus the structural keys —
  // never a fixed list named after one sport.
  const keys = proposableKeys(resolveCategoryFields(judo));
  check("proposable keys follow the club's categories", keys.includes("category") && keys.includes("weight"), keys);
  check("session is always proposable", keys.includes("session"));
  check("one more entry is always proposable", keys.includes("extraEntry"));
  check("a foreign sport's key is not proposable", !keys.includes("weightClass"), keys);

  check("extra-entry label defaults neutrally", resolveExtraEntryLabel(null) === DEFAULT_EXTRA_ENTRY_LABEL);
  check("…and is the club's word when they set one", resolveExtraEntryLabel({ extraEntryLabel: "Swim another heat" }) === "Swim another heat");

  const ph = proposalNotePlaceholder(resolveCategoryFields(judo));
  check("the note placeholder speaks the club's vocabulary", ph.includes("White") && ph.includes("Yellow"), ph);
  check(
    "…and stays neutral with nothing configured",
    !/weight|wrestl|dual/i.test(proposalNotePlaceholder([])),
    proposalNotePlaceholder([]),
  );

  // A proposal snapshots its labels, so renaming a category later can't
  // relabel a decision a family already answered.
  check("stored labels win", labelForChangeKey("category", { category: "Belt" }) === "Belt");
  check("structural keys have neutral names", labelForChangeKey("extraEntry", null, "Swim another heat") === "Swim another heat");
  check("pre-configurable keys still render", labelForChangeKey("weightClass") === "Weight class");
  check("an unknown key degrades to itself, never to a sport", labelForChangeKey("zzz") === "zzz");
}


console.log("\n— one address per registration (§5.2.3) —");
{
  const base = "https://athletix-os.com";
  check(
    "a public event uses the readable form",
    registrationUrl(base, { publicSlug: "fall-duals" }, "reg_1") === "https://athletix-os.com/e/fall-duals/registered/reg_1",
  );
  check(
    "an event with no slug still has an address",
    registrationUrl(base, { publicSlug: null }, "reg_1") === "https://athletix-os.com/r/reg_1",
  );
  check(
    "never /e//… — the 404 that /pay/complete existed to patch",
    !registrationUrl(base, { publicSlug: "" }, "reg_1").includes("/e//"),
    registrationUrl(base, { publicSlug: "" }, "reg_1"),
  );
  check(
    "Stripe returns to the same page either way",
    registrationReturnUrl(base, { publicSlug: null }, "reg_1", "paid").startsWith(registrationUrl(base, { publicSlug: null }, "reg_1")),
  );
  check(
    "…and the outcome is a hint, not the state",
    registrationReturnUrl(base, { publicSlug: "x" }, "reg_1", "canceled").endsWith("?src=canceled"),
  );
  // The card renders from the row, so the URL parameter can say anything and
  // the page still tells the truth — that is the property that matters.
  const paidLooking = ctx({ status: "AWAITING_CASH" });
  check("a ?src=paid return on an unpaid row still says cash is due", /cash/i.test(paidLooking.chargeTiming), paidLooking.chargeTiming);
}

console.log("\n— confirmation code (§5.2.3) —");
{
  const a = confirmationCodeFor("reg_abc12345");
  check("deterministic", a === confirmationCodeFor("reg_abc12345"));
  check("eight characters", a.length === 8, a);
  check("recognized by its own validator", isConfirmationCode(a));
  check("no ambiguous letters", !/[ILOU]/.test(a), a);
  check("different rows differ", confirmationCodeFor("reg_1") !== confirmationCodeFor("reg_2"));
  check("salting produces a different code", confirmationCodeFor("reg_1", 1) !== confirmationCodeFor("reg_1"));
  const codes = new Set(Array.from({ length: 5000 }, (_, i) => confirmationCodeFor(`clx${i}k9q0000${i}abcdef`)));
  check("5,000 ids produce 5,000 codes", codes.size === 5000, codes.size);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
