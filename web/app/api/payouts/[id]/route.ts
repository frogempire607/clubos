import { NextResponse } from "next/server";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive, isOwnerLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { PAYOUT_STATUSES, PAYOUT_METHODS } from "@/lib/payouts";

// A row with no staff member and no contractor behind it was paid to a typed-in
// name; the self rule cannot see who that is, so only an owner touches it
// (same rule as creating one — POST /api/payouts).
const FREE_TEXT_DENIED = () =>
  NextResponse.json(
    { error: "Only an owner can change a payout made to a typed-in name.", code: "OWNER_REQUIRED" },
    { status: 403 },
  );

const snapshot = (p: { id: string; payeeName: string; payeeType: string; amount: unknown; status: string; method: string | null; paidAt: Date | null; kind: string; eventId: string | null }) => ({
  id: p.id, payeeName: p.payeeName, payeeType: p.payeeType, amount: Number(p.amount), status: p.status,
  method: p.method, paidAt: p.paidAt ? p.paidAt.toISOString() : null, kind: p.kind, eventId: p.eventId,
});

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
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const existing = await prisma.payout.findFirst({ where: { id, clubId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.payeeUserId && selfRule(session!.user.role, session!.user.id, existing.payeeUserId, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  if (!existing.payeeUserId && !existing.contractorId && !(await isOwnerLive(session))) return FREE_TEXT_DENIED();

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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
  // A PAID row is ledger history. Editing it is allowed (the ledger is not
  // being redesigned here) but never silently: who, what it was, what it is now.
  if (existing.status === "PAID") {
    await writeBillingAudit({
      clubId,
      actorUserId: session!.user.id ?? null,
      action: "PAYOUT_PAID_EDITED",
      before: snapshot(existing),
      after: snapshot(payout),
      note: `A paid payout to ${existing.payeeName} was edited.`,
    });
  }
  return NextResponse.json({ ...payout, amount: Number(payout.amount) });
}

// DELETE /api/payouts/[id]  (finances:full) — remove a ledger entry.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const existing = await prisma.payout.findFirst({ where: { id, clubId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.payeeUserId && selfRule(session!.user.role, session!.user.id, existing.payeeUserId, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  if (!existing.payeeUserId && !existing.contractorId && !(await isOwnerLive(session))) return FREE_TEXT_DENIED();

  await prisma.payout.delete({ where: { id } });
  // Deleting a PAID row removes money that was recorded as paid — keep the
  // record of what it was and who removed it.
  if (existing.status === "PAID") {
    await writeBillingAudit({
      clubId,
      actorUserId: session!.user.id ?? null,
      action: "PAYOUT_PAID_DELETED",
      before: snapshot(existing),
      note: `A paid payout to ${existing.payeeName} was deleted.`,
    });
  }
  return NextResponse.json({ ok: true });
}
