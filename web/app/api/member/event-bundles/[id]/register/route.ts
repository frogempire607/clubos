import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({ memberId: z.string().optional() });

async function resolveMember(userId: string, clubId: string, email: string, requestedMemberId?: string) {
  const self = await findOrAutoLinkMember(userId, clubId, email);
  const guardianships = await prisma.memberGuardianUser.findMany({
    where: { userId, member: { clubId } },
    include: { member: true },
  });
  const accessible = [...(self ? [self] : []), ...guardianships.map((g) => g.member)];
  if (requestedMemberId) return accessible.find((m) => m.id === requestedMemberId) ?? null;
  return self ?? accessible[0] ?? null;
}

// Book every event in the bundle for this member, skipping any already booked.
async function bookAllEvents(eventIds: string[], memberId: string) {
  for (const eventId of eventIds) {
    const existing = await prisma.booking.findUnique({
      where: { eventId_memberId: { eventId, memberId } },
    });
    if (!existing) {
      await prisma.booking.create({ data: { eventId, memberId, status: "CONFIRMED" } });
    }
  }
}

// POST /api/member/event-bundles/[id]/register
// One payment for the package price; on success the webhook books the member
// into every event in the bundle. Free bundles book immediately.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `book:bundle:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a moment.");

  try {
    const { memberId } = schema.parse(await req.json().catch(() => ({})));

    // COPPA: block a guardian from registering a minor until consent is on file.
    if (memberId && (await guardianActionBlocked(session.user.id, memberId))) {
      return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
    }

    const bundle = await prisma.eventBundle.findFirst({
      where: { id, clubId: session.user.clubId, deletedAt: null, published: true },
      include: { items: { select: { eventId: true } } },
    });
    if (!bundle) return NextResponse.json({ error: "Bundle not available" }, { status: 404 });
    const eventIds = bundle.items.map((it: { eventId: string }) => it.eventId);
    if (eventIds.length === 0) {
      return NextResponse.json({ error: "This bundle has no events." }, { status: 400 });
    }

    const sessionUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    const member = sessionUser
      ? await resolveMember(session.user.id, session.user.clubId, sessionUser.email, memberId)
      : null;
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club to get added." },
        { status: 400 },
      );
    }

    const priceCents = Math.round(Number(bundle.price) * 100);

    // Free bundle → book everything immediately.
    if (priceCents <= 0) {
      await bookAllEvents(eventIds, member.id);
      return NextResponse.json({ free: true, booked: eventIds.length });
    }

    // Paid → one Stripe Checkout for the package price. The webhook books every
    // event in the bundle on payment success (keyed off metadata.bundleId).
    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    const platformFee = calculatePlatformFee(priceCents, club.tier);
    const baseUrl = getAppBaseUrl();
    const feeItem = processingFeeLineItem(priceCents, club.passProcessingFees);

    const checkout = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: priceCents,
              product_data: { name: bundle.name, description: `Event bundle · ${eventIds.length} events` },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        success_url: `${baseUrl}/member/events?paid=true`,
        cancel_url: `${baseUrl}/member/events?canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: { memberId: member.id, bundleId: bundle.id, clubId: club.id },
        },
        metadata: { memberId: member.id, bundleId: bundle.id, clubId: club.id },
      },
      { stripeAccount: club.stripeAccountId },
    );
    return NextResponse.json({ url: checkout.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
