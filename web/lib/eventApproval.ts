// The coach-decision write path — plan.md §5.4.6.
//
// approve / decline / propose-change all land here rather than in their routes,
// for one reason: §5.4.7's parent-accept flow re-enters approval ("acceptance
// implies approval"), and two implementations of "what approving does" would
// drift the day one of them learned about a new payment method. The routes
// stay thin — auth, rate limit, parse, call, respond.
//
// ── Serialization ───────────────────────────────────────────────────────────
// Every mutation takes a transaction-scoped advisory lock on
// `evreg-mut:<regId>` — a distinct namespace from the create path's
// `evreg:<eventId>:<memberId>` so a registration replay and an approval never
// contend. Inside the lock the row is re-read, the transition is validated, and
// the state is written. A stale caller gets 409 INVALID_TRANSITION with the
// current state rather than a silent no-op, because "you approved someone who
// was already declined" is something the coach's screen needs to know.
//
// ── Why money moves AFTER the transaction commits ──────────────────────────
// §5.4.6 describes side-effect dispatch as being inside the lock. It cannot be,
// and the reason is mechanical: `chargeEventRegistration` runs on the global
// Prisma client, so its own UPDATE of this same registration row would block on
// the row lock the open transaction is holding — a self-deadlock that resolves
// only when the interactive transaction times out (5s by default), leaving a
// live PaymentIntent behind an aborted transaction. Holding a pooled connection
// across a multi-second Stripe round trip is the other half of the problem.
//
// So the lock covers the state decision, and money runs immediately after
// commit. Nothing is lost: §5.4.10 already assigns side-effect idempotency to
// the side-effect owners, and each of them is independently replay-safe — the
// charge engine's per-registration key plus prior-PI recovery, the refund's
// Stripe idempotency key, the offline void's conditional updateMany. What the
// lock guarantees is that only ONE caller ever reaches the dispatch.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeBillingAudit } from "@/lib/billingAudit";
import { chargeEventRegistration, type AutoChargeOutcome } from "@/lib/eventAutoCharge";
import { billOneRegistrant } from "@/lib/eventInvoicing";
import { resolveRegistrationRecipients } from "@/lib/eventRecipients";
import { sendRegistrationLifecycleEmail } from "@/lib/eventLifecycleEmails";
import { computeNextReminderAt } from "@/lib/eventReminders";
import { amountToCollect } from "@/lib/eventRepricing";
import { confirmationCodeFor } from "@/lib/confirmationCode";
import { ACTIVE_REGISTRATION_STATUSES, resolveEventPolicy } from "@/lib/eventPayments";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { stripe } from "@/lib/stripe";

export type MutationErrorCode =
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "EVENT_FULL"
  | "PROPOSALS_NOT_ALLOWED"
  | "INVALID_PRICE_DELTA"
  | "FINANCE_PERMISSION_REQUIRED"
  | "APPROVAL_NOT_REQUIRED";

export type MutationFailure = {
  ok: false;
  code: MutationErrorCode;
  status: number;
  message: string;
  currentStatus?: string;
  currentApprovalStatus?: string | null;
};

export type ApproveSuccess = {
  ok: true;
  registrationId: string;
  status: string;
  approvalStatus: "APPROVED";
  chargeOutcome?: AutoChargeOutcome;
  chargeError?: string;
  invoiceUrl?: string;
  invoiceError?: string;
};

export type DeclineSuccess = {
  ok: true;
  registrationId: string;
  status: "CANCELED";
  approvalStatus: "DECLINED";
  refund?: { attempted: true; refundId?: string; error?: string };
};

export type ProposeSuccess = {
  ok: true;
  registrationId: string;
  proposedAt: string;
};

const REG_FOR_MUTATION = {
  include: {
    event: {
      include: { customEventType: { select: { defaultPolicy: true } } },
    },
    club: {
      select: {
        id: true,
        name: true,
        tier: true,
        stripeAccountId: true,
        stripeChargesEnabled: true,
        passProcessingFees: true,
      },
    },
  },
} as const;

