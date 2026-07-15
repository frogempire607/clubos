// Version-safe Stripe webhook/object field access + exact fee/net capture.
//
// The club's Stripe webhook endpoints deliver events on API version
// 2026-02-25.clover. Since 2025-03 "basil", invoice payloads no longer carry
// top-level `subscription` / `payment_intent` — the subscription id and its
// metadata live at `invoice.parent.subscription_details.*`, and payments are
// listed under `invoice.payments`. Our pinned stripe-node SDK still *retrieves*
// objects on its own pinned (older) API version, so server-side retrieves may
// return the LEGACY shape. Every helper here therefore accepts BOTH shapes —
// never read those fields directly off an invoice anywhere else.
import { stripe } from "@/lib/stripe";
import type Stripe from "stripe";

export type StripeMoneyFacts = {
  paymentIntentId: string | null;
  chargeId: string | null;
  /** Exact Stripe processing fee in dollars, from the balance transaction. */
  feeAmount: number | null;
  /** Exact net in dollars, from the balance transaction. */
  netAmount: number | null;
};

const EMPTY_MONEY: StripeMoneyFacts = {
  paymentIntentId: null,
  chargeId: null,
  feeAmount: null,
  netAmount: null,
};

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

/** Subscription id from an invoice — legacy `invoice.subscription` OR clover `invoice.parent.subscription_details.subscription`. */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const inv = invoice as Record<string, any>;
  return idOf(inv?.subscription) ?? idOf(inv?.parent?.subscription_details?.subscription);
}

/** Subscription metadata embedded in a clover invoice payload (memberId / migrationMemberId / clubId / memberSubscriptionId). */
export function invoiceSubscriptionMetadata(invoice: unknown): Record<string, string> {
  const inv = invoice as Record<string, any>;
  const meta = inv?.parent?.subscription_details?.metadata;
  return meta && typeof meta === "object" ? meta : {};
}

/** Payment intent id from an invoice — legacy `invoice.payment_intent` OR clover `invoice.payments.data[].payment.payment_intent`. */
export function invoicePaymentIntentId(invoice: unknown): string | null {
  const inv = invoice as Record<string, any>;
  const legacy = idOf(inv?.payment_intent);
  if (legacy) return legacy;
  const payments = inv?.payments?.data;
  if (Array.isArray(payments)) {
    for (const p of payments) {
      const pi = idOf(p?.payment?.payment_intent);
      if (pi) return pi;
    }
  }
  return null;
}

/**
 * Exact charge id + Stripe fee/net for a payment intent, from the expanded
 * balance transaction. Read-only; NEVER throws (fee capture must never block
 * recording the payment itself — a row without fee data gets backfilled by
 * reconciliation later).
 */
export async function moneyFactsForPaymentIntent(
  paymentIntentId: string | null | undefined,
  stripeAccount?: string | null,
): Promise<StripeMoneyFacts> {
  if (!paymentIntentId) return EMPTY_MONEY;
  try {
    const pi = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge.balance_transaction"] },
      stripeAccount ? { stripeAccount } : undefined,
    );
    const rawCharge = (pi as unknown as { latest_charge?: unknown }).latest_charge;
    const charge =
      rawCharge && typeof rawCharge === "object" ? (rawCharge as Stripe.Charge) : null;
    const rawBt = charge?.balance_transaction;
    const bt = rawBt && typeof rawBt === "object" ? (rawBt as Stripe.BalanceTransaction) : null;
    return {
      paymentIntentId,
      chargeId: charge?.id ?? idOf(rawCharge),
      feeAmount: bt ? bt.fee / 100 : null,
      netAmount: bt ? bt.net / 100 : null,
    };
  } catch (err) {
    console.error("stripeTruth: moneyFactsForPaymentIntent failed", paymentIntentId, err);
    return { ...EMPTY_MONEY, paymentIntentId };
  }
}

/**
 * Money facts for an invoice. Tries the payload first (both shapes); if the
 * payload has no payment intent (clover webhook payloads usually don't embed
 * payments), retrieves the invoice with payments expanded. NEVER throws.
 */
export async function moneyFactsForInvoice(
  invoice: unknown,
  stripeAccount?: string | null,
): Promise<StripeMoneyFacts> {
  let piId = invoicePaymentIntentId(invoice);
  const invId = idOf((invoice as Record<string, unknown>)?.id ?? null) ?? (invoice as { id?: string })?.id ?? null;
  if (!piId && invId) {
    try {
      const fresh = await stripe.invoices.retrieve(
        invId,
        { expand: ["payments"] } as never,
        stripeAccount ? { stripeAccount } : undefined,
      );
      piId = invoicePaymentIntentId(fresh);
    } catch (err) {
      console.error("stripeTruth: invoice retrieve for payments failed", invId, err);
    }
  }
  return moneyFactsForPaymentIntent(piId, stripeAccount);
}

/**
 * Spreadable Transaction fields for a Stripe-CONFIRMED payment. Only rows
 * created through this helper may carry paymentSource STRIPE +
 * reconciliationStatus VERIFIED.
 */
export function verifiedStripeTxFields(money: StripeMoneyFacts | null) {
  return {
    paymentSource: "STRIPE" as const,
    reconciliationStatus: "VERIFIED" as const,
    ...(money?.chargeId ? { stripeChargeId: money.chargeId } : {}),
    ...(money?.feeAmount != null ? { stripeFeeAmount: money.feeAmount } : {}),
    ...(money?.netAmount != null ? { netAmount: money.netAmount } : {}),
  };
}
