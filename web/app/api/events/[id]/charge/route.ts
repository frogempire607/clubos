import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendBookingConfirmationEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { resolveStaffDiscount, quotePayment, discountAppliedLabel } from "@/lib/staffPayments";
import { recordDiscountUse } from "@/lib/discounts";
import { settleEventRegistrationOffline } from "@/lib/eventOfflinePayments";
import { eventAllowedPaymentMethods } from "@/lib/eventPayments";
import { quoteSessions } from "@/lib/eventPricingModel";
import { staffMethodAllowed } from "@/lib/eventAttendeeActions";

const schema = z.object({
  memberId: z.string(),
  pricingType: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).optional(),
  // Optional staff-selected discount code (itemType EVENT). Validated
  // server-side against the server-derived price; invalid = 400 BLOCK.
  discountCode: z.string().optional().nullable(),
  // STRIPE  -> existing online checkout link (default)
  // CASH    -> owner took cash at the door
  // TERMINAL-> owner ran the card on an in-person card reader / terminal
  // CASH and TERMINAL confirm the booking and log a manual transaction in
  // Financials WITHOUT creating a Stripe charge (reuses the manual-payment path).
  //
  // B11 slice 3 (the Attendees screen's "+ Add attendee"):
  // CHECK   -> a check handed over now; the same settle path as CASH.
  // INVOICE -> register them owing the quoted price, nothing charged. The
  //            payment link then goes out through bill-registrants (review
  //            first), the same path every other unpaid registrant uses.
  // Every method must be one the EVENT allows (Event.paymentMethods): staff
  // can't pick a way to pay that contradicts the event's own settings.
  paymentMethod: z.enum(["STRIPE", "CASH", "TERMINAL", "CHECK", "INVOICE"]).optional().default("STRIPE"),
  // Check number / note for CHECK.
  reference: z.string().max(120).optional().nullable(),
  // DROP_IN + sessionIds = a per-session purchase priced by
  // lib/eventPricingModel.quoteSessions (the member register route's rule).
  sessionIds: z.array(z.string().min(1)).max(50).optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Owner-side at-the-door charge. Members must use the member-facing
  // registration flow which enforces parent controls and tier eligibility.
  // §6A.8 — at-the-door charging is a COACH workflow (owner ruling 2026-09-08):
  // whoever checks people in takes the drop-in. Gated on attendance, not
  // billing, so a coach running the door is not blocked. Live-checked because
  // it moves money — a revoked permission must bite without a re-login.
  const denied = await requirePermissionLive(session, "attendance", "full");
  if (denied) return denied;

  try {
    const body = await req.json();
    const { memberId, pricingType = "MEMBER", paymentMethod = "STRIPE", discountCode, reference, sessionIds } = schema.parse(body);

    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
    });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

    // Resolve the discount up front — an invalid code blocks the request even
    // if the flow later turns out to be membership-covered / variable-cost.
    const discountCheck = await resolveStaffDiscount(club.id, discountCode, {
      type: "EVENT",
      eventId: params.id,
    });
    if (!discountCheck.ok) return NextResponse.json({ error: discountCheck.error }, { status: 400 });
    const discount = discountCheck.discount;
    // Stripe is only required for the online-checkout path. Cash/terminal
    // bookings are recorded manually and never touch Stripe, so a club that
    // hasn't connected Stripe can still take an at-the-door payment.
    if (paymentMethod === "STRIPE" && (!club.stripeAccountId || !club.stripeChargesEnabled)) {
      return NextResponse.json({ error: "Connect Stripe first" }, { status: 400 });
    }

    const event = await prisma.event.findFirst({
      where: { id: params.id, clubId: club.id, deletedAt: null },
      include: {
        _count: { select: { bookings: true } },
        sessions: { select: { id: true, price: true, startsAt: true }, orderBy: { sortOrder: "asc" } },
      },
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

    // Paying by — only what the event allows (checked after the covered and
    // split branches above, which collect nothing and ask no payment question).
    if (!staffMethodAllowed(paymentMethod, eventAllowedPaymentMethods(event))) {
      return NextResponse.json(
        { error: "This event doesn't take that way of paying. Change the event's payment options first." },
        { status: 400 },
      );
    }

    let priceCents: number;
    let priceLabel: string;
    let purchasedSessionIds: string[] = [];
    if (pricingType === "DROP_IN" && sessionIds && sessionIds.length > 0) {
      const sq = quoteSessions({
        pricingModel: (event.pricingModel as "FREE" | "FIXED" | "SPLIT") ?? "FIXED",
        sellIndividualSessions: !!event.sellIndividualSessions,
        sessions: event.sessions,
        requestedIds: sessionIds,
      });
      if (!sq.ok) return NextResponse.json({ error: sq.error }, { status: 400 });
      priceCents = sq.cents;
      priceLabel = sq.label;
      purchasedSessionIds = sq.sessionIds;
    } else if (pricingType === "DROP_IN" && event.dropInFee) {
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

    // Discount applies to the SERVER-derived price. Card checkout computes its
    // fee on the discounted price; cash/terminal records take no fee.
    const quoted = quotePayment({
      originalPrice: priceCents / 100,
      discount,
      method: paymentMethod === "STRIPE" ? "NEW_CARD" : "CASH",
      passProcessingFees: paymentMethod === "STRIPE" ? club.passProcessingFees : false,
    });
    if (!quoted.ok) return NextResponse.json({ error: quoted.error }, { status: 400 });
    const quote = quoted.quote;
    const discountLabel = discountAppliedLabel(discount);

    // ── Cash / in-person terminal at the door ────────────────────────────────
    // Event money is recorded against a REGISTRATION, never as a free-floating
    // Transaction. This branch used to create a Booking plus its own SUCCEEDED
    // Transaction that no registration knew about, so the registration still
    // read "owes" and the only way to mark someone paid was to remove and
    // re-add their booking — minting a duplicate Transaction every cycle
    // (Frog Empire Road Trip: four $450 rows for two athletes, both still
    // unpaid on paper). Now it ensures a registration exists and settles it
    // through the ONE shared offline path, which also tags paymentSource and
    // reconciliationStatus correctly — a card-reader swipe is
    // EXTERNAL_READER/UNVERIFIED and must never blend into verified card
    // revenue.
    if (paymentMethod === "CASH" || paymentMethod === "TERMINAL" || paymentMethod === "CHECK") {
      const existing = await prisma.booking.findUnique({
        where: { eventId_memberId: { eventId: event.id, memberId } },
      });
      if (existing) return NextResponse.json({ error: "Already booked" }, { status: 409 });

      const status =
        event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      const amount = quote.finalPrice;

      // Find or create the registration this money belongs to. A member who
      // was already registered (and owes) settles that row rather than
      // spawning a second one.
      let reg = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId, status: { not: "CANCELED" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true },
      });
      if (reg?.status === "PAID") {
        return NextResponse.json(
          { error: "This member's registration is already paid — resend their receipt instead." },
          { status: 409 },
        );
      }
      // The discount RULE goes on the registration, not just the Transaction —
      // the roster, a later reprice, and any re-invoice all read it from here.
      const regDiscount = {
        discountId: discount?.id ?? null,
        discountCode: discount?.code ?? null,
        discountType: discount?.type ?? null,
        discountValue: discount?.value ?? null,
        discountAmount: discount ? quote.discountAmount : null,
      };
      if (!reg) {
        reg = await prisma.eventRegistration.create({
          data: {
            eventId: event.id,
            clubId: club.id,
            memberId,
            name: `${member.firstName} ${member.lastName}`.trim(),
            email: member.email ?? member.guardianEmail ?? "",
            status: "REGISTERED",
            amountDue: amount,
            sessionIds: purchasedSessionIds,
            ...regDiscount,
          },
          select: { id: true, status: true },
        });
      } else {
        // Settle at the price quoted at the door (discount included). Staff
        // applying a code to an existing registration replaces whatever was
        // there — one discount per registration, never two stacked.
        await prisma.eventRegistration.update({
          where: { id: reg.id },
          data: {
            amountDue: amount,
            ...(purchasedSessionIds.length > 0 ? { sessionIds: purchasedSessionIds } : {}),
            ...regDiscount,
          },
        });
      }

      const settled = await settleEventRegistrationOffline({
        clubId: club.id,
        registrationId: reg.id,
        method: paymentMethod,
        reference: paymentMethod === "CHECK" ? reference ?? null : null,
        actorUserId: session.user.id ?? null,
        // The receipt from the settle path is the payment receipt; the booking
        // confirmation below carries the event details.
        skipReceipt: true,
      });
      if (!settled.ok) {
        return NextResponse.json({ error: settled.error }, { status: settled.status });
      }

      await prisma.booking.create({ data: { eventId: event.id, memberId, status } });

      // Discount identity lives on the settled Transaction so receipts and
      // reports still say which discount applied.
      if (discount) {
        await prisma.transaction.update({
          where: { id: settled.transactionId },
          data: {
            discountCode: discount.code,
            discountAmount: quote.discountAmount,
            description: `${event.name} — ${priceLabel} price (${paymentMethod === "CASH" ? "cash" : paymentMethod === "CHECK" ? "check" : "in-person terminal"})${discountLabel ? ` — ${discountLabel}` : ""}`,
          },
        });
        await recordDiscountUse(discount.id);
      }

      if (status === "CONFIRMED") {
        const to = member.isMinor
          ? member.guardianEmail || member.email
          : member.email || member.guardianEmail;
        if (to) {
          const baseUrl = getAppBaseUrl();
          sendBookingConfirmationEmail({
            to,
            firstName: member.firstName,
            clubName: club.name,
            eventName: event.name,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            amountPaid: amount.toFixed(2),
            portalUrl: `${baseUrl}/member/bookings`,
          }).catch((e) => console.error("Booking email failed:", e));
        }
      }

      return NextResponse.json({
        recordedManually: true,
        paymentMethod,
        status,
        amount,
        registrationId: reg.id,
        transactionId: settled.transactionId,
      });
    }

    // ── Card, paid later by emailed link (B11 slice 3) ──────────────────────
    // Roster and bill in one request: the registration owes the quoted price
    // (discount included) and the booking holds the spot. Nothing is charged
    // and no Transaction is written here — the link goes out through
    // bill-registrants, whose review step shows the exact amount first. Same
    // shape as the split-cost branch above, which also registers now and
    // bills later.
    if (paymentMethod === "INVOICE") {
      const existing = await prisma.booking.findUnique({
        where: { eventId_memberId: { eventId: event.id, memberId } },
      });
      if (existing) return NextResponse.json({ error: "Already booked" }, { status: 409 });
      const prior = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId, status: { not: "CANCELED" } },
        select: { id: true },
      });
      if (prior) {
        return NextResponse.json(
          { error: "They're already on this event's billing list — email their payment link from Attendees instead." },
          { status: 409 },
        );
      }
      if (quote.finalPrice <= 0) {
        return NextResponse.json(
          { error: "The discount brings the total to $0 — there's nothing to email a link for." },
          { status: 400 },
        );
      }
      const status =
        event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      const reg = await prisma.eventRegistration.create({
        data: {
          eventId: event.id,
          clubId: club.id,
          memberId,
          name: `${member.firstName} ${member.lastName}`.trim(),
          email: member.email ?? member.guardianEmail ?? "",
          status: "REGISTERED",
          amountDue: quote.finalPrice,
          sessionIds: purchasedSessionIds,
          discountId: discount?.id ?? null,
          discountCode: discount?.code ?? null,
          discountType: discount?.type ?? null,
          discountValue: discount?.value ?? null,
          discountAmount: discount ? quote.discountAmount : null,
        },
        select: { id: true },
      });
      await prisma.booking.create({ data: { eventId: event.id, memberId, status } });
      if (discount) await recordDiscountUse(discount.id);
      return NextResponse.json({
        billedLater: true,
        paymentMethod,
        status,
        amount: quote.finalPrice,
        registrationId: reg.id,
      });
    }

    if (quote.finalPrice <= 0) {
      return NextResponse.json(
        { error: "The discount brings the total to $0 — record it as a cash/comp booking instead of a card charge." },
        { status: 400 }
      );
    }
    const chargeCents = Math.round(quote.finalPrice * 100);
    const platformFee = calculatePlatformFee(chargeCents, club.tier);
    const baseUrl = getAppBaseUrl();
    const feeItem = processingFeeLineItem(chargeCents, club.passProcessingFees);

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: chargeCents,
              product_data: {
                name: `${event.name}${discount ? ` (${discount.code})` : ""}`,
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
            // Discount identity for the webhook's Transaction (pickup pending —
            // the webhook is a separate workstream and is not modified here).
            ...(discount
              ? { discountCode: discount.code, discountAmount: String(quote.discountAmount) }
              : {}),
          },
        },
        metadata: {
          memberId,
          eventId: event.id,
          eventName: event.name,
          clubId: club.id,
          ...(discount
            ? { discountCode: discount.code, discountAmount: String(quote.discountAmount) }
            : {}),
        },
      },
      // Non-null: the STRIPE path only reaches here after the top guard
      // confirmed stripeAccountId; cash/terminal returned earlier.
      { stripeAccount: club.stripeAccountId! }
    );
    if (discount) await recordDiscountUse(discount.id);

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Event charge error:", err);
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