type RegForMutation = Prisma.EventRegistrationGetPayload<typeof REG_FOR_MUTATION>;

function fail(
  code: MutationErrorCode,
  status: number,
  message: string,
  reg?: { status: string; approvalStatus: string | null },
): MutationFailure {
  return {
    ok: false,
    code,
    status,
    message,
    ...(reg ? { currentStatus: reg.status, currentApprovalStatus: reg.approvalStatus } : {}),
  };
}

/** A registration a coach can still decide on. */
function isDecidable(reg: { status: string; approvalStatus: string | null }): boolean {
  if (reg.approvalStatus !== "PENDING") return false;
  return reg.status !== "CANCELED";
}

/**
 * Approve one registration as submitted.
 *
 * `actorUserId` is the coach on the coach route and, on the parent-accept path
 * (§5.4.7), the coach who made the proposal — the approving party is whoever
 * made the call the parent agreed to, not the parent who clicked accept.
 */
export async function approveRegistration(args: {
  registrationId: string;
  clubId: string;
  actorUserId: string | null;
  /** Attribution for the Booking this creates (§5.4.8). */
  bookedByUserId?: string | null;
  now?: Date;
}): Promise<ApproveSuccess | MutationFailure> {
  const now = args.now ?? new Date();

  const decided = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${args.registrationId}`}, 0))`;

    const reg = (await db.eventRegistration.findFirst({
      where: { id: args.registrationId, clubId: args.clubId },
      ...REG_FOR_MUTATION,
    })) as RegForMutation | null;
    if (!reg) return fail("NOT_FOUND", 404, "Registration not found");
    if (reg.approvalStatus == null) {
      return fail(
        "APPROVAL_NOT_REQUIRED",
        409,
        "This event didn't require coach approval when this registration was created.",
        reg,
      );
    }
    if (!isDecidable(reg)) {
      return fail(
        "INVALID_TRANSITION",
        409,
        reg.approvalStatus === "APPROVED"
          ? "This registration was already approved."
          : "This registration can no longer be approved.",
        reg,
      );
    }

    const policy = resolveEventPolicy(reg.event);

    // Capacity is decided HERE, not at registration time (§5.4.2) — unless the
    // owner opted into holding spots during review, in which case this row
    // already consumed one and re-checking would refuse the spot it holds.
    if (!policy.holdSpotDuringReview && reg.event.capacity != null) {
      const [bookings, active] = await Promise.all([
        db.booking.count({ where: { eventId: reg.eventId, status: { notIn: ["CANCELED"] } } }),
        db.eventRegistration.count({
          where: {
            eventId: reg.eventId,
            id: { not: reg.id },
            status: { in: ACTIVE_REGISTRATION_STATUSES },
          },
        }),
      ]);
      if (Math.max(bookings, active) >= reg.event.capacity) {
        return fail("EVENT_FULL", 409, "This event is full — approve someone else or raise the capacity.", reg);
      }
    }

    const activeCount = await db.eventRegistration.count({
      where: { eventId: reg.eventId, status: { not: "CANCELED" } },
    });
    const owed = amountToCollect(reg.event, reg, activeCount);

    // What approval does to the money state, keyed on how they chose to pay.
    let nextStatus = reg.status;
    let scheduledChargeAt: Date | null = reg.scheduledChargeAt;
    let amountDue: number | null = reg.amountDue == null ? null : Number(reg.amountDue);
    if (reg.paymentMethod === "APPROVAL_CHARGE") {
      // SCHEDULED with a charge date of now is exactly the shape the existing
      // engine already sweeps — approval reuses it verbatim rather than
      // introducing a second way to charge a saved card.
      nextStatus = "SCHEDULED";
      scheduledChargeAt = now;
      amountDue = owed;
    } else if (reg.paymentMethod === "INVOICE") {
      nextStatus = "REGISTERED";
      amountDue = owed;
    } else if (reg.status === "PENDING_REVIEW") {
      // A PENDING_REVIEW row with no money decision (free / covered) is simply
      // confirmed. CARD (already PAID) and CASH/CHECK keep their status.
      nextStatus = "REGISTERED";
    }

    const projected = {
      ...reg,
      status: nextStatus,
      approvalStatus: "APPROVED" as const,
      amountDue,
      scheduledChargeAt,
    };
    const nextReminderAt = computeNextReminderAt(projected, reg.event, policy, { now });

    const updated = await db.eventRegistration.update({
      where: { id: reg.id },
      data: {
        approvalStatus: "APPROVED",
        approvedByUserId: args.actorUserId,
        approvedAt: now,
        status: nextStatus,
        scheduledChargeAt,
        ...(amountDue != null ? { amountDue } : {}),
        nextReminderAt,
        // Backfill-on-read: the number the parent will quote back to staff must
        // exist by the time the approval email goes out.
        ...(reg.confirmationCode ? {} : { confirmationCode: confirmationCodeFor(reg.id) }),
      },
    });

    // The confirmed spot appears on member-facing surfaces only now (§5.4.5:
    // no Booking exists while a registration is under review).
    if (reg.memberId) {
      try {
        await db.booking.create({
          data: {
            eventId: reg.eventId,
            memberId: reg.memberId,
            status: "CONFIRMED",
            bookedByUserId: args.bookedByUserId ?? args.actorUserId,
          },
        });
      } catch {
        // Unique (eventId, memberId): a concurrent path already booked them.
        // That is the outcome we wanted, so it is not an error for the coach.
      }
    }

    return { reg, updated, owed, policy, nextStatus };
  });

  if ("ok" in decided) return decided;
  const { reg, nextStatus, owed } = decided;

  await writeBillingAudit({
    clubId: args.clubId,
    memberId: reg.memberId,
    actorUserId: args.actorUserId,
    action: "EVENT_REGISTRATION_APPROVED",
    before: { registrationId: reg.id, status: reg.status, approvalStatus: reg.approvalStatus },
    after: { registrationId: reg.id, status: nextStatus, approvalStatus: "APPROVED", amountDue: owed },
    note: `${reg.name} approved for ${reg.event.name}.`,
  });

  const result: ApproveSuccess = {
    ok: true,
    registrationId: reg.id,
    status: nextStatus,
    approvalStatus: "APPROVED",
  };

  // ── Money, after the lock is released ────────────────────────────────────
  if (reg.paymentMethod === "APPROVAL_CHARGE") {
    try {
      const charge = await chargeEventRegistration(reg.id);
      result.chargeOutcome = charge.outcome;
      if (charge.error) result.chargeError = charge.error;
    } catch (e) {
      // The engine already recorded whatever it knows on the row. The approval
      // itself stands — a card problem is not a reason to un-approve an athlete.
      console.error("[eventApproval] approval charge threw", reg.id, e);
      result.chargeOutcome = "failed";
      result.chargeError = String(e);
    }
  } else if (reg.paymentMethod === "INVOICE") {
    const billed = await billFirstInvoice(reg, owed);
    if (billed.ok) result.invoiceUrl = billed.url;
    else result.invoiceError = billed.error;
  }

  // Sent last so the copy reflects the state money left the registration in —
  // "charged $X today" rather than "we'll charge you when your coach approves".
  await sendRegistrationLifecycleEmail({
    registrationId: reg.id,
    transition: "APPROVED",
    actorUserId: args.actorUserId,
  });

  return result;
}

