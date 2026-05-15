import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";

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

  // Compute amount due.
  let amountDue = 0;
  if (
    event.variableCostEnabled &&
    event.variableCostMode === "ESTIMATED" &&
    event.variableCostTotal &&
    event.variableCostEstimatedSignups
  ) {
    amountDue = +(Number(event.variableCostTotal) / event.variableCostEstimatedSignups).toFixed(2);
  } else if (event.nonMemberPrice && Number(event.nonMemberPrice) > 0) {
    amountDue = Number(event.nonMemberPrice);
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
      status: amountDue > 0 ? "REGISTERED" : "REGISTERED",
      amountDue: amountDue > 0 ? amountDue : null,
    },
  });

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
