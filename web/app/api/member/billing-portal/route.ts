import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/baseUrl";

// POST /api/member/billing-portal
//
// Opens the Stripe billing portal for the member on their CLUB's connected
// account. Cancellation is INTENTIONALLY DISABLED in the portal configuration:
// members keep the ability to update their payment method and view invoices,
// but to cancel a membership they must use the in-app "Request cancellation"
// action, which routes to club owner/staff approval (see
// /api/member/subscriptions/request-cancel). This satisfies the parental-
// controls + club-control requirement that members can't self-cancel.

// Stripe billing-portal configurations are reusable. Cache one id per connected
// account (per warm server instance) so we don't create a fresh configuration
// on every click. A cold start recreates it — harmless and rare.
const portalConfigCache = new Map<string, string>();

async function getMemberPortalConfigId(stripeAccountId: string): Promise<string> {
  const cached = portalConfigCache.get(stripeAccountId);
  if (cached) return cached;
  const configuration = await stripe.billingPortal.configurations.create(
    {
      business_profile: { headline: "Manage your membership billing" },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: {
          enabled: true,
          allowed_updates: ["email", "address", "phone"],
        },
        // Self-cancel is off by design — cancellation goes through the club.
        subscription_cancel: { enabled: false },
        subscription_pause: { enabled: false },
      },
    },
    { stripeAccount: stripeAccountId },
  );
  portalConfigCache.set(stripeAccountId, configuration.id);
  return configuration.id;
}

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { memberProfile: { select: { id: true, stripeCustomerId: true } } },
  });
  const customerId = user?.memberProfile?.stripeCustomerId || null;
  if (!customerId) {
    return NextResponse.json(
      {
        error:
          "No billing account on file yet. Your club sets this up when your membership billing begins.",
      },
      { status: 400 },
    );
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { stripeAccountId: true },
  });
  if (!club?.stripeAccountId) {
    return NextResponse.json(
      { error: "Your club hasn't finished setting up payments yet." },
      { status: 400 },
    );
  }

  const baseUrl = getAppBaseUrl();
  try {
    const configuration = await getMemberPortalConfigId(club.stripeAccountId);
    const portal = await stripe.billingPortal.sessions.create(
      {
        customer: customerId,
        configuration,
        return_url: `${baseUrl}/member/profile`,
      },
      { stripeAccount: club.stripeAccountId },
    );
    return NextResponse.json({ url: portal.url });
  } catch (err) {
    console.error("Member billing portal error:", err);
    return NextResponse.json(
      { error: "Could not open the billing portal. Please contact your club." },
      { status: 500 },
    );
  }
}