/** The first invoice on an approved INVOICE registration (§5.4.6). */
async function billFirstInvoice(
  reg: RegForMutation,
  amount: number,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!reg.club.stripeAccountId || !reg.club.stripeChargesEnabled) {
    return { ok: false, error: "Connect Stripe before invoicing this registrant." };
  }
  const recipients = await resolveRegistrationRecipients(reg.clubId, [reg]);
  const recipient = recipients.get(reg.id);
  if (!recipient?.email) {
    return { ok: false, error: recipient?.reason ?? "No email on file for this registrant." };
  }
  const outcome = await billOneRegistrant({
    event: {
      id: reg.eventId,
      clubId: reg.clubId,
      name: reg.event.name,
      publicSlug: reg.event.publicSlug,
      isTournament: reg.event.isTournament,
    },
    club: {
      stripeAccountId: reg.club.stripeAccountId,
      tier: reg.club.tier,
      passProcessingFees: reg.club.passProcessingFees,
    },
    registration: { id: reg.id, name: reg.name },
    recipientEmail: recipient.email,
    amount,
    discountCode: reg.discountCode,
    discountOff: reg.discountAmount == null ? 0 : Number(reg.discountAmount),
    kind: "FEE",
    lineNote: reg.event.isTournament ? "Tournament registration" : "Event registration",
    productName: reg.event.name,
    // No request in scope on the cron/parent-accept paths, and the payer opens
    // this link out of an email later — §5.6.8's rule.
    baseUrl: getAppBaseUrl(),
  });
  return outcome.ok ? { ok: true, url: outcome.url } : { ok: false, error: outcome.error };
}

