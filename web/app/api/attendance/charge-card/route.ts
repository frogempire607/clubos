import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { applyProcessingFee } from "@/lib/fees";
import { resolveCardSnapshot, resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { sendPaymentReceiptEmail } from "@/lib/email";
import { writeBillingAudit } from "@/lib/billingAudit";
import { getAppBaseUrl } from "@/lib/baseUrl";
import type Stripe from "stripe";

// Attendance "Charge saved card" — a REAL Stripe charge on the club's
// connected account against the family's saved payment method.
//
//   GET  ?memberId=&classSessionId=|eventId=   → confirm-dialog preview:
//        card brand/last4/cardholder, payer relationship, who else the same
//        payer manages, server-allowed amounts, fee breakdown.
//   POST { memberId, classSessionId|eventId, amount, ... , clientKey }
//        → PaymentIntent (off-session, confirmed now, idempotent). Exactly one
//        Transaction + receipt + audit row on CONFIRMED Stripe success only.
//
// Owners / staff with FULL billing permission only. The amount is validated
// server-side against the item's configured prices — the client can pick,
// never invent. This is entirely separate from the external-reader option
// (paymentMethod CREDIT), which records and never charges.

export const maxDuration = 60;

// Server-derived allowed base prices for the item being charged.
async function allowedPricesFor(
  clubId: string,
  classSessionId: string | null,
  eventId: string | null,
): Promise<{ label: string; price: number }[] | null> {
  if (classSessionId) {
    const cs = await prisma.classSession.findFirst({
      where: { id: classSessionId, clubId },
      select: { recurringClass: { select: { pricingOptions: true } } },
    });
    if (!cs) return null;
    const opts =
      (cs.recurringClass.pricingOptions as Array<{ type: string; price?: number }> | null) || [];
    const prices: { label: string; price: number }[] = [];
    for (const o of opts) {
      if (typeof o?.price === "number" && o.price > 0) {
        const label =
          o.type === "member" ? "Member price" : o.type === "nonmember" ? "Non-member price" : "Drop-in";
        prices.push({ label, price: o.price });
      }
    }
    return prices;
  }
  if (eventId) {
    const ev = await prisma.event.findFirst({
      where: { id: eventId, clubId },
      select: { memberPrice: true, nonMemberPrice: true },
    });
    if (!ev) return null;
    const prices: { label: string; price: number }[] = [];
    if (ev.memberPrice != null && Number(ev.memberPrice) > 0)
      prices.push({ label: "Member price", price: Number(ev.memberPrice) });
    if (ev.nonMemberPrice != null && Number(ev.nonMemberPrice) > 0)
      prices.push({ label: "Non-member price", price: Number(ev.nonMemberPrice) });
    return prices;
  }
  return null;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  const url = new URL(req.url);
  const memberId = url.searchParams.get("memberId") || "";
  const classSessionId = url.searchParams.get("classSessionId");
  const eventId = url.searchParams.get("eventId");
  const clubId = session.user.clubId;

  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      isMinor: true,
      guardianName: true,
      stripeSetupCustomerId: true,
      stripeSetupPaymentMethodId: true,
      stripeCustomerId: true,
      guardianLinks: {
        select: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          relationship: true,
        },
      },
    },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { stripeAccountId: true, passProcessingFees: true },
  });
  if (!club?.stripeAccountId) return NextResponse.json({ error: "Stripe is not connected" }, { status: 409 });

  const customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId;
  const card = await resolveCardSnapshot(customerId, club.stripeAccountId);

  // Same payer, multiple athletes: everyone whose saved card lives on the
  // same Stripe customer — staff must see whose card this really is.
  const sharedWith = customerId
    ? await prisma.member.findMany({
        where: {
          clubId,
          id: { not: member.id },
          OR: [{ stripeSetupCustomerId: customerId }, { stripeCustomerId: customerId }],
        },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];

  const allowed = await allowedPricesFor(clubId, classSessionId, eventId);

  return NextResponse.json({
    member: { id: member.id, name: `${member.firstName} ${member.lastName ?? ""}`.trim(), isMinor: member.isMinor },
    hasSavedCard: !!(customerId && (member.stripeSetupPaymentMethodId || card)),
    card, // { brand, last4, cardholderName } | null
    guardians: member.guardianLinks.map((g) => ({
      name: `${g.user.firstName} ${g.user.lastName}`.trim(),
      email: g.user.email,
      relationship: g.relationship,
    })),
    payerManagesOthers: sharedWith.map((m) => `${m.firstName} ${m.lastName ?? ""}`.trim()),
    allowedPrices: allowed ?? [],
    passProcessingFees: !!club.passProcessingFees,
  });
}

