// B10 slice 3 — the database half of lib/productBooking: availability, making
// a booking (member portal, public link, front desk), the payment landing, and
// the staff actions. The only writer of product_bookings.

import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { normalizeProductSettings, isBookable, type ProductSettings } from "@/lib/productSettings";
import {
  DEFAULT_TZ,
  bookingQuote,
  checkAnswers,
  holdsSlot,
  lengthOptions,
  slotIsOpen,
  slotsForDay,
  statusAfterPayment,
  minsLabel,
  type Busy,
  type BookingQuote,
} from "@/lib/productBooking";
import { recordProductMoney } from "@/lib/productMoney";
import { writeBillingAudit } from "@/lib/billingAudit";
import type { StripeMoneyFacts } from "@/lib/stripeTruth";

export async function clubTimezone(clubId: string): Promise<string> {
  const c = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  return c?.timezone || DEFAULT_TZ;
}

/** Bookings that hold a slot on this product between two instants. */
export async function busyFor(productId: string, from: Date, to: Date, excludeId?: string | null): Promise<Busy[]> {
  const rows = await prisma.productBooking.findMany({
    where: {
      productId,
      startsAt: { lt: to },
      endsAt: { gt: new Date(from.getTime() - 24 * 3_600_000) },
      status: { in: ["CONFIRMED", "PENDING", "PENDING_PAYMENT"] },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { startsAt: true, endsAt: true, status: true, createdAt: true },
  });
  const now = new Date();
  return rows.filter((r) => holdsSlot(r, now)).map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt }));
}

type BookableProduct = {
  id: string;
  clubId: string;
  name: string;
  description: string | null;
  price: unknown;
  productType: string;
  settings: unknown;
  active: boolean;
  deletedAt: Date | null;
};

export async function availabilityFor(product: BookableProduct, date: string, lengthKey: string) {
  const settings = normalizeProductSettings(product.settings);
  const opt = lengthOptions(settings, Number(product.price)).find((o) => o.key === lengthKey) ?? lengthOptions(settings, Number(product.price))[0];
  const tz = await clubTimezone(product.clubId);
  const [y, m, d] = date.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, d) - 24 * 3_600_000);
  const to = new Date(Date.UTC(y, m - 1, d) + 48 * 3_600_000);
  const busy = await busyFor(product.id, from, to);
  return { tz, slots: slotsForDay({ settings, date, mins: opt.mins, busy, tz }) };
}

export type BookingWho = {
  memberId?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  guestPhone?: string | null;
  bookedByUserId?: string | null;
};

export type BookingRequest = {
  lengthKey: string;
  startsAt: string;
  guests: number;
  addOns: string[];
  answers: Record<string, unknown>;
  notes?: string | null;
};

export type CreateBookingResult =
  | { ok: true; bookingId: string; status: string; url: string | null; quote: BookingQuote }
  | { ok: false; status: number; message: string };

/**
 * Make a booking. Member / public: money due now goes through Stripe Checkout
 * (the booking holds its slot for 30 minutes while the page is open); nothing
 * due (request first, or free) files it straight away. Front desk: confirmed
 * at once, optionally with cash taken now.
 */
