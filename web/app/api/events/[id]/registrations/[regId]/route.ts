import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";

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
export async function DELETE(_req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
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
    return NextResponse.json(
      { error: "This registrant has already paid. Refund them first, then remove them." },
      { status: 409 },
    );
  }
  if (reg.status === "SCHEDULED") {
    return NextResponse.json(
      { error: "This registrant's card charge is authorized for the event date. Cancel the scheduled charge before removing them." },
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
  await prisma.eventRegistration.updateMany({
    where: { id: reg.id, clubId, status: { not: "CANCELED" } },
    data: { status: "CANCELED", amountDue: null, paymentUrl: null },
  });

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
