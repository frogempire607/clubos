// B16 — the money actions behind the Membership panel. Each one re-derives its
// plan from LIVE values (lib/membershipMoney), refuses if that plan no longer
// matches what the owner previewed, acts, and writes both the subscription
// event log and the billing audit with who did it.
//
// Every entry point takes `preview: true` and then returns the exact sentences
// without touching Stripe or the database — the sheet shows those, so the
// words the owner confirms are the words this code runs.

import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { recurringUnitWithFee } from "@/lib/fees";
import { writeBillingAudit } from "@/lib/billingAudit";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { turnAutopayOff, turnAutopayOn, setAutoRenew, planNonRenewal, applyNonRenewal, offlineStopDate } from "@/lib/autopay";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { recordSubscriptionEvent, SUBSCRIPTION_EVENT_KIND, SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";
import { chargeDateMovePlan, type MoveRow } from "@/lib/chargeDate";
import { resolveDatesEdit } from "@/lib/membershipPanel";
import { syncOneSubscription } from "@/lib/stripeSync";
import {
  type MoneyRow, type PmFacts,
  paidAnotherWayPlan, waivePlan, refundable, checkRefund, switchToCashPlan, switchToCardPlan, autoRenewPlan,
  paymentMethodLabel, fmtDate, fmtShort, money2,
} from "@/lib/membershipMoney";

export type ActionResult =
  | { ok: true; preview: true; sentence: string; consequence: string; needsChargeAck?: boolean; facts?: Record<string, unknown> }
  | { ok: true; preview?: false; message: string }
  | { ok: false; status: number; code: string; error: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const sameDay = (a: Date | null | undefined, b: string | null | undefined) => !!a && !!b && Math.abs(a.getTime() - new Date(b).getTime()) < 86_400_000;
const stamp = () => new Date().toISOString().slice(0, 10);

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadRow(clubId: string, memberId: string, subscriptionId: string) {
  return prisma.memberSubscription.findFirst({
    where: { id: subscriptionId, memberId, member: { clubId, deletedAt: null }, status: { in: ["active", "past_due"] } },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, requestedPaymentMethod: true, stripeSetupCustomerId: true, stripeCustomerId: true, stripeSetupPaymentMethodId: true } },
      membership: { select: { name: true } },
    },
  });
}
type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>;

async function clubStripe(clubId: string) {
  return prisma.club.findUnique({ where: { id: clubId }, select: { stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true } });
}

export function toMoneyRow(row: Row, live: LiveFacts | null): MoneyRow {
  const snap = (row.stripeSnapshot ?? null) as { cancelAt?: string | null } | null;
  return {
    hasStripe: !!row.stripeSubscriptionId,
    status: row.status,
    stripeStatus: live?.status ?? row.stripeStatus,
    price: Number(row.price),
    billingPeriod: row.billingPeriod,
    startDate: row.startDate,
    endDate: row.endDate,
    currentPeriodEnd: live?.currentPeriodEnd ?? row.currentPeriodEnd,
    paidThroughDate: row.paidThroughDate,
    minimumTermEndsAt: row.minimumTermEndsAt,
    autoRenew: row.autoRenew,
    cancelAt: live ? live.cancelAt : snap?.cancelAt ? new Date(snap.cancelAt) : null,
    pausedAt: row.pausedAt ?? (live?.paused ? new Date() : null),
    pausedUntil: row.pausedUntil,
    deliberateFree: row.deliberateFree,
  };
}

// ── Live facts from Stripe (read-only) ───────────────────────────────────────

export type LiveFacts = {
  status: string;
  currentPeriodEnd: Date | null;
  /** When the next invoice is drafted: trial end while trialing, else the period end. */
  nextInvoiceAt: Date | null;
  cancelAt: Date | null;
  paused: boolean;
  pm: PmFacts | null;
  /** The invoice date our one-time skip discount is waiting for, if one is attached. */
  skipAt: Date | null;
  /** Discounts already on the subscription — kept when a skip is added. */
  discountIds: string[];
};

function pmFacts(pm: Stripe.PaymentMethod | string | null | undefined): PmFacts | null {
  if (!pm || typeof pm === "string") return null;
  return {
    type: pm.type,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? (pm as { us_bank_account?: { last4?: string | null } }).us_bank_account?.last4 ?? null,
    wallet: pm.card?.wallet?.type ?? null,
  };
}

/** Never throws. `timeoutMs` keeps a slow Stripe from holding the panel hostage. */
export async function liveStripeFacts(stripeSubscriptionId: string, stripeAccount: string, timeoutMs = 4000): Promise<LiveFacts | null> {
  const work = (async () => {
    const sub = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
      { expand: ["default_payment_method", "discounts", "customer.invoice_settings.default_payment_method"] },
      { stripeAccount },
    );
    const cust = typeof sub.customer === "object" && sub.customer && !("deleted" in sub.customer && sub.customer.deleted) ? (sub.customer as Stripe.Customer) : null;
    const pm = pmFacts(sub.default_payment_method as Stripe.PaymentMethod | null) ?? pmFacts(cust?.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null);
    let skipAt: Date | null = null;
    const discountIds: string[] = [];
    for (const d of (sub.discounts ?? []) as (string | Stripe.Discount)[]) {
      if (typeof d === "string") { discountIds.push(d); continue; }
      discountIds.push(d.id);
      const f = d.coupon?.metadata?.aoxSkipFor;
      if (f && Number(f) > 0) skipAt = new Date(Number(f) * 1000);
    }
    const cpe = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
    return {
      status: sub.status,
      currentPeriodEnd: cpe,
      nextInvoiceAt: sub.status === "trialing" && sub.trial_end ? new Date(sub.trial_end * 1000) : cpe,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : sub.cancel_at_period_end ? cpe : null,
      paused: !!sub.pause_collection,
      pm,
      skipAt,
      discountIds,
    } satisfies LiveFacts;
  })();
  try {
    return await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  } catch (e) {
    console.error("[membershipMoney] live Stripe read failed", stripeSubscriptionId, e);
    return null;
  }
}

