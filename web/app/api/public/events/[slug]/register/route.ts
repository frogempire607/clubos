import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { publicFixedPrice } from "@/lib/eventPricing";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import {
  eventAllowedPaymentMethods,
  offlineStatusForMethod,
  createEventOfflinePendingTx,
  EVENT_PAYMENT_METHOD_LABELS,
} from "@/lib/eventPayments";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  formResponses: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  // The registrant's payment decision. AUTO_CARD is never offered publicly
  // (it needs an authenticated member with a saved card).
  paymentMethod: z.enum(["CARD", "CASH", "CHECK"]).optional(),
});

// POST /api/public/events/[slug]/register
// NO AUTH. Creates an EventRegistration. When money is owed the registrant
// must choose a payment method the owner allows for this event:
//   CARD        → PENDING_PAYMENT + Stripe Checkout URL; the webhook completes
//                 it (PAID + Transaction + receipt). An abandoned checkout
//                 stays PENDING_PAYMENT and never holds a spot.
//   CASH/CHECK  → confirmed as AWAITING_CASH/AWAITING_CHECK with a PENDING
//                 offline Transaction (the amount due — never revenue). Staff
//                 records receipt at/ before the event.
// Free + variable-cost (billed later) registrations need no decision.
export async function POST(req: Request, context: { params: Promise<{ slug: string }> }) {
  // 10 public registrations per 10 minutes per IP. Public event pages
  // are unauthenticated — without a per-IP limit, a script can fill
  // every event's registration table.
  const rl = rateLimit({ key: `book:public:${ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many registration attempts. Try again in a few minutes.");

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
    include: {
      club: true,
      // Abandoned card checkouts + cancellations don't consume capacity.
      _count: {
        select: {
          registrations: { where: { status: { notIn: ["CANCELED", "PENDING_PAYMENT"] } } },
          bookings: { where: { status: { notIn: ["CANCELED"] } } },
        },
      },
    },
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
  const amountDue = isVariableCost ? 0 : publicFixedPrice(event);

  // Payment decision. Money owed ⇒ the registrant must pick a method the owner
  // allows (AUTO_CARD is member-only, so it's never selectable here). Cash and
  // check can't be collected without Stripe, but card can't be collected
  // WITHOUT it — so a club with no Connect account only gets offline methods.
  const stripeReady = !!event.club.stripeAccountId && !!event.club.stripeChargesEnabled;
  const allowed = eventAllowedPaymentMethods(event).filter((m) => m !== "AUTO_CARD");
  const selectable = allowed.filter((m) => m !== "CARD" || stripeReady);
  const needsDecision = !isVariableCost && amountDue > 0;

  let method: "CARD" | "CASH" | "CHECK" | null = null;
  if (needsDecision) {
    if (selectable.length === 0) {
      // Owner allows only card but hasn't connected Stripe — don't strand the
      // registrant in a half-state; tell them to contact the club.
      return NextResponse.json(
        { error: "Online payment isn't set up for this event yet. Please contact the club." },
        { status: 503 },
      );
    }
    const chosen = body.paymentMethod ?? (selectable.length === 1 ? selectable[0] : null);
    if (!chosen) {
      return NextResponse.json(
        { error: "PAYMENT_METHOD_REQUIRED", message: "Choose how you'd like to pay." },
        { status: 400 },
      );
    }
    if (!selectable.includes(chosen)) {
      return NextResponse.json(
        {
          error: "PAYMENT_METHOD_NOT_ALLOWED",
          message: `${EVENT_PAYMENT_METHOD_LABELS[chosen]} isn't available for this event.`,
        },
        { status: 400 },
      );
    }
    method = chosen;
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
      // A card registration isn't complete until Stripe confirms it.
      status: method === "CARD" ? "PENDING_PAYMENT" : method ? offlineStatusForMethod(method) : "REGISTERED",
      paymentMethod: method,
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

  // Cash / check — the spot is confirmed now; the money is recorded as due.
  // Acceptance is NOT payment: one PENDING offline Transaction, no receipt.
  if (method === "CASH" || method === "CHECK") {
    const tx = await createEventOfflinePendingTx({
      clubId: event.clubId,
      memberId: member?.id ?? null,
      amount: amountDue,
      method,
      eventName: event.name,
      registrantName: body.name,
    });
    await prisma.eventRegistration.update({
      where: { id: registration.id },
      data: { transactionId: tx.id },
    });
    return NextResponse.json({
      ok: true,
      registrationId: registration.id,
      offline: true,
      paymentMethod: method,
      amountDue,
      message: `You're registered. Please bring $${amountDue.toFixed(2)} in ${method.toLowerCase()} to the event.`,
    });
  }

  // CARD — only reachable when Stripe is connected (guarded by `selectable`);
  // this re-check also narrows the account id for the SDK call.
  if (!event.club.stripeAccountId) {
    return NextResponse.json(
      { error: "Online payment isn't set up for this event yet. Please contact the club." },
      { status: 503 },
    );
  }

  const amountCents = Math.round(amountDue * 100);
  const platformFee = calculatePlatformFee(amountCents, event.club.tier);
  const baseUrl = getAppBaseUrl();
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