/**
 * Decline one registration.
 *
 * A decline that leaves collected money behind is never a correct terminal
 * state, so the refund is part of the transition rather than a follow-up task.
 * `canRefund` is the caller's permission answer (finances:full, or Owner): a
 * coach without it is refused BEFORE anything is written, so nobody can produce
 * a declined-but-still-paid registration by lacking a permission.
 */
export async function declineRegistration(args: {
  registrationId: string;
  clubId: string;
  actorUserId: string | null;
  reason: string;
  canRefund: boolean;
  now?: Date;
}): Promise<DeclineSuccess | MutationFailure> {
  const now = args.now ?? new Date();

  const decided = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${args.registrationId}`}, 0))`;

    const reg = (await db.eventRegistration.findFirst({
      where: { id: args.registrationId, clubId: args.clubId },
      ...REG_FOR_MUTATION,
    })) as RegForMutation | null;
    if (!reg) return fail("NOT_FOUND", 404, "Registration not found");
    if (reg.approvalStatus == null) {
      return fail(
        "APPROVAL_NOT_REQUIRED",
        409,
        "This event didn't require coach approval when this registration was created.",
        reg,
      );
    }
    if (!isDecidable(reg)) {
      return fail("INVALID_TRANSITION", 409, "This registration can no longer be declined.", reg);
    }

    const paidUpFront = reg.status === "PAID" || Number(reg.amountPaid ?? 0) > 0;
    if (paidUpFront && !args.canRefund) {
      return fail(
        "FINANCE_PERMISSION_REQUIRED",
        403,
        "This registrant already paid. Declining has to refund them, which needs finance permission — ask an owner to decline it.",
        reg,
      );
    }

    await db.eventRegistration.update({
      where: { id: reg.id },
      data: {
        approvalStatus: "DECLINED",
        approvedByUserId: args.actorUserId,
        approvedAt: now,
        declinedReason: args.reason,
        status: "CANCELED",
        // Nothing more is owed and nothing more is chased.
        nextReminderAt: null,
        ...(reg.confirmationCode ? {} : { confirmationCode: confirmationCodeFor(reg.id) }),
      },
    });

    // A cash/check registrant's PENDING offline Transaction represents money
    // due, not money held. Left alone it is orphaned: unreachable from any
    // registration, permanently PENDING, permanently inflating "owed". The
    // conditional updateMany is what makes a replay a no-op.
    if (reg.transactionId) {
      await db.transaction.updateMany({
        where: { id: reg.transactionId, clubId: reg.clubId, status: "PENDING" },
        data: {
          status: "FAILED",
          reconciliationStatus: "VOID",
          notes: "Superseded — the coach declined this registration.",
        },
      });
    }

    // The spot goes back.
    if (reg.memberId) {
      await db.booking
        .delete({ where: { eventId_memberId: { eventId: reg.eventId, memberId: reg.memberId } } })
        .catch(() => undefined);
    }

    return { reg, paidUpFront };
  });

  if ("ok" in decided) return decided;
  const { reg, paidUpFront } = decided;

  await writeBillingAudit({
    clubId: args.clubId,
    memberId: reg.memberId,
    actorUserId: args.actorUserId,
    action: "EVENT_REGISTRATION_DECLINED",
    before: { registrationId: reg.id, status: reg.status, approvalStatus: reg.approvalStatus },
    after: { registrationId: reg.id, status: "CANCELED", approvalStatus: "DECLINED", reason: args.reason },
    note: `${reg.name} declined for ${reg.event.name}.`,
  });

  const result: DeclineSuccess = {
    ok: true,
    registrationId: reg.id,
    status: "CANCELED",
    approvalStatus: "DECLINED",
  };

  if (paidUpFront && reg.stripePaymentIntentId && reg.club.stripeAccountId) {
    result.refund = { attempted: true };
    try {
      const refund = await stripe.refunds.create(
        { payment_intent: reg.stripePaymentIntentId },
        {
          stripeAccount: reg.club.stripeAccountId,
          // A replay returns Stripe's cached refund rather than issuing a second one.
          idempotencyKey: `aox-eventreg-refund-${reg.id}`,
        },
      );
      result.refund.refundId = refund.id;
      await writeBillingAudit({
        clubId: args.clubId,
        memberId: reg.memberId,
        actorUserId: args.actorUserId,
        action: "EVENT_REGISTRATION_REFUNDED",
        before: { registrationId: reg.id, amountPaid: Number(reg.amountPaid ?? 0) },
        after: { registrationId: reg.id, refundId: refund.id, amount: refund.amount / 100 },
        note: `Refund issued on decline of ${reg.name} for ${reg.event.name}.`,
      });
    } catch (e) {
      // Never retried inline: a refund that failed needs a human to look at
      // Stripe, and a retry loop here would risk a second refund on a
      // response we never saw. The audit row is the durable signal.
      console.error("[eventApproval] refund failed", reg.id, e);
      result.refund.error = String(e);
      await writeBillingAudit({
        clubId: args.clubId,
        memberId: reg.memberId,
        actorUserId: args.actorUserId,
        action: "EVENT_REGISTRATION_REFUND_FAILED",
        before: { registrationId: reg.id, paymentIntentId: reg.stripePaymentIntentId },
        after: { registrationId: reg.id, error: String(e).slice(0, 300) },
        note: `Refund FAILED on decline of ${reg.name} for ${reg.event.name}. Check Stripe.`,
      });
    }
  }

  await sendRegistrationLifecycleEmail({
    registrationId: reg.id,
    transition: "DECLINED",
    actorUserId: args.actorUserId,
  });

  return result;
}

