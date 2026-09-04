import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeBillingAudit } from "@/lib/billingAudit";
import { requirePermission } from "@/lib/apiGuard";

// Owner review: assign entity / category / payment method / notes, mark
// refund/reversal, attach receipt. Never auto-categorizes.
//
// Money-touching fields (refund flag) are gated by `finances:full`; the
// non-money edits (entity/category/method/notes) also require `finances:full`.
const schema = z.object({
  legalEntityId: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // Refund/reversal (owner-declared flag — Phase 1A does NOT call Stripe
  // refunds). To CLEAR a previously-set refund, send `refundedAmount: 0` +
  // `refundedAt: null`.
  refundedAmount: z.number().nullable().optional(),
  refundedAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .or(z.literal("")),
  refundReason: z.string().max(120).nullable().optional(),
  // Attach or clear a receipt file URL. Coming from /api/upload.
  receiptUrl: z.string().nullable().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const tx = await prisma.transaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: {
      id: true, amount: true, refundedAmount: true, refundedAt: true,
      // Carried so the audit row below can show a real before/after rather
      // than only the new value.
      legalEntityId: true, category: true, paymentMethod: true, notes: true,
      receiptUrl: true, refundReason: true, memberId: true,
    },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const before = tx;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  // Refund flag: refundedAmount is validated against the row total. Owner may
  // record a partial refund (< amount) or a full one (== amount). Anything
  // above the charge is rejected — refunds don't add money.
  const patch: Record<string, unknown> = {};
  if (data.legalEntityId !== undefined) patch.legalEntityId = data.legalEntityId || null;
  if (data.category !== undefined) patch.category = data.category || null;
  if (data.paymentMethod !== undefined) patch.paymentMethod = data.paymentMethod || null;
  if (data.notes !== undefined) patch.notes = data.notes || null;
  if (data.receiptUrl !== undefined) patch.receiptUrl = data.receiptUrl || null;
  if (data.refundReason !== undefined) patch.refundReason = data.refundReason || null;

  const setsRefund =
    data.refundedAmount !== undefined || data.refundedAt !== undefined;
  if (setsRefund) {
    const nextAmount =
      data.refundedAmount === null ? 0 : data.refundedAmount ?? Number(tx.refundedAmount ?? 0);
    if (nextAmount > Number(tx.amount) + 0.005) {
      return NextResponse.json(
        { error: "Refund amount cannot exceed the transaction amount." },
        { status: 400 },
      );
    }
    if (nextAmount < 0) {
      return NextResponse.json({ error: "Refund amount cannot be negative." }, { status: 400 });
    }
    patch.refundedAmount = nextAmount > 0 ? nextAmount : null;
    const nextAt =
      data.refundedAt === "" || data.refundedAt === null
        ? null
        : data.refundedAt
          ? new Date(data.refundedAt)
          : nextAmount > 0
            ? new Date()
            : null;
    patch.refundedAt = nextAt;
    patch.refundedByUserId = nextAmount > 0 ? session.user.id ?? null : null;
  }

  const updated = await prisma.transaction.update({
    where: { id },
    data: patch,
    include: { legalEntity: { select: { id: true, name: true } } },
  });

  // §6A — "Add audit logs for financial categorization". This PATCH moves a
  // row between tax categories and legal entities and can record a refund, all
  // of which change what the books say. Only the changed keys are recorded, so
  // the diff reads as what the person actually did.
  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: updated.memberId ?? null,
    actorUserId: session.user.id ?? null,
    action: setsRefund ? "TRANSACTION_REFUND_RECORDED" : "TRANSACTION_RECLASSIFIED",
    before: Object.fromEntries(
      Object.keys(patch).map((k) => [k, (before as Record<string, unknown>)[k] ?? null]),
    ),
    after: patch,
    note:
      `${setsRefund ? "Refund recorded on" : "Reclassified"} transaction ${id}` +
      (setsRefund ? " — recording a refund here does NOT refund the card in Stripe." : "."),
  });

  return NextResponse.json(updated);
}

// Only manually-recorded payments may be deleted (never delete Stripe
// financial records — they're the source of truth).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const tx = await prisma.transaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: {
      id: true, manual: true, amount: true, type: true, category: true,
      paymentMethod: true, paymentSource: true, txDate: true,
      description: true, memberId: true,
    },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!tx.manual) {
    return NextResponse.json(
      { error: "Stripe transactions can't be deleted. Only manual entries can be removed." },
      { status: 400 },
    );
  }
  // §6A — "Preserve historical transaction records". The row itself goes (this
  // is the manual-entry escape hatch, and a mistyped cash entry should not be
  // permanent), but the fact that it existed and who removed it must not.
  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: tx.memberId ?? null,
    actorUserId: session.user.id ?? null,
    action: "TRANSACTION_DELETED",
    before: {
      id: tx.id, amount: tx.amount, type: tx.type, category: tx.category,
      paymentMethod: tx.paymentMethod, paymentSource: tx.paymentSource,
      txDate: tx.txDate, description: tx.description,
    },
    after: null,
    note: "Manually-recorded transaction deleted. Stripe rows are refused by this route.",
  });
  await prisma.transaction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
