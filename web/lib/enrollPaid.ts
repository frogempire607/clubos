// Enrol a member who has ALREADY paid, cash or check.
//
// ── The gap this fills ──────────────────────────────────────────────────────
//
// Enrolling a cash-paying family took three different doors and none of them
// did the whole job:
//
//   members/subscribe      creates a MANUAL subscription and NO money row —
//                          an active membership with no record of payment
//   migration/approve      creates the subscription AND a PENDING amount-due
//                          row, but only for a member mid-migration
//   offline-payment        settles a PENDING row that something else made; with
//                          nothing to settle it 404s
//
// So Drew Telesky's month of cash had nowhere to go: no subscription meant no
// pending row, and no pending row meant the receipt endpoint refused. The money
// was never recorded at all.
//
// This is the missing composition, and it is deliberately ONE operation because
// the four facts only make sense together: what they bought, what they handed
// over, what period that covers, and whether the card takes over afterwards.
//
// ── Cash and check only ─────────────────────────────────────────────────────
//
// A card payment already has a Transaction, a Stripe object and a period Stripe
// itself is tracking. Routing it through here would create a second, manual
// record of money that is already recorded — the duplicate-ledger problem, by
// hand. Card enrolment stays where it is.

import { prisma } from "@/lib/prisma";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { writeBillingAudit } from "@/lib/billingAudit";
import { turnAutopayOn } from "@/lib/autopay";
import {
  recordSubscriptionEvent,
  SUBSCRIPTION_EVENT_KIND,
  SUBSCRIPTION_EVENT_SOURCE,
} from "@/lib/subscriptionEvents";
import { minimumTermEndForOptionId, parseOptions } from "@/lib/membershipOptions";
import { addUTCMonths } from "@/lib/billingAdmin";

export type EnrollPaidInput = {
  memberId: string;
  clubId: string;
  actorUserId: string | null;
  membershipId: string;
  /** Which option was sold. Opaque id — never the label. */
  optionId: string;
  /** What they actually handed over. Validated against the option by the route. */
  amountReceived: number;
  method: "CASH" | "CHECK";
  /** Cheque number / receipt reference. */
  reference?: string | null;
  /** The LAST day this money covers. Billing resumes after it. */
  coversUntil: Date;
  /** Start card billing when the paid period runs out. */
  startCardBilling: boolean;
  note?: string | null;
};