/** What a coach is allowed to propose changing (§5.4.3). */
export const PROPOSABLE_CHANGE_KEYS = [
  "weightClass",
  "division",
  "session",
  "addAnotherDual",
  "freeText",
] as const;
export type ProposableChangeKey = (typeof PROPOSABLE_CHANGE_KEYS)[number];

/**
 * Propose a different spot and hand the decision back to the parent.
 *
 * No money moves here. Ever. A price delta is recorded as part of the proposal
 * so the parent sees it before they agree, and it is collected only if and when
 * they accept (§5.4.7) — which is also where the fresh consent for the delta is
 * captured.
 */
export async function proposeRegistrationChange(args: {
  registrationId: string;
  clubId: string;
  actorUserId: string | null;
  changes: Record<string, unknown>;
  message?: string | null;
  priceDelta?: number | null;
  now?: Date;
}): Promise<ProposeSuccess | MutationFailure> {
  const now = args.now ?? new Date();

  const decided = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${args.registrationId}`}, 0))`;

    const reg = (await db.eventRegistration.findFirst({
      where: { id: args.registrationId, clubId: args.clubId },
      ...REG_FOR_MUTATION,
    })) as RegForMutation | null;
    if (!reg) return fail("NOT_FOUND", 404, "Registration not found");

    const policy = resolveEventPolicy(reg.event);
    if (!policy.allowProposedChanges) {
      return fail(
        "PROPOSALS_NOT_ALLOWED",
        403,
        "Proposed changes aren't enabled for this event.",
        reg,
      );
    }
    if (!isDecidable(reg)) {
      return fail("INVALID_TRANSITION", 409, "This registration can no longer be changed.", reg);
    }

    const delta = args.priceDelta ?? 0;
    if (delta) {
      // A delta must be bounded by something real — an event whose registrants
      // owe $50 cannot carry a -$1,000 proposal.
      const activeCount = await db.eventRegistration.count({
        where: { eventId: reg.eventId, status: { not: "CANCELED" } },
      });
      const owed = amountToCollect(reg.event, reg, activeCount);
      const ceiling = Math.max(owed, Number(reg.amountPaid ?? 0), 0);
      if (delta < -ceiling || delta > Math.max(ceiling, 1) * 4) {
        return fail(
          "INVALID_PRICE_DELTA",
          400,
          `A price change of $${delta.toFixed(2)} doesn't fit this registration's $${ceiling.toFixed(2)}.`,
          reg,
        );
      }
    }

    const blob = {
      proposedByUserId: args.actorUserId,
      proposedAt: now.toISOString(),
      coachNote: args.message ?? null,
      priceDelta: delta,
      changes: args.changes,
    };

    await db.eventRegistration.update({
      where: { id: reg.id },
      data: {
        proposedChange: blob as Prisma.InputJsonValue,
        // A revised proposal reopens the question — the previous answer, if
        // any, no longer applies to what is on the table.
        proposedChangeRespondedAt: null,
        proposedChangeAccepted: null,
        ...(reg.confirmationCode ? {} : { confirmationCode: confirmationCodeFor(reg.id) }),
      },
    });

    return { reg, blob };
  });

  if ("ok" in decided) return decided;
  const { reg, blob } = decided;

  await writeBillingAudit({
    clubId: args.clubId,
    memberId: reg.memberId,
    actorUserId: args.actorUserId,
    action: "EVENT_REGISTRATION_PROPOSAL",
    // The single-slot column keeps only the live proposal; this row is the
    // archive of every version that came before it.
    before: { registrationId: reg.id, proposedChange: reg.proposedChange ?? null },
    after: { registrationId: reg.id, proposedChange: blob },
    note: `Change proposed to ${reg.name}'s registration for ${reg.event.name}.`,
  });

  await sendRegistrationLifecycleEmail({
    registrationId: reg.id,
    transition: "PROPOSAL",
    actorUserId: args.actorUserId,
  });

  return { ok: true, registrationId: reg.id, proposedAt: blob.proposedAt };
}

/**
 * Who may decide a registration (§5.4.6's common contract).
 *
 * `events:edit` is the normal bar — the same one that already gates removing a
 * registrant and mass-invoicing an event. On top of that, the event's named
 * responsible coach may always decide THEIR event even without it, which is the
 * whole point of naming one: a coach who runs the tournament shouldn't need
 * blanket event-editing rights across the club to say who competes.
 *
 * Owners bypass, as everywhere.
 */
export function canDecideRegistrations(
  session: { user?: { id?: string; role?: string; permissions?: unknown } } | null,
  event: { responsibleCoachUserId?: string | null },
  hasEventsEdit: boolean,
): boolean {
  if (!session?.user) return false;
  if (session.user.role === "OWNER") return true;
  if (hasEventsEdit) return true;
  return !!event.responsibleCoachUserId && event.responsibleCoachUserId === session.user.id;
}
