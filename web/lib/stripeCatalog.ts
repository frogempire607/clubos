import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

/**
 * Stripe product catalog (Phase A of the payments/membership/migration loop).
 *
 * Every billable plan should exist in Stripe as a *reusable* Product (and, for
 * the standard recurring amount, a reusable Price) on the club's CONNECTED
 * account — instead of an anonymous `product_data` blob recreated on every
 * charge, which is why the Stripe dashboard's product catalog was empty.
 *
 * Design rules (all enforced here so callers stay simple + safe):
 *   - Connected account only: every call passes `{ stripeAccount }`.
 *   - Idempotent: cached ids on the row are trusted and returned without a
 *     network round-trip; creates use a Stripe idempotency key so concurrent
 *     charges can't fork duplicate catalog objects.
 *   - Never blocks a sale: ANY failure (Stripe off, network, bad key) is
 *     swallowed and returns `null`. Callers fall back to the existing inline
 *     `product_data` path, so pricing/charging behavior is unchanged.
 *   - Amount-preserving: this module NEVER decides what to charge. It only
 *     provides a Product/Price id the caller may reference; the caller still
 *     controls unit_amount, discounts, fees, and trials.
 */

type CatalogClub = {
  id: string;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
};

type CatalogMembership = {
  id: string;
  clubId: string;
  name: string;
  description: string | null;
  stripeProductId: string | null;
  stripePriceIds: unknown; // Json map { "<PERIOD>:<amountCents>": "price_..." }
};

type StripeInterval = { interval: "day" | "week" | "month" | "year"; interval_count: number };

function clubCanSync(club: CatalogClub): club is CatalogClub & { stripeAccountId: string } {
  return !!club.stripeAccountId && !!club.stripeChargesEnabled;
}

function priceMap(raw: unknown): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return {};
}

/**
 * Ensure a reusable Stripe Product exists for this membership plan on the
 * club's connected account. Returns the product id, or null if Stripe isn't
 * ready / anything failed. Caches the id on `Membership.stripeProductId`.
 */
export async function ensureMembershipProduct(
  membership: CatalogMembership,
  club: CatalogClub,
): Promise<string | null> {
  if (!clubCanSync(club)) return null;
  if (membership.stripeProductId) return membership.stripeProductId;

  try {
    const product = await stripe.products.create(
      {
        name: membership.name,
        ...(membership.description?.trim() ? { description: membership.description.trim() } : {}),
        metadata: { athletixMembershipId: membership.id, clubId: membership.clubId, kind: "membership" },
      },
      { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-membership-product-${membership.id}` },
    );
    await prisma.membership.update({
      where: { id: membership.id },
      data: { stripeProductId: product.id },
    });
    membership.stripeProductId = product.id;
    return product.id;
  } catch (e) {
    console.error(`[stripeCatalog] ensureMembershipProduct failed for ${membership.id}:`, e);
    return null;
  }
}

/**
 * Ensure a reusable recurring Price for a plan's standard option amount.
 * Keyed by "<billingPeriod>:<amountCents>" so a price change mints a new Price
 * (Stripe prices are immutable) while reusing the same Product. Returns the
 * price id or null. Use this ONLY for the plain recurring case (no per-charge
 * discount); discounted/fee-variant amounts should stay inline so we don't
 * pollute the catalog with one-off prices.
 */
export async function ensureRecurringPrice(
  membership: CatalogMembership,
  club: CatalogClub,
  args: { billingPeriod: string; amountCents: number; interval: StripeInterval },
): Promise<string | null> {
  if (!clubCanSync(club)) return null;
  if (!Number.isFinite(args.amountCents) || args.amountCents <= 0) return null;

  const productId = await ensureMembershipProduct(membership, club);
  if (!productId) return null;

  const key = `${args.billingPeriod}:${args.amountCents}`;
  const map = priceMap(membership.stripePriceIds);
  if (map[key]) return map[key];

  try {
    const price = await stripe.prices.create(
      {
        product: productId,
        currency: "usd",
        unit_amount: args.amountCents,
        recurring: args.interval,
        metadata: { athletixMembershipId: membership.id, clubId: membership.clubId, billingPeriod: args.billingPeriod },
      },
      { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-membership-price-${membership.id}-${key}` },
    );
    map[key] = price.id;
    await prisma.membership.update({
      where: { id: membership.id },
      data: { stripePriceIds: map },
    });
    membership.stripePriceIds = map;
    return price.id;
  } catch (e) {
    console.error(`[stripeCatalog] ensureRecurringPrice failed for ${membership.id} (${key}):`, e);
    return null;
  }
}
