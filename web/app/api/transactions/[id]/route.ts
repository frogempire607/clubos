import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
    select: { id: true, amount: true, refundedAmount: true, refundedAt: true },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
    select: { id: true, manual: true },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!tx.manual) {
    return NextResponse.json(
      { error: "Stripe transactions can't be deleted. Only manual entries can be removed." },
      { status: 400 },
    );
  }
  await prisma.transaction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
