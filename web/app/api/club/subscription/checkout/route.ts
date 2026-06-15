import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { TIER_PRICES, type Tier } from "@/lib/tier";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({
  tier: z.enum(["growth", "pro", "enterprise"]),
});

// Resolve which Stripe Price ID to use for a tier. These are set in env per
// environment (test vs live) — see .env.example.
function priceIdFor(tier: Tier): string | null {
  switch (tier) {
    case "growth":     return process.env.STRIPE_PRICE_GROWTH ?? null;
    case "pro":        return process.env.STRIPE_PRICE_PRO ?? null;
    case "enterprise": return process.env.STRIPE_PRICE_ENTERPRISE ?? null;
    default:           return null;
  }
}

// POST /api/club/subscription/checkout
// Body: { tier: "growth" | "pro" | "enterprise" }
// Returns: { url } — redirect the owner to Stripe Checkout to subscribe to the
// chosen ClubOS tier. This uses the PLATFORM Stripe account (not Connect),
// because the club is paying us, not their members paying them.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { tier } = schema.parse(await req.json());
    const priceId = priceIdFor(tier);
    if (!priceId) {
      return NextResponse.json(
        { error: `No Stripe price configured for tier "${tier}". Set STRIPE_PRICE_${tier.toUpperCase()} in env.` },
        { status: 500 }
      );
    }

    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: {
        id: true,
        name: true,
        tier: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

    // If the club already has a LIVE subscription, send them to the customer
    // portal to swap plans. Verify against Stripe rather than trusting the
    // stored id — cancellations or dashboard deletions can leave stale ids.
    if (club.stripeSubscriptionId) {
      let live = false;
      try {
        const sub = await stripe.subscriptions.retrieve(club.stripeSubscriptionId);
        live = ["active", "trialing", "past_due", "unpaid", "paused"].includes(sub.status);
      } catch {
        live = false; // subscription gone on Stripe's side — treat as none
      }
      if (live) {
        return NextResponse.json(
          { error: "You already have an active plan. Use 'Manage billing' to change it." },
          { status: 400 }
        );
      }
      await prisma.club.update({
        where: { id: club.id },
        data: { stripeSubscriptionId: null, subscriptionStatus: "canceled" },
      });
      club.stripeSubscriptionId = null;
    }

    // Reuse the saved customer only if it still exists (and wasn't deleted in
    // the Stripe dashboard); otherwise start fresh.
    if (club.stripeCustomerId) {
      try {
        const cust = await stripe.customers.retrieve(club.stripeCustomerId);
        if ((cust as { deleted?: boolean }).deleted) throw new Error("deleted");
      } catch {
        await prisma.club.update({
          where: { id: club.id },
          data: { stripeCustomerId: null },
        });
        club.stripeCustomerId = null;
      }
    }

    const baseUrl = getAppBaseUrl();
    const ownerEmail = session.user.email ?? undefined;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      // Reuse existing customer if we have one (preserves card on file).
      ...(club.stripeCustomerId
        ? { customer: club.stripeCustomerId }
        : { customer_email: ownerEmail }),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/dashboard/settings/billing?upgraded=${tier}`,
      cancel_url:  `${baseUrl}/dashboard/settings/billing?canceled=true`,
      // 14-day free trial (must match /pricing and all marketing copy). A card
      // IS collected up front and is charged automatically when the trial ends
      // unless the owner cancels first.
      payment_method_collection: "always",
      // Show the promotion-code field so owners can redeem coupons created in
      // the Stripe dashboard.
      allow_promotion_codes: true,
      metadata: {
        clubOsPlan: tier,
        platformClubId: club.id,
      },
      subscription_data: {
        trial_period_days: 14,
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" },
        },
        metadata: {
          clubOsPlan: tier,
          platformClubId: club.id,
        },
      },
    });

    if (!checkoutSession.url) {
      return NextResponse.json({ error: "Stripe did not return a checkout URL" }, { status: 500 });
    }

    return NextResponse.json({ url: checkoutSession.url, priceLabel: TIER_PRICES[tier].label });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error("Subscription checkout error:", err);
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
