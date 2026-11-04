import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requirePermissionLive } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { writeBillingAudit } from "@/lib/billingAudit";
import { walletsFor, OWNER_META } from "@/lib/payerWallet";

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
  // Where Stripe sends staff back. "Advanced billing" is retired (2026-09-28):
  // payment methods live on the profile's Memberships tab, and only a member
  // still mid-migration collects a card from the Migration setup page.
  returnTo: z.enum(["profile", "migration"]).default("profile"),
  // 2026-11-03 — WHOSE card this is: a person who pays for the athlete (Paid
  // by, a family guardian, their own login). The card is saved to that
  // person's wallet, never into another family's.
  ownerUserId: z.string().optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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

  // Where the card goes (2026-11-03). Cards belong to people (lib/payerWallet):
  //   · the chosen owner's existing wallet customer, else a NEW customer
  //     stamped with that owner — never the customer of another family;
  //   · the athlete's card on file only changes when it is empty or already
  //     that owner's ("ADD"). Otherwise the card just joins the owner's wallet
  //     ("WALLET") — e.g. the coach adds his card on an athlete whose mom's card
  //     is on file; the Assign sheet can then bill the membership to it.
  const wallets = await walletsFor(member.clubId, member.id, stripeAccount).catch(() => null);
  const ownerUserId =
    data.ownerUserId ?? wallets?.onFile?.ownerUserId ?? wallets?.wallets[0]?.ownerUserId ?? null;
  let customerId: string | null = null;
  let ownerName: string | null = null;
  if (ownerUserId) {
    const wallet = wallets?.wallets.find((w) => w.ownerUserId === ownerUserId);
    if (!wallet) {
      return NextResponse.json(
        { error: "That person doesn't pay for this athlete. Set them as Paid by, or link them as a guardian, first.", code: "NOT_A_PAYER" },
        { status: 409 },
      );
    }
    ownerName = wallet.ownerName;
    customerId = wallet.customers[0]?.customerId ?? null;
    if (!customerId) {
      const owner = await prisma.user.findFirst({ where: { id: ownerUserId, clubId: member.clubId }, select: { email: true } });
      const customer = await stripe.customers.create(
        { email: owner?.email ?? undefined, name: wallet.ownerName, metadata: { [OWNER_META]: ownerUserId, clubId: member.clubId, memberId: member.id } },
        { stripeAccount },
      );
      customerId = customer.id;
    }
  } else {
    // Nobody to name (no login, no guardian, no Paid by): the athlete's own customer, as before.
    customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId ?? null;
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
    }
  }

  const onFileCustomer = member.stripeSetupCustomerId ?? null;
  const sameWallet = !!onFileCustomer && onFileCustomer === customerId;
  const hasOnFile = !!member.stripeSetupPaymentMethodId;
  let intent: "ADD" | "REPLACE" | "WALLET";
  if (!hasOnFile) intent = "ADD";
  else if (sameWallet) intent = data.intent === "REPLACE" ? "REPLACE" : "ADD";
  else if (ownerUserId && wallets?.onFile?.ownerUserId && wallets.onFile.ownerUserId !== ownerUserId) intent = "WALLET";
  else intent = data.intent === "REPLACE" ? "REPLACE" : "ADD";
  // REPLACE confirms on the customer the athlete already uses; a different wallet is a plain ADD.
  if (intent === "REPLACE" && !sameWallet) intent = "ADD";

  // Request-derived origin: on a deploy preview the Stripe success/cancel
  // return must land back on the SAME deployment, not production.
  const baseUrl = baseUrlFromRequest(req);
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: data.returnTo === "migration"
        ? `${baseUrl}/dashboard/members/${member.id}/billing?card_saved=1&intent=${intent}`
        : `${baseUrl}/dashboard/members/${member.id}?tab=memberships&card_saved=1&intent=${intent}`,
      cancel_url: data.returnTo === "migration"
        ? `${baseUrl}/dashboard/members/${member.id}/billing?card_canceled=1`
        : `${baseUrl}/dashboard/members/${member.id}?tab=memberships&card_canceled=1`,
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
        : intent === "WALLET"
          ? `Staff opened a Stripe card-collection page to save a card to ${ownerName ?? "the payer"}'s wallet (the card on file is unchanged).`
          : `Staff opened a Stripe card-collection page to add a payment method${ownerName ? ` (${ownerName}'s card)` : ""}.`,
  });

  return NextResponse.json({ url: checkout.url, intent, ownerName });
}
