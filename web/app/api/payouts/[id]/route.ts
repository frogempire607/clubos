import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { PAYOUT_STATUSES, PAYOUT_METHODS } from "@/lib/payouts";

const patchSchema = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  method: z.enum(PAYOUT_METHODS).optional().nullable(),
  amount: z.number().positive().max(1_000_000).optional(),
  paidAt: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

// PATCH /api/payouts/[id]  (finances:full) — mark paid / void, edit amount/notes.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const existing = await prisma.payout.findFirst({ where: { id, clubId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const update: Record<string, unknown> = {};
  if (data.method !== undefined) update.method = data.method;
  if (data.amount !== undefined) update.amount = data.amount;
  if (data.notes !== undefined) update.notes = data.notes;

  if (data.status !== undefined) {
    update.status = data.status;
    if (data.status === "PAID") {
      // Stamp paidAt when marking paid (unless an explicit date was given).
      update.paidAt = data.paidAt ? new Date(data.paidAt) : existing.paidAt ?? new Date();
    } else if (data.status === "PENDING") {
      update.paidAt = null;
    }
    // VOID leaves paidAt untouched (preserves the record of when it was paid).
  } else if (data.paidAt !== undefined) {
    update.paidAt = data.paidAt ? new Date(data.paidAt) : null;
  }

  const payout = await prisma.payout.update({ where: { id }, data: update });
  return NextResponse.json({ ...payout, amount: Number(payout.amount) });
}

// DELETE /api/payouts/[id]  (finances:full) — remove a ledger entry.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const existing = await prisma.payout.findFirst({ where: { id, clubId }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.payout.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
