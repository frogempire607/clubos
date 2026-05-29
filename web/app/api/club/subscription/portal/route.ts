import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/baseUrl";

// POST /api/club/subscription/portal
// Returns: { url } — opens the Stripe Customer Portal so the club owner can
// change plan, update card, view invoices, or cancel. Requires an existing
// Stripe customer (created during initial checkout).
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { stripeCustomerId: true },
  });
  if (!club?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account on file. Subscribe to a paid plan first." },
      { status: 400 }
    );
  }

  const baseUrl = getAppBaseUrl();
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: club.stripeCustomerId,
      return_url: `${baseUrl}/dashboard/settings/billing`,
    });
    return NextResponse.json({ url: portal.url });
  } catch (err) {
    console.error("Portal session error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
