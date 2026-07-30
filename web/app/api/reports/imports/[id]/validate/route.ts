import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { Prisma } from "@prisma/client";
import {
  MemberFieldKey,
  TransactionFieldKey,
  validateMemberRow,
  validateTransactionRow,
} from "@/lib/reportsImports";

// POST /api/reports/imports/[id]/validate
// Runs every row through the row-level validator and records the results.
// Returns { readyCount, reviewCount, errorCount, errorGroups[], warnings[] }.

type Grouped = Map<string, { count: number; sampleRowNumbers: number[]; sampleValue: string | null }>;

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const batch = await prisma.importBatch.findFirst({ where: { id, clubId: session.user.clubId } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rows = await prisma.importRow.findMany({ where: { batchId: id }, orderBy: { rowNumber: "asc" } });
  const map = (batch.columnMap ?? {}) as Record<string, string | null | undefined> & { __dateFormat?: "MDY" | "DMY" | "YMD" };
  const dateFormat = map.__dateFormat ?? "MDY";

  const errorGroups: Grouped = new Map();
  const warningGroups: Grouped = new Map();
  let ready = 0;
  let errored = 0;

  // Fresh validation — patch outcomes as we go.
  await prisma.$transaction(
    rows.map((r) => {
      const values = r.rawData as Record<string, string | null | undefined>;
      const fieldsMap: Record<string, string | null> = Object.fromEntries(
        Object.entries(map).filter(([k]) => k !== "__dateFormat"),
      ) as Record<string, string | null>;
      const validation =
        batch.kind === "MEMBERS"
          ? validateMemberRow(values, fieldsMap as Record<string, MemberFieldKey | null>, dateFormat)
          : validateTransactionRow(values, fieldsMap as Record<string, TransactionFieldKey | null>, dateFormat);
      for (const e of validation.errors) group(errorGroups, e.field ?? e.message, e.message, r.rowNumber, values[e.field ?? ""] ?? null);
      for (const w of validation.warnings) group(warningGroups, w.field ?? w.message, w.message, r.rowNumber, values[w.field ?? ""] ?? null);
      const willError = validation.errors.length > 0;
      if (willError) errored += 1;
      else ready += 1;
      const errorJson: Prisma.InputJsonValue | typeof Prisma.DbNull =
        validation.errors.length > 0
          ? (validation.errors as unknown as Prisma.InputJsonValue)
          : validation.warnings.length > 0
            ? (validation.warnings as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull;
      return prisma.importRow.update({
        where: { id: r.id },
        data: {
          outcome: willError ? "EXCLUDED" : "PENDING_REVIEW",
          errors: errorJson,
          reason: willError ? validation.errors[0].message : null,
        },
      });
    }),
  );

  await prisma.importBatch.update({
    where: { id },
    data: { status: "AWAITING_REVIEW", errorCount: errored, reviewCount: ready, startedAt: batch.startedAt ?? new Date() },
  });

  return NextResponse.json({
    readyCount: ready,
    reviewCount: ready,
    errorCount: errored,
    errorGroups: Array.from(errorGroups.entries()).map(([k, v]) => ({ kind: k, ...v })),
    warnings: Array.from(warningGroups.entries()).map(([k, v]) => ({ kind: k, ...v })),
  });
}

function group(map: Grouped, key: string, message: string, rowNumber: number, sample: string | null) {
  const entry = map.get(key) ?? { count: 0, sampleRowNumbers: [], sampleValue: sample };
  entry.count += 1;
  if (entry.sampleRowNumbers.length < 3) entry.sampleRowNumbers.push(rowNumber);
  map.set(`${message}`, entry);
}
