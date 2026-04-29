import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Only club owners can connect Stripe" }, { status: 403 });
  }

  try {
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
    });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

    let stripeAccountId = club.stripeAccountId;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        metadata: { clubId: club.id, clubSlug: club.slug },
        business_profile: {
          name: club.name,
          ...(club.tagline ? { product_description: club.tagline } : {}),
        },
      });
      stripeAccountId = account.id;

      await prisma.club.update({
        where: { id: club.id },
        data: { stripeAccountId },
      });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${baseUrl}/dashboard/settings/billing?refresh=true`,
      return_url: `${baseUrl}/dashboard/settings/billing?connected=true`,
      type: "account_onboarding",
    });

    return NextResponse.json({ url: accountLink.url });
  } catch (err) {
    console.error("Stripe onboarding error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
