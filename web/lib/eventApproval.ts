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
import { sendMemberMessage } from "@/lib/memberMessaging";
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
  | "APPROVAL_NOT_REQUIRED"
  | "CONSENT_REQUIRED"
  | "CONSENT_AMOUNT_MISMATCH"
  | "NO_PAYMENT_METHOD";

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
  /**
   * false when the caller sends its own message about this transition — the
   * parent-accept path does, and §5.4.7 is explicit that a family gets ONE
   * email about accepting, not an "approved" notice chasing an "accepted" one.
   */
  sendEmail?: boolean;
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

    // A priced registration with no way to pay is refused, not warned about.
    //
    // Approving it would confirm the spot and collect nothing — which is
    // exactly what happened on 2026-08-12: a public registration on a
    // charge-on-approval event arrived with no payment method, approval
    // dispatched no money, and the family was emailed "this event is free"
    // with their card listed underneath. A coach should have to resolve it,
    // not spot a message after the fact.
    //
    // Rows that owe nothing are unaffected (free, membership-covered), and so
    // are rows that already paid up front.
    const settled = reg.status === "PAID" || Number(reg.amountPaid ?? 0) > 0;
    if (owed > 0 && !reg.paymentMethod && !settled) {
      return fail(
        "NO_PAYMENT_METHOD",
        409,
        `${reg.name} owes $${owed.toFixed(2)} but has no way to pay recorded. Send them a payment link or record cash/check from this roster, then approve.`,
        reg,
      );
    }

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
  if (args.sendEmail !== false) {
    await sendRegistrationLifecycleEmail({
      registrationId: reg.id,
      transition: "APPROVED",
      actorUserId: args.actorUserId,
    });
  }

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

  // §5.7 — the parent needs this in the two places they already look: the
  // family approvals card, and the coach thread. Neither is a new inbox.
  if (reg.memberId) {
    // One open row per registration: a revised proposal replaces the previous
    // one rather than stacking a second card on the same question.
    await prisma.pendingApproval
      .updateMany({
        where: { clubId: args.clubId, memberId: reg.memberId, kind: PROPOSAL_APPROVAL_KIND, status: "PENDING" },
        data: { status: "EXPIRED", respondedAt: now },
      })
      .catch(() => undefined);
    await prisma.pendingApproval
      .create({
        data: {
          clubId: args.clubId,
          memberId: reg.memberId,
          kind: PROPOSAL_APPROVAL_KIND,
          status: "PENDING",
          amount: blob.priceDelta || null,
          // The payload is what the family card renders and links to — it
          // never replays a booking, unlike the parental-control kinds.
          payload: { registrationId: reg.id, eventId: reg.eventId, eventName: reg.event.name },
          requestedAt: now,
        },
      })
      .catch((e) => console.error("[eventApproval] proposal approval row failed", e));

    if (args.actorUserId) {
      const changeLines = Object.entries(args.changes)
        .map(([k, v]) => `• ${k}: ${String(v)}`)
        .join("\n");
      await sendMemberMessage({
        clubId: args.clubId,
        senderId: args.actorUserId,
        memberId: reg.memberId,
        body:
          `I'd like to change ${reg.name}'s registration for ${reg.event.name}:\n${changeLines}` +
          (blob.priceDelta ? `\nAdditional fee: $${Number(blob.priceDelta).toFixed(2)}` : "") +
          (args.message ? `\n\n${args.message}` : "") +
          `\n\nAccept or decline here: /member/bookings/${reg.id}/proposal`,
      }).catch((e) => console.error("[eventApproval] proposal DM failed", e));
    }
  }

  return { ok: true, registrationId: reg.id, proposedAt: blob.proposedAt };
}

/** The PendingApproval kind a coach proposal raises for the family card. */
export const PROPOSAL_APPROVAL_KIND = "EVENT_PROPOSAL_RESPONSE";

export type RespondSuccess = {
  ok: true;
  registrationId: string;
  accepted: boolean;
  status: string;
  respondedAt: string;
  chargeOutcome?: AutoChargeOutcome;
  chargeError?: string;
  invoiceUrl?: string;
  invoiceError?: string;
  refund?: { attempted: true; refundId?: string; error?: string };
};

/**
 * The parent's answer to a coach's proposal (§5.4.7).
 *
 * Accepting IS approving: the coach's proposal was their approval, conditional
 * on the family agreeing, so this re-enters `approveRegistration` with the
 * COACH recorded as the approver rather than inventing a second approval path.
 * Declining is functionally a cancellation, so it refunds on the same terms a
 * coach decline does — except that the actor here is the parent, so there is no
 * finance permission to check and the refund is unconditional.
 *
 * `proposedChangeRespondedAt` is written once and never rewritten. It is both
 * the terminal-state guard (a second Accept 409s) and the dedupe key both
 * response emails ride on, so a replay under the lock produces the same email
 * row instead of a second message.
 */
