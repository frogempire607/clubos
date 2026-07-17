// Event-bundle purchases — payment decision + settlement. Mirrors the event
// registration model (lib/eventPayments) with one hard rule: bookings (the
// usable credits) are granted ONLY when the purchase is PAID, or at acceptance
// when the club's existing offlineActivationPolicy is ON_ACCEPTANCE. Cash and
// check never touch Stripe. Every payment method gets its own status — never
// one vague "pending".

import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { applyProcessingFee } from "@/lib/fees";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { sendPaymentReceiptEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

export const BUNDLE_PAYMENT_METHODS = ["CARD", "CASH", "CHECK", "PAY_LATER"] as const;
export type BundlePaymentMethod = (typeof BUNDLE_PAYMENT_METHODS)[number];

export const BUNDLE_STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "Started checkout — not completed",
  AWAITING_CASH: "Awaiting cash",
  AWAITING_CHECK: "Awaiting check",
  PAY_LATER: "Pay later — club will invoice",
  PAYMENT_FAILED: "Card charge failed",
  PAID: "Paid",
  CANCELED: "Canceled",
};

/** Owner-allowed methods; null/empty config = card-only (legacy). */
export function bundleAllowedPaymentMethods(bundle: { paymentMethods?: unknown }): BundlePaymentMethod[] {
  const raw = bundle.paymentMethods;
  if (!Array.isArray(raw)) return ["CARD"];
  const methods = raw.filter(
    (m): m is BundlePaymentMethod =>
      typeof m === "string" && (BUNDLE_PAYMENT_METHODS as readonly string[]).includes(m),
  );
  return methods.length > 0 ? methods : ["CARD"];
}

export function bundleOfflineStatus(method: "CASH" | "CHECK" | "PAY_LATER"): string {
  return method === "CASH" ? "AWAITING_CASH" : method === "CHECK" ? "AWAITING_CHECK" : "PAY_LATER";
}

/** Book every event in the bundle for the member (idempotent). */
export async function bookBundleEvents(eventIds: string[], memberId: string): Promise<number> {
  let booked = 0;
  for (const eventId of eventIds) {
    const existing = await prisma.booking.findUnique({
      where: { eventId_memberId: { eventId, memberId } },
    });
    if (!existing) {
      await prisma.booking.create({ data: { eventId, memberId, status: "CONFIRMED" } });
      booked++;
    }
  }
  return booked;
}

type PurchaseForSettle = {
  id: string;
  clubId: string;
  bundleId: string;
  memberId: string;
  status: string;
  transactionId: string | null;
  amountDue: unknown;
};

/**
 * Mark a purchase PAID and grant the bookings — the ONE settlement path for
 * webhook (checkout), saved-card success, and staff-recorded cash/check.
 * Claims the row conditionally first, so a duplicate webhook delivery, a
 * double-click, or a race between two settle paths books and records exactly
 * once. Returns false when someone else already settled it.
 */
