// Start a recurring Stripe subscription off a member's SAVED card, and mirror
// it locally. Extracted from migration/[id]/approve (B9, 2026-09-23) so the
// billing centre can activate a saved setup for a card payer without the
// member having to be mid-migration. The approve route calls this too — one
// implementation of "charge the saved card from date X", not two.
//
// This function does the Stripe call and the local row ONLY. Preflights
// (live-subscription check, immediate-charge confirmation, offline intent)
// and everything after (events, member update, audit, email) stay with the
// caller, because they differ between approval and direct activation.

import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { stripe, billingPeriodToStripeInterval } from "@/lib/stripe";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { recurringUnitWithFee } from "@/lib/fees";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { addBillingPeriod } from "@/lib/billingAdmin";

export type CardActivationInput = {
  member: {
    id: string;
    stripeSetupCustomerId: string;
    stripeSetupPaymentMethodId: string | null;
  };
  /** When the membership starts (the row's startDate). Callers decide; this never reads a member-level date. */
  startDate: Date;
  club: { id: string; stripeAccountId: string; passProcessingFees: boolean };
  membershipId: string;
  planName: string;
  /** Label written on the row. Approval writes the plan name; activation writes the option label. */
  optionLabel: string;
  optionId: string | null;
  price: number;
  period: string;
  autoRenew: boolean;
  minimumTermEndsAt: Date | null;
  /** First charge date. Null/past ⇒ charged now. */
  anchor: Date | null;
  /** Explicit end (commitment / requested cancellation). Null ⇒ derived from autoRenew. */
  cancelSource: Date | null;
  discount?: { code: string; amountOff: number } | null;
  notes: string;
  metadata: Record<string, string>;
  idempotencyPrefix: string;
};

export type CardActivationResult =
  | {
      ok: true;
      memberSub: Awaited<ReturnType<typeof prisma.memberSubscription.create>>;
      stripeSubscriptionId: string;
      stripeStatus: string;
      chargedImmediately: boolean;
      firstChargeAt: Date;
      endsAt: Date | null;
    }
  | { ok: false; code: "CARD_SETUP_INCOMPLETE" | "STRIPE_FAILED"; error: string };

