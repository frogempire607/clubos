import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { sendPaymentReceiptEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

export const dynamic = "force-dynamic";

// Staff records that cash/check money was PHYSICALLY received.
//
//   GET  → the member's outstanding offline payments (PENDING cash/check
//          Transactions) for the "record payment received" UI.
//   POST → mark one received: Transaction → SUCCEEDED (this is the moment it
//          becomes revenue), activate the pending offline membership if the
//          club policy deferred activation, send the receipt, audit who
//          received what, when, and how. NO Stripe object is ever involved.
//
// billing:full only (owners bypass). Client acceptance NEVER reaches here —
// this is strictly the staff receipt-confirmation step.

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "view");
  if (denied) return denied;

  const rows = await prisma.transaction.findMany({
    where: {
      clubId: session.user.clubId,
      memberId,
      status: "PENDING",
      paymentSource: { in: ["CASH", "CHECK"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, amount: true, paymentMethod: true, paymentSource: true,
      description: true, discountCode: true, discountAmount: true, createdAt: true,
    },
  });
  return NextResponse.json({
    pending: rows.map((t) => ({
      ...t,
      amount: Number(t.amount),
      discountAmount: t.discountAmount != null ? Number(t.discountAmount) : null,
      stateLabel: t.paymentSource === "CHECK" ? "Client accepted — awaiting check payment" : "Client accepted — awaiting cash payment",
    })),
  });
}

const schema = z.object({
  transactionId: z.string().min(1),
  // Staff may correct cash↔check at receipt time (what actually arrived).
  method: z.enum(["CASH", "CHECK"]).optional(),
  // Check number or a short note.
  reference: z.string().max(120).optional().nullable(),
  // What was actually received; must equal the amount due (partial payments
  // are out of scope — adjust the offer instead).
  amountReceived: z.number().positive().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { transactionId, method, reference, amountReceived } = parsed.data;

  const tx = await prisma.transaction.findFirst({
    where: { id: transactionId, clubId, memberId, status: "PENDING", paymentSource: { in: ["CASH", "CHECK"] } },
  });
  if (!tx) return NextResponse.json({ error: "No matching outstanding cash/check payment." }, { status: 404 });

  const due = Number(tx.amount);
  if (amountReceived != null && Math.abs(amountReceived - due) > 0.005) {
    return NextResponse.json(
      { error: `Amount received ($${amountReceived.toFixed(2)}) must equal the amount due ($${due.toFixed(2)}). Adjust the member's billing first if the agreed amount changed.` },
      { status: 400 },
    );
  }

  const finalMethod = method ?? (tx.paymentSource === "CHECK" ? "CHECK" : "CASH");
  const receivedAt = new Date();
  const receiver = session.user.id ?? null;

  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      status: "SUCCEEDED",
      paymentMethod: finalMethod,
      paymentSource: finalMethod,
      txDate: receivedAt,
      description: (tx.description || "Membership payment").replace(/ — awaiting (cash|check)/i, "") + ` — paid by ${finalMethod.toLowerCase()}`,
      notes: `${tx.notes ? tx.notes + "\n" : ""}Received ${receivedAt.toISOString()} by staff${reference ? ` · ref: ${reference}` : ""}.`,
    },
  });

  // Activate the pending offline membership (ON_PAYMENT policy) — this is the
  // exact moment "awaiting cash/check" becomes "Paid" + Active.
  const pendingSub = await prisma.memberSubscription.findFirst({
    where: { memberId, status: "pending", billingType: "MANUAL", stripeSubscriptionId: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (pendingSub) {
    await prisma.memberSubscription.update({
      where: { id: pendingSub.id },
      data: { status: "active", startedAt: receivedAt },
    });
  }
  await recomputeMemberStatus(memberId, clubId);

  await writeBillingAudit({
    clubId,
    memberId,
    actorUserId: receiver,
    action: "OFFLINE_PAYMENT_RECEIVED",
    before: { transactionId: tx.id, status: "PENDING", amountDue: due, method: tx.paymentSource },
    after: {
      transactionId: tx.id,
      status: "SUCCEEDED",
      amountReceived: due,
      method: finalMethod,
      reference: reference || null,
      receivedAt: receivedAt.toISOString(),
      activatedSubscriptionId: pendingSub?.id ?? null,
      discountCode: tx.discountCode,
    },
    note: `Staff recorded ${finalMethod.toLowerCase()} payment of $${due.toFixed(2)} as physically received${reference ? ` (ref ${reference})` : ""}.`,
  });

  // Receipt goes out only now — money in hand.
  (async () => {
    try {
      const m = await prisma.member.findUnique({
        where: { id: memberId },
        select: {
          firstName: true, email: true, isMinor: true, guardianEmail: true,
          guardian: { select: { email: true } }, user: { select: { email: true } },
          club: { select: { name: true } },
        },
      });
      const to = m?.isMinor
        ? m.guardian?.email || m.guardianEmail || m.email || m.user?.email
        : m?.email || m?.user?.email || m?.guardianEmail;
      if (to) {
        const discountLine = tx.discountCode ? ` · ${tx.discountCode} Discount Applied` : "";
        await sendPaymentReceiptEmail({
          to,
          firstName: m?.firstName || "there",
          clubName: m?.club?.name || "your club",
          description: `${(tx.description || "Membership payment").replace(/ — awaiting (cash|check)/i, "")}${discountLine} · Paid by ${finalMethod === "CHECK" ? "Check" : "Cash"}`,
          amountPaid: `$${due.toFixed(2)}`,
          paidAt: receivedAt,
          portalUrl: `${getAppBaseUrl()}/member/profile`,
        });
      }
    } catch (e) {
      console.error("offline payment receipt failed", e);
    }
  })();

  return NextResponse.json({
    ok: true,
    paid: true,
    transactionId: tx.id,
    method: finalMethod,
    amount: due,
    activatedSubscription: !!pendingSub,
  });
}