export async function settleBundlePurchase(args: {
  purchase: PurchaseForSettle;
  amountPaid: number;
  paidVia: "STRIPE" | "CASH" | "CHECK";
  transactionId: string;
  receivedById?: string | null;
  checkReference?: string | null;
  sendReceipt?: boolean;
}): Promise<boolean> {
  const claim = await prisma.eventBundlePurchase.updateMany({
    where: { id: args.purchase.id, status: { notIn: ["PAID", "CANCELED"] } },
    data: {
      status: "PAID",
      amountPaid: args.amountPaid,
      paidAt: new Date(),
      paidVia: args.paidVia,
      transactionId: args.transactionId,
      receivedById: args.receivedById ?? null,
      checkReference: args.checkReference ?? null,
      lastChargeError: null,
    },
  });
  if (claim.count === 0) return false;

  const bundle = await prisma.eventBundle.findUnique({
    where: { id: args.purchase.bundleId },
    select: { name: true, items: { select: { eventId: true } }, club: { select: { name: true } } },
  });
  if (bundle) {
    await bookBundleEvents(
      bundle.items.map((i) => i.eventId),
      args.purchase.memberId,
    );
  }

  await writeBillingAudit({
    clubId: args.purchase.clubId,
    memberId: args.purchase.memberId,
    action: "EVENT_BUNDLE_PAID",
    before: { purchaseId: args.purchase.id, status: args.purchase.status },
    after: {
      purchaseId: args.purchase.id,
      status: "PAID",
      transactionId: args.transactionId,
      amount: args.amountPaid,
      via: args.paidVia,
    },
    note: `Bundle ${bundle?.name ?? args.purchase.bundleId} paid — events booked.`,
  });

  // Receipt to the member/guardian contact — only now that money changed hands.
  if (args.sendReceipt === false) return true;
  try {
    const m = await prisma.member.findUnique({
      where: { id: args.purchase.memberId },
      select: {
        firstName: true,
        email: true,
        isMinor: true,
        guardianEmail: true,
        user: { select: { email: true } },
      },
    });
    const to = m ? (m.isMinor ? m.guardianEmail || m.email : m.email) || m.user?.email : null;
    if (to && bundle) {
      await sendPaymentReceiptEmail({
        to,
        firstName: m?.firstName || "there",
        clubName: bundle.club.name,
        description: `${bundle.name} — event bundle${args.paidVia !== "STRIPE" ? ` · Paid by ${args.paidVia === "CHECK" ? "Check" : "Cash"}` : ""}`,
        amountPaid: `$${args.amountPaid.toFixed(2)}`,
        paidAt: new Date(),
        portalUrl: `${getAppBaseUrl()}/member/bookings`,
      });
    }
  } catch (e) {
    console.error("bundle receipt failed", e);
  }
  return true;
}

/**
 * Immediate saved-card charge for a bundle purchase. Same discipline as event
 * auto-charges: per-purchase idempotency key, prior-PI settlement before any
 * create, one VERIFIED Transaction deduped on the PI id. A failed charge
 * leaves the purchase PAYMENT_FAILED — no bookings, nothing marked paid.
 */
export async function chargeBundlePurchaseSavedCard(purchaseId: string): Promise<
  | { ok: true; total: number }
  | { ok: false; outcome: "declined" | "requires_action" | "processing" | "failed"; message: string }