export async function createSavedCardSubscription(input: CardActivationInput): Promise<CardActivationResult> {
  const { member, club, price, period } = input;
  const anchor = input.anchor && input.anchor.getTime() > Date.now() + 60_000 ? input.anchor : null;
  // trial_end anchors the FIRST charge to the agreed date so nobody is billed
  // on activation day; no future anchor ⇒ the charge runs now.
  const trialEnd = anchor ? Math.floor(anchor.getTime() / 1000) : undefined;
  const chargedImmediately = !trialEnd;
  const firstChargeAt = anchor ?? new Date();

  // Auto Renew OFF with no explicit end date: the subscription ends after its
  // FIRST billing period, measured from the first charge.
  let cancelSource = input.cancelSource;
  if (!cancelSource && !input.autoRenew) {
    cancelSource = addBillingPeriod(firstChargeAt, period);
  }
  let cancelAtUnix: number | undefined;
  if (cancelSource && cancelSource.getTime() > Date.now() + 60_000) {
    const ts = Math.floor(cancelSource.getTime() / 1000);
    if (!trialEnd || ts > trialEnd) cancelAtUnix = ts;
  }
  const amountCents = recurringUnitWithFee(Math.round(price * 100), club.passProcessingFees);
  const interval = billingPeriodToStripeInterval(period) || { interval: "month" as const, interval_count: 1 };

  // VERIFY the saved payment method is still attached before charging — a
  // family that replaced their card leaves a stale pointer, and Stripe then
  // errors "payment method must be attached to the customer" (Mack Munroe,
  // 2026-07-15). Falls back to the customer's default / only method (card OR
  // Link wallet) and persists the correction.
  const chargePmId = await resolveChargeablePaymentMethodId(
    member.stripeSetupCustomerId,
    club.stripeAccountId,
    member.stripeSetupPaymentMethodId,
  );
  if (!chargePmId) {
    return {
      ok: false,
      code: "CARD_SETUP_INCOMPLETE",
      error:
        "The saved payment method is no longer attached to this member's billing account (it was likely replaced or removed). Send the card-setup link again, or bill offline. Nothing was charged.",
    };
  }
  if (chargePmId !== member.stripeSetupPaymentMethodId) {
    await prisma.member.update({
      where: { id: member.id },
      data: { stripeSetupPaymentMethodId: chargePmId },
    });
  }

  try {
    // Subscription price_data needs an existing Product (no inline product_data
    // like Checkout). Reuse the plan's reusable catalog Product so every member
    // on a plan shares ONE Stripe product. Fall back to a plan-scoped product
    // only if catalog sync hiccups — never block activation.
    const catalogMembership = await prisma.membership.findFirst({
      where: { id: input.membershipId, clubId: club.id },
      select: { id: true, clubId: true, name: true, description: true, stripeProductId: true, stripePriceIds: true },
    });
    let productId = catalogMembership
      ? await ensureMembershipProduct(catalogMembership, { id: club.id, stripeAccountId: club.stripeAccountId, stripeChargesEnabled: true })
      : null;
    if (!productId) {
      const product = await stripe.products.create(
        {
          name: input.planName,
          metadata: { athletixMembershipId: input.membershipId, clubId: club.id, kind: "membership" },
        },
        { stripeAccount: club.stripeAccountId },
      );
      productId = product.id;
    }
    const sub = await stripe.subscriptions.create(
      {
        customer: member.stripeSetupCustomerId,
        default_payment_method: chargePmId,
        items: [
          {
            price_data: {
              currency: "usd",
              product: productId,
              unit_amount: amountCents,
              recurring: interval,
            },
          },
        ],
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        ...(cancelAtUnix ? { cancel_at: cancelAtUnix } : {}),
        application_fee_percent: 0,
        metadata: input.metadata,
      },
      {
        stripeAccount: club.stripeAccountId,
        // A double-submit must not fork a second subscription — Stripe returns
        // the first one instead. Param-sensitive: a corrected retry (fixed
        // payment method, new price/date) gets a fresh key, so a failed attempt
        // never permanently "burns" the member's key (Mack Munroe, 2026-07-15).
        idempotencyKey: `${input.idempotencyPrefix}-${member.id}-${crypto
          .createHash("sha256")
          .update(JSON.stringify({ amountCents, trialEnd: trialEnd ?? null, cancelAtUnix: cancelAtUnix ?? null, pm: chargePmId, product: productId }))
          .digest("hex")
          .slice(0, 12)}`,
      },
    );

    const memberSub = await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId: input.membershipId,
        optionId: input.optionId,
        minimumTermEndsAt: input.minimumTermEndsAt,
        optionLabel: input.optionLabel,
        price,
        billingPeriod: period,
        billingType: "RECURRING",
        autoRenew: input.autoRenew,
        status: sub.status === "active" || sub.status === "trialing" ? "active" : "pending",
        stripeStatus: sub.status,
        startDate: input.startDate,
        billingAnchorDate: anchor,
        ...(cancelAtUnix ? { endDate: new Date(cancelAtUnix * 1000) } : {}),
        stripeSubscriptionId: sub.id,
        stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
        ...(input.discount ? { discountCode: input.discount.code, discountAmount: input.discount.amountOff } : {}),
        notes: input.notes,
      },
    });
    return {
      ok: true,
      memberSub,
      stripeSubscriptionId: sub.id,
      stripeStatus: sub.status,
      chargedImmediately,
      firstChargeAt,
      endsAt: cancelAtUnix ? new Date(cancelAtUnix * 1000) : null,
    };
  } catch (e) {
    return { ok: false, code: "STRIPE_FAILED", error: `Could not start the subscription: ${String(e)}` };
  }
}
