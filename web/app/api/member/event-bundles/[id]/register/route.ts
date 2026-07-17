import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem, applyProcessingFee } from "@/lib/fees";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { resolveChargeablePaymentMethodId, resolveCardSnapshot, prettyBrand } from "@/lib/memberCard";
import { offlineActivationPolicy } from "@/lib/staffPayments";
import {
  bundleAllowedPaymentMethods,
  bundleOfflineStatus,
  bookBundleEvents,
  chargeBundlePurchaseSavedCard,
} from "@/lib/bundlePurchases";
import { documentsForEvent, EVENT_DOC_REQUIREMENT_LABELS } from "@/lib/eventDocuments";

const schema = z.object({
  memberId: z.string().optional(),
  // The buyer's decision. SAVED_CARD = charge the saved card NOW (only offered
  // when CARD is allowed and a verified card exists); CARD = Stripe Checkout.
  paymentMethod: z.enum(["CARD", "SAVED_CARD", "CASH", "CHECK", "PAY_LATER"]).optional(),
});

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

// POST /api/member/event-bundles/[id]/register
// A bundle purchase requires a payment decision from the owner-enabled methods.
// Bookings (usable credits) are granted ONLY on payment — or at acceptance when
// the club's offlineActivationPolicy is ON_ACCEPTANCE. Cash/check/pay-later
// NEVER touch Stripe. Every method gets its own distinct status.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `book:bundle:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a moment.");

  try {
    const { memberId, paymentMethod } = schema.parse(await req.json().catch(() => ({})));

    // COPPA: block a guardian from registering a minor until consent is on file.
    if (memberId && (await guardianActionBlocked(session.user.id, memberId))) {
      return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
    }

    const bundle = await prisma.eventBundle.findFirst({
      where: { id, clubId: session.user.clubId, deletedAt: null, published: true },
      include: { items: { select: { eventId: true, event: { select: { name: true } } } } },
    });
    if (!bundle) return NextResponse.json({ error: "Bundle not available" }, { status: 404 });
    const eventIds = bundle.items.map((it) => it.eventId);
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

    const price = Number(bundle.price);
    const priceCents = Math.round(price * 100);

    // Free bundle → book everything immediately (no decision to make).
    if (priceCents <= 0) {
      await bookBundleEvents(eventIds, member.id);
      return NextResponse.json({ free: true, booked: eventIds.length });
    }

    // One LIVE purchase per member per bundle (partial unique index backs this
    // up at the DB level — duplicate clicks cannot double-purchase).
    const live = await prisma.eventBundlePurchase.findFirst({
      where: { bundleId: bundle.id, memberId: member.id, status: { notIn: ["CANCELED", "PAYMENT_FAILED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (live?.status === "PAID") {
      return NextResponse.json({ error: "You've already purchased this bundle." }, { status: 409 });
    }
    if (live && ["AWAITING_CASH", "AWAITING_CHECK", "PAY_LATER"].includes(live.status)) {
      return NextResponse.json(
        {
          error:
            live.status === "PAY_LATER"
              ? "You've already claimed this bundle — the club will invoice you."
              : `You've already claimed this bundle — bring $${Number(live.amountDue ?? price).toFixed(2)} ${live.status === "AWAITING_CASH" ? "in cash" : "by check"} to the club.`,
        },
        { status: 409 },
      );
    }

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });
    const stripeReady = !!club.stripeAccountId && !!club.stripeChargesEnabled;

    const allowed = bundleAllowedPaymentMethods(bundle);
    // Saved-card pay-now rides on CARD permission and a verified saved card.
    const customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId;
    const chargeablePm =
      allowed.includes("CARD") && stripeReady
        ? await resolveChargeablePaymentMethodId(customerId, club.stripeAccountId, member.stripeSetupPaymentMethodId)
        : null;
    const selectable: string[] = [
      ...(chargeablePm ? ["SAVED_CARD"] : []),
      ...allowed.filter((m) => (m === "CARD" ? stripeReady : true)),
    ];
    if (selectable.length === 0) {
      return NextResponse.json(
        { error: "Online payment isn't set up for this bundle yet. Please contact the club." },
        { status: 503 },
      );
    }

    type Chosen = "CARD" | "SAVED_CARD" | "CASH" | "CHECK" | "PAY_LATER";
    const chosen: Chosen | null = paymentMethod ?? (selectable.length === 1 ? (selectable[0] as Chosen) : null);
    if (!chosen) {
      // Card totals include the processing fee when the club passes it; cash,
      // check and pay-later owe the sticker price. Documents from the included
      // events are surfaced for review — hard enforcement stays at check-in.
      const fee = applyProcessingFee(priceCents, club.passProcessingFees);
      const card = chargeablePm
        ? await resolveCardSnapshot(customerId, club.stripeAccountId)
        : null;
      const docsByEvent = await Promise.all(
        bundle.items.map(async (it) => ({
          eventName: it.event.name,
          docs: await documentsForEvent(club.id, it.eventId),
        })),
      );
      const documents = docsByEvent.flatMap(({ eventName, docs }) =>
        docs.map((d) => ({
          id: d.id,
          title: d.title,
          requirement: d.requirement,
          requirementLabel: EVENT_DOC_REQUIREMENT_LABELS[d.requirement],
          eventName,
        })),
      );
      return NextResponse.json(
        {
          error: "PAYMENT_METHOD_REQUIRED",
          message: "Choose how you'd like to pay.",
          options: selectable,
          quote: {
            base: price,
            cardFee: fee.feeCents / 100,
            cardTotal: fee.totalCents / 100,
            offlineTotal: price,
          },
          savedCard: card ? { label: `${prettyBrand(card.brand)} ····${card.last4}` } : null,
          documents,
        },
        { status: 400 },
      );
    }
    if (!selectable.includes(chosen)) {
      return NextResponse.json(
        {
          error: "PAYMENT_METHOD_NOT_ALLOWED",
          message:
            chosen === "SAVED_CARD"
              ? "You don't have a saved card yet — add one in your profile, or choose another way to pay."
              : "That payment method isn't available for this bundle.",
        },
        { status: 400 },
      );
    }

    // ── Cash / check / pay-later: claim now, book on payment, NO Stripe ─────
    if (chosen === "CASH" || chosen === "CHECK" || chosen === "PAY_LATER") {
      const payLater = chosen === "PAY_LATER";
      let purchase;
      if (live?.status === "PENDING_PAYMENT") {
        // They started a card checkout earlier and are switching to an offline
        // method. Convert that row — creating would trip the live-unique index
        // and 409 them out of ever paying cash. (If the abandoned checkout is
        // somehow completed later, the webhook's settle claims the row and
        // voids this branch's PENDING offline Transaction — money stays right.)
        purchase = await prisma.eventBundlePurchase.update({
          where: { id: live.id },
          data: { status: bundleOfflineStatus(chosen), paymentMethod: chosen, amountDue: price },
        });
      } else {
        try {
          purchase = await prisma.eventBundlePurchase.create({
            data: {
              clubId: club.id,
              bundleId: bundle.id,
              memberId: member.id,
              status: bundleOfflineStatus(chosen),
              paymentMethod: chosen,
              amountDue: price,
            },
          });
        } catch {
          // Partial unique index fired — someone (or a double click) beat us.
          return NextResponse.json({ error: "You've already claimed this bundle." }, { status: 409 });
        }
      }
      const memberName = `${member.firstName} ${member.lastName ?? ""}`.trim();
      const tx = await prisma.transaction.create({
        data: {
          clubId: club.id,
          memberId: member.id,
          amount: price,
          status: "PENDING",
          type: "EVENT",
          category: "events",
          description: `Event bundle — ${bundle.name} — ${memberName}${payLater ? " (pay later — club invoices)" : ` (pay by ${chosen.toLowerCase()} at the club)`}`,
          paymentMethod: payLater ? "INVOICE" : chosen,
          paymentSource: payLater ? "MANUAL_ADJUSTMENT" : chosen,
          reconciliationStatus: "OFFLINE",
          manual: true,
        },
        select: { id: true },
      });
      await prisma.eventBundlePurchase.update({
        where: { id: purchase.id },
        data: { transactionId: tx.id },
      });

      // Existing owner setting: ON_ACCEPTANCE grants the bookings now with the
      // money still due; the default ON_PAYMENT waits for the receipt.
      const activateNow = offlineActivationPolicy(club) === "ON_ACCEPTANCE";
      if (activateNow) await bookBundleEvents(eventIds, member.id);

      return NextResponse.json({
        ok: true,
        offline: true,
        purchaseId: purchase.id,
        status: purchase.status,
        booked: activateNow ? eventIds.length : 0,
        message: payLater
          ? `You're in — the club will send you an invoice for $${price.toFixed(2)}.${activateNow ? " Your events are booked." : " Your events will be booked once it's paid."}`
          : `You're in — bring $${price.toFixed(2)} ${chosen === "CASH" ? "in cash" : "by check"} to the club.${activateNow ? " Your events are booked." : " Your events will be booked once payment is received."}`,
      });
    }

    // ── Saved card: charge NOW (explicit confirmation happened client-side
    // with the exact total on the button) ───────────────────────────────────
    if (chosen === "SAVED_CARD") {
      let purchase;
      try {
        purchase = await prisma.eventBundlePurchase.create({
          data: {
            clubId: club.id,
            bundleId: bundle.id,
            memberId: member.id,
            status: "PENDING_PAYMENT",
            paymentMethod: "SAVED_CARD",
            amountDue: price,
          },
        });
      } catch {
        // A live row exists — reuse it if it's an unfinished attempt.
        purchase = await prisma.eventBundlePurchase.findFirst({
          where: { bundleId: bundle.id, memberId: member.id, status: "PENDING_PAYMENT" },
          orderBy: { createdAt: "desc" },
        });
        if (!purchase) {
          return NextResponse.json({ error: "You've already claimed this bundle." }, { status: 409 });
        }
      }
      const result = await chargeBundlePurchaseSavedCard(purchase.id);
      if (!result.ok) {
        return NextResponse.json(
          { error: "CHARGE_FAILED", outcome: result.outcome, message: result.message },
          { status: result.outcome === "processing" ? 202 : 402 },
        );
      }
      return NextResponse.json({
        ok: true,
        paid: true,
        total: result.total,
        booked: eventIds.length,
        message: `Paid $${result.total.toFixed(2)} — you're booked into all ${eventIds.length} events.`,
      });
    }

    // ── New card: Stripe Checkout; webhook settles via bundlePurchaseId ─────
    let purchase =
      live?.status === "PENDING_PAYMENT"
        ? live
        : null;
    if (!purchase) {
      try {
        purchase = await prisma.eventBundlePurchase.create({
          data: {
            clubId: club.id,
            bundleId: bundle.id,
            memberId: member.id,
            status: "PENDING_PAYMENT",
            paymentMethod: "CARD",
            amountDue: price,
          },
        });
      } catch {
        purchase = await prisma.eventBundlePurchase.findFirst({
          where: { bundleId: bundle.id, memberId: member.id, status: "PENDING_PAYMENT" },
          orderBy: { createdAt: "desc" },
        });
        if (!purchase) {
          return NextResponse.json({ error: "You've already claimed this bundle." }, { status: 409 });
        }
      }
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
          metadata: { memberId: member.id, bundleId: bundle.id, clubId: club.id, bundlePurchaseId: purchase.id },
        },
        metadata: { memberId: member.id, bundleId: bundle.id, clubId: club.id, bundlePurchaseId: purchase.id },
      },
      { stripeAccount: club.stripeAccountId! },
    );
    await prisma.eventBundlePurchase.update({
      where: { id: purchase.id },
      data: { stripeCheckoutSessionId: checkout.id, paymentMethod: "CARD" },
    });
    return NextResponse.json({ url: checkout.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
