// WHEN a payment reminder is due — plan.md §5.6.3 to §5.6.5.
//
// This file is the scheduling MATH only. The hourly sweep, the send, and the
// coach digest are §5.6.1/§5.6.6/§5.6.7 and land with the cron; what lives here
// is what the WRITE PATH needs today, because §5.6.5 puts `nextReminderAt` in
// exactly three hands and two of them are mutations:
//
//   1. registration create,
//   2. the cron, after each successful send,
//   3. every mutation that changes status — approve, decline, proposal
//      accept/decline, offline payment recorded.
//
// (3) is why this ships with the write path rather than with the cron. A
// registration that gets paid must have its queue entry cleared in the SAME
// transaction that records the payment; otherwise the next sweep reads a stale
// row and emails a family a payment reminder for money they already handed
// over. Nulling `nextReminderAt` at the moment of settlement is the whole
// defence, and it only works if it is impossible to write the status without
// also writing the schedule.
//
// PURE — no prisma, no IO, no implicit clock.

import {
  escalationDays,
  registrationWaitingOn,
  type EventPolicy,
  type WaitingOnRegistration,
} from "@/lib/eventPayments";

export type AnchorEvent = {
  paymentDueBy?: Date | null;
  registrationDeadline?: Date | null;
  startsAt?: Date | null;
  autoChargeDate?: Date | null;
};

/**
 * The date the cadence counts back from (§5.6.3). First non-null wins:
 * an owner-set hard deadline, then the policy's chosen anchor, then the
 * natural fallback. Null means the owner enabled escalation on an event with
 * no dates at all — the caller skips the row and surfaces the misconfiguration
 * rather than inventing a deadline.
 */
export function resolveReminderAnchor(event: AnchorEvent, policy: EventPolicy): Date | null {
  if (event.paymentDueBy) return event.paymentDueBy;
  switch (policy.escalationAnchor) {
    case "eventStart":
      if (event.startsAt) return event.startsAt;
      break;
    case "autoChargeDate":
      if (event.autoChargeDate) return event.autoChargeDate;
      break;
    case "registrationDeadline":
    default:
      if (event.registrationDeadline) return event.registrationDeadline;
      break;
  }
  return event.registrationDeadline ?? event.startsAt ?? null;
}

/** The absolute instant a given day-offset from the anchor resolves to. */
export function stageDate(anchor: Date, dayOffset: number): Date {
  return new Date(anchor.getTime() + dayOffset * 86_400_000);
}

export type ReminderRegistration = WaitingOnRegistration & {
  reminderStage?: number | null;
  lastReminderAt?: Date | string | null;
  createdAt?: Date | string | null;
};

/**
 * When this registration should next be reminded, or null for "never / not
 * anymore". Null is the common answer and the safe one — it is what every
 * settled, canceled, declined, free, scheduled and already-paid registration
 * gets, and it is what a row gets when the owner has escalation switched off.
 *
 * Stage selection is by TIME TO THE ANCHOR, not by stage count: a parent who
 * registers nine days before the deadline on a cadence whose first three stages
 * are 14, 7 and 3 days out does not receive three reminders in a burst. Stages
 * that were already in the past when the row was created never fire (§5.6.4's
 * "stage 0 handling"), and the same rule applies after each send — the next
 * stage is simply the earliest offset still in the future.
 */
export function computeNextReminderAt(
  reg: ReminderRegistration,
  event: AnchorEvent,
  policy: EventPolicy,
  opts: { now?: Date } = {},
): Date | null {
  const now = opts.now ?? new Date();
  if (!policy.escalationEnabled) return null;
  // Only money-on-the-parent states are eligible (§5.6.2). Everything else —
  // awaiting a coach, awaiting a parent's reply to a proposal, paid, scheduled,
  // in-flight checkout, canceled — is somebody else's problem to resolve.
  if (registrationWaitingOn(reg, { now }) !== "PAYMENT") return null;
  if (reg.status === "SCHEDULED" || reg.status === "PENDING_PAYMENT") return null;

  const anchor = resolveReminderAnchor(event, policy);
  if (!anchor) return null;

  const days = escalationDays(policy);
  if (days.length === 0) return null;

  const last = reg.lastReminderAt ? new Date(reg.lastReminderAt) : null;
  const floorMs = Math.max(
    now.getTime(),
    last ? last.getTime() : 0,
    // A stage whose date fell before this row existed is history, not a debt.
    reg.createdAt ? new Date(reg.createdAt).getTime() : 0,
  );

  for (const offset of days) {
    const at = stageDate(anchor, offset);
    if (at.getTime() > floorMs) return at;
  }
  return null;
}

/** 1-based index of the stage a given date belongs to, for `reminderStage`. */
export function stageIndexFor(anchor: Date, policy: EventPolicy, at: Date): number {
  const days = escalationDays(policy);
  const idx = days.findIndex((d) => stageDate(anchor, d).getTime() === at.getTime());
  return idx < 0 ? 0 : idx + 1;
}