export async function createProductBooking(args: {
  product: BookableProduct;
  who: BookingWho;
  request: BookingRequest;
  channel: "MEMBER" | "PUBLIC" | "STAFF";
  staffCash?: number | null;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<CreateBookingResult> {
  const { product, request } = args;
  if (!product.active || product.deletedAt || !isBookable(product.productType)) {
    return { ok: false, status: 404, message: "This can't be booked." };
  }
  const settings: ProductSettings = normalizeProductSettings(product.settings);
  const q = bookingQuote(settings, Number(product.price), { lengthKey: request.lengthKey, guests: request.guests, addOns: request.addOns });
  if (!q.ok) return { ok: false, status: 400, message: q.message };
  const answers = checkAnswers(settings, request.answers ?? {});
  if (!answers.ok) return { ok: false, status: 400, message: answers.message };
  if (args.channel !== "STAFF" && !args.who.memberId && (!args.who.guestName?.trim() || !args.who.guestEmail?.trim())) {
    return { ok: false, status: 400, message: "Add your name and email." };
  }
  const quote = q.quote;
  const tz = await clubTimezone(product.clubId);
  const startsAt = new Date(request.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, status: 400, message: "Pick a time." };
  const endsAt = new Date(startsAt.getTime() + quote.option.mins * 60_000);

  const club = await prisma.club.findUnique({
    where: { id: product.clubId },
    select: { id: true, stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true, tier: true },
  });
  if (!club) return { ok: false, status: 404, message: "Club not found." };
  const needsCard = args.channel !== "STAFF" && quote.dueNow > 0;
  if (needsCard && (!club.stripeAccountId || !club.stripeChargesEnabled)) {
    return { ok: false, status: 409, message: "Online payments aren't set up for this club yet — contact them to book." };
  }

  // Serialize bookings of one product so two families can't take the last spot.
  const created = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pbook:${product.id}`}, 0))`;
    const rows = await db.productBooking.findMany({
      where: { productId: product.id, startsAt: { lt: new Date(endsAt.getTime() + 24 * 3_600_000) }, endsAt: { gt: new Date(startsAt.getTime() - 24 * 3_600_000) }, status: { in: ["CONFIRMED", "PENDING", "PENDING_PAYMENT"] } },
      select: { startsAt: true, endsAt: true, status: true, createdAt: true },
    });
    const busy = rows.filter((r) => holdsSlot(r)).map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt }));
    // Staff may book outside the public windows (a phone booking for a closed
    // day); they still can't double-book past the per-slot limit.
    const open =
      args.channel === "STAFF"
        ? busy.filter((b) => new Date(b.startsAt) < endsAt && startsAt < new Date(b.endsAt)).length < Math.max(1, settings.capacityLimit ?? 1)
        : slotIsOpen({ settings, startsAt: startsAt.toISOString(), mins: quote.option.mins, busy, tz });
    if (!open) return null;
    const status =
      args.channel === "STAFF" ? "CONFIRMED"
      : needsCard ? "PENDING_PAYMENT"
      : settings.depositMode === "REQUEST_ONLY" ? "PENDING"
      : statusAfterPayment(settings);
    return db.productBooking.create({
      data: {
        clubId: product.clubId,
        productId: product.id,
        memberId: args.who.memberId ?? null,
        guestName: args.who.guestName?.trim() || null,
        guestEmail: args.who.guestEmail?.trim().toLowerCase() || null,
        guestPhone: args.who.guestPhone?.trim() || null,
        bookedByUserId: args.who.bookedByUserId ?? null,
        tierName: quote.option.tierName,
        durationMins: quote.option.mins,
        startsAt,
        endsAt,
        guests: quote.guests,
        addOns: quote.addOns,
        answers: answers.answers,
        status,
        paymentMode: settings.depositMode,
        amountTotal: quote.total,
        dueNow: args.channel === "STAFF" ? 0 : quote.dueNow,
        notes: request.notes?.trim().slice(0, 1000) || null,
      },
    });
  });
  if (!created) return { ok: false, status: 409, message: "That time was just taken — pick another." };

  if (args.channel === "STAFF") {
    const cash = Math.min(quote.total, Math.max(0, args.staffCash ?? 0));
    if (cash > 0) {
      const txId = await recordProductMoney({
        clubId: product.clubId, memberId: args.who.memberId ?? null, amount: cash,
        description: `Booking — ${product.name} (${quote.option.tierName ?? minsLabel(quote.option.mins)})`, method: "CASH",
        recordedByUserId: args.who.bookedByUserId ?? null,
      });
      await prisma.productBooking.update({ where: { id: created.id }, data: { amountPaid: cash, transactionId: txId } });
    }
    return { ok: true, bookingId: created.id, status: created.status, url: null, quote };
  }
  if (!needsCard) return { ok: true, bookingId: created.id, status: created.status, url: null, quote };

  const cents = Math.round(quote.dueNow * 100);
  const feeItem = processingFeeLineItem(cents, club.passProcessingFees);
  const what = quote.option.tierName ?? minsLabel(quote.option.mins);
  try {
    const cs = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: cents,
              product_data: {
                name: `${product.name} — ${what}${quote.mode === "DEPOSIT" && quote.dueNow < quote.total ? " (deposit)" : ""}`,
                description: `${startsAt.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${quote.guests} guest${quote.guests === 1 ? "" : "s"}`,
              },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        ...(args.who.guestEmail ? { customer_email: args.who.guestEmail } : {}),
        success_url: args.successUrl ?? "",
        cancel_url: args.cancelUrl ?? "",
        payment_intent_data: {
          application_fee_amount: calculatePlatformFee(cents, club.tier),
          metadata: { productBookingId: created.id, productId: product.id, clubId: club.id },
        },
        metadata: { productBookingId: created.id, productId: product.id, clubId: club.id, ...(args.who.memberId ? { memberId: args.who.memberId } : {}) },
      },
      { stripeAccount: club.stripeAccountId! },
    );
    await prisma.productBooking.update({ where: { id: created.id }, data: { stripeCheckoutSessionId: cs.id } });
    return { ok: true, bookingId: created.id, status: created.status, url: cs.url, quote };
  } catch (e) {
    await prisma.productBooking.update({ where: { id: created.id }, data: { status: "CANCELED", notes: `Checkout couldn't open: ${String(e).slice(0, 200)}` } });
    return { ok: false, status: 502, message: "The payment page couldn't open. Nothing was charged — try again." };
  }
}

