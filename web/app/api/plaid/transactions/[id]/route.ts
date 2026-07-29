import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// PATCH /api/plaid/transactions/[id]
//
// Owner review of a single bank row:
//   - categoryOverride  → owner-picked expense category (never auto-applied)
//   - markedAsTransfer  → transfer between club's own accounts (not income
//                          or expense)
//   - excludedFromTax   → keep on the ledger but drop from Tax Summary
//   - notes             → free-form
//   - reviewed          → true stamps reviewedAt + reviewedByUserId
//
// finances:full only.
const schema = z.object({
  categoryOverride: z.string().nullable().optional(),
  markedAsTransfer: z.boolean().optional(),
  excludedFromTax: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  reviewed: z.boolean().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const row = await prisma.plaidTransaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const patch: Record<string, unknown> = {};
  if (data.categoryOverride !== undefined) patch.categoryOverride = data.categoryOverride || null;
  if (data.markedAsTransfer !== undefined) patch.markedAsTransfer = data.markedAsTransfer;
  if (data.excludedFromTax !== undefined) patch.excludedFromTax = data.excludedFromTax;
  if (data.notes !== undefined) patch.notes = data.notes || null;
  if (data.reviewed !== undefined) {
    patch.reviewedAt = data.reviewed ? new Date() : null;
    patch.reviewedByUserId = data.reviewed ? session.user.id ?? null : null;
  }

  const updated = await prisma.plaidTransaction.update({
    where: { id: row.id },
    data: patch,
  });
  return NextResponse.json(updated);
}
