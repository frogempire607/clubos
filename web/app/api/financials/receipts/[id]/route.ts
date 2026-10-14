import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { matchReceipt } from "@/lib/receiptsServer";

export const dynamic = "force-dynamic";

const schema = z.object({
  vendor: z.string().trim().max(80).nullable().optional(),
  amount: z.number().positive().max(1_000_000).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  /** Attach to this bank row (owner-confirmed). */
  matchRowId: z.string().min(1).optional(),
  unmatch: z.literal(true).optional(),
  ignore: z.boolean().optional(),
}).strict();

// PATCH /api/financials/receipts/[id] — edit what the receipt says, attach it
// to a bank row, detach it, or set it aside. finances:full.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const clubId = session.user.clubId;
  const rc = await prisma.receipt.findFirst({ where: { id, clubId }, select: { id: true } });
  if (!rc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const data: Prisma.ReceiptUpdateInput = {};
  if (body.vendor !== undefined) data.vendor = body.vendor || null;
  if (body.amount !== undefined) data.amount = body.amount === null ? null : new Prisma.Decimal(body.amount);
  if (body.date !== undefined) data.receiptDate = body.date ? new Date(`${body.date}T00:00:00Z`) : null;
  if (body.notes !== undefined) data.notes = body.notes || null;
  if (body.unmatch) Object.assign(data, { status: "UNMATCHED", plaidTransactionId: null, matchedAt: null, matchedByUserId: null });
  if (body.ignore !== undefined) Object.assign(data, body.ignore ? { status: "IGNORED", plaidTransactionId: null } : { status: "UNMATCHED" });
  if (Object.keys(data).length) await prisma.receipt.update({ where: { id: rc.id }, data });
  if (body.matchRowId) {
    const ok = await matchReceipt(clubId, rc.id, body.matchRowId, session.user.id ?? null);
    if (!ok) return NextResponse.json({ error: "That bank row wasn't found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/financials/receipts/[id] — remove a receipt from the inbox
// (not one that is attached to a bank row: detach it first). finances:full.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const rc = await prisma.receipt.findFirst({ where: { id, clubId: session.user.clubId }, select: { id: true, status: true } });
  if (!rc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (rc.status === "MATCHED") return NextResponse.json({ error: "Detach it from its bank row first." }, { status: 409 });
  await prisma.receipt.delete({ where: { id: rc.id } });
  return NextResponse.json({ ok: true });
}