const postSchema = z.object({
  memberId: z.string().min(1),
  classSessionId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  amount: z.number().positive(), // BASE price (fee added server-side)
  status: z.enum(["DROP_IN", "TRIAL", "PRESENT"]).optional().default("DROP_IN"),
  notes: z.string().max(500).optional().nullable(),
  emailReceipt: z.boolean().optional().default(true),
  // Client-generated UUID per confirm click — double-clicks and retries reuse
  // the SAME PaymentIntent instead of forking a second charge.
  clientKey: z.string().min(8).max(64),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const data = parsed.data;
  if (!data.classSessionId && !data.eventId) {
    return NextResponse.json({ error: "classSessionId or eventId required" }, { status: 400 });
  }
  const clubId = session.user.clubId;

  const [member, club] = await Promise.all([
    prisma.member.findFirst({
      where: { id: data.memberId, clubId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        stripeSetupCustomerId: true,
        stripeSetupPaymentMethodId: true,
        stripeCustomerId: true,
      },
    }),
    prisma.club.findUnique({
      where: { id: clubId },
      select: { id: true, name: true, stripeAccountId: true, passProcessingFees: true },
    }),
  ]);
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (!club?.stripeAccountId) return NextResponse.json({ error: "Stripe is not connected" }, { status: 409 });

  // NEVER trust the client's amount: it must equal one of the item's
  // configured prices (base, before any processing fee).
  const allowed = await allowedPricesFor(clubId, data.classSessionId ?? null, data.eventId ?? null);
  if (!allowed) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (!allowed.some((p) => Math.abs(p.price - data.amount) < 0.005)) {
    return NextResponse.json(
      { error: "AMOUNT_NOT_ALLOWED", allowedPrices: allowed },
      { status: 400 },
    );
  }

  const customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId;
  if (!customerId) {
    return NextResponse.json(
      { error: "NO_SAVED_CARD", message: "No saved payment method — send a payment link instead." },
      { status: 409 },
    );
  }
  // Resolve the PM: captured setup PM first, else the customer default / only
  // card — never a guess among multiple cards.
  let paymentMethodId = member.stripeSetupPaymentMethodId ?? null;
  if (!paymentMethodId) {
    paymentMethodId = await resolveChargeablePaymentMethodId(customerId, club.stripeAccountId);
  }
  if (!paymentMethodId) {
    return NextResponse.json(
      { error: "NO_SAVED_CARD", message: "No saved payment method — send a payment link instead." },
      { status: 409 },
    );
  }

  const fee = applyProcessingFee(Math.round(data.amount * 100), !!club.passProcessingFees);
  const memberName = `${member.firstName} ${member.lastName ?? ""}`.trim();
  const contextName = data.classSessionId ? "class" : "event";
  const description = `Attendance charge — ${memberName} (${contextName})`;

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: fee.totalCents,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description,
        expand: ["latest_charge.balance_transaction"],
        metadata: {
          kind: "attendance_saved_card",
          memberId: member.id,
          clubId,
          classSessionId: data.classSessionId ?? "",
          eventId: data.eventId ?? "",
          chargedByUserId: session.user.id ?? "",
        },
      },
      { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-att-card-${data.clientKey}` },
    );
  } catch (err) {
    const e = err as { type?: string; code?: string; message?: string; payment_intent?: { id?: string } };
    if (e.type === "StripeCardError") {
      const outcome = e.code === "authentication_required" ? "requires_action" : "declined";
      return NextResponse.json(
        {
          error: outcome === "declined" ? "CARD_DECLINED" : "AUTHENTICATION_REQUIRED",
          outcome,
          message:
            outcome === "declined"
              ? e.message || "The card was declined."
              : "This card requires the cardholder to authenticate — send a payment link instead.",
        },
        { status: 402 },
      );
    }
    console.error("attendance charge-card failed", err);
    return NextResponse.json({ error: "Charge failed", outcome: "failed" }, { status: 502 });
  }

  if (pi.status === "processing") {
    // No Transaction yet — reconciliation picks it up if it settles; surface
    // honestly instead of pretending success.
    return NextResponse.json({ ok: false, outcome: "processing", paymentIntentId: pi.id }, { status: 202 });
  }
  if (pi.status !== "succeeded") {
    return NextResponse.json(
      { error: "NOT_COMPLETED", outcome: pi.status, message: `Stripe returned status ${pi.status}` },
      { status: 402 },
    );
  }

  // Confirmed Stripe success → exactly ONE Transaction (unique PI id guards
  // webhook races and re-runs).
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Stripe.Charge) : null;
  const bt =
    charge?.balance_transaction && typeof charge.balance_transaction === "object"
      ? (charge.balance_transaction as Stripe.BalanceTransaction)
      : null;

  const existing = await prisma.transaction.findFirst({
    where: { stripePaymentIntentId: pi.id },
    select: { id: true },
  });
  const tx =
    existing ??
    (await prisma.transaction.create({
      data: {
        clubId,
        memberId: member.id,
        amount: fee.totalCents / 100,
        status: "SUCCEEDED",
        stripePaymentIntentId: pi.id,
        stripeChargeId: charge?.id ?? null,
        description: `Card charge (saved card) — ${memberName}`,
        type: data.classSessionId ? "CLASS" : "EVENT",
        category: data.classSessionId ? "classes" : "events",
        paymentMethod: "STRIPE",
        paymentSource: "STRIPE",
        reconciliationStatus: "VERIFIED",
        ...(bt ? { stripeFeeAmount: bt.fee / 100, netAmount: bt.net / 100 } : {}),
        notes: data.notes || null,
        txDate: new Date(),
      },
    }));

  // Attendance record: mark present/paid (mirrors /api/attendance/charge).
  if (data.classSessionId) {
    const existingRec = await prisma.attendanceRecord.findFirst({
      where: { classSessionId: data.classSessionId, memberId: member.id },
    });
    if (existingRec) {
      await prisma.attendanceRecord.update({
        where: { id: existingRec.id },
        data: { status: data.status, checkedInAt: existingRec.checkedInAt ?? new Date() },
      });
    } else {
      await prisma.attendanceRecord.create({
        data: {
          clubId,
          classSessionId: data.classSessionId,
          memberId: member.id,
          status: data.status,
          checkedInAt: new Date(),
        },
      });
    }
  }

  await writeBillingAudit({
    clubId,
    memberId: member.id,
    actorUserId: session.user.id ?? null,
    action: "ATTENDANCE_CARD_CHARGED",
    before: null,
    after: {
      transactionId: tx.id,
      paymentIntentId: pi.id,
      base: fee.subtotalCents / 100,
      processingFee: fee.feeCents / 100,
      total: fee.totalCents / 100,
      stripeFee: bt ? bt.fee / 100 : null,
    },
    note: `Saved-card attendance charge confirmed by Stripe (${contextName}).`,
  });

  if (data.emailReceipt) {
    // Receipt to the member/guardian contact — non-blocking.
    (async () => {
      try {
        const m = await prisma.member.findUnique({
          where: { id: member.id },
          select: {
            firstName: true,
            email: true,
            isMinor: true,
            guardianEmail: true,
            guardian: { select: { email: true } },
            user: { select: { email: true } },
          },
        });
        const to = m?.isMinor
          ? m.guardian?.email || m.guardianEmail || m.email || m.user?.email
          : m?.email || m?.user?.email || m?.guardianEmail;
        if (to) {
          await sendPaymentReceiptEmail({
            to,
            firstName: m?.firstName || "there",
            clubName: club.name,
            description: `${description}${fee.feeCents > 0 ? " (includes processing fee)" : ""}`,
            amountPaid: `$${(fee.totalCents / 100).toFixed(2)}`,
            paidAt: new Date(),
            portalUrl: `${getAppBaseUrl()}/member/profile`,
          });
        }
      } catch (e) {
        console.error("attendance card receipt failed", e);
      }
    })();
  }

  return NextResponse.json({
    ok: true,
    outcome: "succeeded",
    transactionId: tx.id,
    total: fee.totalCents / 100,
    processingFee: fee.feeCents / 100,
  });
}
