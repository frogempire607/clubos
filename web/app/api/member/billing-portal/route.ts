import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

// POST /api/member/billing-portal
// Creates a Stripe Customer Portal session for the current member so they can
// update their saved card / cancel/renew subscriptions / view invoices.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await prisma.member.findFirst({
    where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, stripeCustomerId: true, email: true, firstName: true, lastName: true, subscriptions: { select: { id: true, stripeSubscriptionId: true } } },
  });
  if (!member) return NextResponse.json({ error: "No member profile found" }, { status: 400 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { stripeAccountId: true, stripeChargesEnabled: true },
  });
  if (!club?.stripeAccountId) {
    return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
  }

  // Best-effort: if the member doesn't have a stripeCustomerId stored, look one up
  // from any subscription that already pinned a customer on the connected account.
  let customerId = member.stripeCustomerId;
  if (!customerId) {
    const subWithStripe = member.subscriptions.find((s) => s.stripeSubscriptionId);
    if (subWithStripe?.stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(
          subWithStripe.stripeSubscriptionId,
          { stripeAccount: club.stripeAccountId },
        );
        if (typeof sub.customer === "string") {
          customerId = sub.customer;
          await prisma.member.update({ where: { id: member.id }, data: { stripeCustomerId: customerId } });
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (!customerId) {
    return NextResponse.json(
      { error: "You don't have a saved payment method yet — purchase a membership or product first." },
      { status: 400 }
    );
  }

  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const portal = await stripe.billingPortal.sessions.create(
    {
      customer: customerId,
      return_url: `${baseUrl}/member/profile`,
    },
    { stripeAccount: club.stripeAccountId },
  );

  return NextResponse.json({ url: portal.url });
}