/** The Stripe webhook: the money for a booking landed. Idempotent. */
export async function confirmBookingPayment(args: {
  bookingId: string;
  clubId: string;
  amount: number;
  paymentIntentId: string | null;
  money: StripeMoneyFacts | null;
}): Promise<void> {
  const b = await prisma.productBooking.findFirst({
    where: { id: args.bookingId, clubId: args.clubId },
    include: { product: { select: { name: true, settings: true } } },
  });
  if (!b || b.transactionId) return;
  const txId = await recordProductMoney({
    clubId: b.clubId, memberId: b.memberId, amount: args.amount,
    description: `Booking — ${b.product.name} (${b.tierName ?? minsLabel(b.durationMins)})${b.guestName ? ` — ${b.guestName}` : ""}`,
    method: "STRIPE", paymentIntentId: args.paymentIntentId, money: args.money,
  });
  const settings = normalizeProductSettings(b.product.settings);
  await prisma.productBooking.update({
    where: { id: b.id },
    data: {
      transactionId: txId,
      stripePaymentIntentId: args.paymentIntentId,
      amountPaid: Number(b.amountPaid) + Number(b.dueNow),
      // A booking canceled while its checkout was open stays canceled — the
      // money is then a refund for staff, flagged in notes.
      ...(b.status === "PENDING_PAYMENT" ? { status: statusAfterPayment(settings) } : {}),
      ...(b.status === "CANCELED" ? { notes: `${b.notes ? `${b.notes}\n` : ""}Paid after it was canceled — refund it from Stripe.` } : {}),
    },
  });
}

export type StaffBookingAction =
  | { action: "approve" }
  | { action: "decline"; reason?: string | null; refund?: boolean }
  | { action: "cancel"; refund?: boolean }
  | { action: "record_payment"; amount: number };

/** Approve / decline / cancel / take the rest in cash. Refunds only when the
 *  owner ticks it, and only what was paid by card. */
