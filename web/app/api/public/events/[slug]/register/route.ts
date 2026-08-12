import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { registrationListPrice } from "@/lib/eventRepricing";
import { findValidDiscountFor, recordDiscountUse, type ValidDiscount } from "@/lib/discounts";
import { registrationDiscountFields, discountLineLabel } from "@/lib/eventDiscounts";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import {
  eventAllowedPaymentMethods,
  offlineStatusForMethod,
  capacityWhere,
  resolveEventPolicy,
  EVENT_PAYMENT_METHOD_LABELS,
} from "@/lib/eventPayments";
import { confirmationCodeFor } from "@/lib/confirmationCode";
import { sendRegistrationLifecycleEmail } from "@/lib/eventLifecycleEmails";
import { createEventOfflinePendingTx } from "@/lib/eventOfflinePayments";
import { documentsForEvent } from "@/lib/eventDocuments";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  formResponses: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  // The registrant's payment decision. AUTO_CARD is never offered publicly
  // (it needs an authenticated member with a saved card).
  paymentMethod: z.enum(["CARD", "CASH", "CHECK"]).optional(),
  // Optional discount code (EVENT scope, narrowed to this event). Re-resolved
  // here against the server-derived price — whatever the page previewed is
  // never trusted. An invalid code is a hard 400, never silently dropped.
  discountCode: z.string().max(50).optional().nullable(),
  // Ticked when the event has ACKNOWLEDGE/SIGN-level documents. Anonymous
  // visitors can't produce an audited signature, so acknowledgement (stored on
  // the registration) is the strongest gate available here.
  acknowledgeDocuments: z.boolean().optional(),
});

