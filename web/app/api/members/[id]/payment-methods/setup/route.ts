import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { writeBillingAudit } from "@/lib/billingAudit";

// POST /api/members/[id]/payment-methods/setup  (billing:full)
//
// Owner/staff-initiated "add or replace a card" for an athlete: creates a
// SETUP-mode Stripe Checkout on the club's connected account and returns its
// URL. Card entry happens ONLY on the Stripe-hosted page (nobody in
// AthletixOS ever types card numbers), and saving charges nothing.
//
// intent:
//   ADD     — the captured method becomes the member's on-file card as soon
//             as the webhook lands (there is nothing to protect).
//   REPLACE — collect-first: the new method is attached to the customer but
//             the member's captured card, the customer default, and any live
//             subscription keep charging the OLD method until the owner
//             explicitly confirms via make-default.
const schema = z.object({
  intent: z.enum(["ADD", "REPLACE"]).default("ADD"),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, email: true, guardianEmail: true,
      stripeSetupCustomerId: true, stripeCustomerId: true, stripeSetupPaymentMethodId: true,
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const club = await prisma.club.findUnique({
    where: { id: member.clubId },
    select: { stripeAccountId: true, stripeChargesEnabled: true },
  });
  if (!club?.stripeAccountId) {
    return NextResponse.json({ error: "This club hasn't connected Stripe yet, so a card can't be saved." }, { status: 400 });
  }
  const stripeAccount = club.stripeAccountId;

  // Reuse whichever customer already exists so the saved card lands where
  // billing flows (approval, reactivation, portal) will look for it.
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

  // REPLACE only makes sense when something is already on file.
  const intent = data.intent === "REPLACE" && member.stripeSetupPaymentMethodId ? "REPLACE" : "ADD";

  // Request-derived origin: on a deploy preview the Stripe success/cancel
  // return must land back on the SAME deployment, not production.
  const baseUrl = baseUrlFromRequest(req);
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: `${baseUrl}/dashboard/members/${member.id}/billing?card_saved=1&intent=${intent}`,
      cancel_url: `${baseUrl}/dashboard/members/${member.id}/billing?card_canceled=1`,
      metadata: {
        adminCardSetupMemberId: member.id,
        adminCardSetupIntent: intent,
        clubId: member.clubId,
        setupCustomerId: customerId,
      },
      setup_intent_data: {
        metadata: { adminCardSetupMemberId: member.id, adminCardSetupIntent: intent, clubId: member.clubId },
      },
    },
    { stripeAccount },
  );

  await writeBillingAudit({
    clubId: member.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: intent === "REPLACE" ? "PM_REPLACE_STARTED" : "PM_ADD_STARTED",
    note:
      intent === "REPLACE"
        ? "Staff opened a Stripe card-collection page to REPLACE the saved method (old method stays in charge until confirmed)."
        : "Staff opened a Stripe card-collection page to add a payment method.",
  });

  return NextResponse.json({ url: checkout.url, intent });
}