// ── Skipping exactly one invoice ─────────────────────────────────────────────
//
// WHY A ONE-TIME 100% COUPON, NOT pause_collection:
//
//  · pause_collection {behavior:"void", resumes_at} would also skip one
//    invoice, but a paused subscription is read by lib/stripeSync as "the owner
//    paused this in Stripe" and flips the row to paused and the athlete to
//    PAUSED on the next sync — the family would lose class access for a month
//    they paid for. It also blocks Change plan (stripePlanChangeServer refuses
//    a paused subscription), and a resumes_at that lands a few minutes early
//    lets the invoice through.
//  · A coupon with duration "once" and max_redemptions 1 applies to the next
//    invoice Stripe drafts for this subscription and then removes itself. The
//    price, the plan item, the billing anchor, cancel_at and the commitment
//    are all untouched; the subscription stays "active". The $0 invoice is
//    ignored by the invoice.paid webhook ("$0 invoices don't belong in the
//    money ledger"), so no revenue is invented and nothing is double counted.
//  · It is visible in the Stripe dashboard as a named discount ("Skip Oct 27
//    payment"), and its metadata (aoxSkipFor) is how the panel knows a skip is
//    waiting, straight from Stripe rather than from a local flag that could drift.
//  · Discounts already on the subscription are passed back alongside it, so a
//    real discount is never dropped.
//  Residual risk: an invoice Stripe drafts BEFORE the renewal (only a
//  mid-cycle proration, which nothing in this app creates) would consume it.

async function addSkipDiscount(opts: { subId: string; acct: string; rowId: string; at: Date; label: string; discountIds: string[]; why: string }): Promise<{ couponId: string }> {
  const atUnix = Math.floor(opts.at.getTime() / 1000);
  const coupon = await stripe.coupons.create(
    {
      percent_off: 100, duration: "once", max_redemptions: 1,
      name: opts.label.slice(0, 40),
      metadata: { aoxSkipFor: String(atUnix), memberSubscriptionId: opts.rowId, why: opts.why.slice(0, 200) },
    },
    { stripeAccount: opts.acct, idempotencyKey: `aox-skip-coupon-${opts.rowId}-${atUnix}` },
  );
  await stripe.subscriptions.update(
    opts.subId,
    { discounts: [...opts.discountIds.map((id) => ({ discount: id })), { coupon: coupon.id }], proration_behavior: "none" },
    { stripeAccount: opts.acct },
  );
  return { couponId: coupon.id };
}

/** Best-effort rollback: put the discounts back exactly as they were. */
async function removeSkipDiscount(subId: string, acct: string, discountIds: string[]) {
  try {
    await stripe.subscriptions.update(subId, { discounts: discountIds.length ? discountIds.map((id) => ({ discount: id })) : "" }, { stripeAccount: acct });
  } catch (e) {
    console.error("[membershipMoney] skip rollback FAILED — remove the skip discount by hand in Stripe", subId, e);
  }
}

// ── 1. They paid another way this time / Record a payment ────────────────────

export async function paidAnotherWay(input: {
  clubId: string; memberId: string; subscriptionId: string; actorUserId: string | null;
  method: "CASH" | "CHECK"; amount: number | null; reference: string | null; preview: boolean; expectedSkipAt: string | null;
}): Promise<ActionResult> {
  const row = await loadRow(input.clubId, input.memberId, input.subscriptionId);
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", error: "No live membership found." };
  const club = await clubStripe(input.clubId);
  const live = row.stripeSubscriptionId && club?.stripeAccountId ? await liveStripeFacts(row.stripeSubscriptionId, club.stripeAccountId) : null;
  if (row.stripeSubscriptionId && !live) return { ok: false, status: 502, code: "STRIPE_UNREACHABLE", error: "Stripe couldn't be reached to check the next charge. Nothing was recorded — try again in a minute." };
  const m = toMoneyRow(row, live);
  const amount = input.amount ?? m.price;
  const pmLabel = paymentMethodLabel(live?.pm);
  const plan = paidAnotherWayPlan(m, { method: input.method, amount, pmLabel, nextInvoiceAt: live?.nextInvoiceAt ?? null, alreadySkippedAt: live?.skipAt ?? null, now: new Date() });
  if (!plan.ok) return { ok: false, status: 409, code: plan.code, error: plan.error };
  if (input.preview) return { ok: true, preview: true, sentence: plan.sentence, consequence: plan.consequence, facts: { skipAt: iso(plan.skipAt), coversStart: iso(plan.coversStart), coversEnd: iso(plan.coversEnd), amount } };
  if (plan.skipAt && !sameDay(plan.skipAt, input.expectedSkipAt)) {
    return { ok: false, status: 409, code: "STALE", error: `The next charge is now ${fmtDate(plan.skipAt)} — review the sheet again.` };
  }

  let couponId: string | null = null;
  if (plan.mode === "SKIP_CARD_CHARGE") {
    try {
      couponId = (await addSkipDiscount({ subId: row.stripeSubscriptionId!, acct: club!.stripeAccountId!, rowId: row.id, at: plan.skipAt!, label: `Skip ${fmtShort(plan.skipAt!)} payment (paid ${input.method.toLowerCase()})`, discountIds: live!.discountIds, why: `paid ${input.method.toLowerCase()}` })).couponId;
    } catch (e) {
      return { ok: false, status: 502, code: "STRIPE_FAILED", error: `Stripe didn't accept the skip — nothing was recorded or charged: ${String(e)}` };
    }
  }

  const planName = row.membership?.name ?? row.optionLabel;
  const m2 = input.method.toLowerCase();
  let txId: string;
  try {
    // The money, as RECEIVED — the same shape lib/enrollPaid writes, so it
    // lands in Financials (Cash & Offline) and Reports as cash revenue. No
    // Stripe id on it: it must never blend into verified card revenue.
    const tx = await prisma.transaction.create({
      data: {
        clubId: input.clubId, memberId: input.memberId, amount, type: "MEMBERSHIP", category: "memberships", status: "SUCCEEDED",
        paymentSource: input.method, paymentMethod: input.method, reconciliationStatus: "OFFLINE", manual: true, txDate: new Date(),
        recordedByUserId: input.actorUserId,
        description: `${planName} — ${row.optionLabel} — paid by ${m2} (${fmtShort(plan.coversStart)} – ${fmtShort(plan.coversEnd)})`,
        notes: `Covers ${plan.coversStart.toISOString().slice(0, 10)} – ${plan.coversEnd.toISOString().slice(0, 10)}.${input.reference ? ` Ref: ${input.reference}.` : ""}${plan.skipAt ? ` The ${plan.skipAt.toISOString().slice(0, 10)} card charge was skipped so they aren't charged twice (Stripe coupon ${couponId}).` : ""}`,
        coversPeriods: 1, coversStart: plan.coversStart, coversEnd: plan.coversEnd,
      },
      select: { id: true },
    });
    txId = tx.id;
    // How far the money reaches. On a Stripe row this is the ONE hand-written
    // paid-through: the period the cash bought is otherwise invisible (the $0
    // invoice never reaches invoice.paid), and the next real charge overwrites it.
    await prisma.memberSubscription.update({
      where: { id: row.id },
      data: {
        paidThroughDate: plan.paidThroughAfter,
        ...(!row.stripeSubscriptionId && (row.currentPeriodEnd == null || row.currentPeriodEnd < new Date()) ? { currentPeriodEnd: plan.coversEnd } : {}),
      },
    });
  } catch (e) {
    if (couponId) await removeSkipDiscount(row.stripeSubscriptionId!, club!.stripeAccountId!, live!.discountIds);
    return { ok: false, status: 500, code: "DB_FAILED", error: `The payment couldn't be saved${couponId ? " — the skipped charge was put back" : ""}. Nothing changed: ${String(e)}` };
  }
  await recomputeMemberStatus(input.memberId, input.clubId);
  await recordSubscriptionEvent({
    clubId: input.clubId, memberSubscriptionId: row.id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.PAYMENT_RECORDED,
    toPlan: row.optionLabel, toAmount: amount, actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "membership/paid-another-way", method: input.method, amount, transactionId: txId, coversStart: iso(plan.coversStart), coversEnd: iso(plan.coversEnd), skippedChargeAt: iso(plan.skipAt), stripeCouponId: couponId },
  });
  await writeBillingAudit({
    clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: plan.skipAt ? "PAID_ANOTHER_WAY_CHARGE_SKIPPED" : "OFFLINE_PAYMENT_RECORDED",
    before: { paidThroughDate: row.paidThroughDate }, after: { paidThroughDate: plan.paidThroughAfter, transactionId: txId, amount, method: input.method, skippedChargeAt: iso(plan.skipAt), stripeCouponId: couponId },
    note: plan.skipAt
      ? `${money2(amount)} ${m2} recorded for ${fmtShort(plan.coversStart)} – ${fmtShort(plan.coversEnd)}; the ${fmtShort(plan.skipAt)} Stripe charge is skipped (one-time 100% coupon ${couponId}).`
      : `${money2(amount)} ${m2} recorded for ${fmtShort(plan.coversStart)} – ${fmtShort(plan.coversEnd)}; paid through ${fmtDate(plan.paidThroughAfter)}.`,
  });
  return {
    ok: true,
    message: plan.skipAt
      ? `${money2(amount)} ${m2} recorded. The ${fmtShort(plan.skipAt)} charge is skipped — ${row.member.firstName} won't be charged for that month.`
      : `${money2(amount)} ${m2} recorded — ${row.member.firstName} is paid through ${fmtDate(plan.paidThroughAfter)}.`,
  };
}