// POST /api/public/events/[slug]/register
// NO AUTH. Creates an EventRegistration. When money is owed the registrant
// must choose a payment method the owner allows for this event:
//   CARD        → PENDING_PAYMENT + Stripe Checkout URL; the webhook completes
//                 it (PAID + Transaction + receipt). It holds its spot only
//                 while the checkout is live (CHECKOUT_HOLD_MS) — abandoned,
//                 it owes nothing and releases the spot.
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
      // Phase 5 §5.3.1 — the type's defaultPolicy is half of what
      // resolveEventPolicy walks; without it every event reads as opted out.
      customEventType: { select: { defaultPolicy: true } },
      // Spot-holding registrations only: real ones, plus card checkouts still
      // inside their hold window (capacityWhere). A checkout abandoned an hour
      // ago releases its spot; one started a minute ago keeps it.
      _count: {
        select: {
          registrations: { where: capacityWhere() },
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
  const policy = resolveEventPolicy(event);

  // The count in the query above used the default capacity rule (a
  // PENDING_REVIEW row holds nothing). An owner who turned holdSpotDuringReview
  // ON means those rows DO hold a spot, and the flag isn't known until the
  // event is loaded — so re-count for exactly those events rather than making
  // every public page pay for a second query.
  let spotsTaken = event._count.registrations + event._count.bookings;
  if (event.capacity != null && policy.holdSpotDuringReview) {
    spotsTaken =
      (await prisma.eventRegistration.count({
        where: { eventId: event.id, ...capacityWhere(now, { holdSpotDuringReview: true }) },
      })) + event._count.bookings;
  }
  if (event.capacity != null && spotsTaken >= event.capacity) {
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

  // Event documents: anything above INFO requires an explicit acknowledgement
  // tick before the registration is accepted.
  const eventDocs = await documentsForEvent(event.clubId, event.id);
  const gatedDocs = eventDocs.filter((d) => d.requirement !== "INFO");
  if (gatedDocs.length > 0 && !body.acknowledgeDocuments) {
    return NextResponse.json(
      {
        error: "DOCUMENTS_ACKNOWLEDGE_REQUIRED",
        documents: gatedDocs.map((d) => ({ id: d.id, title: d.title })),
        message: `Please review and acknowledge: ${gatedDocs.map((d) => d.title).join(", ")}.`,
      },
      { status: 400 },
    );
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

  // Optional discount code. Resolved against the SERVER's price, scoped to
  // this event, before the payment decision and before Stripe sees a number.
  // A bad code blocks the registration rather than quietly charging full
  // price — the visitor typed it because they were told it applies.
  let discount: ValidDiscount | null = null;
  if (body.discountCode?.trim()) {
    const check = await findValidDiscountFor(event.clubId, body.discountCode, {
      type: "EVENT",
      eventId: event.id,
    });
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    discount = check.discount;
  }

  // Immediate (charge-now) amount only applies to non-variable fixed pricing.
  // NET of the discount — every downstream number (the processing fee, the
  // Stripe line item, the cash amount, the roster) derives from this.
  // Through the shared resolver, not publicFixedPrice: an event priced for
  // members only is not a free event, and quoting a walk-in $0 on it is how a
  // registration reached a coach with nothing to charge (2026-08-12). A matched
  // member gets the member rate; everyone else the non-member one, with either
  // falling through to whatever price the owner actually set.
  const grossDue = isVariableCost ? 0 : registrationListPrice(event, { memberId: member?.id ?? null });
  const discountFields = registrationDiscountFields(discount, grossDue);
  const amountDue = isVariableCost ? 0 : discountFields.amountDue;

  // Payment decision. Money owed ⇒ the registrant must pick a method the owner
  // allows (AUTO_CARD is member-only, so it's never selectable here). Cash and
  // check can't be collected without Stripe, but card can't be collected
  // WITHOUT it — so a club with no Connect account only gets offline methods.
  const stripeReady = !!event.club.stripeAccountId && !!event.club.stripeChargesEnabled;
  const allowed = eventAllowedPaymentMethods(event).filter((m) => m !== "AUTO_CARD");
  const selectable = allowed.filter((m) => m !== "CARD" || stripeReady);
  // Phase 5 §5.12 item 7: APPROVAL_CHARGE needs a saved card, a saved card
  // needs an account, and this route is anonymous — so it is never offered
  // here, exactly like AUTO_CARD. An approval-gated public event whose policy
  // is INVOICE collects no money now and bills on approval instead.
  // Two intents collect nothing at registration time on this path:
  //   INVOICE        — by configuration;
  //   APPROVAL_CHARGE— by impossibility. It charges a saved card, a saved card
  //                    needs an account, and this route is anonymous (§5.12
  //                    item 7). §5.4.5 says it falls back rather than being
  //                    offered, and invoicing on approval IS that fallback.
  //                    Without this the row was written with no payment method
  //                    at all, so approving it confirmed a spot and collected
  //                    nothing.
  const billOnApproval =
    policy.requiresCoachApproval &&
    (policy.approvalPaymentIntent === "INVOICE" || policy.approvalPaymentIntent === "APPROVAL_CHARGE");
  const needsDecision = !isVariableCost && amountDue > 0 && !billOnApproval;

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
      formResponses: {
        ...body.formResponses,
        ...(gatedDocs.length > 0
          ? { __documentsAcknowledged: `${new Date().toISOString()} — ${gatedDocs.map((d) => d.title).join("; ")}` }
          : {}),
      },
      // A card registration isn't complete until Stripe confirms it. When the
      // coach has to approve first, nothing else is complete either: the row
      // is a REQUEST (PENDING_REVIEW) rather than a spot, and no Booking
      // exists for it until the approve route creates one (§5.4.5).
      status: method === "CARD"
        ? "PENDING_PAYMENT"
        : method
          ? // Cash and check keep their own status even under approval: the
            // money is genuinely owed at the door either way, and
            // approvalStatus below is what gates the spot. The render context
            // reads approvalStatus FIRST, so the registrant still sees
            // "Registration requested", not "You're registered".
            offlineStatusForMethod(method)
          : policy.requiresCoachApproval
            ? "PENDING_REVIEW"
            : "REGISTERED",
      paymentMethod: method ?? (billOnApproval ? "INVOICE" : null),
      // null means "coach approval was never part of this event's contract" —
      // never write PENDING on an event that doesn't require it.
      approvalStatus: policy.requiresCoachApproval ? "PENDING" : null,
      approvalRequestedAt: policy.requiresCoachApproval ? new Date() : null,
      amountDue: isVariableCost ? estimatedShare : amountDue > 0 ? amountDue : null,
      // The rule, not just the result. On a variable-cost event amountDue is
      // only an estimate, but the code still binds — bill-registrants applies
      // it to the real split when the invoice goes out.
      discountId: discountFields.discountId,
      discountCode: discountFields.discountCode,
      discountType: discountFields.discountType,
      discountValue: discountFields.discountValue,
      discountAmount: isVariableCost ? null : discountFields.discountAmount,
    },
  });

  // The registration number the visitor will quote back to staff. Derived from
  // the row id, so it is the same value on the page, in the email, and in any
  // later backfill — see lib/confirmationCode.
  await prisma.eventRegistration
    .update({ where: { id: registration.id }, data: { confirmationCode: confirmationCodeFor(registration.id) } })
    .catch(async () => {
      // Astronomically unlikely, but the partial unique index is what makes it
      // an error rather than a duplicate: salt and try once more.
      await prisma.eventRegistration
        .update({
          where: { id: registration.id },
          data: { confirmationCode: confirmationCodeFor(registration.id, 1) },
        })
        .catch(() => undefined);
    });

  // Redemption counts once, here, for every public path below (free, offline,
  // and card). The card branch counts at checkout creation rather than on
  // webhook confirmation, matching how the member and staff paths already
  // behave — an abandoned checkout burns a use, which is the existing
  // trade-off across the whole engine, not something new here.
  if (discount) await recordDiscountUse(discount.id);

  // ── Awaiting coach review (§5.4.5) ──────────────────────────────────────
  // Everything that isn't a card checkout or an at-the-door payment stops
  // here: no Stripe session, no Booking, no money. The coach decides, and the
  // approve route takes it from there (charging, invoicing, or nothing).
  if (policy.requiresCoachApproval && method !== "CARD" && method !== "CASH" && method !== "CHECK") {
    await sendRegistrationLifecycleEmail({ registrationId: registration.id, transition: "CONFIRMATION" });
    return NextResponse.json({
      ok: true,
      registrationId: registration.id,
      pendingReview: true,
      awaitingApproval: true,
      amountDue: billOnApproval ? amountDue : null,
      message: billOnApproval
        ? `Request received — nothing is charged yet. Your coach reviews it first, and the club will email a payment link for $${amountDue.toFixed(2)} once they approve.`
        : "Request received — your coach reviews it and you'll be notified as soon as they do. No money moves until then.",
    });
  }

  // Variable cost — registered now, billed later by the owner.
  if (isVariableCost) {
    await sendRegistrationLifecycleEmail({ registrationId: registration.id, transition: "CONFIRMATION" });
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

  // Free registration — done. A 100%-off code lands here too: the spot is
  // confirmed outright rather than sent to a $0 Stripe checkout (Stripe
  // refuses charges under $0.50 anyway). Same shape as the member path.
  if (amountDue <= 0) {
    // The success page has always told this visitor "a confirmation has been
    // sent to <email>". Until now nothing was sent — the route returned first
    // (ARCHITECTURE-NOTES §2.1 Phase 5, bug 1). One dedupe-keyed send makes the
    // sentence true; a replay of this POST is a no-op at the ledger.
    await sendRegistrationLifecycleEmail({ registrationId: registration.id, transition: "CONFIRMATION" });
    return NextResponse.json({
      ok: true,
      free: true,
      registrationId: registration.id,
      ...(discount ? { discountCode: discount.code, discountOff: discountFields.discountAmount } : {}),
      ...(discount && grossDue > 0
        ? { message: `You're registered — ${discountLineLabel(discount)} covered the full $${grossDue.toFixed(2)}.` }
        : {}),
    });
  }

  // Cash / check — the spot is confirmed now; the money is recorded as due.
  // Acceptance is NOT payment: one PENDING offline Transaction, no receipt.
  if (method === "CASH" || method === "CHECK") {
    const tx = await createEventOfflinePendingTx({
      clubId: event.clubId,
      eventId: event.id,
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
    await sendRegistrationLifecycleEmail({ registrationId: registration.id, transition: "CONFIRMATION" });
    return NextResponse.json({
      ok: true,
      registrationId: registration.id,
      offline: true,
      ...(policy.requiresCoachApproval ? { pendingReview: true, awaitingApproval: true } : {}),
      paymentMethod: method,
      amountDue,
      ...(discount ? { discountCode: discount.code, discountOff: discountFields.discountAmount } : {}),
      // The amount named here is the discounted one, and it's the same figure
      // the PENDING Transaction carries and the roster shows staff at the door.
      // Under coach approval the spot isn't theirs yet, so the copy must not
      // say it is — the whole point of the shared render context is that no
      // surface promises a state the row isn't in.
      message: `${
        policy.requiresCoachApproval
          ? "Request received — your coach reviews it first. If they approve, please bring"
          : "You're registered. Please bring"
      } $${amountDue.toFixed(2)} in ${method.toLowerCase()} to the event.${
        discount ? ` (${discountLineLabel(discount)} applied — $${(discountFields.discountAmount ?? 0).toFixed(2)} off.)` : ""
      }`,
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

  // amountDue is already NET, so the platform fee and the passed-through
  // processing fee are both computed on the discounted amount — never on the
  // list price.
  const amountCents = Math.round(amountDue * 100);
  const platformFee = calculatePlatformFee(amountCents, event.club.tier);
  const baseUrl = getAppBaseUrl();
  const feeItem = processingFeeLineItem(amountCents, event.club.passProcessingFees);
  const discountMetadata: Record<string, string> = discount
    ? { discountCode: discount.code, discountAmount: String(discountFields.discountAmount ?? 0) }
    : {};

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
              // The payer sees the code on the Stripe page, so the reduced
              // number is explained rather than looking like a wrong price.
              description: `${event.isTournament ? "Tournament registration" : "Event registration"}${
                discount ? ` · ${discountLineLabel(discount)} — $${(discountFields.discountAmount ?? 0).toFixed(2)} off` : ""
              }`,
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
          ...discountMetadata,
        },
      },
      // The webhook stamps discountCode/discountAmount from session metadata
      // onto the Transaction, so the receipt and Financials say which code
      // applied without re-reading the registration.
      metadata: {
        eventRegistrationId: registration.id,
        eventId: event.id,
        clubId: event.clubId,
        ...discountMetadata,
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
