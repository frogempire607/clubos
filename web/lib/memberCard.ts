import { stripe } from "@/lib/stripe";

// Read-only resolver for the saved card behind a member's billing so the member
// portal can show "Visa ···· 4242 (Shannan Hall)" instead of a bare "Card on
// file". Never charges, never mutates — a pure GET against the club's connected
// Stripe account. All failures degrade to null so a Stripe hiccup or an
// un-configured club never breaks the billing page (it falls back to the
// existing "Card on file" copy).

export type CardSnapshot = {
  brand: string; // "visa", "mastercard", …
  last4: string;
  // billing_details.name on the payment method — i.e. the name on the card,
  // which answers "whose card is this?" when multiple guardians manage one
  // athlete. Null when Stripe has no name on file.
  cardholder: string | null;
};

/** Title-case a Stripe card brand ("visa" → "Visa", "american_express" → "American Express"). */
export function prettyBrand(brand: string): string {
  return brand
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Resolve the default (or first) card on file for a Stripe customer on a
 * connected account. Returns null on any error or when there's no card.
 */
export async function resolveCardSnapshot(
  customerId: string | null | undefined,
  stripeAccountId: string | null | undefined,
): Promise<CardSnapshot | null> {
  if (!customerId || !stripeAccountId) return null;
  try {
    // Prefer the customer's default payment method (the one that will be
    // charged); fall back to the first saved card (setup-mode / migrated cards
    // may not have a default set).
    let paymentMethodId: string | null = null;
    try {
      const customer = await stripe.customers.retrieve(customerId, {
        stripeAccount: stripeAccountId,
      });
      if (customer && !("deleted" in customer && customer.deleted)) {
        const def = (customer as { invoice_settings?: { default_payment_method?: string | { id: string } | null } })
          .invoice_settings?.default_payment_method;
        paymentMethodId = typeof def === "string" ? def : def?.id ?? null;
      }
    } catch {
      // ignore — fall through to listing cards
    }

    if (paymentMethodId) {
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId, {
        stripeAccount: stripeAccountId,
      });
      if (pm.card) {
        return { brand: pm.card.brand, last4: pm.card.last4, cardholder: pm.billing_details?.name ?? null };
      }
    }

    const list = await stripe.paymentMethods.list(
      { customer: customerId, type: "card", limit: 1 },
      { stripeAccount: stripeAccountId },
    );
    const pm = list.data[0];
    if (pm?.card) {
      return { brand: pm.card.brand, last4: pm.card.last4, cardholder: pm.billing_details?.name ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the payment-method id that an off-session charge should use:
 * the customer's default PM, else the ONLY saved card. Returns null when the
 * customer has multiple cards and no default — we never guess which card to
 * charge (same rule as the reactivation confirm fallback).
 */
export async function resolveChargeablePaymentMethodId(
  customerId: string | null | undefined,
  stripeAccountId: string | null | undefined,
): Promise<string | null> {
  if (!customerId || !stripeAccountId) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId, { stripeAccount: stripeAccountId });
    if (customer && !("deleted" in customer && customer.deleted)) {
      const def = (customer as { invoice_settings?: { default_payment_method?: string | { id: string } | null } })
        .invoice_settings?.default_payment_method;
      const defId = typeof def === "string" ? def : def?.id ?? null;
      if (defId) return defId;
    }
    const list = await stripe.paymentMethods.list(
      { customer: customerId, type: "card", limit: 2 },
      { stripeAccount: stripeAccountId },
    );
    return list.data.length === 1 ? list.data[0].id : null;
  } catch {
    return null;
  }
}
