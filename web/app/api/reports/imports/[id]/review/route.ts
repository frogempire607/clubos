import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import type { Prisma, PrismaPromise } from "@prisma/client";
import {
  MemberFieldKey,
  normalizeEmail,
  normalizePhone,
  parseDateWith,
} from "@/lib/reportsImports";
import {
  loadMatchCache,
  resolveMatch,
  type MatchOutcome,
} from "@/lib/reportsImportsMatch";

// GET /api/reports/imports/[id]/review?cursor=
// Returns rows that need owner review (MATCH_REVIEW). Called from wizard step 5.
//
// This endpoint also RUNS the matching pass on first call — it fills in
// each row's `matchSignal`/`confidence`/`targetId` when the resolver picks
// an auto-match, and leaves REVIEW rows queued for the owner.

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
  if (batch.kind !== "MEMBERS") {
    return NextResponse.json({ items: [], total: 0, reviewed: 0, note: "Transaction imports dedupe by external ID + fingerprint — no per-row review needed." });
  }

  const cache = await loadMatchCache(session.user.clubId);
  const map = (batch.columnMap ?? {}) as Record<string, string | null | undefined> & { __dateFormat?: "MDY" | "DMY" | "YMD" };
  const dateFormat = map.__dateFormat ?? "MDY";
  const getField = (row: Record<string, string | null | undefined>, k: MemberFieldKey): string | null => {
    for (const header in map) if (map[header] === k) return (row[header] ?? null) as string | null;
    return null;
  };

  // Idempotent matching pass — only rows still PENDING_REVIEW with no
  // decision get considered.
  const rows = await prisma.importRow.findMany({
    where: { batchId: id, outcome: { in: ["PENDING_REVIEW"] } },
    orderBy: { rowNumber: "asc" },
  });
  const updates: Array<PrismaPromise<unknown>> = [];
  const reviewItems: Array<{ rowNumber: number; rowId: string; input: Record<string, string | null>; outcome: MatchOutcome }> = [];
  for (const row of rows) {
    const raw = row.rawData as Record<string, string | null | undefined>;
    const input = {
      firstName: getField(raw, "firstName"),
      lastName: getField(raw, "lastName"),
      email: normalizeEmail(getField(raw, "email")),
      phone: normalizePhone(getField(raw, "phone")),
      dateOfBirth: getField(raw, "dateOfBirth") ? parseDateWith(getField(raw, "dateOfBirth"), dateFormat) : null,
      externalMemberId: getField(raw, "externalMemberId"),
    };
    const outcome = resolveMatch(input, cache);
    if (outcome.kind === "AUTO_MATCH") {
      updates.push(
        prisma.importRow.update({
          where: { id: row.id },
          data: {
            outcome: "MATCHED",
            targetType: "Member",
            targetId: outcome.memberId,
            matchSignal: outcome.signal,
            confidence: outcome.confidence,
            reason: `Auto-matched by ${outcome.signal}`,
          },
        }),
      );
    } else if (outcome.kind === "CREATE") {
      updates.push(
        prisma.importRow.update({
          where: { id: row.id },
          data: {
            outcome: "CREATED",
            reason: outcome.reason,
            matchSignal: null,
            confidence: null,
          },
        }),
      );
    } else {
      reviewItems.push({
        rowNumber: row.rowNumber,
        rowId: row.id,
        input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null)])),
        outcome,
      });
    }
  }
  if (updates.length > 0) await prisma.$transaction(updates);

  // Load the candidate members for the review items so the UI can render
  // both sides.
  const candidateIds = new Set<string>();
  for (const item of reviewItems) if (item.outcome.kind === "REVIEW") for (const c of item.outcome.candidates) candidateIds.add(c.memberId);
  const candidateMembers =
    candidateIds.size > 0
      ? await prisma.member.findMany({
          where: { id: { in: Array.from(candidateIds) } },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, dateOfBirth: true, externalMemberId: true },
        })
      : [];
  const candById = new Map(candidateMembers.map((m) => [m.id, m]));

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor") ?? "0");
  const pageSize = 20;

  const reviewedRows = await prisma.importRow.count({
    where: { batchId: id, outcome: { notIn: ["PENDING_REVIEW"] } },
  });

  return NextResponse.json({
    items: reviewItems.slice(cursor, cursor + pageSize).map((item) => ({
      rowNumber: item.rowNumber,
      rowId: item.rowId,
      input: item.input,
      candidates:
        item.outcome.kind === "REVIEW"
          ? item.outcome.candidates.map((c) => ({
              memberId: c.memberId,
              signal: c.signal,
              reason: c.reason,
              member: candById.get(c.memberId) ?? null,
            }))
          : [],
      confidence: item.outcome.kind === "REVIEW" ? item.outcome.confidence : null,
    })),
    total: reviewItems.length,
    reviewed: reviewedRows,
    nextCursor: cursor + pageSize < reviewItems.length ? cursor + pageSize : null,
  });
}
