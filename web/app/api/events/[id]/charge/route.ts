import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";

const schema = z.object({
  memberId: z.string(),
  pricingType: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { memberId, pricingType = "MEMBER" } = schema.parse(body);

    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
    });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Connect Stripe first" }, { status: 400 });
    }

    const event = await prisma.event.findFirst({
      where: { id: params.id, clubId: club.id, deletedAt: null },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    let priceCents: number;
    let priceLabel: string;
    if (pricingType === "DROP_IN" && event.dropInFee) {
      priceCents = Math.round(Number(event.dropInFee) * 100);
      priceLabel = "Drop-in";
    } else if (pricingType === "NON_MEMBER" && event.nonMemberPrice) {
      priceCents = Math.round(Number(event.nonMemberPrice) * 100);
      priceLabel = "Non-member";
    } else if (event.memberPrice) {
      priceCents = Math.round(Number(event.memberPrice) * 100);
      priceLabel = "Member";
    } else {
      return NextResponse.json({ error: "No price set for this event" }, { status: 400 });
    }

    const member = await prisma.member.findFirst({
      where: { id: memberId, clubId: club.id, deletedAt: null },
    });
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const platformFee = calculatePlatformFee(priceCents, club.tier);
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: priceCents,
              product_data: {
                name: event.name,
                description: `${priceLabel} price · ${event.type}`,
              },
            },
          },
        ],
        success_url: `${baseUrl}/dashboard/events?paid=true`,
        cancel_url: `${baseUrl}/dashboard/events?canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: {
            memberId,
            eventId: event.id,
            eventName: event.name,
            clubId: club.id,
          },
        },
        metadata: {
          memberId,
          eventId: event.id,
          eventName: event.name,
          clubId: club.id,
        },
      },
      { stripeAccount: club.stripeAccountId }
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Event charge error:", err);
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
