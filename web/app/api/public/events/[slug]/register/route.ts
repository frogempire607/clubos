import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  formResponses: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
});

// POST /api/public/events/[slug]/register
// NO AUTH. Creates an EventRegistration. If a price applies (non-member price
// or ESTIMATED variable cost), returns a Stripe Checkout URL on the club's
// connected account. Otherwise the registration is immediately confirmed.
export async function POST(req: Request, context: { params: Promise<{ slug: string }> }) {
  const params = await context.params;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const event = await prisma.event.findUnique({
    where: { publicSlug: params.slug },
    include: { club: true, _count: { select: { registrations: true, bookings: true } } },
  });
  if (!event || event.deletedAt) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  if (!event.publicRegistration && event.tournamentMode !== "HOST") {
    return NextResponse.json({ error: "Public registration is not enabled for this event" }, { status: 403 });
  }

  const now = new Date();
  if (event.publishAt && event.publishAt > now) {
    return NextResponse.json({ error: "Registration is not open yet" }, { status: 403 });
  }
  if (event.unpublishAt && event.unpublishAt < now) {
    return NextResponse.json({ error: "Registration has closed" }, { status: 403 });
  }
  if (event.registrationDeadline && event.registrationDeadline < now) {
    return NextResponse.json({ error: "The registration deadline has passed" }, { status: 403 });
  }
  if (
    event.capacity != null &&
    event._count.registrations + event._count.bookings >= event.capacity
  ) {
    return NextResponse.json({ error: "This event is full" }, { status: 409 });
  }

  // Validate required custom-form fields.
  const form = (event.registrationForm as Array<{ id: string; label: string; required: boolean }> | null) ?? [];
  for (const f of form) {
    if (f.required) {
      const v = body.formResponses[f.id];
      if (v === undefined || v === "" || v === false) {
        return NextResponse.json({ error: `"${f.label}" is required` }, { status: 400 });
      }
    }
  }

  // Try to match an existing member by email (so it shows on their account).
  const member = await prisma.member.findFirst({
    where: { clubId: event.clubId, email: body.email.toLowerCase(), deletedAt: null },
    select: { id: true },
  });

  // Variable-cost events (any mode) do NOT charge at registration. The
  // registrant signs up now; the owner sends invoices/payment links when
  // ready (estimated split before the event, official split after).
  const varTotal =
    event.variableCostTotal != null
      ? Number(event.variableCostTotal)
      : event.variableCostEstimatedTotal != null
        ? Number(event.variableCostEstimatedTotal)
        : 0;
  const isVariableCost = !!event.variableCostEnabled && varTotal > 0;

  // Estimated per-head, shown to the registrant as their expected share.
  let estimatedShare: number | null = null;
  if (
    isVariableCost &&
    event.variableCostMode !== "OFFICIAL" &&
    event.variableCostEstimatedSignups &&
    event.variableCostEstimatedSignups > 0
  ) {
    estimatedShare = +(varTotal / event.variableCostEstimatedSignups).toFixed(2);
  }

  // Immediate (charge-now) amount only applies to non-variable fixed pricing.
  // The owner picks WHICH price the public link charges via
  // event.publicPricingOption — null/missing falls back to nonMemberPrice.
  let amountDue = 0;
  if (!isVariableCost) {
    const opt = (event as { publicPricingOption?: string | null }).publicPricingOption;
    const chosen =
      opt === "MEMBER" ? event.memberPrice
      : opt === "DROP_IN" ? event.dropInFee
      : event.nonMemberPrice;
    if (chosen && Number(chosen) > 0) amountDue = Number(chosen);
  }

  const registration = await prisma.eventRegistration.create({
    data: {
      eventId: event.id,
      clubId: event.clubId,
      memberId: member?.id ?? null,
      name: body.name,
      email: body.email.toLowerCase(),
      phone: body.phone || null,
      formResponses: body.formResponses,
      status: "REGISTERED",
      amountDue: isVariableCost ? estimatedShare : amountDue > 0 ? amountDue : null,
    },
  });

  // Variable cost — registered now, billed later by the owner.
  if (isVariableCost) {
    return NextResponse.json({
      ok: true,
      registrationId: registration.id,
      variableCost: true,
      billedLater: true,
      estimatedShare,
      message:
        estimatedShare != null
          ? `You're registered. Your estimated share is about $${estimatedShare.toFixed(2)} — the club will email you a payment link.`
          : "You're registered. The club will email you a payment link for this event's shared cost.",
    });
  }

  // Free registration — done.
  if (amountDue <= 0) {
    return NextResponse.json({ ok: true, free: true, registrationId: registration.id });
  }

  // Paid — needs Stripe Connect on the club.
  if (!event.club.stripeAccountId || !event.club.stripeChargesEnabled) {
    // Keep the registration but flag that payment can't be collected online.
    return NextResponse.json({
      ok: true,
      registrationId: registration.id,
      paymentPending: true,
      message: "You're registered. The club will contact you about payment.",
    });
  }

  const amountCents = Math.round(amountDue * 100);
  const platformFee = calculatePlatformFee(amountCents, event.club.tier);
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  const feeItem = processingFeeLineItem(amountCents, event.club.passProcessingFees);

  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer_email: body.email.toLowerCase(),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: event.name,
              description: event.isTournament ? "Tournament registration" : "Event registration",
            },
          },
        },
        ...(feeItem ? [feeItem] : []),
      ],
      success_url: `${baseUrl}/e/${event.publicSlug}?registered=true`,
      cancel_url: `${baseUrl}/e/${event.publicSlug}?canceled=true`,
      payment_intent_data: {
        application_fee_amount: platformFee,
        metadata: {
          eventRegistrationId: registration.id,
          eventId: event.id,
          clubId: event.clubId,
        },
      },
      metadata: {
        eventRegistrationId: registration.id,
        eventId: event.id,
        clubId: event.clubId,
      },
    },
    { stripeAccount: event.club.stripeAccountId }
  );

  await prisma.eventRegistration.update({
    where: { id: registration.id },
    data: { stripeCheckoutSessionId: checkout.id },
  });

  return NextResponse.json({ ok: true, url: checkout.url, registrationId: registration.id });
}
