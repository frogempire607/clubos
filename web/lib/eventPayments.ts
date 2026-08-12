// Event registration payment decisions — the single model for which payment
// methods an event offers, what each registration chose, and what its status
// means for money. Reuses the shared payment vocabulary (lib/staffPayments,
// lib/paymentSources); this file only adds the event-specific mapping.
//
// Method semantics (owner configures per event via Event.paymentMethods):
//   CARD      — pay now by card (Stripe Checkout). Registration is complete
//               only when Stripe confirms (webhook) — until then it's
//               PENDING_PAYMENT, not a reserved spot.
//   AUTO_CARD — client consents at registration to an off-session charge of
//               their saved card on the event date (or Event.autoChargeDate).
//               Registration confirms immediately as SCHEDULED.
//   CASH      — pay cash at the event. Confirms as AWAITING_CASH with a
//               PENDING offline Transaction; staff records receipt.
//   CHECK     — same, AWAITING_CHECK.
//
// null/empty Event.paymentMethods = ["CARD"] (pre-feature behavior).
//
// This module is PURE — constants and pure functions only, no prisma, no IO.
// Keep it that way: pure modules (lib/compensation.ts) import this vocabulary,
// and a DB import here would drag a client into them. DB writes for offline
// event money live in lib/eventOfflinePayments.ts.

export const EVENT_PAYMENT_METHODS = ["CARD", "AUTO_CARD", "CASH", "CHECK"] as const;
export type EventPaymentMethod = (typeof EVENT_PAYMENT_METHODS)[number];

export const EVENT_PAYMENT_METHOD_LABELS: Record<EventPaymentMethod, string> = {
  CARD: "Pay now by card",
  AUTO_CARD: "Charge my saved card on the event date",
  CASH: "Pay cash at the event",
  CHECK: "Pay by check at the event",
};

export function isEventPaymentMethod(v: unknown): v is EventPaymentMethod {
  return typeof v === "string" && (EVENT_PAYMENT_METHODS as readonly string[]).includes(v);
}

/** Allowed methods for an event; null/empty config = card-only (legacy). */
export function eventAllowedPaymentMethods(event: { paymentMethods?: unknown }): EventPaymentMethod[] {
  const raw = event.paymentMethods;
  if (!Array.isArray(raw)) return ["CARD"];
  const methods = raw.filter(isEventPaymentMethod);
  return methods.length > 0 ? methods : ["CARD"];
}

// ── Registration status model ────────────────────────────────────────────────
// EventRegistration.status. REGISTERED = complete with nothing owed (free /
// membership-covered / variable-cost-billed-later / legacy rows).

export const REGISTRATION_STATUSES = [
  "REGISTERED",
  "PENDING_PAYMENT",
  // Phase 5 §5.4.1 — the ONE new status this phase introduces. A request the
  // responsible coach has not decided yet. It is not a spot (see
  // ACTIVE_REGISTRATION_STATUSES) and nothing is owed on it yet (see
  // UNPAID_REGISTRATION_STATUSES), but it does block the door.
  "PENDING_REVIEW",
  "SCHEDULED",
  "AWAITING_CASH",
  "AWAITING_CHECK",
  "PAYMENT_FAILED",
  "PAID",
  "CANCELED",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  REGISTERED: "Registered",
  PENDING_PAYMENT: "Started checkout — not completed",
  PENDING_REVIEW: "Awaiting coach review",
  SCHEDULED: "Card charge scheduled",
  AWAITING_CASH: "Awaiting cash at event",
  AWAITING_CHECK: "Awaiting check at event",
  PAYMENT_FAILED: "Payment failed",
  PAID: "Paid",
  CANCELED: "Canceled",
};

export function offlineStatusForMethod(method: "CASH" | "CHECK"): RegistrationStatus {
  return method === "CASH" ? "AWAITING_CASH" : "AWAITING_CHECK";
}

/**
 * Statuses that count as a real (spot-holding) registration. PENDING_PAYMENT
 * is an in-flight-or-abandoned card checkout: it is not yet a registration, so
 * it grants no chat access and earns no staff bonus. For CAPACITY it gets a
 * short hold instead — see `capacityWhere`.
 */
export const ACTIVE_REGISTRATION_STATUSES: RegistrationStatus[] = [
  "REGISTERED",
  "SCHEDULED",
  "AWAITING_CASH",
  "AWAITING_CHECK",
  "PAYMENT_FAILED",
  "PAID",
];

