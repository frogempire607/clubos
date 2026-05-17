import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { TIER_PRICES, type Tier } from "@/lib/tier";

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

    // If the club already has an active subscription, redirect them to the
    // customer portal to swap plans rather than starting a fresh checkout.
    if (club.stripeSubscriptionId) {
      return NextResponse.json(
        { error: "You already have an active plan. Use 'Manage billing' to change it." },
        { status: 400 }
      );
    }

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
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
      metadata: {
        clubOsPlan: tier,
        platformClubId: club.id,
      },
      subscription_data: {
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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