export type EnrollPaidResult =
  | {
      ok: true;
      subscriptionId: string;
      transactionId: string;
      paidThrough: Date;
      cardBilling: { started: boolean; message: string | null };
      message: string;
    }
  | { ok: false; code: string; error: string };

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function enrollAlreadyPaid(input: EnrollPaidInput): Promise<EnrollPaidResult> {
  const { memberId, clubId, membershipId, optionId } = input;

  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, commitmentEndDate: true },
  });
  if (!member) return { ok: false, code: "NOT_FOUND", error: "That member no longer exists." };

  const plan = await prisma.membership.findFirst({
    where: { id: membershipId, clubId, deletedAt: null },
    select: { id: true, name: true, options: true, contractMonths: true },
  });
  if (!plan) return { ok: false, code: "NO_PLAN", error: "That membership plan no longer exists." };

  const option = parseOptions(plan.options).find((o) => o.id === optionId);
  if (!option) {
    return { ok: false, code: "NO_OPTION", error: "That option is no longer on the plan. Re-pick it." };
  }

  // ── Never enrol over live card billing ───────────────────────────────────
  //
  // If Stripe is actively charging them, adding a cash period on top is how a
  // family gets billed twice for the same month. Adjust the live subscription
  // instead.
  // `canceledAt: null` is load-bearing, not tidiness. Holding a
  // stripeSubscriptionId does NOT mean Stripe is charging them — Dakota
  // Mastrantonio's row pointed at a subscription Stripe deleted on 2026-08-07
  // and still read `status: active`, because a late payment had flipped it back.
  // Without this clause the guard refuses the exact case this whole path exists
  // to handle: someone who has paid, has no live billing, and needs enrolling.
  //
  // canceledAt is only ever written by the deletion webhook or by an executed
  // cancellation, so its presence is reliable evidence that nothing is charging.
  // The residual risk runs the safe way: a row whose deletion webhook was missed
  // still refuses, and refusing costs a conversation while double-billing costs
  // a family money.
  const liveCard = await prisma.memberSubscription.findFirst({
    where: {
      memberId, status: { in: ["active", "past_due"] },
      stripeSubscriptionId: { not: null },
      canceledAt: null,
    },
    select: { id: true, optionLabel: true, stripeSubscriptionId: true },
  });
  if (liveCard) {
    return {
      ok: false, code: "LIVE_CARD_BILLING",
      error:
        `${member.firstName} already has card billing running on "${liveCard.optionLabel}" ` +
        `(${liveCard.stripeSubscriptionId}). Recording a cash period on top would bill them twice. ` +
        `Change the live subscription instead, or turn autopay off first.`,
    };
  }

  // Reuse an existing row for this plan rather than stacking a second one — a
  // member with two rows for one plan is the shape every coverage and billing
  // reader has to disambiguate, and none of them do it well.
  const existing = await prisma.memberSubscription.findFirst({
    where: { memberId, membershipId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, canceledAt: true, stripeSubscriptionId: true },
  });

  const termEnd = minimumTermEndForOptionId(
    new Date(), parseOptions(plan.options), optionId,
    { contractMonths: plan.contractMonths }, addUTCMonths,
  );

  const subData = {
    optionId,
    optionLabel: option.label,
    price: option.price,
    billingPeriod: option.billingPeriod,
    billingType: "MANUAL",
    status: "active",
    // The money reaches this far, and that is what anchors everything after:
    // renewal surfacing, "who owes", and the first card charge if one is armed.
    paidThroughDate: input.coversUntil,
    currentPeriodEnd: input.coversUntil,
    minimumTermEndsAt: termEnd,
    // A stale pointer to a subscription Stripe has already deleted would make
    // turnAutopayOn refuse with ALREADY_ON, and leaves canceledAt contradicting
    // an active row — the exact state Dakota Mastrantonio was found in.
    stripeSubscriptionId: null,
    stripePriceId: null,
    canceledAt: null,
    expiredAt: null,
  };

  const sub = existing
    ? await prisma.memberSubscription.update({
        where: { id: existing.id },
        data: { ...subData, notes: `Re-enrolled ${day(new Date())} — ${input.method.toLowerCase()} received, paid through ${day(input.coversUntil)}.` },
        select: { id: true },
      })
    : await prisma.memberSubscription.create({
        data: {
          ...subData, memberId, membershipId,
          startDate: new Date(),
          notes: `Enrolled ${day(new Date())} — ${input.method.toLowerCase()} received, paid through ${day(input.coversUntil)}.`,
        },
        select: { id: true },
      });

  // ── The money, recorded as RECEIVED, not as owed ─────────────────────────
  //
  // SUCCEEDED, not PENDING: this is not "they agreed to pay", it is "the cash
  // is in the drawer". OFFLINE reconciliation because no Stripe balance
  // transaction backs it and it must never blend into verified card revenue.
  const tx = await prisma.transaction.create({
    data: {
      clubId, memberId,
      amount: input.amountReceived,
      type: "MEMBERSHIP",
      category: "memberships",
      status: "SUCCEEDED",
      paymentSource: input.method,
      paymentMethod: input.method,
      reconciliationStatus: "OFFLINE",
      manual: true,
      txDate: new Date(),
      recordedByUserId: input.actorUserId,
      description: `${plan.name} — ${option.label} — paid by ${input.method.toLowerCase()}`,
      notes:
        `Covers through ${day(input.coversUntil)}.` +
        (input.reference ? ` Ref: ${input.reference}.` : "") +
        (input.note ? ` ${input.note}` : ""),
      coversStart: new Date(),
      coversEnd: input.coversUntil,
    },
    select: { id: true },
  });

  await prisma.member.update({
    where: { id: memberId },
    data: { membershipId, billingUpdatedAt: new Date(), billingUpdatedById: input.actorUserId },
  });
  await recomputeMemberStatus(memberId, clubId);

  await recordSubscriptionEvent({
    clubId, memberSubscriptionId: sub.id, memberId,
    kind: existing ? SUBSCRIPTION_EVENT_KIND.REACTIVATED : SUBSCRIPTION_EVENT_KIND.CREATED,
    toPlan: option.label,
    toAmount: String(option.price),
    actorUserId: input.actorUserId,
    source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: {
      route: "enrollAlreadyPaid", method: input.method,
      amountReceived: input.amountReceived, coversUntil: input.coversUntil.toISOString(),
      transactionId: tx.id,
    },
  });
  await writeBillingAudit({
    clubId, memberId, actorUserId: input.actorUserId,
    action: "ENROLLED_ALREADY_PAID",
    before: { hadSubscription: !!existing, previousStatus: existing?.status ?? null },
    after: {
      subscriptionId: sub.id, transactionId: tx.id,
      option: option.label, amountReceived: input.amountReceived,
      method: input.method, paidThrough: input.coversUntil.toISOString(),
      cardBillingArmed: input.startCardBilling,
    },
    note:
      `${member.firstName} ${member.lastName} enrolled on "${option.label}" — ` +
      `$${input.amountReceived.toFixed(2)} ${input.method.toLowerCase()} received, paid through ` +
      `${day(input.coversUntil)}.` +
      (input.startCardBilling ? " Card billing armed from that date." : " No card billing."),
  });

  // ── Card billing, anchored to what the cash bought ───────────────────────
  //
  // turnAutopayOn reads paidThroughDate for its trial_end, which is now stamped
  // above — so the first charge lands the day the cash runs out. A paid-through
  // date in the past charges immediately, which is correct: the period is over.
  let cardBilling: { started: boolean; message: string | null } = { started: false, message: null };
  if (input.startCardBilling) {
    const r = await turnAutopayOn(sub.id, clubId, {
      userId: input.actorUserId,
      source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    });
    cardBilling = r.ok
      ? { started: true, message: r.message }
      // Soft-fail on purpose: the enrolment and the money are already recorded
      // and correct. Failing the whole operation because a card could not be
      // armed would throw away the part that worked.
      : { started: false, message: `Enrolled, but card billing could not start: ${r.error}` };
  }

  return {
    ok: true,
    subscriptionId: sub.id,
    transactionId: tx.id,
    paidThrough: input.coversUntil,
    cardBilling,
    message:
      `${member.firstName} is on "${option.label}", paid through ${day(input.coversUntil)} ` +
      `by ${input.method.toLowerCase()}.` +
      (cardBilling.started ? ` ${cardBilling.message}` : ""),
  };
}