export async function respondToProposal(args: {
  registrationId: string;
  clubId: string;
  /** The guardian (or the athlete's own login) answering. */
  actorUserId: string;
  accept: boolean;
  /** Required when accepting a proposal that costs more. */
  additionalConsent?: { agreed: true; buttonLabel?: string; amount: number } | null;
  now?: Date;
}): Promise<RespondSuccess | MutationFailure> {
  const now = args.now ?? new Date();

  const decided = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${args.registrationId}`}, 0))`;

    const reg = (await db.eventRegistration.findFirst({
      where: { id: args.registrationId, clubId: args.clubId },
      ...REG_FOR_MUTATION,
    })) as RegForMutation | null;
    if (!reg) return fail("NOT_FOUND", 404, "Registration not found");
    if (!reg.proposedChange || reg.proposedChangeRespondedAt) {
      return fail(
        "INVALID_TRANSITION",
        409,
        reg.proposedChangeRespondedAt
          ? "You've already answered this proposal."
          : "There's nothing to respond to on this registration.",
        reg,
      );
    }

    const blob = reg.proposedChange as Record<string, unknown>;
    const delta = Number(blob.priceDelta ?? 0) || 0;
    const changes = (blob.changes && typeof blob.changes === "object" ? blob.changes : {}) as Record<
      string,
      unknown
    >;

    if (args.accept && delta > 0) {
      // The amount is re-derived from the stored proposal, never taken from the
      // client: consent has to be to the number the coach actually proposed.
      if (!args.additionalConsent?.agreed) {
        return fail(
          "CONSENT_REQUIRED",
          400,
          `Accepting adds $${delta.toFixed(2)}. Please confirm you authorize it.`,
          reg,
        );
      }
      if (Math.round(Number(args.additionalConsent.amount) * 100) !== Math.round(delta * 100)) {
        return fail(
          "CONSENT_AMOUNT_MISMATCH",
          400,
          "The amount you confirmed doesn't match the proposed change. Reload and try again.",
          reg,
        );
      }
    }

    if (!args.accept) {
      await db.eventRegistration.update({
        where: { id: reg.id },
        data: {
          proposedChangeRespondedAt: now,
          proposedChangeAccepted: false,
          status: "CANCELED",
          // approvalStatus stays PENDING on purpose — the coach never declined
          // this, the family did. §5.2.6 renders the difference.
          nextReminderAt: null,
        },
      });
      if (reg.transactionId) {
        await db.transaction.updateMany({
          where: { id: reg.transactionId, clubId: reg.clubId, status: "PENDING" },
          data: {
            status: "FAILED",
            reconciliationStatus: "VOID",
            notes: "Superseded — the family declined the coach's proposed change.",
          },
        });
      }
      if (reg.memberId) {
        await db.booking
          .delete({ where: { eventId_memberId: { eventId: reg.eventId, memberId: reg.memberId } } })
          .catch(() => undefined);
      }
      return { reg, accepted: false as const, delta, changes };
    }

    // Accepted: the proposed values become what they registered for. v1 change
    // types are all form answers, so they overlay onto formResponses — the same
    // JSON every other surface already reads.
    const responses = (reg.formResponses && typeof reg.formResponses === "object"
      ? reg.formResponses
      : {}) as Record<string, unknown>;
    const merged = { ...responses, ...changes };

    const consentSnapshot =
      delta > 0
        ? {
            ...((reg.autoChargeConsent as Record<string, unknown> | null) ?? {}),
            deltaAgreedAt: now.toISOString(),
            deltaAmount: delta,
            deltaButtonLabel: args.additionalConsent?.buttonLabel ?? null,
            deltaByUserId: args.actorUserId,
          }
        : null;

    await db.eventRegistration.update({
      where: { id: reg.id },
      data: {
        proposedChangeRespondedAt: now,
        proposedChangeAccepted: true,
        formResponses: merged as Prisma.InputJsonValue,
        // The delta rides on amountDue for every method that settles later.
        // For a CARD registration that already paid, amountDue becomes the
        // outstanding delta and the invoice path collects it separately —
        // never a re-charge of the original PaymentIntent.
        ...(delta ? { amountDue: Math.max(0, Number(reg.amountDue ?? 0) + delta) } : {}),
        ...(consentSnapshot ? { autoChargeConsent: consentSnapshot as Prisma.InputJsonValue } : {}),
      },
    });

    return { reg, accepted: true as const, delta, changes };
  });

  if ("ok" in decided) return decided;
  const { reg, accepted, delta, changes } = decided;
  const respondedAt = now.toISOString();

  await writeBillingAudit({
    clubId: args.clubId,
    memberId: reg.memberId,
    actorUserId: args.actorUserId,
    action: "EVENT_REGISTRATION_PARENT_RESPONSE",
    before: { registrationId: reg.id, status: reg.status, proposedChange: reg.proposedChange ?? null },
    after: { registrationId: reg.id, accepted, changes, priceDelta: delta, respondedAt },
    note: `${reg.name}'s family ${accepted ? "accepted" : "declined"} the coach's proposed change for ${reg.event.name}.`,
  });

  // The family card's row is answered either way.
  if (reg.memberId) {
    await prisma.pendingApproval
      .updateMany({
        where: { clubId: args.clubId, memberId: reg.memberId, kind: PROPOSAL_APPROVAL_KIND, status: "PENDING" },
        data: {
          status: accepted ? "APPROVED" : "DECLINED",
          respondedAt: now,
          respondedById: args.actorUserId,
        },
      })
      .catch(() => undefined);
  }

  // Back to the coach, in the thread the proposal came from (§5.5).
  //
  // Addressed to the COACH directly rather than through sendMemberMessage:
  // that helper fans out to the athlete's family, and the family is who is
  // replying. Routing the reply through it would have the parent message
  // themselves — the helper filters the sender out of its own recipient list
  // and the message would silently go nowhere. subjectMemberId keeps it in the
  // same child-scoped thread the proposal arrived in.
  const coachUserId =
    typeof (reg.proposedChange as Record<string, unknown> | null)?.proposedByUserId === "string"
      ? ((reg.proposedChange as Record<string, unknown>).proposedByUserId as string)
      : null;
  if (coachUserId && coachUserId !== args.actorUserId) {
    await prisma.message
      .create({
        data: {
          clubId: args.clubId,
          senderId: args.actorUserId,
          recipientId: coachUserId,
          subjectMemberId: reg.memberId,
          body: accepted
            ? `We accept the change to ${reg.name}'s ${reg.event.name} registration.`
            : `We can't take the proposed change to ${reg.name}'s ${reg.event.name} registration, so we're withdrawing.`,
        } as Prisma.MessageUncheckedCreateInput,
      })
      .catch((e) => console.error("[eventApproval] response DM failed", e));
  }

  if (!accepted) {
    const result: RespondSuccess = {
      ok: true,
      registrationId: reg.id,
      accepted: false,
      status: "CANCELED",
      respondedAt,
    };
    // A family that already paid gets their money back — unconditionally.
    // There is no finance permission to test here: the actor is the payer.
    if ((reg.status === "PAID" || Number(reg.amountPaid ?? 0) > 0) && reg.stripePaymentIntentId && reg.club.stripeAccountId) {
      result.refund = { attempted: true };
      try {
        const refund = await stripe.refunds.create(
          { payment_intent: reg.stripePaymentIntentId },
          { stripeAccount: reg.club.stripeAccountId, idempotencyKey: `aox-eventreg-refund-${reg.id}` },
        );
        result.refund.refundId = refund.id;
        await writeBillingAudit({
          clubId: args.clubId,
          memberId: reg.memberId,
          actorUserId: args.actorUserId,
          action: "EVENT_REGISTRATION_REFUNDED",
          before: { registrationId: reg.id, amountPaid: Number(reg.amountPaid ?? 0) },
          after: { registrationId: reg.id, refundId: refund.id, amount: refund.amount / 100 },
          note: `Refund issued after the family declined the proposed change for ${reg.event.name}.`,
        });
      } catch (e) {
        console.error("[eventApproval] parent-decline refund failed", reg.id, e);
        result.refund.error = String(e);
        await writeBillingAudit({
          clubId: args.clubId,
          memberId: reg.memberId,
          actorUserId: args.actorUserId,
          action: "EVENT_REGISTRATION_REFUND_FAILED",
          before: { registrationId: reg.id, paymentIntentId: reg.stripePaymentIntentId },
          after: { registrationId: reg.id, error: String(e).slice(0, 300) },
          note: `Refund FAILED after a declined proposal on ${reg.event.name}. Check Stripe.`,
        });
      }
    }
    await sendRegistrationLifecycleEmail({
      registrationId: reg.id,
      transition: "PROPOSAL_DECLINED",
      actorUserId: args.actorUserId,
      respondedAt,
    });
    return result;
  }

  // Acceptance implies approval — same helper the coach route calls, with the
  // COACH as the approver and as the Booking's bookedByUserId.
  const approved = await approveRegistration({
    registrationId: reg.id,
    clubId: args.clubId,
    actorUserId: coachUserId,
    bookedByUserId: coachUserId,
    // The PROPOSAL_ACCEPTED email below covers this transition.
    sendEmail: false,
    now,
  });

  const result: RespondSuccess = {
    ok: true,
    registrationId: reg.id,
    accepted: true,
    status: approved.ok ? approved.status : reg.status,
    respondedAt,
  };
  if (approved.ok) {
    if (approved.chargeOutcome) result.chargeOutcome = approved.chargeOutcome;
    if (approved.chargeError) result.chargeError = approved.chargeError;
    if (approved.invoiceUrl) result.invoiceUrl = approved.invoiceUrl;
    if (approved.invoiceError) result.invoiceError = approved.invoiceError;
  }

  // Row 5, not row 2: acceptance-triggered approval sends ONE email about the
  // whole thing rather than an "approved" message chasing an "accepted" one.
  await sendRegistrationLifecycleEmail({
    registrationId: reg.id,
    transition: "PROPOSAL_ACCEPTED",
    actorUserId: args.actorUserId,
    respondedAt,
  });

  return result;
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