// ── 3. Waive a payment ───────────────────────────────────────────────────────

export async function waivePayment(input: {
  clubId: string; memberId: string; subscriptionId: string; actorUserId: string | null; reason: string; preview: boolean; expectedSkipAt: string | null;
}): Promise<ActionResult> {
  const row = await loadRow(input.clubId, input.memberId, input.subscriptionId);
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", error: "No live membership found." };
  const club = await clubStripe(input.clubId);
  const live = row.stripeSubscriptionId && club?.stripeAccountId ? await liveStripeFacts(row.stripeSubscriptionId, club.stripeAccountId) : null;
  if (row.stripeSubscriptionId && !live) return { ok: false, status: 502, code: "STRIPE_UNREACHABLE", error: "Stripe couldn't be reached to check the next charge. Nothing was changed — try again in a minute." };
  const m = toMoneyRow(row, live);
  const plan = waivePlan(m, { reason: input.reason, pmLabel: paymentMethodLabel(live?.pm), nextInvoiceAt: live?.nextInvoiceAt ?? null, alreadySkippedAt: live?.skipAt ?? null, now: new Date() });
  if (!plan.ok) return { ok: false, status: plan.code === "REASON" ? 400 : 409, code: plan.code, error: plan.error };
  if (input.preview) return { ok: true, preview: true, sentence: plan.sentence, consequence: plan.consequence, facts: { skipAt: iso(plan.skipAt), waivedStart: iso(plan.waivedStart), waivedEnd: iso(plan.waivedEnd) } };
  if (plan.skipAt && !sameDay(plan.skipAt, input.expectedSkipAt)) {
    return { ok: false, status: 409, code: "STALE", error: `The next charge is now ${fmtDate(plan.skipAt)} — review the sheet again.` };
  }
  const reason = input.reason.trim().slice(0, 120);
  let couponId: string | null = null;
  if (plan.mode === "SKIP_CARD_CHARGE") {
    try {
      couponId = (await addSkipDiscount({ subId: row.stripeSubscriptionId!, acct: club!.stripeAccountId!, rowId: row.id, at: plan.skipAt!, label: `Waived ${fmtShort(plan.skipAt!)} payment`, discountIds: live!.discountIds, why: `waived: ${reason}` })).couponId;
    } catch (e) {
      return { ok: false, status: 502, code: "STRIPE_FAILED", error: `Stripe didn't accept the waiver — nothing was changed: ${String(e)}` };
    }
  }
  const planName = row.membership?.name ?? row.optionLabel;
  let txId: string;
  try {
    // A $0 COMP line — the category Reports and Financials already have for
    // "comped, never revenue" (lib/financials.isCompMethod; Reports' "Comped"
    // source). It records that the period was given, by whom and why, without
    // inventing a cent of income.
    const tx = await prisma.transaction.create({
      data: {
        clubId: input.clubId, memberId: input.memberId, amount: 0, type: "MEMBERSHIP", category: "memberships", status: "SUCCEEDED",
        paymentSource: "COMP", paymentMethod: "COMP", reconciliationStatus: "OFFLINE", manual: true, txDate: new Date(),
        recordedByUserId: input.actorUserId,
        description: `${planName} — ${row.optionLabel} — ${plan.label} — ${reason}`,
        notes: `Waived ${plan.waivedStart.toISOString().slice(0, 10)} – ${plan.waivedEnd.toISOString().slice(0, 10)}: ${reason}.${couponId ? ` Stripe charge skipped (coupon ${couponId}).` : ""}`,
        coversPeriods: 1, coversStart: plan.waivedStart, coversEnd: plan.waivedEnd,
      },
      select: { id: true },
    });
    txId = tx.id;
    await prisma.memberSubscription.update({
      where: { id: row.id },
      data: {
        paidThroughDate: plan.paidThroughAfter,
        ...(!row.stripeSubscriptionId && (row.currentPeriodEnd == null || row.currentPeriodEnd < new Date()) ? { currentPeriodEnd: plan.waivedEnd } : {}),
      },
    });
  } catch (e) {
    if (couponId) await removeSkipDiscount(row.stripeSubscriptionId!, club!.stripeAccountId!, live!.discountIds);
    return { ok: false, status: 500, code: "DB_FAILED", error: `The waiver couldn't be saved${couponId ? " — the skipped charge was put back" : ""}. Nothing changed: ${String(e)}` };
  }
  await recomputeMemberStatus(input.memberId, input.clubId);
  await recordSubscriptionEvent({
    clubId: input.clubId, memberSubscriptionId: row.id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.PAYMENT_WAIVED,
    fromPlan: row.optionLabel, fromAmount: String(row.price), toAmount: 0, actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "membership/waive", reason, transactionId: txId, waivedStart: iso(plan.waivedStart), waivedEnd: iso(plan.waivedEnd), skippedChargeAt: iso(plan.skipAt), stripeCouponId: couponId },
  });
  await writeBillingAudit({
    clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: "PAYMENT_WAIVED",
    before: { paidThroughDate: row.paidThroughDate }, after: { paidThroughDate: plan.paidThroughAfter, transactionId: txId, reason, skippedChargeAt: iso(plan.skipAt), stripeCouponId: couponId },
    note: `${plan.label} (${fmtShort(plan.waivedStart)} – ${fmtShort(plan.waivedEnd)}) — ${reason}${couponId ? ` — Stripe charge skipped (coupon ${couponId})` : ""}.`,
  });
  return { ok: true, message: `${plan.label} — ${reason}. Paid through ${fmtDate(plan.paidThroughAfter)}.` };
}