export async function staffBookingAction(args: {
  clubId: string;
  bookingId: string;
  actorUserId: string | null;
  act: StaffBookingAction;
}): Promise<{ ok: true; message: string } | { ok: false; status: number; message: string }> {
  const b = await prisma.productBooking.findFirst({
    where: { id: args.bookingId, clubId: args.clubId },
    include: { product: { select: { name: true } } },
  });
  if (!b) return { ok: false, status: 404, message: "Booking not found." };
  const who = b.guestName ?? "the family";
  const act = args.act;

  if (act.action === "approve") {
    if (b.status !== "PENDING") return { ok: false, status: 409, message: "Only a booking waiting on you can be approved." };
    await prisma.productBooking.update({ where: { id: b.id }, data: { status: "CONFIRMED" } });
    return { ok: true, message: `Confirmed ${b.product.name} for ${who}.` };
  }
  if (act.action === "record_payment") {
    const amount = Math.round(act.amount * 100) / 100;
    const owed = Math.round((Number(b.amountTotal) - Number(b.amountPaid)) * 100) / 100;
    if (!(amount > 0) || amount > owed) return { ok: false, status: 400, message: `Enter up to $${owed.toFixed(2)}.` };
    const txId = await recordProductMoney({
      clubId: b.clubId, memberId: b.memberId, amount,
      description: `Booking balance — ${b.product.name}${b.guestName ? ` — ${b.guestName}` : ""}`, method: "CASH", recordedByUserId: args.actorUserId,
    });
    await prisma.productBooking.update({ where: { id: b.id }, data: { amountPaid: Number(b.amountPaid) + amount, ...(b.transactionId ? {} : { transactionId: txId }) } });
    return { ok: true, message: `Recorded $${amount.toFixed(2)} for ${b.product.name}.` };
  }

  if (b.status === "CANCELED" || b.status === "DECLINED") return { ok: false, status: 409, message: "This booking is already closed." };
  const refund = act.refund === true;
  let refunded = 0;
  if (refund && b.stripePaymentIntentId && Number(b.amountPaid) > 0) {
    const club = await prisma.club.findUnique({ where: { id: b.clubId }, select: { stripeAccountId: true } });
    try {
      const r = await stripe.refunds.create(
        { payment_intent: b.stripePaymentIntentId },
        { stripeAccount: club?.stripeAccountId ?? undefined, idempotencyKey: `aox-pbook-refund-${b.id}` },
      );
      refunded = (r.amount ?? 0) / 100;
      if (b.transactionId) {
        await prisma.transaction.updateMany({
          where: { id: b.transactionId, clubId: b.clubId },
          data: { refundedAmount: refunded, refundedAt: new Date(), refundReason: act.action === "decline" ? "Booking declined" : "Booking canceled", refundedByUserId: args.actorUserId },
        });
      }
    } catch (e) {
      return { ok: false, status: 502, message: `Stripe wouldn't refund it — nothing changed: ${String(e).slice(0, 160)}` };
    }
  }
  await prisma.productBooking.update({
    where: { id: b.id },
    data: {
      status: act.action === "decline" ? "DECLINED" : "CANCELED",
      ...(act.action === "decline" ? { declinedReason: (act.reason ?? "").trim().slice(0, 500) || null } : {}),
    },
  });
  await writeBillingAudit({
    clubId: b.clubId, memberId: b.memberId, actorUserId: args.actorUserId,
    action: act.action === "decline" ? "PRODUCT_BOOKING_DECLINED" : "PRODUCT_BOOKING_CANCELED",
    before: { bookingId: b.id, status: b.status, amountPaid: Number(b.amountPaid) },
    after: { status: act.action === "decline" ? "DECLINED" : "CANCELED", refunded },
    note: `${b.product.name} for ${who}${refunded ? ` — refunded $${refunded.toFixed(2)}` : ""}.`,
  });
  return {
    ok: true,
    message: `${act.action === "decline" ? "Declined" : "Canceled"} ${b.product.name} for ${who}.${refunded ? ` Refunded $${refunded.toFixed(2)}.` : Number(b.amountPaid) > 0 && !refund ? " Nothing was refunded." : ""}`,
  };
}