/**
 * How long an in-flight card checkout holds a spot. Long enough to finish
 * typing a card, short enough that abandoning doesn't burn the spot forever
 * (which is what happened before payment decisions existed).
 */
export const CHECKOUT_HOLD_MS = 30 * 60_000;

/**
 * Prisma `where` for "registrations that occupy a spot right now".
 *
 * Capacity is the one place PENDING_PAYMENT must still count: before this
 * feature every registration row held a spot from the moment it was created,
 * so two people could never both pass a capacity:1 check. Dropping the
 * in-flight rows entirely would let N people check out simultaneously and all
 * pay for one spot — the club then owes N-1 refunds. The hold restores the old
 * safety without the old bug.
 */
export function capacityWhere(
  now: Date = new Date(),
  opts: { holdSpotDuringReview?: boolean } = {},
) {
  return {
    OR: [
      { status: { in: ACTIVE_REGISTRATION_STATUSES } },
      { status: "PENDING_PAYMENT", createdAt: { gte: new Date(now.getTime() - CHECKOUT_HOLD_MS) } },
      // Phase 5 §5.4.2. Default OFF: an approval-gated tournament with 32
      // spots that receives 60 requests must let request #33 into the queue —
      // choosing who competes is the coach's job, not a race between phones.
      // Capacity is re-counted inside the approve transaction instead. Owners
      // who genuinely run first-come approvals flip Event.holdSpotDuringReview
      // and the pending rows start consuming capacity here.
      ...(opts.holdSpotDuringReview ? [{ status: "PENDING_REVIEW" }] : []),
    ],
  };
}

/**
 * Statuses with money still owed. Note REGISTERED is included: legacy rows
 * (and variable-cost signups awaiting an invoice) carry an amountDue with no
 * payment decision, and they're exactly the rows an owner must chase — pair
 * this with `amountDue: { not: null }`. PENDING_PAYMENT owes nothing until the
 * client completes checkout; SCHEDULED is already authorized.
 */
export const UNPAID_REGISTRATION_STATUSES: RegistrationStatus[] = [
  "REGISTERED",
  "AWAITING_CASH",
  "AWAITING_CHECK",
  "PAYMENT_FAILED",
];

/** Offline money physically owed at the door (cash/check specifically). */
export const AWAITING_OFFLINE_STATUSES: RegistrationStatus[] = ["AWAITING_CASH", "AWAITING_CHECK"];

/**
 * With Event.requirePaymentBeforeCheckin on, these statuses block check-in.
 * SCHEDULED does NOT block — the client consented to an automatic charge, so
 * payment is already committed.
 */
export const CHECKIN_BLOCKING_STATUSES: RegistrationStatus[] = [
  "AWAITING_CASH",
  "AWAITING_CHECK",
  "PAYMENT_FAILED",
  "PENDING_PAYMENT",
  // Phase 5 §5.4.1 — someone the coach hasn't approved is not on the roster,
  // so they don't walk in past a payment gate.
  "PENDING_REVIEW",
];

/** When an AUTO_CARD registration's charge should run. */
export function eventScheduledChargeAt(event: { autoChargeDate?: Date | null; startsAt: Date }): Date {
  return event.autoChargeDate ?? event.startsAt;
}

/**
 * The one check-in payment gate. Returns a human-readable reason to block, or
 * null to allow. Only applies when the owner set requirePaymentBeforeCheckin;
 * everyone else checks in freely and settles however they arranged.
 *
 * Deliberately fails OPEN when there's no registration row at all — plenty of
 * attendees (membership-covered, free events, staff-added) legitimately have
 * none, and turning a payment setting into a door lock for them would be worse
 * than the problem it solves.
 */
export function checkinPaymentBlock(
  event: { requirePaymentBeforeCheckin?: boolean | null },
  registration: { status: string; amountDue?: unknown; paymentMethod?: string | null } | null,
): string | null {
  if (!event.requirePaymentBeforeCheckin) return null;
  if (!registration) return null;
  if (!(CHECKIN_BLOCKING_STATUSES as string[]).includes(registration.status)) return null;
  const due = registration.amountDue == null ? 0 : Number(registration.amountDue);
  if (!(due > 0)) return null;
  const amount = `$${due.toFixed(2)}`;
  if (registration.status === "AWAITING_CASH") return `Payment of ${amount} in cash is due before check-in.`;
  if (registration.status === "AWAITING_CHECK") return `Payment of ${amount} by check is due before check-in.`;
  if (registration.status === "PAYMENT_FAILED") return `The card charge for ${amount} didn't go through — payment is due before check-in.`;
  if (registration.status === "PENDING_REVIEW")
    return "This registration is still awaiting coach approval — please see staff.";
  return `Payment of ${amount} is due before check-in.`;
}


// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — tournament approval workflow (plan.md §5.3, §5.4)
//
// Everything below is opt-in and default OFF. A club that never touches the
// new settings gets byte-identical behavior: `resolveEventPolicy` on an event
// with no policy returns DEFAULT_EVENT_POLICY (all off), PENDING_REVIEW never
// appears on a row, and every set above keeps the membership it had.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How the registrant intends to settle when the coach approves (§5.3.1).
 * Configured by the owner per event type / per event — NOT by the registrant.
 *
 *   CARD           — pay in full now; a decline refunds (§5.4.6).
 *   APPROVAL_CHARGE— saved card charged the moment the coach approves. This is
 *                    an off-session charge, never a Stripe authorization hold:
 *                    an auth expires in 7 days and tournament registration
 *                    opens weeks out (plan §5.1).
 *   INVOICE        — no card at all; approval sends the first payment link.
 *   CASH_CHECK     — settle at the door; approval gates the spot, not the money.
 *   PARENT_CHOOSES — show the normal picker; each concrete method branches.
 */
export const APPROVAL_PAYMENT_INTENTS = [
  "CARD",
  "APPROVAL_CHARGE",
  "INVOICE",
  "CASH_CHECK",
  "PARENT_CHOOSES",
] as const;
export type ApprovalPaymentIntent = (typeof APPROVAL_PAYMENT_INTENTS)[number];

export const APPROVAL_PAYMENT_INTENT_LABELS: Record<ApprovalPaymentIntent, string> = {
  CARD: "Require payment up front",
  APPROVAL_CHARGE: "Charge the saved card when the coach approves",
  INVOICE: "Bill later — no card at registration",
  CASH_CHECK: "Cash or check at the event",
  PARENT_CHOOSES: "Let the registrant choose",
};

export function isApprovalPaymentIntent(v: unknown): v is ApprovalPaymentIntent {
  return typeof v === "string" && (APPROVAL_PAYMENT_INTENTS as readonly string[]).includes(v);
}

/**
 * Everything that can legitimately sit in `EventRegistration.paymentMethod`.
 * Wider than EVENT_PAYMENT_METHODS (which is the owner's per-event menu):
 * SAVED_CARD is written by the member pay-now path, and APPROVAL_CHARGE /
 * INVOICE are written by the approval create-path (§5.4.5).
 */
export const REGISTRATION_PAYMENT_METHODS = [
  "CARD",
  "SAVED_CARD",
  "AUTO_CARD",
  "CASH",
  "CHECK",
  "APPROVAL_CHARGE",
  "INVOICE",
] as const;
export type RegistrationPaymentMethod = (typeof REGISTRATION_PAYMENT_METHODS)[number];

export const ESCALATION_ANCHORS = ["registrationDeadline", "eventStart", "autoChargeDate"] as const;
export type EscalationAnchor = (typeof ESCALATION_ANCHORS)[number];

export const ESCALATION_SCHEDULES = ["DEFAULT_TOURNAMENT", "GENTLE", "AGGRESSIVE", "CUSTOM"] as const;
export type EscalationSchedule = (typeof ESCALATION_SCHEDULES)[number];

/** Day-offsets from the anchor per named cadence (§5.6.4). Negative = before. */
export const ESCALATION_SCHEDULE_DAYS: Record<Exclude<EscalationSchedule, "CUSTOM">, number[]> = {
  DEFAULT_TOURNAMENT: [-14, -7, -3, -1, 0, 2],
  GENTLE: [-14, -3, 0],
  AGGRESSIVE: [-21, -14, -7, -3, -1, 0, 2, 7],
};

export type EventPolicy = {
  requiresCoachApproval: boolean;
  approvalPaymentIntent: ApprovalPaymentIntent;
  allowProposedChanges: boolean;
  escalationEnabled: boolean;
  escalationAnchor: EscalationAnchor;
  escalationSchedule: EscalationSchedule;
  /** Only meaningful when escalationSchedule = CUSTOM. */
  customEscalationDays: number[] | null;
  cancellationPolicyText: string | null;
  holdSpotDuringReview: boolean;
  responsibleCoachUserId: string | null;
};