// ── 4. Refund ────────────────────────────────────────────────────────────────

export async function refundPaymentTx(input: {
  clubId: string; memberId: string; subscriptionId: string | null; transactionId: string; actorUserId: string | null;
  amount: number | null; reason: string; preview: boolean;
}): Promise<ActionResult> {
  const tx = await prisma.transaction.findFirst({
    where: { id: input.transactionId, clubId: input.clubId, OR: [{ memberId: input.memberId }, { athleteMemberId: input.memberId }] },
  });
  if (!tx) return { ok: false, status: 404, code: "NOT_FOUND", error: "Payment not found." };
  if (tx.reconciliationStatus === "VOID") return { ok: false, status: 409, code: "VOID", error: "This payment was voided — there's nothing to refund." };
  const left = refundable({ amount: Number(tx.amount), refundedAmount: tx.refundedAmount != null ? Number(tx.refundedAmount) : null, status: tx.status });
  const want = input.amount ?? left;
  const chk = checkRefund(want, left);
  if (!chk.ok) return { ok: false, status: 400, code: "AMOUNT", error: chk.error };
  const reason = input.reason.trim().slice(0, 120);
  if (!reason) return { ok: false, status: 400, code: "REASON", error: "Say why — it shows on the payment and in the history." };

  const isStripe = tx.paymentSource === "STRIPE" || (!tx.manual && (!!tx.stripeChargeId || !!tx.stripePaymentIntentId));
  const src = (tx.paymentSource ?? tx.paymentMethod ?? "").toUpperCase();
  const via = isStripe ? "back to their payment method through Stripe" : src === "CHECK" ? "a check refund you hand back" : src === "EXTERNAL_READER" ? "recorded here — refund it on the card reader you used" : "cash you hand back";
  if (isStripe && !tx.stripeChargeId && !tx.stripePaymentIntentId) {
    return { ok: false, status: 409, code: "NO_STRIPE_REF", error: "This card payment has no Stripe reference on record, so it can't be refunded from here. Refund it in the Stripe dashboard." };
  }
  if (input.preview) {
    return {
      ok: true, preview: true,
      sentence: `Refunds ${money2(chk.amount)}${chk.full ? " — the full amount left on this payment" : ` of ${money2(left)} left on this payment`} — ${via}.`,
      consequence: isStripe
        ? `a refund of ${money2(chk.amount)} is created on the original charge. It usually reaches them in 5–10 business days. Reports subtract it from income once. Paid-through doesn't move — use Change dates if the period should end early.`
        : "nothing — no card involved. Reports subtract it from income once. Paid-through doesn't move — use Change dates if the period should end early.",
      facts: { left, amount: chk.amount, full: chk.full },
    };
  }

  let refundedTotal = Math.round(((tx.refundedAmount != null ? Number(tx.refundedAmount) : 0) + chk.amount) * 100) / 100;
  let stripeRefundId: string | null = null;
  if (isStripe) {
    const club = await clubStripe(input.clubId);
    if (!club?.stripeAccountId) return { ok: false, status: 409, code: "NO_STRIPE", error: "Stripe isn't connected for this club." };
    const cents = Math.round(chk.amount * 100);
    const prevCents = Math.round((tx.refundedAmount != null ? Number(tx.refundedAmount) : 0) * 100);
    try {
      const refund = await stripe.refunds.create(
        {
          ...(tx.stripeChargeId ? { charge: tx.stripeChargeId } : { payment_intent: tx.stripePaymentIntentId! }),
          amount: cents, reason: "requested_by_customer",
          metadata: { transactionId: tx.id, memberId: input.memberId, refundedByUserId: input.actorUserId ?? "", reason },
          expand: ["charge"],
        },
        // Keyed on what was already refunded: a double-tap re-sends the same
        // request and gets the same refund, never a second one.
        { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-refund-${tx.id}-${prevCents}-${cents}` },
      );
      stripeRefundId = refund.id;
      // Stripe's running total is the truth — the charge.refunded webhook
      // writes the same absolute number, so the refund is counted once.
      const ch = refund.charge && typeof refund.charge === "object" ? (refund.charge as Stripe.Charge) : null;
      if (ch && typeof ch.amount_refunded === "number") refundedTotal = ch.amount_refunded / 100;
    } catch (e) {
      return { ok: false, status: 502, code: "STRIPE_FAILED", error: `Stripe didn't accept the refund — nothing was refunded: ${String(e)}` };
    }
  }
  const full = refundedTotal >= Number(tx.amount) - 0.005;
  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      refundedAmount: refundedTotal,
      refundedAt: new Date(),
      refundReason: reason,
      refundedByUserId: input.actorUserId,
      ...(full ? { status: "REFUNDED" } : {}),
      notes: `${tx.notes ? tx.notes + "\n" : ""}Refunded ${money2(chk.amount)} on ${stamp()}${isStripe ? ` via Stripe (${stripeRefundId})` : ` as ${src === "CHECK" ? "check" : "cash"}`} — ${reason}.`,
    },
  });
  if (input.subscriptionId) {
    const owns = await prisma.memberSubscription.count({ where: { id: input.subscriptionId, memberId: input.memberId } });
    if (owns) {
      await recordSubscriptionEvent({
        clubId: input.clubId, memberSubscriptionId: input.subscriptionId, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.PAYMENT_REFUNDED,
        fromAmount: chk.amount, actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
        detail: { route: "membership/refund", transactionId: tx.id, amount: chk.amount, full, reason, via: isStripe ? "Stripe" : src === "CHECK" ? "check" : "cash", stripeRefundId },
      });
    }
  }
  await writeBillingAudit({
    clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: isStripe ? "PAYMENT_REFUNDED_STRIPE" : "PAYMENT_REFUNDED_OFFLINE",
    before: { transactionId: tx.id, refundedAmount: tx.refundedAmount != null ? Number(tx.refundedAmount) : 0, status: tx.status },
    after: { refundedAmount: refundedTotal, status: full ? "REFUNDED" : tx.status, stripeRefundId, reason },
    note: `Refunded ${money2(chk.amount)} of "${tx.description ?? "payment"}"${isStripe ? ` through Stripe (${stripeRefundId})` : " in cash/check"} — ${reason}.`,
  });
  return { ok: true, message: `Refunded ${money2(chk.amount)}${isStripe ? " — it goes back to their payment method in 5–10 business days" : " — hand it back in cash or check"}.` };
}

