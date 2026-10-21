import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBankRead } from "@/lib/plaidGate";
import { prisma } from "@/lib/prisma";
import { requireTierFeature } from "@/lib/tierGuard";

// PATCH /api/plaid/connections/[id] — rename the bank connection. The
// label is the friendly name owners use to tell their accounts apart
// (e.g. "Operating", "Foundation", "Savings").
const patchSchema = z.object({ label: z.string().max(80).nullable() });

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Read gate, not the connect gate: renaming a connection you already have is
  // tidying your own data, which the downgrade rule keeps available.
  const tierGate = await requireBankRead(session.user.clubId);
  if (tierGate) return tierGate;

  const conn = await prisma.plaidConnection.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { label } = patchSchema.parse(await req.json());
    const updated = await prisma.plaidConnection.update({
      where: { id: conn.id },
      data: { label: label?.trim() || null },
    });
    return NextResponse.json({ id: updated.id, label: updated.label });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

// DELETE /api/plaid/connections/[id] — soft-delete the connection. We
// don't revoke the Plaid access token automatically so the owner can
// reconnect with the same institution later if needed.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // DELIBERATELY NOT TIER-GATED (Phase 11 task 8, 2026-10-21).
  //
  // This used to require `plaid`, which meant a club that dropped to Starter
  // could not disconnect its own bank — its access token stayed live on disk
  // with no way to unplug it through the product. Unplugging must always be
  // available; gating it is how you trap somebody. Still owner-only, still
  // club-scoped, and still a soft delete that keeps the history.

  const conn = await prisma.plaidConnection.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.plaidConnection.update({
    where: { id: conn.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
