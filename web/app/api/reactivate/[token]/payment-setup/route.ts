import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { writeBillingAudit } from "@/lib/billingAudit";

// POST /api/reactivate/[token]/payment-setup — the no-card path on the public
// reactivation page. Opens a SETUP-mode Stripe Checkout on the club's
// connected account (saves a card/wallet, charges NOTHING) and returns its
// URL. Uses the existing `saveCardMemberId` webhook capture, so the saved
// method lands exactly where confirm will look for it.
export async function POST(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token || token.length < 20) return NextResponse.json({ error: "Invalid link" }, { status: 400 });

  const r = await prisma.membershipReactivation.findUnique({
    where: { token },
    include: {
      member: {
        select: {
          id: true, clubId: true, firstName: true, lastName: true, email: true, guardianEmail: true,
          stripeSetupCustomerId: true, stripeCustomerId: true,
        },
      },
      club: { select: { stripeAccountId: true, stripeChargesEnabled: true } },
    },
  });
  if (!r) return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  if (r.status !== "DRAFT" && r.status !== "SENT") {
    return NextResponse.json({ error: "This offer is no longer open." }, { status: 410 });
  }
  if (r.tokenExpires < new Date()) {
    return NextResponse.json({ error: "This link has expired. Ask the club to resend it." }, { status: 410 });
  }
  if (!r.club.stripeAccountId || !r.club.stripeChargesEnabled) {
    return NextResponse.json({ error: "The club doesn't accept online payments right now." }, { status: 400 });
  }
  const stripeAccount = r.club.stripeAccountId;
  const member = r.member;

  let customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        email: member.email ?? member.guardianEmail ?? undefined,
        name: `${member.firstName} ${member.lastName}`.trim(),
        metadata: { memberId: member.id, migrationMemberId: member.id, clubId: member.clubId },
      },
      { stripeAccount },
    );
    customerId = customer.id;
    await prisma.member.update({
      where: { id: member.id },
      data: { stripeSetupCustomerId: customerId },
    });
  }

  const baseUrl = getAppBaseUrl();
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: `${baseUrl}/reactivate/${token}?card_saved=1`,
      cancel_url: `${baseUrl}/reactivate/${token}?card_canceled=1`,
      metadata: {
        saveCardMemberId: member.id,
        reactivationId: r.id,
        clubId: member.clubId,
        setupCustomerId: customerId,
      },
      setup_intent_data: {
        metadata: { saveCardMemberId: member.id, reactivationId: r.id, clubId: member.clubId },
      },
    },
    { stripeAccount },
  );

  await writeBillingAudit({
    clubId: member.clubId,
    memberId: member.id,
    action: "PM_ADD_STARTED",
    note: "Client opened secure card collection from the reactivation page.",
  });

  return NextResponse.json({ url: checkout.url });
}