// ── 2. Switch how they pay ───────────────────────────────────────────────────

export async function switchHowTheyPay(input: {
  clubId: string; memberId: string; subscriptionId: string; actorUserId: string | null;
  direction: "to_cash" | "to_card"; method: "CASH" | "CHECK"; confirmImmediateCharge: boolean; preview: boolean; expectedEffectiveAt: string | null;
}): Promise<ActionResult> {
  const row = await loadRow(input.clubId, input.memberId, input.subscriptionId);
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", error: "No live membership found." };
  const club = await clubStripe(input.clubId);
  const now = new Date();
  const actor = { userId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION };

  if (input.direction === "to_cash") {
    const live = row.stripeSubscriptionId && club?.stripeAccountId ? await liveStripeFacts(row.stripeSubscriptionId, club.stripeAccountId) : null;
    if (row.stripeSubscriptionId && !live) return { ok: false, status: 502, code: "STRIPE_UNREACHABLE", error: "Stripe couldn't be reached. Nothing was changed — try again in a minute." };
    const plan = switchToCashPlan(toMoneyRow(row, live), { pmLabel: paymentMethodLabel(live?.pm), now });
    if (!plan.ok) return { ok: false, status: 409, code: plan.code, error: plan.error };
    if (input.preview) return { ok: true, preview: true, sentence: plan.sentence, consequence: plan.consequence, facts: { effectiveAt: iso(plan.effectiveAt) } };
    if (!sameDay(plan.effectiveAt, input.expectedEffectiveAt)) return { ok: false, status: 409, code: "STALE", error: `The paid period now ends ${fmtDate(plan.effectiveAt)} — review the sheet again.` };
    // lib/autopay.turnAutopayOff: cancel_at_period_end on Stripe, and the SAME
    // row becomes MANUAL with paid-through = the period end — in one step, so
    // the later deletion webhook matches nothing and can't churn the athlete.
    const r = await turnAutopayOff(row.id, input.clubId, actor);
    if (!r.ok) return { ok: false, status: r.code === "STRIPE_FAILED" ? 502 : 409, code: r.code, error: r.error };
    await prisma.member.updateMany({ where: { id: input.memberId, clubId: input.clubId }, data: { requestedPaymentMethod: input.method, billingUpdatedAt: now, billingUpdatedById: input.actorUserId } });
    return { ok: true, message: `Switched to ${input.method === "CHECK" ? "check" : "cash"}. No more automatic charges — you collect ${money2(Number(row.price))} from ${fmtDate(r.effectiveAt)}.` };
  }

  // to_card
  if (!club?.stripeAccountId || !club.stripeChargesEnabled) return { ok: false, status: 409, code: "NO_STRIPE", error: "Online payments aren't connected for this club." };
  const customerId = row.member.stripeSetupCustomerId ?? row.member.stripeCustomerId;
  const pmId = customerId ? await resolveChargeablePaymentMethodId(customerId, club.stripeAccountId, row.member.stripeSetupPaymentMethodId) : null;
  if (!pmId) return { ok: false, status: 409, code: "CARD_SETUP_REQUIRED", error: "There's no saved payment method we can charge. Send them a link to add one first." };
  let pmLabel: string | null = null;
  try {
    const pm = await stripe.paymentMethods.retrieve(pmId, { stripeAccount: club.stripeAccountId });
    pmLabel = paymentMethodLabel(pmFacts(pm));
  } catch { /* the label is nice-to-have */ }
  const charge = recurringUnitWithFee(Math.round(Number(row.price) * 100), club.passProcessingFees) / 100;
  const plan = switchToCardPlan(toMoneyRow(row, null), { pmLabel, chargeAmount: charge, now });
  if (!plan.ok) return { ok: false, status: 409, code: plan.code, error: plan.error };
  if (input.preview) return { ok: true, preview: true, sentence: plan.sentence, consequence: plan.consequence, needsChargeAck: plan.chargesToday, facts: { effectiveAt: iso(plan.effectiveAt), chargeAmount: charge } };
  if (plan.chargesToday && !input.confirmImmediateCharge) return { ok: false, status: 409, code: "IMMEDIATE_CHARGE_CONFIRM_REQUIRED", error: `This charges ${money2(charge)} right now. Tick the box to confirm.` };
  if (!plan.chargesToday && !sameDay(plan.effectiveAt, input.expectedEffectiveAt)) return { ok: false, status: 409, code: "STALE", error: `The first charge would now be ${fmtDate(plan.effectiveAt)} — review the sheet again.` };
  // lib/autopay.turnAutopayOn: first charge = paid-through (trial_end), at the
  // member's own price plus the club's fee passthrough; never a plan reprice.
  const r = await turnAutopayOn(row.id, input.clubId, actor);
  if (!r.ok) return { ok: false, status: r.code === "STRIPE_FAILED" ? 502 : 409, code: r.code, error: r.error };
  await prisma.member.updateMany({ where: { id: input.memberId, clubId: input.clubId }, data: { requestedPaymentMethod: "CARD", billingUpdatedAt: now, billingUpdatedById: input.actorUserId } });
  // turnAutopayOn starts an open-ended subscription; a row with a stop date
  // must stop on Stripe too, or going automatic would quietly extend it.
  let endWarning = "";
  if (plan.endsAt) {
    const after = await prisma.memberSubscription.findUnique({ where: { id: row.id }, select: { stripeSubscriptionId: true } });
    try {
      if (after?.stripeSubscriptionId) await stripe.subscriptions.update(after.stripeSubscriptionId, { cancel_at: Math.floor(plan.endsAt.getTime() / 1000) }, { stripeAccount: club.stripeAccountId });
    } catch (e) {
      console.error("[membershipMoney] switch to card: cancel_at failed", row.id, e);
      endWarning = ` Stripe didn't take the ${fmtDate(plan.endsAt)} end date — set it again with Change dates.`;
      await writeBillingAudit({ clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: "AUTOPAY_ON_END_DATE_FAILED", after: { endsAt: iso(plan.endsAt) }, note: `Card billing started but Stripe refused cancel_at ${fmtDate(plan.endsAt)}: ${String(e)}` });
    }
  }
  await recomputeMemberStatus(input.memberId, input.clubId);
  return { ok: true, message: r.message + endWarning };
}