> {
  const purchase = await prisma.eventBundlePurchase.findUnique({
    where: { id: purchaseId },
    include: {
      bundle: { select: { name: true } },
      member: {
        select: {
          id: true,
          stripeCustomerId: true,
          stripeSetupCustomerId: true,
          stripeSetupPaymentMethodId: true,
        },
      },
      club: {
        select: {
          id: true,
          tier: true,
          stripeAccountId: true,
          stripeChargesEnabled: true,
          passProcessingFees: true,
        },
      },
    },
  });
  if (!purchase || purchase.status === "PAID" || purchase.status === "CANCELED") {
    return { ok: false, outcome: "failed", message: "This purchase is no longer chargeable." };
  }
  if (!purchase.club.stripeAccountId || !purchase.club.stripeChargesEnabled) {
    return { ok: false, outcome: "failed", message: "Online payments aren't enabled." };
  }
  const baseCents = Math.round(Number(purchase.amountDue ?? 0) * 100);
  if (baseCents <= 0) return { ok: false, outcome: "failed", message: "Nothing to charge." };
  const fee = applyProcessingFee(baseCents, purchase.club.passProcessingFees);
  const totalCents = fee.totalCents;

  async function recordStripeSuccess(pi: Stripe.PaymentIntent): Promise<{ ok: true; total: number }> {
    const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Stripe.Charge) : null;
    const bt =
      charge?.balance_transaction && typeof charge.balance_transaction === "object"
        ? (charge.balance_transaction as Stripe.BalanceTransaction)
        : null;
    const p = purchase!;
    const existing = await prisma.transaction.findFirst({
      where: { stripePaymentIntentId: pi.id },
      select: { id: true },
    });
    const tx =
      existing ??
      (await prisma.transaction.create({
        data: {
          clubId: p.clubId,
          memberId: p.memberId,
          amount: pi.amount / 100,
          status: "SUCCEEDED",
          stripePaymentIntentId: pi.id,
          stripeChargeId: charge?.id ?? null,
          description: `Event bundle — ${p.bundle.name} (saved card)`,
          type: "EVENT",
          category: "events",
          paymentMethod: "STRIPE",
          paymentSource: "STRIPE",
          reconciliationStatus: "VERIFIED",
          ...(bt ? { stripeFeeAmount: bt.fee / 100, netAmount: bt.net / 100 } : {}),
          txDate: new Date(),
        },
        select: { id: true },
      }));
    await prisma.eventBundlePurchase.update({
      where: { id: p.id },
      data: { stripePaymentIntentId: pi.id },
    });
    await settleBundlePurchase({
      purchase: p,
      amountPaid: pi.amount / 100,
      paidVia: "STRIPE",
      transactionId: tx.id,
    });
    return { ok: true, total: pi.amount / 100 };
  }

  // Settle a prior attempt before ever creating a new PaymentIntent — same
  // fail-closed rule as event auto-charges: if we know a PI exists and can't
  // read it, we do NOT charge again.
  if (purchase.stripePaymentIntentId) {
    try {
      const prior = await stripe.paymentIntents.retrieve(
        purchase.stripePaymentIntentId,
        { expand: ["latest_charge.balance_transaction"] },
        { stripeAccount: purchase.club.stripeAccountId },
      );
      if (prior.status === "succeeded") return await recordStripeSuccess(prior);
      if (prior.status === "processing")
        return { ok: false, outcome: "processing", message: "Your previous payment is still processing." };
      // definitively dead — fall through to a fresh attempt
    } catch (e) {
      console.error("bundle saved-card prior PI retrieve failed", e);
      return {
        ok: false,
        outcome: "failed",
        message: "Couldn't verify your previous payment — not charging again. Try later.",
      };
    }
  }

  const customerId = purchase.member.stripeSetupCustomerId ?? purchase.member.stripeCustomerId;
  const paymentMethodId = await resolveChargeablePaymentMethodId(
    customerId,
    purchase.club.stripeAccountId,
    purchase.member.stripeSetupPaymentMethodId,
  );
  if (!customerId || !paymentMethodId) {
    return { ok: false, outcome: "failed", message: "No chargeable saved card on file." };
  }

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `Event bundle — ${purchase.bundle.name}`,
        expand: ["latest_charge.balance_transaction"],
        application_fee_amount: calculatePlatformFee(totalCents, purchase.club.tier),
        metadata: {
          kind: "bundle_saved_card",
          bundlePurchaseId: purchase.id,
          bundleId: purchase.bundleId,
          memberId: purchase.memberId,
          clubId: purchase.clubId,
        },
      },
      { stripeAccount: purchase.club.stripeAccountId, idempotencyKey: `aox-bundlepur-${purchase.id}` },
    );
  } catch (err) {
    const e = err as { type?: string; code?: string; message?: string };
    const declined = e.type === "StripeCardError";
    await prisma.eventBundlePurchase.updateMany({
      where: { id: purchase.id, status: { notIn: ["PAID", "CANCELED"] } },
      data: {
        status: "PAYMENT_FAILED",
        lastChargeError: String(e.message || err).slice(0, 500),
      },
    });
    if (declined) {
      const outcome = e.code === "authentication_required" ? "requires_action" : "declined";
      return {
        ok: false,
        outcome,
        message:
          outcome === "declined"
            ? e.message || "The card was declined."
            : "This card requires authentication — pay by card checkout instead.",
      };
    }
    console.error("bundle saved-card charge failed", err);
    return { ok: false, outcome: "failed", message: "The charge could not be completed. Try another method." };
  }

  if (pi.status === "processing") {
    await prisma.eventBundlePurchase.update({
      where: { id: purchase.id },
      data: { stripePaymentIntentId: pi.id },
    });
    return { ok: false, outcome: "processing", message: "Your payment is processing — check back shortly." };
  }
  if (pi.status !== "succeeded") {
    await prisma.eventBundlePurchase.updateMany({
      where: { id: purchase.id, status: { notIn: ["PAID", "CANCELED"] } },
      data: { status: "PAYMENT_FAILED", lastChargeError: `Stripe returned status ${pi.status}` },
    });
    return { ok: false, outcome: "failed", message: `Payment didn't complete (${pi.status}).` };
  }
  return await recordStripeSuccess(pi);
}
