import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, hasPermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { stripe } from "@/lib/stripe";
import { REFUND_APPLICATION_FEE } from "@/lib/fees";

// DELETE /api/events/[id]/registrations/[regId]
// Remove someone from an event's BILLING list.
//
// Until now there was no way to do this at all: the roster's "Cancel" button
// removes a Booking, and bookings live in a different table from
// event_registrations. A registrant with no booking — anyone who signed up
// through the public link, or whose booking was already removed — could not be
// taken off the invoice list by any UI path, so they kept receiving payment
// links after being pulled from the trip.
//
// CANCELED, never a hard delete: bill-registrants, capacity, the roster, and
// the reprice preview all already exclude CANCELED, and the row stays as
// history. Money that is already committed blocks the removal — a paid or
// scheduled registrant needs a refund or a canceled authorization first, which
// is a decision, not a side effect of tidying a list.
//
// 2026-11-17: someone who PAID can now be removed, as an explicit decision
// with body { paid: "refund" | "keep" } (owner, or staff with billing:full):
//   refund  the card refund the decline path already uses — same Stripe
//           idempotency key (aox-eventreg-refund-<regId>), so a decline and a
//           remove can never refund the same registration twice
//   keep    CANCELED, nothing else: amountPaid, transactionId and the Stripe
//           payment are untouched, so the money stays in Financials and on the
//           event's Collected tile. An audit row records that it was kept.
// Without that body a paid registrant is still refused, as before.
type PaidChoice = "refund" | "keep";

export async function DELETE(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const reg = await prisma.eventRegistration.findFirst({
    where: { id: regId, eventId, clubId },
    include: { event: { select: { name: true } } },
  });
  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  if (reg.status === "CANCELED") return NextResponse.json({ ok: true, alreadyCanceled: true });

  if (reg.status === "PAID" || Number(reg.amountPaid ?? 0) > 0) {
    const body = (await req.json().catch(() => null)) as { paid?: unknown } | null;
    const choice: PaidChoice | null = body?.paid === "refund" || body?.paid === "keep" ? body.paid : null;
    if (!choice) {
      return NextResponse.json(
        { error: "This registrant has already paid. Choose Remove and refund, or Remove, keep the payment.", code: "PAID_CHOICE_REQUIRED" },
        { status: 409 },
      );
    }
    if (!(await hasPermissionLive(session, "billing", "full"))) {
      return NextResponse.json(
        { error: "Only the owner or staff with billing permission can remove someone who paid." },
        { status: 403 },
      );
    }
    return removePaid({ reg, eventId, clubId, choice, actorUserId: session.user.id ?? null });
  }
  // A SCHEDULED card charge hasn't run yet; removing cancels it (the charge
  // runner only charges SCHEDULED rows). Once a charge has STARTED (a
  // PaymentIntent exists) it can't be pulled back from here — refused.
  if (reg.status === "SCHEDULED" && reg.stripePaymentIntentId) {
    return NextResponse.json(
      { error: "This registrant's card charge is already being processed. Wait for it to finish, then refund and remove them." },
      { status: 409 },
    );
  }
  if (reg.transactionId || reg.status === "AWAITING_CASH" || reg.status === "AWAITING_CHECK") {
    return NextResponse.json(
      { error: "An open cash/check record exists for this registrant. Void it in Financials first, then remove them." },
      { status: 409 },
    );
  }

  // Clearing paymentUrl removes the link from OUR surfaces only. A Checkout
  // session already emailed to a parent stays payable on Stripe's side until
  // it expires (24h from creation) or is explicitly expired against the
  // connected account. Expiring it is a live Stripe write and is deliberately
  // NOT done here — see the operator runbook.
  const done = await prisma.eventRegistration.updateMany({
    // A scheduled charge that started between the read and now (PI id
    // written) must not be cancelled out from under it.
    where: { id: reg.id, clubId, status: { not: "CANCELED" }, ...(reg.status === "SCHEDULED" ? { stripePaymentIntentId: null } : {}) },
    data: { status: "CANCELED", amountDue: null, paymentUrl: null, ...(reg.status === "SCHEDULED" ? { scheduledChargeAt: null } : {}) },
  });
  if (reg.status === "SCHEDULED" && done.count === 0) {
    return NextResponse.json(
      { error: "This registrant's card charge started just now. Wait for it to finish, then refund and remove them." },
      { status: 409 },
    );
  }

  // Keep the two lists in step — the attendee roster must lose them too.
  if (reg.memberId) {
    await prisma.booking
      .delete({ where: { eventId_memberId: { eventId, memberId: reg.memberId } } })
      .catch(() => undefined);
  }

  await writeBillingAudit({
    clubId,
    memberId: reg.memberId,
    actorUserId: session.user.id ?? null,
    action: "EVENT_REGISTRATION_REMOVED",
    before: { registrationId: reg.id, status: reg.status, amountDue: reg.amountDue == null ? null : Number(reg.amountDue) },
    after: { registrationId: reg.id, status: "CANCELED", amountDue: null },
    note: `${reg.name} removed from ${reg.event.name}. No money moved.`,
  });

  return NextResponse.json({ ok: true, registrationId: reg.id, status: "CANCELED" });
}