// ── 5. Auto-renew ────────────────────────────────────────────────────────────

export async function setAutoRenewFromPanel(input: {
  clubId: string; memberId: string; subscriptionId: string; actorUserId: string | null; on: boolean; preview: boolean;
}): Promise<ActionResult> {
  const row = await loadRow(input.clubId, input.memberId, input.subscriptionId);
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", error: "No live membership found." };
  const club = await clubStripe(input.clubId);
  const live = row.stripeSubscriptionId && club?.stripeAccountId ? await liveStripeFacts(row.stripeSubscriptionId, club.stripeAccountId) : null;
  if (row.stripeSubscriptionId && !live) return { ok: false, status: 502, code: "STRIPE_UNREACHABLE", error: "Stripe couldn't be reached. Nothing was changed — try again in a minute." };
  const m = toMoneyRow(row, live);
  const now = new Date();
  const plan = autoRenewPlan(m, input.on, now);
  if (!plan.ok) return { ok: false, status: 409, code: plan.code, error: plan.error };
  if (input.preview) return { ok: true, preview: true, sentence: plan.sentence, consequence: row.stripeSubscriptionId ? (input.on ? "the scheduled stop is removed — it renews until cancelled." : `the subscription stops on ${fmtDate(plan.endsAt!)}.`) : "nothing — billed offline. The end date changes on the record.", facts: { endsAt: iso(plan.endsAt) } };

  let endsAt: Date | null;
  if (row.autoRenew !== input.on) {
    // The one implementation of what auto-renew means (lib/autopay.setAutoRenew):
    // Stripe rows → cancel_at at the commitment end / cancel_at_period_end, or
    // both cleared; cash rows → offlineStopDate. It writes the billing audit.
    const r = await setAutoRenew(row.id, input.clubId, input.on, { userId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION });
    if (!r.ok) return { ok: false, status: r.code === "STRIPE_FAILED" ? 502 : 409, code: r.code, error: r.error };
    const after = await prisma.memberSubscription.findUnique({ where: { id: row.id }, select: { endDate: true } });
    endsAt = after?.endDate ?? null;
  } else {
    // The flag already says `on`, but the dates disagree (a stop scheduled in
    // Stripe or an end date on a "renewing" row — what the owner sees is the
    // stop). Same rules as setAutoRenew, applied directly.
    const nr = { minimumTermEndsAt: row.minimumTermEndsAt, endDate: row.endDate, currentPeriodEnd: m.currentPeriodEnd, paidThroughDate: row.paidThroughDate };
    try {
      if (row.stripeSubscriptionId) {
        if (input.on) {
          await stripe.subscriptions.update(row.stripeSubscriptionId, { cancel_at_period_end: false, cancel_at: "" }, { stripeAccount: club!.stripeAccountId! });
          endsAt = null;
        } else {
          endsAt = await applyNonRenewal(row.stripeSubscriptionId, club!.stripeAccountId!, planNonRenewal(nr, now));
        }
      } else {
        endsAt = input.on ? null : offlineStopDate(nr, now);
      }
    } catch (e) {
      return { ok: false, status: 502, code: "STRIPE_FAILED", error: `Stripe didn't accept the change — nothing was saved: ${String(e)}` };
    }
    await prisma.memberSubscription.update({ where: { id: row.id }, data: { autoRenew: input.on, endDate: endsAt } });
    await writeBillingAudit({
      clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: input.on ? "AUTO_RENEW_ON" : "AUTO_RENEW_OFF",
      before: { autoRenew: row.autoRenew, endDate: iso(row.endDate), stripeCancelAt: iso(m.cancelAt) }, after: { autoRenew: input.on, endDate: iso(endsAt) },
      note: `${plan.sentence} (Flag already matched; dates realigned from the Membership panel.)`,
    });
  }
  await recomputeMemberStatus(input.memberId, input.clubId);
  await recordSubscriptionEvent({
    clubId: input.clubId, memberSubscriptionId: row.id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.RENEWAL_CHANGED,
    fromPlan: row.optionLabel, actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    detail: { route: "membership/auto-renew", autoRenew: input.on, stopsOn: iso(endsAt), mode: plan.mode, stripe: !!row.stripeSubscriptionId },
  });
  return { ok: true, message: input.on ? `Auto-renew is on — ${row.member.firstName}'s membership keeps renewing.` : `Auto-renew is off — ends ${endsAt ? fmtDate(endsAt) : "at the end of the paid period"}.` };
}