/**
 * The fallback every event resolves to when nobody has configured anything.
 * All off, on purpose: a weekly clinic must see zero behavior change.
 */
export const DEFAULT_EVENT_POLICY: EventPolicy = {
  requiresCoachApproval: false,
  approvalPaymentIntent: "PARENT_CHOOSES",
  allowProposedChanges: false,
  escalationEnabled: false,
  escalationAnchor: "registrationDeadline",
  escalationSchedule: "DEFAULT_TOURNAMENT",
  customEscalationDays: null,
  cancellationPolicyText: null,
  holdSpotDuringReview: false,
  responsibleCoachUserId: null,
};

export type PolicyEvent = {
  requiresCoachApproval?: boolean | null;
  approvalPaymentIntent?: string | null;
  allowProposedChanges?: boolean | null;
  responsibleCoachUserId?: string | null;
  escalationEnabled?: boolean | null;
  escalationAnchor?: string | null;
  escalationSchedule?: string | null;
  escalationCustomDays?: unknown;
  cancellationPolicyText?: string | null;
  holdSpotDuringReview?: boolean | null;
  customEventType?: { defaultPolicy?: unknown } | null;
};

function boolOr(a: boolean | null | undefined, b: boolean | null | undefined, fallback: boolean): boolean {
  if (typeof a === "boolean") return a;
  if (typeof b === "boolean") return b;
  return fallback;
}

function dayList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const days = v.map(Number).filter((n) => Number.isFinite(n));
  return days.length > 0 ? days : null;
}

/**
 * event → event type default → all-off fallback. The ONE reader of the policy
 * columns; no route may read `event.requiresCoachApproval` directly, because
 * the null-means-inherit rule only exists here.
 *
 * Every field of the type's JSON blob is validated on read, so a hand-edited
 * or half-written `defaultPolicy` degrades to the fallback rather than
 * throwing in the middle of a registration.
 */
export function resolveEventPolicy(event: PolicyEvent | null | undefined): EventPolicy {
  if (!event) return DEFAULT_EVENT_POLICY;
  const raw = event.customEventType?.defaultPolicy;
  const type = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

  const requiresCoachApproval = boolOr(
    event.requiresCoachApproval,
    typeof type.requiresCoachApproval === "boolean" ? type.requiresCoachApproval : null,
    DEFAULT_EVENT_POLICY.requiresCoachApproval,
  );

  const intent = isApprovalPaymentIntent(event.approvalPaymentIntent)
    ? event.approvalPaymentIntent
    : isApprovalPaymentIntent(type.approvalPaymentIntent)
      ? type.approvalPaymentIntent
      : DEFAULT_EVENT_POLICY.approvalPaymentIntent;

  const anchor = (ESCALATION_ANCHORS as readonly string[]).includes(event.escalationAnchor ?? "")
    ? (event.escalationAnchor as EscalationAnchor)
    : (ESCALATION_ANCHORS as readonly string[]).includes(String(type.escalationAnchor ?? ""))
      ? (type.escalationAnchor as EscalationAnchor)
      : DEFAULT_EVENT_POLICY.escalationAnchor;

  const schedule = (ESCALATION_SCHEDULES as readonly string[]).includes(event.escalationSchedule ?? "")
    ? (event.escalationSchedule as EscalationSchedule)
    : (ESCALATION_SCHEDULES as readonly string[]).includes(String(type.escalationSchedule ?? ""))
      ? (type.escalationSchedule as EscalationSchedule)
      : DEFAULT_EVENT_POLICY.escalationSchedule;

  return {
    requiresCoachApproval,
    approvalPaymentIntent: intent,
    // Proposed changes are meaningless without an approval step to attach
    // them to, so the flag can never resolve true on its own.
    allowProposedChanges:
      requiresCoachApproval &&
      boolOr(
        event.allowProposedChanges,
        typeof type.allowProposedChanges === "boolean" ? type.allowProposedChanges : null,
        DEFAULT_EVENT_POLICY.allowProposedChanges,
      ),
    escalationEnabled: boolOr(
      event.escalationEnabled,
      typeof type.escalationEnabled === "boolean" ? type.escalationEnabled : null,
      DEFAULT_EVENT_POLICY.escalationEnabled,
    ),
    escalationAnchor: anchor,
    escalationSchedule: schedule,
    customEscalationDays:
      schedule === "CUSTOM"
        ? (dayList(event.escalationCustomDays) ?? dayList(type.customEscalationDays))
        : null,
    cancellationPolicyText:
      (typeof event.cancellationPolicyText === "string" && event.cancellationPolicyText.trim()
        ? event.cancellationPolicyText.trim()
        : null) ??
      (typeof type.cancellationPolicyText === "string" && type.cancellationPolicyText.trim()
        ? type.cancellationPolicyText.trim()
        : null),
    // Per-event only — see the schema comment. Capacity must have exactly one
    // answer, so this never inherits.
    holdSpotDuringReview: event.holdSpotDuringReview === true,
    responsibleCoachUserId: event.responsibleCoachUserId?.trim() || null,
  };
}

