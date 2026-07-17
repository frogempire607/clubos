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
export function capacityWhere(now: Date = new Date()) {
  return {
    OR: [
      { status: { in: ACTIVE_REGISTRATION_STATUSES } },
      { status: "PENDING_PAYMENT", createdAt: { gte: new Date(now.getTime() - CHECKOUT_HOLD_MS) } },
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
  return `Payment of ${amount} is due before check-in.`;
}

