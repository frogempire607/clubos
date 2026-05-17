import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendBookingConfirmationEmail } from "@/lib/email";
import { findOrAutoLinkMember } from "@/lib/memberLink";

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
      include: {
        _count: { select: { bookings: true } },
        sessions: { select: { id: true } },
      },
    });
    if (!event) return NextResponse.json({ error: "Event not available" }, { status: 404 });

    const sessionUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    const member = sessionUser
      ? await findOrAutoLinkMember(session.user.id, session.user.clubId, sessionUser.email)
      : null;
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club to get added." },
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

    // Variable-cost events (shared tournament cost): the member is registered
    // now but billed LATER by the owner via mass-invoice — it is NOT free.
    // Booking is created so they hold a spot; an EventRegistration row is
    // created so the owner can send an invoice/payment link when ready.
    const varTotal =
      event.variableCostTotal != null
        ? Number(event.variableCostTotal)
        : event.variableCostEstimatedTotal != null
          ? Number(event.variableCostEstimatedTotal)
          : 0;
    const hasVariableCost = !!event.variableCostEnabled && varTotal > 0;

    if (hasVariableCost) {
      const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({ data: { eventId: event.id, memberId: member.id, status } });

      // Estimated per-head is only known up front in ESTIMATED mode; OFFICIAL
      // splits the real total across actual signups at bill time.
      let perHead: number | null = null;
      if (
        event.variableCostMode === "ESTIMATED" &&
        event.variableCostEstimatedSignups &&
        event.variableCostEstimatedSignups > 0
      ) {
        perHead = +(varTotal / event.variableCostEstimatedSignups).toFixed(2);
      }

      // Mirror as an EventRegistration so mass-invoice can reach this member.
      const already = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId: member.id, status: { not: "CANCELED" } },
        select: { id: true },
      });
      if (!already) {
        await prisma.eventRegistration.create({
          data: {
            eventId: event.id,
            clubId: session.user.clubId,
            memberId: member.id,
            name: `${member.firstName} ${member.lastName}`.trim(),
            email: member.email ?? "",
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

    // Genuinely free — no fixed price AND no variable cost AND no membership gate.
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

    // Auto-detect: is this person an active member of the club? We do NOT
    // trust the client's pricingType for member vs non-member — the server
    // decides from real subscription state so a non-member can't pay the
    // member rate. The only client-driven choice is opting into DROP_IN
    // (single-session price), and only on multi-session events.
    const activeSubCount = await prisma.memberSubscription.count({
      where: { memberId: member.id, status: "active" },
    });
    const isActiveMember = activeSubCount > 0 || member.status === "ACTIVE";
    const isMultiSession = event.sessions.length > 1;

    const memberCents = event.memberPrice != null ? Math.round(Number(event.memberPrice) * 100) : null;
    const nonMemberCents =
      event.nonMemberPrice != null ? Math.round(Number(event.nonMemberPrice) * 100) : null;
    const dropInCents = event.dropInFee != null ? Math.round(Number(event.dropInFee) * 100) : null;

    let priceCents = 0;
    let priceLabel = "";

    if (pricingType === "DROP_IN") {
      // Drop-in = pay for a single session. Only valid on multi-session events.
      if (!isMultiSession) {
        return NextResponse.json(
          { error: "Drop-in pricing is only available for events with multiple sessions." },
          { status: 400 },
        );
      }
      if (dropInCents == null) {
        return NextResponse.json(
          { error: "This event doesn't offer a single-session drop-in price." },
          { status: 400 },
        );
      }
      priceCents = dropInCents;
      priceLabel = "Drop-in (single session)";
    } else if (isActiveMember) {
      // Active member → member price (full event). Fall back to non-member
      // price if the club only set one number.
      priceCents = memberCents ?? nonMemberCents ?? dropInCents ?? 0;
      priceLabel = memberCents != null ? "Member" : nonMemberCents != null ? "Non-member" : "Drop-in";
    } else {
      // Non-member → full event (non-member) price.
      priceCents = nonMemberCents ?? memberCents ?? dropInCents ?? 0;
      priceLabel =
        nonMemberCents != null ? "Non-member" : memberCents != null ? "Member" : "Drop-in";
    }

    if (priceCents <= 0) {
      return NextResponse.json({ error: "No price configured" }, { status: 400 });
    }

    const platformFee = calculatePlatformFee(priceCents, club.tier);
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
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
