import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, hasPermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { refundEventRegistration } from "@/lib/eventRefundServer";
import type { RefundMode } from "@/lib/eventRefunds";

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
//   refund  { mode: price|all|custom, amountCents?, expectedRefundedCents }.
//           The refund runs FIRST (lib/eventRefundServer, the one engine).
//           They come off the event only once it has gone through. Until
//           2026-11-25 the removal was written first, so a refused refund left
//           somebody removed and still charged.
//   keep    CANCELED, nothing else: amountPaid, transactionId and the Stripe
//           payment are untouched, so the money stays in Financials and on the
//           event's Collected tile. An audit row records that it was kept.
// Without that body a paid registrant is still refused, as before.
type PaidChoice = "refund" | "keep";

export const maxDuration = 60;

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
    const body = (await req.json().catch(() => null)) as { paid?: unknown; mode?: unknown; amountCents?: unknown; expectedRefundedCents?: unknown } | null;
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
    if (choice === "refund") {
      // A screen loaded before the refund sheet existed sends no mode; it told
      // the person the whole payment goes back, so that is what happens.
      const mode: RefundMode = body?.mode === "price" || body?.mode === "custom" ? body.mode : "all";
      const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
      const r = await refundEventRegistration({
        clubId,
        eventId,
        registrationId: reg.id,
        mode,
        customCents: int(body?.amountCents),
        expectedRefundedCents: int(body?.expectedRefundedCents),
        actorUserId: session.user.id ?? null,
        remove: true,
        byStaff: true,
        reason: "Removed from the event and refunded",
      });
      // Not refunded: nothing was written, and they are still registered.
      if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, refunded: false, status: reg.status }, { status: r.status });
      return NextResponse.json({ ...r, registrationId: reg.id, refunded: true, refundAmount: r.cents / 100, status: r.removed ? "CANCELED" : reg.status });
    }
    return removeKeepingPayment({ reg, eventId, clubId, actorUserId: session.user.id ?? null });
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

async function removeKeepingPayment(input: { reg: PaidReg; eventId: string; clubId: string; actorUserId: string | null }) {
  const { reg, eventId, clubId, actorUserId } = input;
  const paid = Number(reg.amountPaid ?? 0);
  const paidText = `$${paid.toFixed(2)}`;

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