type PaidReg = {
  id: string;
  memberId: string | null;
  name: string;
  status: string;
  amountPaid: unknown;
  transactionId: string | null;
  stripePaymentIntentId: string | null;
  event: { name: string };
};

async function removePaid(input: { reg: PaidReg; eventId: string; clubId: string; choice: PaidChoice; actorUserId: string | null }) {
  const { reg, eventId, clubId, choice, actorUserId } = input;
  const paid = Number(reg.amountPaid ?? 0);
  const paidText = `$${paid.toFixed(2)}`;

  let stripeAccountId: string | null = null;
  if (choice === "refund") {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { stripeAccountId: true } });
    stripeAccountId = club?.stripeAccountId ?? null;
    if (!reg.stripePaymentIntentId || !stripeAccountId) {
      return NextResponse.json(
        { error: "This payment wasn't made by card through AthletixOS, so it can't be refunded from here. Choose Remove, keep the payment, then hand the money back and record it in Financials." },
        { status: 409 },
      );
    }
  }

  // Claim the row first: a double tap, or two staff at once, removes once.
  // Only status (and the link) changes — amountPaid, transactionId and the
  // payment intent stay, because that is what makes the money traceable.
  const claimed = await prisma.eventRegistration.updateMany({
    where: { id: reg.id, clubId, status: { not: "CANCELED" } },
    data: { status: "CANCELED", paymentUrl: null },
  });
  if (claimed.count === 0) return NextResponse.json({ ok: true, alreadyCanceled: true });

  if (reg.memberId) {
    await prisma.booking
      .delete({ where: { eventId_memberId: { eventId, memberId: reg.memberId } } })
      .catch(() => undefined);
  }

  if (choice === "keep") {
    await writeBillingAudit({
      clubId,
      memberId: reg.memberId,
      actorUserId,
      action: "EVENT_REGISTRATION_REMOVED_PAYMENT_KEPT",
      before: { registrationId: reg.id, status: reg.status, amountPaid: paid, transactionId: reg.transactionId },
      after: { registrationId: reg.id, status: "CANCELED", amountPaid: paid, transactionId: reg.transactionId, refunded: false },
      note: `${reg.name} removed from ${reg.event.name}. The ${paidText} they paid was kept — not refunded.`,
    });
    return NextResponse.json({ ok: true, registrationId: reg.id, status: "CANCELED", paymentKept: true });
  }

  try {
    const refund = await stripe.refunds.create(
      { payment_intent: reg.stripePaymentIntentId as string, refund_application_fee: REFUND_APPLICATION_FEE },
      // Same key the decline path uses: a replay returns Stripe's existing refund.
      { stripeAccount: stripeAccountId as string, idempotencyKey: `aox-eventreg-refund-${reg.id}` },
    );
    await writeBillingAudit({
      clubId,
      memberId: reg.memberId,
      actorUserId,
      action: "EVENT_REGISTRATION_REFUNDED",
      before: { registrationId: reg.id, status: reg.status, amountPaid: paid },
      after: { registrationId: reg.id, status: "CANCELED", refundId: refund.id, amount: refund.amount / 100 },
      note: `${reg.name} removed from ${reg.event.name} and refunded.`,
    });
    return NextResponse.json({ ok: true, registrationId: reg.id, status: "CANCELED", refunded: true, refundAmount: refund.amount / 100 });
  } catch (e) {
    // Never retried here: a refund whose answer we didn't see needs a person
    // to look at Stripe. The registration stays removed; the audit row says
    // the refund did not go through.
    console.error("[event remove] refund failed", reg.id, e);
    await writeBillingAudit({
      clubId,
      memberId: reg.memberId,
      actorUserId,
      action: "EVENT_REGISTRATION_REFUND_FAILED",
      before: { registrationId: reg.id, paymentIntentId: reg.stripePaymentIntentId },
      after: { registrationId: reg.id, status: "CANCELED", error: String(e).slice(0, 300) },
      note: `${reg.name} removed from ${reg.event.name}, but the refund FAILED. Check Stripe.`,
    });
    return NextResponse.json({
      ok: true,
      registrationId: reg.id,
      status: "CANCELED",
      refunded: false,
      refundError: "They were removed, but the refund didn't go through. Check the payment in Stripe before trying again.",
    });
  }
}
