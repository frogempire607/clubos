import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { sendBookingConfirmationEmail } from "@/lib/email";

async function emailBookingConfirmation(args: {
  memberId: string;
  clubName: string;
  eventName: string;
  startsAt: Date;
  endsAt: Date;
  coveredByMembership: boolean;
}) {
  const m = await prisma.member.findUnique({
    where: { id: args.memberId },
    select: {
      firstName: true,
      email: true,
      isMinor: true,
      guardianEmail: true,
      guardian: { select: { email: true } },
    },
  });
  if (!m) return;
  const to = m.isMinor
    ? (m.guardian?.email || m.guardianEmail || m.email)
    : (m.email || m.guardianEmail);
  if (!to) return;
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  try {
    await sendBookingConfirmationEmail({
      to,
      firstName: m.firstName,
      clubName: args.clubName,
      eventName: args.eventName,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      coveredByMembership: args.coveredByMembership,
      portalUrl: `${baseUrl}/member/bookings`,
    });
  } catch (e) {
    console.error("Booking email failed:", e);
  }
}

const schema = z.object({
  pricingType: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).default("MEMBER"),
});

// POST /api/member/events/[id]/register
// Member self-registers. Free path if active sub matches an accepted membership.
// Otherwise opens Stripe Checkout for the chosen price (defaults to MEMBER).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { pricingType } = schema.parse(await req.json().catch(() => ({})));

    const event = await prisma.event.findFirst({
      where: {
        id: params.id,
        clubId: session.user.clubId,
        deletedAt: null,
        visibility: { in: ["PUBLIC", "MEMBERS_ONLY"] },
        purchaseAccess: "ANYONE",
      },
      include: { _count: { select: { bookings: true } } },
    });
    if (!event) return NextResponse.json({ error: "Event not available" }, { status: 404 });

    const member = await prisma.member.findFirst({
      where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club." },
        { status: 400 },
      );
    }

    // Already booked?
    const existing = await prisma.booking.findUnique({
      where: { eventId_memberId: { eventId: event.id, memberId: member.id } },
    });
    if (existing) return NextResponse.json({ error: "You're already registered for this event." }, { status: 409 });

    const acceptedMembershipIds = (
      (event.pricingOptions as unknown as Array<{ type: string; membershipId?: string }> | null) || []
    )
      .filter((o) => o?.type === "membership" && o.membershipId)
      .map((o) => o.membershipId as string);

    // Membership-covered: free booking
    if (acceptedMembershipIds.length > 0) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, membershipId: { in: acceptedMembershipIds }, status: "active" },
      });
      if (activeSub) {
        const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
        await prisma.booking.create({ data: { eventId: event.id, memberId: member.id, status } });
        if (status === "CONFIRMED") {
          const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { name: true } });
          emailBookingConfirmation({
            memberId: member.id,
            clubName: club?.name ?? "your club",
            eventName: event.name,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            coveredByMembership: true,
          });
        }
        return NextResponse.json({ coveredByMembership: true, status });
      }
    }

    // No price configured at all → free booking
    const hasPrice = !!(event.memberPrice || event.nonMemberPrice || event.dropInFee);
    if (!hasPrice) {
      const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({ data: { eventId: event.id, memberId: member.id, status } });
      if (status === "CONFIRMED") {
        const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { name: true } });
        emailBookingConfirmation({
          memberId: member.id,
          clubName: club?.name ?? "your club",
          eventName: event.name,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          coveredByMembership: false,
        });
      }
      return NextResponse.json({ free: true, status });
    }

    // Paid path
    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    let priceCents = 0;
    let priceLabel = "Member";
    if (pricingType === "DROP_IN" && event.dropInFee) {
      priceCents = Math.round(Number(event.dropInFee) * 100);
      priceLabel = "Drop-in";
    } else if (pricingType === "NON_MEMBER" && event.nonMemberPrice) {
      priceCents = Math.round(Number(event.nonMemberPrice) * 100);
      priceLabel = "Non-member";
    } else if (event.memberPrice) {
      priceCents = Math.round(Number(event.memberPrice) * 100);
      priceLabel = "Member";
    } else if (event.dropInFee) {
      priceCents = Math.round(Number(event.dropInFee) * 100);
      priceLabel = "Drop-in";
    } else if (event.nonMemberPrice) {
      priceCents = Math.round(Number(event.nonMemberPrice) * 100);
      priceLabel = "Non-member";
    } else {
      return NextResponse.json({ error: "No price configured" }, { status: 400 });
    }

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
        success_url: `${baseUrl}/member/events?paid=true`,
        cancel_url:  `${baseUrl}/member/events?canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: {
            memberId: member.id,
            eventId: event.id,
            eventName: event.name,
            clubId: club.id,
          },
        },
        metadata: {
          memberId: member.id,
          eventId: event.id,
          eventName: event.name,
          clubId: club.id,
        },
      },
      { stripeAccount: club.stripeAccountId }
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
