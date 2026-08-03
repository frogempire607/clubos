import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { sendPaymentReceiptEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

// POST /api/events/[id]/registrations/[regId]/resend-receipt
//
// Re-send the receipt for a registration that is already PAID. Families lose
// the original email, change addresses, or need proof for a school/club
// reimbursement, and the only previous way to produce another receipt was to
// re-record the payment — which mints a second Transaction and double-counts
// the money.
//
// Read-only with respect to money: it re-renders the receipt for the payment
// that already exists and never creates, modifies, or settles a Transaction.
export async function POST(_req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Lower bar than recording money (billing:full) — this only re-sends what
  // was already sent, to the address already on the registration.
  const denied = requirePermission(session, "billing", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const reg = await prisma.eventRegistration.findFirst({
    where: { id: regId, eventId, clubId },
    include: { event: { select: { name: true } }, club: { select: { name: true } } },
  });
  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  if (reg.status !== "PAID") {
    return NextResponse.json(
      { error: "There's no receipt to resend — this registration isn't paid yet." },
      { status: 409 },
    );
  }
  if (!reg.email) {
    return NextResponse.json({ error: "No email on file for this registrant." }, { status: 400 });
  }

  // Prefer the Transaction as the source of truth for what was actually
  // recorded; fall back to the registration's own snapshot for older rows
  // settled before transactions were linked.
  const tx = reg.transactionId
    ? await prisma.transaction.findFirst({
        where: { id: reg.transactionId, clubId },
        select: { amount: true, txDate: true, createdAt: true, paymentMethod: true },
      })
    : null;

  const amount = tx ? Number(tx.amount) : Number(reg.amountPaid ?? reg.amountDue ?? 0);
  if (!(amount > 0)) {
    return NextResponse.json({ error: "No recorded payment amount to receipt." }, { status: 400 });
  }
  const paidAt = tx?.txDate ?? tx?.createdAt ?? reg.paidAt ?? new Date();
  const via = reg.paidVia ?? tx?.paymentMethod ?? null;
  const viaLabel = via === "CHECK" ? " · Paid by Check" : via === "CASH" ? " · Paid by Cash" : "";

  try {
    await sendPaymentReceiptEmail({
      to: reg.email,
      firstName: reg.name?.split(" ")[0] || "there",
      clubName: reg.club.name,
      description: `${reg.event.name} — event registration${viaLabel}`,
      amountPaid: `$${amount.toFixed(2)}`,
      paidAt,
      portalUrl: `${getAppBaseUrl()}/member`,
    });
  } catch (e) {
    console.error("resend event receipt failed", e);
    return NextResponse.json({ error: "Could not send the receipt. Try again." }, { status: 502 });
  }

  await writeBillingAudit({
    clubId,
    memberId: reg.memberId,
    actorUserId: session.user.id ?? null,
    action: "EVENT_RECEIPT_RESENT",
    before: { registrationId: reg.id, status: reg.status },
    after: { registrationId: reg.id, to: reg.email, amount, paidAt },
    note: `Receipt for ${reg.event.name} re-sent to ${reg.name}. No money moved.`,
  });

  return NextResponse.json({ ok: true, to: reg.email, amount });
}
