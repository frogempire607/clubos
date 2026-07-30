import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { hasReportScope } from "@/lib/reportsPermissions";

// GET /api/reports/imports/[id]/log?cursor=&outcome=
// Paginated ImportRow list — the audit log surface for wizard step 7.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;
  if (!hasReportScope(session, "imports")) {
    return NextResponse.json({ error: "You don't have permission to run imports." }, { status: 403 });
  }

  const batch = await prisma.importBatch.findFirst({ where: { id, clubId: session.user.clubId }, select: { id: true } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor") ?? "0");
  const outcome = url.searchParams.get("outcome") ?? undefined;

  const pageSize = 100;
  const [rows, total] = await Promise.all([
    prisma.importRow.findMany({
      where: { batchId: id, ...(outcome ? { outcome } : {}) },
      orderBy: { rowNumber: "asc" },
      skip: cursor,
      take: pageSize,
    }),
    prisma.importRow.count({ where: { batchId: id, ...(outcome ? { outcome } : {}) } }),
  ]);

  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      rowNumber: r.rowNumber,
      outcome: r.outcome,
      reason: r.reason,
      matchSignal: r.matchSignal,
      confidence: r.confidence,
      targetType: r.targetType,
      targetId: r.targetId,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      errors: r.errors,
    })),
    total,
    nextCursor: cursor + pageSize < total ? cursor + pageSize : null,
  });
}