// ── 6. Change charge date ────────────────────────────────────────────────────
//
// "Move the next charge to a new date" on a live membership. The rules and the
// words are lib/chargeDate.chargeDateMovePlan; this re-reads Stripe, re-derives
// the plan, refuses if the sheet is stale, and acts.
//
// THE STRIPE MECHANISM — `trial_end` = the new date, proration_behavior "none":
//
//  · API 2023-10-16 has no way to set a FUTURE billing_cycle_anchor on an
//    existing subscription (update accepts only "now" / "unchanged"). Stripe's
//    documented way to move a live subscription's billing day to a later date
//    is a trial that ends on that date: the trial end becomes the new cycle
//    anchor and every renewal after it lands on that day.
//  · proration_behavior "none": no credit for the unused part of the paid
//    period and no charge for the gap. The member keeps what they paid for and
//    the days after it up to the new date are simply not charged — the sheet
//    says "Nov 27 → Dec 5: 8 days at no charge".
//  · Moving EARLIER than what's paid is refused in chargeDateMovePlan, never
//    "fixed" with a proration credit (that credit sits on the Stripe customer
//    balance, not the card — the family would see a second charge).
//  · cancel_at, the price item, discounts and the default payment method are
//    not touched. A pending one-time discount (the B16 skip coupon) is refused
//    up front: starting the no-charge stretch makes Stripe issue a $0 invoice,
//    which would consume the coupon. That $0 invoice is ignored by the
//    invoice.paid webhook ("$0 invoices (trial starts) don't belong in the
//    money ledger"), so no revenue is invented.
//  · Alternatives rejected: pause_collection (lib/stripeSync reads it as the
//    owner pausing and flips the athlete to PAUSED — see addSkipDiscount's
//    note); cancel + recreate with a future billing_cycle_anchor (a new
//    subscription id, history, discounts and cancel_at to re-create, and a
//    window where the member has no subscription).
//
// THE `trialing` QUESTION. Stripe reports the subscription as `trialing` until
// the new date. What that does here, checked reader by reader:
//  · Member status is NOT demoted. recomputeMemberStatus (lib/memberStatus)
//    counts a priced card row only by a SUCCEEDED transaction on its Stripe
//    subscription id — never by stripeStatus (lib/memberTracks.countsAsMembership
//    says so explicitly). A paying member has one; nothing changes.
//  · The local row stays status "active": lib/stripeSync.localStatusFor maps
//    trialing → active on every sync.
//  · Reports don't count trialists from stripeStatus (reportsMembership has no
//    trial detection; trialToPaidRate is null).
//  · The ONE reader that keyed on it was lib/billingAdmin.deriveBillingState:
//    trialing → "SCHEDULED — nothing has been charged yet". We write
//    metadata.aoxPaidThrough on the subscription; lib/stripeSync copies it into
//    the snapshot (chargeDateMovedFrom), and deriveBillingState now reads
//    trialing + that marker as ACTIVE_STRIPE. The family's own page
//    (/api/member/billing) shows "active" for the same reason
//    (lib/chargeDate.displayStripeStatus).
//  · The marker is written only when the subscription had been PAYING
//    (active). A first charge still to come stays unmarked, so it keeps
//    reading as Scheduled — which is the truth.

async function stripeMoveFacts(subId: string, acct: string) {
  const sub = await stripe.subscriptions.retrieve(
    subId,
    { expand: ["discounts", "default_payment_method", "customer.invoice_settings.default_payment_method", "items.data.price"] },
    { stripeAccount: acct },
  );
  const cust = typeof sub.customer === "object" && sub.customer && !("deleted" in sub.customer && sub.customer.deleted) ? (sub.customer as Stripe.Customer) : null;
  const pm = pmFacts(sub.default_payment_method as Stripe.PaymentMethod | null) ?? pmFacts(cust?.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null);
  const cpe = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
  let onceAt: Date | null = null;
  for (const d of (sub.discounts ?? []) as (string | Stripe.Discount)[]) {
    if (typeof d === "string") continue;
    if (d.coupon?.duration === "once") {
      const f = Number(d.coupon.metadata?.aoxSkipFor);
      onceAt = f > 0 ? new Date(f * 1000) : cpe ?? new Date();
    }
  }
  const item = sub.items?.data?.[0];
  const unit = item?.price?.unit_amount;
  const marker = Number(sub.metadata?.aoxPaidThrough);
  return {
    sub,
    status: sub.status,
    nextChargeAt: sub.status === "trialing" && sub.trial_end ? new Date(sub.trial_end * 1000) : cpe,
    cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : sub.cancel_at_period_end ? cpe : null,
    paused: !!sub.pause_collection,
    pmLabel: paymentMethodLabel(pm),
    onceAt,
    unitDollars: typeof unit === "number" ? (unit * (item?.quantity ?? 1)) / 100 : null,
    movedPaidThrough: marker > 0 ? new Date(marker * 1000) : null,
  };
}

