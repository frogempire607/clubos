import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { resolveFamilyContext } from "@/lib/memberContext";

// POST /api/member/payment-method/setup
//
// "Add a card for future use only." Opens a Stripe SETUP-mode Checkout on the
// club's connected account that saves a card with NO charge — the same
// mechanism migration activation uses. Built for cash/check members (and
// their guardians) who want a card on file for later purchases; the webhook
// stores the resulting payment method on the member.
const schema = z.object({
  // Whose card: the viewer's own profile or a child they guardian.
  memberId: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, stripeAccountId: true },
  });
  if (!club?.stripeAccountId) {
    return NextResponse.json(
      { error: "Your club hasn't enabled online payments yet, so a card can't be saved." },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const resolved = user
    ? await resolveFamilyContext(session.user.id, clubId, user.email, data.memberId ?? undefined)
    : null;
  if (resolved === "FORBIDDEN") {
    return NextResponse.json({ error: "You can't manage that profile." }, { status: 403 });
  }
  const member = resolved?.context ?? null;
  if (!member) {
    return NextResponse.json(
      { error: "Your account isn't linked to a member profile yet. Contact your club." },
      { status: 400 },
    );
  }

  const stripeAccount = club.stripeAccountId;
  // Reuse whichever customer already exists so the saved card lands where
  // billing flows (portal, migration approve) will look for it.
  let customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        email: member.email ?? member.guardianEmail ?? user?.email ?? undefined,
        name: `${member.firstName} ${member.lastName}`.trim(),
        metadata: { memberId: member.id, clubId },
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
      success_url: `${baseUrl}/member/profile?card_saved=1`,
      cancel_url: `${baseUrl}/member/profile?card_canceled=1`,
      metadata: {
        saveCardMemberId: member.id,
        clubId,
        setupCustomerId: customerId,
      },
      setup_intent_data: {
        metadata: { saveCardMemberId: member.id, clubId },
      },
    },
    { stripeAccount },
  );

  return NextResponse.json({ url: checkout.url });
}
