import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { hasReportScope } from "@/lib/reportsPermissions";

// POST /api/reports/imports/[id]/rollback
// Owner-only, 30-day window. `CREATED` members without dependent activity
// are hard-deleted; those with activity are downgraded to isHistoricalOnly.
// Historical records + imported transactions are hard-deleted (they have
// no downstream dependents).
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;
  if (!hasReportScope(session, "rollback")) {
    return NextResponse.json({ error: "You don't have permission to roll back imports." }, { status: 403 });
  }

  const batch = await prisma.importBatch.findFirst({ where: { id, clubId: session.user.clubId } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (batch.status !== "COMPLETED") {
    return NextResponse.json({ error: "Batch is not completed." }, { status: 409 });
  }
  if (!batch.rollbackExpiresAt || batch.rollbackExpiresAt < new Date()) {
    return NextResponse.json({ error: "Rollback window (30 days) has expired." }, { status: 409 });
  }

  const memberRows = await prisma.importRow.findMany({
    where: { batchId: id, targetType: "Member", targetId: { not: null } },
    select: { id: true, targetId: true, outcome: true },
  });
  const txRows = await prisma.importRow.findMany({
    where: { batchId: id, targetType: "Transaction", targetId: { not: null } },
    select: { id: true, targetId: true, outcome: true },
  });

  let removedMembers = 0;
  let downgradedMembers = 0;
  let removedTx = 0;
  let removedHistorical = 0;

  // Historical records — always safe to delete.
  const h = await prisma.memberHistoricalRecord.deleteMany({ where: { importBatchId: id } });
  removedHistorical = h.count;

  // Imported transactions — safe to delete (isHistorical=true, never
  // referenced by bookings/attendance downstream).
  for (const row of txRows) {
    if (!row.targetId) continue;
    try {
      await prisma.transaction.delete({ where: { id: row.targetId } });
      removedTx += 1;
    } catch {
      // Ignore — row may have already been removed manually.
    }
  }

  // Members created by this batch. Downgrade to isHistoricalOnly when
  // dependents exist; hard-delete when clean.
  for (const row of memberRows) {
    if (!row.targetId || row.outcome !== "CREATED") continue;
    const dependents = await prisma.$transaction([
      prisma.booking.count({ where: { memberId: row.targetId } }),
      prisma.attendanceRecord.count({ where: { memberId: row.targetId } }),
      prisma.memberSubscription.count({ where: { memberId: row.targetId } }),
      prisma.transaction.count({ where: { memberId: row.targetId, importBatchId: null } }),
      prisma.documentSignature.count({ where: { memberId: row.targetId } }),
    ]);
    const hasActivity = dependents.some((n) => n > 0);
    if (hasActivity) {
      await prisma.member.update({
        where: { id: row.targetId },
        data: { isHistoricalOnly: true, status: "INACTIVE", notes: `Kept after import rollback — has activity since import.` },
      });
      downgradedMembers += 1;
    } else {
      try {
        await prisma.member.delete({ where: { id: row.targetId } });
        removedMembers += 1;
      } catch {
        // FK constraint — keep and downgrade.
        await prisma.member.update({
          where: { id: row.targetId },
          data: { isHistoricalOnly: true, status: "INACTIVE" },
        });
        downgradedMembers += 1;
      }
    }
  }

  await prisma.importBatch.update({
    where: { id },
    data: {
      status: "ROLLED_BACK",
      rolledBackAt: new Date(),
    },
  });

  return NextResponse.json({
    ok: true,
    removedMembers,
    downgradedMembers,
    removedTx,
    removedHistorical,
  });
}
