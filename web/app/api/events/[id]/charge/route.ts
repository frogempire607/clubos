import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendBookingConfirmationEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({
  memberId: z.string(),
  pricingType: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Owner-side at-the-door charge. Members must use the member-facing
  // registration flow which enforces parent controls and tier eligibility.
  if (session.user.role !== "OWNER" && session.user.role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      include: { _count: { select: { bookings: true } } },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // If the event accepts certain memberships and this member has an active
    // subscription on one of them, register them for free.
    const acceptedMembershipIds = (
      (event.pricingOptions as unknown as Array<{ type: string; membershipId?: string }> | null) || []
    )
      .filter((o) => o?.type === "membership" && o.membershipId)
      .map((o) => o.membershipId as string);

    if (acceptedMembershipIds.length > 0) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: {
          memberId,
          membershipId: { in: acceptedMembershipIds },
          status: "active",
        },
      });
      if (activeSub) {
        const existing = await prisma.booking.findUnique({
          where: { eventId_memberId: { eventId: event.id, memberId } },
        });
        if (existing) {
          return NextResponse.json({ error: "Already booked" }, { status: 409 });
        }
        const status =
          event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
        await prisma.booking.create({
          data: { eventId: event.id, memberId, status },
        });
        const baseUrl = getAppBaseUrl();

        // Email: free membership-covered booking confirmation
        if (status === "CONFIRMED") {
          const member = await prisma.member.findUnique({
            where: { id: memberId },
            select: {
              firstName: true,
              email: true,
              isMinor: true,
              guardianEmail: true,
              guardian: { select: { email: true } },
            },
          });
          const to = member?.isMinor
            ? (member?.guardian?.email || member?.guardianEmail || member?.email)
            : (member?.email || member?.guardianEmail);
          if (to && member) {
            sendBookingConfirmationEmail({
              to,
              firstName: member.firstName,
              clubName: club.name,
              eventName: event.name,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              coveredByMembership: true,
              portalUrl: `${baseUrl}/member/bookings`,
            }).catch((e) => console.error("Booking email failed:", e));
          }
        }

        return NextResponse.json({
          coveredByMembership: true,
          status,
          url: `${baseUrl}/dashboard/events?booked=membership`,
        });
      }
    }

    // Variable-cost events: register the member now, bill later via the
    // Registrations → Send invoices flow. Never silently free, never an error.
    const varTotal =
      event.variableCostTotal != null
        ? Number(event.variableCostTotal)
        : event.variableCostEstimatedTotal != null
          ? Number(event.variableCostEstimatedTotal)
          : 0;
    if (event.variableCostEnabled && varTotal > 0) {
      const existing = await prisma.booking.findUnique({
        where: { eventId_memberId: { eventId: event.id, memberId } },
      });
      if (existing) return NextResponse.json({ error: "Already booked" }, { status: 409 });

      const m = await prisma.member.findFirst({
        where: { id: memberId, clubId: club.id, deletedAt: null },
        select: { firstName: true, lastName: true, email: true },
      });
      if (!m) return NextResponse.json({ error: "Member not found" }, { status: 404 });

      const status =
        event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({ data: { eventId: event.id, memberId, status } });

      let perHead: number | null = null;
      if (
        event.variableCostMode === "ESTIMATED" &&
        event.variableCostEstimatedSignups &&
        event.variableCostEstimatedSignups > 0
      ) {
        perHead = +(varTotal / event.variableCostEstimatedSignups).toFixed(2);
      }

      const already = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId, status: { not: "CANCELED" } },
        select: { id: true },
      });
      if (!already) {
        await prisma.eventRegistration.create({
          data: {
            eventId: event.id,
            clubId: club.id,
            memberId,
            name: `${m.firstName} ${m.lastName}`.trim(),
            email: m.email ?? "",
            status: "REGISTERED",
            amountDue: perHead,
          },
        });
      }

      return NextResponse.json({
        variableCost: true,
        billedLater: true,
        mode: event.variableCostMode ?? "ESTIMATED",
        perHead,
        status,
      });
    }

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
    const baseUrl = getAppBaseUrl();
    const feeItem = processingFeeLineItem(priceCents, club.passProcessingFees);

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
          ...(feeItem ? [feeItem] : []),
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
