import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/reports/imports/[id]/review/[rowId]
// Owner picks one of five outcomes for a review row (specs/04 §step 5).

const schema = z.object({
  outcome: z.enum(["MATCHED", "MERGED", "CREATED", "SKIPPED", "EXCLUDED"]),
  targetId: z.string().optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string; rowId: string }> }) {
  const { id, rowId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const row = await prisma.importRow.findFirst({
    where: { id: rowId, batchId: id, clubId: session.user.clubId },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.importRow.update({
    where: { id: rowId },
    data: {
      outcome: parsed.data.outcome,
      targetType: parsed.data.outcome === "EXCLUDED" || parsed.data.outcome === "SKIPPED" ? null : "Member",
      targetId: parsed.data.targetId ?? null,
      decidedBy: session.user.id,
      decidedAt: new Date(),
      reason: `Owner picked ${parsed.data.outcome}`,
    },
  });

  return NextResponse.json({ ok: true });
}