export async function moveChargeDate(input: {
  clubId: string; memberId: string; subscriptionId: string; actorUserId: string | null;
  newDate: string; preview: boolean; expectedFrom: string | null;
}): Promise<ActionResult> {
  const row = await loadRow(input.clubId, input.memberId, input.subscriptionId);
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", error: "No live membership found." };
  const club = await clubStripe(input.clubId);
  const now = new Date();
  let facts: Awaited<ReturnType<typeof stripeMoveFacts>> | null = null;
  if (row.stripeSubscriptionId) {
    if (!club?.stripeAccountId) return { ok: false, status: 409, code: "NO_STRIPE", error: "Stripe isn't connected for this club." };
    try {
      facts = await stripeMoveFacts(row.stripeSubscriptionId, club.stripeAccountId);
    } catch (e) {
      console.error("[membershipMoney] charge date: Stripe read failed", row.id, e);
      return { ok: false, status: 502, code: "STRIPE_UNREACHABLE", error: "Stripe couldn't be reached to check the next charge. Nothing was changed — try again in a minute." };
    }
  }
  const moveRow: MoveRow = {
    hasStripe: !!row.stripeSubscriptionId,
    status: row.status,
    stripeStatus: facts?.status ?? row.stripeStatus,
    chargeAmount: facts?.unitDollars ?? (row.stripeSubscriptionId && club ? recurringUnitWithFee(Math.round(Number(row.price) * 100), club.passProcessingFees) / 100 : Number(row.price)),
    billingPeriod: row.billingPeriod,
    startDate: row.startDate,
    endDate: row.endDate,
    autoRenew: row.autoRenew,
    cancelAt: facts?.cancelAt ?? null,
    paused: !!row.pausedAt || !!facts?.paused,
    nextChargeAt: facts?.nextChargeAt ?? null,
    paidThroughDate: row.paidThroughDate,
    movedPaidThrough: facts?.movedPaidThrough ?? null,
    onceDiscountAt: facts?.onceAt ?? null,
  };
  const plan = chargeDateMovePlan(moveRow, { newDateISO: input.newDate, pmLabel: facts?.pmLabel ?? null, now });
  if (!plan.ok) return { ok: false, status: plan.code === "BAD_DATE" ? 400 : 409, code: plan.code, error: plan.error };
  if (input.preview) {
    return { ok: true, preview: true, sentence: plan.sentence, consequence: plan.consequence, facts: { from: iso(plan.from), to: iso(plan.to), freeDays: plan.freeDays, mode: plan.mode } };
  }
  if (!sameDay(plan.from, input.expectedFrom)) {
    return { ok: false, status: 409, code: "STALE", error: `The next charge is now ${fmtDate(plan.from)} — review the sheet again.` };
  }

  const detail = { route: "membership/charge-date", mode: plan.mode, from: iso(plan.from), to: iso(plan.to), freeDays: plan.freeDays, stripeSubscriptionId: row.stripeSubscriptionId };
  if (plan.mode === "OFFLINE") {
    // set_dates semantics (lib/membershipPanel.resolveDatesEdit): on a cash
    // row the next due date IS the paid-through date.
    const resolved = resolveDatesEdit(
      { startDate: row.startDate, paidThroughDate: row.paidThroughDate, endDate: row.endDate, minimumTermEndsAt: row.minimumTermEndsAt, hasStripe: false },
      { paidThroughDate: plan.to },
    );
    if (!resolved.ok) return { ok: false, status: 409, code: "DATES", error: resolved.error };
    await prisma.memberSubscription.update({ where: { id: row.id }, data: { paidThroughDate: plan.to } });
  } else {
    // Noon UTC on the chosen day: 00:00Z is the evening BEFORE across the US,
    // so a "Dec 5" charge would otherwise land on the 4th for the family.
    const toUnix = Math.floor(plan.to.getTime() / 1000) + 12 * 3600;
    // Deterministic params: the idempotency key below is only valid for an
    // identical request (a retried double-submit must not error or fork).
    const metadata: Record<string, string> = { aoxChargeDateMovedTo: String(toUnix) };
    if (plan.paidThroughMarker) metadata.aoxPaidThrough = String(Math.floor(plan.paidThroughMarker.getTime() / 1000));
    let updated: Stripe.Subscription;
    try {
      updated = await stripe.subscriptions.update(
        row.stripeSubscriptionId!,
        { trial_end: toUnix, proration_behavior: "none", metadata },
        { stripeAccount: club!.stripeAccountId!, idempotencyKey: `aox-charge-date-${row.id}-${Math.floor(plan.from.getTime() / 1000)}-${toUnix}` },
      );
    } catch (e) {
      return { ok: false, status: 502, code: "STRIPE_FAILED", error: `Stripe didn't accept the new date — nothing was changed: ${String(e)}` };
    }
    // Our row, the way lib/stripeSync writes it: the next charge is the new
    // period end, status straight from Stripe. Then the real sync (best-effort)
    // refreshes the snapshot, including chargeDateMovedFrom.
    await prisma.memberSubscription.update({
      where: { id: row.id },
      data: { currentPeriodEnd: updated.current_period_end ? new Date(updated.current_period_end * 1000) : plan.to, stripeStatus: updated.status },
    });
    try { await syncOneSubscription(input.clubId, row.stripeSubscriptionId!); } catch (e) { console.error("[membershipMoney] charge date: sync after move failed", row.id, e); }
  }
  const moved = `${fmtShort(plan.from)} → ${fmtShort(plan.to)}`;
  await recordSubscriptionEvent({
    clubId: input.clubId, memberSubscriptionId: row.id, memberId: input.memberId, kind: SUBSCRIPTION_EVENT_KIND.CHARGE_DATE_MOVED,
    fromPlan: row.optionLabel, toPlan: row.optionLabel, actorUserId: input.actorUserId, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION, detail,
  });
  await writeBillingAudit({
    clubId: input.clubId, memberId: input.memberId, actorUserId: input.actorUserId, action: "CHARGE_DATE_MOVED",
    before: { nextCharge: iso(plan.from), paidThroughDate: iso(row.paidThroughDate) },
    after: { nextCharge: iso(plan.to), mode: plan.mode, freeDays: plan.freeDays, paidThroughMarker: iso(plan.paidThroughMarker) },
    note: plan.mode === "OFFLINE"
      ? `Payment due date moved ${moved} (cash/check) — ${plan.freeDays} day(s) at no charge.`
      : plan.mode === "STRIPE_FIRST_CHARGE"
        ? `First card charge moved ${moved} (Stripe trial_end; nothing had been charged).`
        : `Card charge date moved ${moved} — ${plan.freeDays > 0 ? `${plan.freeDays} day(s) at no charge` : "still within the paid period"} (Stripe trial_end, proration none; renews on the new day).`,
  });
  return {
    ok: true,
    message: plan.mode === "OFFLINE"
      ? `${row.member.firstName}'s next payment is due ${fmtDate(plan.to)}.`
      : `${row.member.firstName}'s next charge is now ${fmtDate(plan.to)}.`,
  };
}
