import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/reports/imports/[id]/preview?limit=50
// Returns the first N rows as they would be stored, with outcome + errors.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const batch = await prisma.importBatch.findFirst({ where: { id, clubId: session.user.clubId } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));

  const rows = await prisma.importRow.findMany({
    where: { batchId: id },
    orderBy: { rowNumber: "asc" },
    take: limit,
  });
  const summary = await prisma.importRow.groupBy({
    by: ["outcome"],
    where: { batchId: id },
    _count: { _all: true },
  });

  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      rowNumber: r.rowNumber,
      rawData: r.rawData,
      outcome: r.outcome,
      reason: r.reason,
      errors: r.errors,
    })),
    summary: summary.reduce<Record<string, number>>((acc, s) => {
      acc[s.outcome] = s._count._all;
      return acc;
    }, {}),
    batch: {
      id: batch.id,
      kind: batch.kind,
      status: batch.status,
      rowCount: batch.rowCount,
      sourceLabel: batch.sourceLabel,
    },
  });
}
