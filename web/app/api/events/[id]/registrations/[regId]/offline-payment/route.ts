import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { sendPaymentReceiptEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { createEventOfflinePendingTx } from "@/lib/eventPayments";

// POST /api/events/[id]/registrations/[regId]/offline-payment
// Staff records the physical cash/check an event registrant handed over — at
// check-in or before the event. This is the ONLY moment an offline event
// registration becomes revenue: the PENDING Transaction flips to SUCCEEDED,
// the registration flips to PAID, and the receipt goes out.
//
// Mirrors /api/members/[id]/offline-payment (same rules, same audit, same
// receipt) but is keyed on the REGISTRATION — event registrants are often not
// members, so there's no member row or subscription to hang this off.

const schema = z.object({
  // Staff may correct cash↔check at receipt time (what actually arrived).
  method: z.enum(["CASH", "CHECK"]).optional(),
  // Check number or a short note.
  reference: z.string().max(120).optional().nullable(),
  // What was actually received; must equal the amount due.
  amountReceived: z.number().positive().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Money is money — same gate as recording a membership's cash/check.
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { method, reference, amountReceived } = parsed.data;

  const reg = await prisma.eventRegistration.findFirst({
    where: { id: regId, eventId, clubId },
    include: { event: { select: { name: true } }, club: { select: { name: true } } },
  });
  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  if (reg.status === "PAID") {
    return NextResponse.json({ error: "This registration is already paid." }, { status: 409 });
  }
  if (reg.status === "CANCELED") {
    return NextResponse.json({ error: "This registration was canceled." }, { status: 409 });
  }

  const due = Number(reg.amountDue ?? 0);
  if (!(due > 0)) {
    return NextResponse.json({ error: "This registration has no amount due." }, { status: 400 });
  }
  if (amountReceived != null && Math.abs(amountReceived - due) > 0.005) {
    return NextResponse.json(
      {
        error: `Amount received ($${amountReceived.toFixed(2)}) must equal the amount due ($${due.toFixed(2)}).`,
      },
      { status: 400 },
    );
  }

  const finalMethod =
    method ?? (reg.paymentMethod === "CHECK" || reg.status === "AWAITING_CHECK" ? "CHECK" : "CASH");
  const receivedAt = new Date();

  // The PENDING offline row normally already exists (created at registration).
  // If the registrant switched to cash at the door — or is settling a failed
  // auto-charge in cash — mint the row now so the money is always represented
  // by exactly one Transaction.
  let txId = reg.transactionId;
  if (txId) {
    const existing = await prisma.transaction.findFirst({
      where: { id: txId, clubId, status: "PENDING" },
      select: { id: true },
    });
    if (!existing) txId = null;
  }
  if (!txId) {
    const created = await createEventOfflinePendingTx({
      clubId,
      memberId: reg.memberId,
      amount: due,
      method: finalMethod,
      eventName: reg.event.name,
      registrantName: reg.name,
    });
    txId = created.id;
  }

  const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });

  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      status: "SUCCEEDED",
      paymentMethod: finalMethod,
      paymentSource: finalMethod,
      reconciliationStatus: "OFFLINE",
      txDate: receivedAt,
      description:
        (tx.description || `Event registration — ${reg.event.name}`).replace(
          / \(pay by (cash|check) at event\)/i,
          "",
        ) + ` — paid by ${finalMethod.toLowerCase()}`,
      notes: `${tx.notes ? tx.notes + "\n" : ""}Received ${receivedAt.toISOString()} by staff${reference ? ` · ref: ${reference}` : ""}.`,
    },
  });

  await prisma.eventRegistration.update({
    where: { id: reg.id },
    data: {
      status: "PAID",
      amountPaid: due,
      paidAt: receivedAt,
      paidVia: finalMethod,
      receivedById: session.user.id ?? null,
      checkReference: reference || null,
      transactionId: tx.id,
      lastChargeError: null,
    },
  });

  await writeBillingAudit({
    clubId,
    memberId: reg.memberId,
    actorUserId: session.user.id ?? null,
    action: "EVENT_OFFLINE_PAYMENT_RECEIVED",
    before: { registrationId: reg.id, status: reg.status, amountDue: due },
    after: {
      registrationId: reg.id,
      status: "PAID",
      transactionId: tx.id,
      method: finalMethod,
      reference: reference || null,
      amount: due,
    },
    note: `${finalMethod === "CHECK" ? "Check" : "Cash"} received for ${reg.event.name} — ${reg.name}.`,
  });

  // Receipt — only now, after real money changed hands.
  if (reg.email) {
    try {
      await sendPaymentReceiptEmail({
        to: reg.email,
        firstName: reg.name?.split(" ")[0] || "there",
        clubName: reg.club.name,
        description: `${reg.event.name} — event registration · Paid by ${finalMethod === "CHECK" ? "Check" : "Cash"}`,
        amountPaid: `$${due.toFixed(2)}`,
        paidAt: receivedAt,
        portalUrl: `${getAppBaseUrl()}/member`,
      });
    } catch (e) {
      console.error("event offline receipt failed", e);
    }
  }

  return NextResponse.json({
    ok: true,
    registrationId: reg.id,
    status: "PAID",
    method: finalMethod,
    amountPaid: due,
    transactionId: tx.id,
  });
}
