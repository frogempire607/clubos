import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { applyParentalControls } from "@/lib/parentalControls";

// POST /api/member/private-packages/[id]/buy
//
// Opens a Stripe Checkout session on the club's connected account for the
// chosen FLAT-mode published package. We deliberately do NOT pre-create
// a PrivateCreditLedger row here — credits get granted only after the
// webhook confirms payment, so the member can't see (or use) credits
// they haven't paid for if checkout abandons.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clubId = session.user.clubId;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const member = user
    ? await findOrAutoLinkMember(session.user.id, clubId, user.email)
    : null;
  if (!member) {
    return NextResponse.json(
      { error: "Your account isn't linked to a member profile yet. Contact your club." },
      { status: 400 },
    );
  }

  const pkg = await prisma.privatePackage.findFirst({
    where: {
      id: params.id,
      clubId,
      deletedAt: null,
      active: true,
      publishedToMembers: true,
      // Match the GET filter — non-FLAT packages aren't supported in the
      // member shop yet.
      pricingMode: "FLAT",
    },
  });
  if (!pkg) {
    return NextResponse.json({ error: "Package not available" }, { status: 404 });
  }

  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
    return NextResponse.json(
      { error: "Your club hasn't enabled online payments yet." },
      { status: 400 },
    );
  }

  const totalCents = Math.round(Number(pkg.price) * 100);
  if (totalCents <= 0) {
    return NextResponse.json({ error: "Package price is missing." }, { status: 400 });
  }

  // P4 parental gate. Runs before any Stripe-side cost is paid; either
  // allows the checkout, blocks the buy outright (allowPackagePurchase=false),
  // or queues a PendingApproval for the guardian. The replay payload is
  // just the package id — POST this same endpoint again after approval
  // and the gate will return "allow" because the row already exists.
  const gate = await applyParentalControls({
    member: {
      id: member.id,
      clubId,
      userId: member.userId,
      isMinor: member.isMinor,
      parentControls: member.parentControls,
    },
    bookerUserId: session.user.id,
    kind: "PACKAGE_BUY",
    amount: Number(pkg.price),
    payload: { packageId: pkg.id },
  });
  if (gate.kind === "block") {
    return NextResponse.json(gate.body, { status: gate.status });
  }
  if (gate.kind === "queue") {
    return NextResponse.json(gate.response, { status: 202 });
  }

  const platformFee = calculatePlatformFee(totalCents, club.tier);
  const feeItem = processingFeeLineItem(totalCents, club.passProcessingFees);
  const baseUrl = getAppBaseUrl();

  const checkoutSession = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: pkg.title,
              ...(pkg.description ? { description: pkg.description } : {}),
            },
          },
        },
        ...(feeItem ? [feeItem] : []),
      ],
      // Packages are now an inline offer inside the private-request
      // flow, not a separate shop. Redirect back to /member/privates
      // so the athlete lands where the credits become usable.
      success_url: `${baseUrl}/member/privates?bought=1`,
      cancel_url: `${baseUrl}/member/privates?canceled=1`,
      payment_intent_data: {
        application_fee_amount: platformFee,
        metadata: {
          privatePackageId: pkg.id,
          memberId: member.id,
          clubId,
        },
      },
      // Webhook reads from the top-level session.metadata. We mirror the
      // payment_intent.metadata so either source resolves the right
      // package + member.
      metadata: {
        privatePackageId: pkg.id,
        memberId: member.id,
        clubId,
      },
    },
    { stripeAccount: club.stripeAccountId },
  );

  return NextResponse.json({ url: checkoutSession.url });
}