/** The day-offsets this event's cadence will actually fire on. */
export function escalationDays(policy: EventPolicy): number[] {
  if (policy.escalationSchedule === "CUSTOM") {
    return [...(policy.customEscalationDays ?? [])].sort((a, b) => a - b);
  }
  return ESCALATION_SCHEDULE_DAYS[policy.escalationSchedule];
}

// ── waitingOn (§5.4.4) ───────────────────────────────────────────────────────

export const REGISTRATION_WAITING_ON = ["COACH", "PARENT", "PAYMENT", "COMPLETE", "CANCELED"] as const;
export type RegistrationWaitingOn = (typeof REGISTRATION_WAITING_ON)[number];

export const WAITING_ON_LABELS: Record<RegistrationWaitingOn, string> = {
  COACH: "Waiting on your coach",
  PARENT: "Waiting on your reply",
  PAYMENT: "Payment due",
  COMPLETE: "You're all set",
  CANCELED: "Canceled",
};

export type WaitingOnRegistration = {
  status: string;
  approvalStatus?: string | null;
  proposedChange?: unknown;
  proposedChangeRespondedAt?: Date | string | null;
  amountDue?: unknown;
  createdAt?: Date | string | null;
};

/** True when a coach proposal is on the table and nobody has answered it. */
export function hasOpenProposal(reg: WaitingOnRegistration): boolean {
  return !!reg.proposedChange && !reg.proposedChangeRespondedAt;
}

/**
 * Who the registration is actually waiting on right now. PURE — callers pass
 * the loaded row so the render context, the roster payload, every Action
 * Center probe and the escalation cron compute this the same way instead of
 * each hand-rolling a status set.
 *
 * Order matters and mirrors the §5.2.6 matrix:
 *   1. an unanswered coach proposal outranks everything — the ball is with
 *      the parent even if the row is also PENDING_REVIEW;
 *   2. terminal states next;
 *   3. a pending approval outranks the payment state, which is how a
 *      CARD-paid-up-front registration still reads "waiting on your coach"
 *      instead of "all set";
 *   4. only then does money decide.
 */
export function registrationWaitingOn(
  reg: WaitingOnRegistration,
  opts: { now?: Date } = {},
): RegistrationWaitingOn {
  const now = opts.now ?? new Date();
  if (hasOpenProposal(reg)) return "PARENT";
  if (reg.approvalStatus === "DECLINED") return "CANCELED";
  if (reg.status === "CANCELED") return "CANCELED";
  if (reg.approvalStatus === "PENDING" || reg.status === "PENDING_REVIEW") return "COACH";

  if (reg.status === "PENDING_PAYMENT") {
    const created = reg.createdAt ? new Date(reg.createdAt).getTime() : now.getTime();
    // An abandoned checkout released its spot; it is not money to chase.
    return now.getTime() - created > CHECKOUT_HOLD_MS ? "CANCELED" : "PAYMENT";
  }
  if (reg.status === "PAID") return "COMPLETE";
  if (reg.status === "SCHEDULED") return "PAYMENT";
  if (
    reg.status === "AWAITING_CASH" ||
    reg.status === "AWAITING_CHECK" ||
    reg.status === "PAYMENT_FAILED"
  ) {
    return "PAYMENT";
  }
  // REGISTERED and anything unknown: money decides.
  return Number(reg.amountDue ?? 0) > 0 ? "PAYMENT" : "COMPLETE";
}
