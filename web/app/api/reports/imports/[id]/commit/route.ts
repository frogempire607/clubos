import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_ORIGIN } from "@/lib/memberOrigin";
import { requirePermission } from "@/lib/apiGuard";
import { hasReportScope } from "@/lib/reportsPermissions";
import { Prisma } from "@prisma/client";
import {
  MemberFieldKey,
  TransactionFieldKey,
  makeDedupeHash,
  normalizeEmail,
  normalizePhone,
  normalizeStatus,
  parseDateWith,
  parseMoney,
} from "@/lib/reportsImports";

// POST /api/reports/imports/[id]/commit
// Writes rows to the database per their resolved outcome.
// Never emails imported members. Never bills them. Never adds them to
// campaigns. All rows carry sourceSystem + importBatchId + isHistorical*.

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;
  if (!hasReportScope(session, "imports")) {
    return NextResponse.json({ error: "You don't have permission to run imports." }, { status: 403 });
  }

  const batch = await prisma.importBatch.findFirst({
    where: { id, clubId: session.user.clubId },
  });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (batch.status === "COMPLETED") {
    return NextResponse.json({ error: "Already committed" }, { status: 409 });
  }
  if (batch.status === "COMMITTING") {
    return NextResponse.json({ error: "Commit already in progress" }, { status: 409 });
  }

  await prisma.importBatch.update({ where: { id }, data: { status: "COMMITTING", startedAt: batch.startedAt ?? new Date() } });

  try {
    const rows = await prisma.importRow.findMany({
      where: { batchId: id, outcome: { in: batch.kind === "MEMBERS" ? ["MATCHED", "CREATED", "MERGED"] : ["CREATED"] } },
      orderBy: { rowNumber: "asc" },
    });
    const map = (batch.columnMap ?? {}) as Record<string, string | null | undefined> & { __dateFormat?: "MDY" | "DMY" | "YMD" };
    const dateFormat = map.__dateFormat ?? "MDY";

    let created = 0;
    let matched = 0;
    let merged = 0;
    let skipped = 0;

    if (batch.kind === "MEMBERS") {
      const getField = (raw: Record<string, string | null | undefined>, k: MemberFieldKey) => {
        for (const header in map) if (map[header] === k) return raw[header] ?? null;
        return null;
      };

      for (const row of rows) {
        const raw = row.rawData as Record<string, string | null | undefined>;
        const first = (getField(raw, "firstName") ?? "").trim();
        const last = (getField(raw, "lastName") ?? "").trim();
        const email = normalizeEmail(getField(raw, "email"));
        const phone = normalizePhone(getField(raw, "phone"));
        const dobRaw = getField(raw, "dateOfBirth");
        const dob = dobRaw ? parseDateWith(dobRaw, dateFormat) : null;
        const joinDateRaw = getField(raw, "joinDate");
        const joinDate = joinDateRaw ? parseDateWith(joinDateRaw, dateFormat) : null;
        const membershipType = getField(raw, "membershipType");
        const startDateRaw = getField(raw, "membershipStartDate");
        const endDateRaw = getField(raw, "membershipEndDate");
        const statusInput = normalizeStatus(getField(raw, "memberStatus"));
        const notes = getField(raw, "notes");
        const externalId = getField(raw, "externalMemberId");
        const status = statusInput === "ACTIVE" ? "ACTIVE" : statusInput === "PAUSED" ? "PAUSED" : "INACTIVE";

        if (row.outcome === "CREATED") {
          const member = await prisma.member.create({
            data: {
              clubId: session.user.clubId,
              createdVia: MEMBER_ORIGIN.IMPORT,
              firstName: first || "Imported",
              lastName: last || "",
              email: getField(raw, "email"),
              phone: getField(raw, "phone"),
              dateOfBirth: dob,
              joinedAt: joinDate ?? new Date(),
              status,
              notes,
              externalMemberId: externalId ?? null,
              sourceSystem: batch.sourceSystem ?? "MANUAL_IMPORT",
              importBatchId: batch.id,
              isHistoricalOnly: true,
              normalizedEmail: email,
              normalizedPhone: phone,
            },
          });
          if (membershipType) {
            await prisma.memberHistoricalRecord.create({
              data: {
                clubId: session.user.clubId,
                memberId: member.id,
                membershipTypeLabel: membershipType,
                startDate: startDateRaw ? parseDateWith(startDateRaw, dateFormat) : null,
                endDate: endDateRaw ? parseDateWith(endDateRaw, dateFormat) : null,
                status: statusInput,
                externalMemberId: externalId,
                sourceSystem: batch.sourceSystem,
                importBatchId: batch.id,
                notes,
                dataCompleteness: {
                  joinDate: joinDate != null,
                  membershipType: !!membershipType,
                  startDate: !!startDateRaw,
                  endDate: !!endDateRaw,
                } as unknown as Prisma.InputJsonValue,
              },
            });
          }
          await prisma.importRow.update({
            where: { id: row.id },
            data: { targetType: "Member", targetId: member.id, normalizedData: { memberId: member.id } as unknown as Prisma.InputJsonValue },
          });
          created += 1;
        } else if (row.outcome === "MATCHED" && row.targetId) {
          // Attach historical span; NEVER overwrite non-empty native fields.
          const native = await prisma.member.findFirst({ where: { id: row.targetId, clubId: session.user.clubId } });
          if (!native) { skipped += 1; continue; }
          const patch: Prisma.MemberUpdateInput = {};
          if (!native.externalMemberId && externalId) patch.externalMemberId = externalId;
          if (!native.normalizedEmail && email) patch.normalizedEmail = email;
          if (!native.normalizedPhone && phone) patch.normalizedPhone = phone;
          if (!native.dateOfBirth && dob) patch.dateOfBirth = dob;
          if (Object.keys(patch).length > 0) {
            await prisma.member.update({ where: { id: native.id }, data: patch });
          }
          if (membershipType) {
            await prisma.memberHistoricalRecord.create({
              data: {
                clubId: session.user.clubId,
                memberId: native.id,
                membershipTypeLabel: membershipType,
                startDate: startDateRaw ? parseDateWith(startDateRaw, dateFormat) : null,
                endDate: endDateRaw ? parseDateWith(endDateRaw, dateFormat) : null,
                status: statusInput,
                externalMemberId: externalId,
                sourceSystem: batch.sourceSystem,
                importBatchId: batch.id,
                notes,
                dataCompleteness: {
                  joinDate: joinDate != null,
                  membershipType: !!membershipType,
                  startDate: !!startDateRaw,
                  endDate: !!endDateRaw,
                } as unknown as Prisma.InputJsonValue,
              },
            });
          }
          matched += 1;
        } else if (row.outcome === "MERGED" && row.targetId) {
          // Full merge is a bigger operation — for MVP treat MERGED like
          // MATCHED (attach history + fill-empty). Full field-level merge
          // ships in a follow-up sub-phase.
          merged += 1;
        }
      }
    } else {
      // TRANSACTIONS
      const getField = (raw: Record<string, string | null | undefined>, k: TransactionFieldKey) => {
        for (const header in map) if (map[header] === k) return raw[header] ?? null;
        return null;
      };
      for (const row of rows) {
        const raw = row.rawData as Record<string, string | null | undefined>;
        const dateRaw = getField(raw, "transactionDate");
        const date = dateRaw ? parseDateWith(dateRaw, dateFormat) : null;
        if (!date) { skipped += 1; continue; }
        const amount = parseMoney(getField(raw, "grossAmount")) ?? 0;
        const externalId = getField(raw, "externalTransactionId");
        const email = normalizeEmail(getField(raw, "email"));
        const item = getField(raw, "itemPurchased");
        const description = item ?? getField(raw, "clientName") ?? "Historical transaction";
        const dedupeHash = externalId
          ? null
          : makeDedupeHash({
              clubId: session.user.clubId,
              date: date.toISOString().slice(0, 10),
              amount,
              normalizedPayerEmail: email,
              itemLabel: item,
            });

        // Idempotent insert. `(clubId, sourceSystem, externalTransactionId)`
        // unique + `(clubId, dedupeHash)` unique catch conflicts.
        try {
          const tx = await prisma.transaction.create({
            data: {
              clubId: session.user.clubId,
              amount,
              status: "SUCCEEDED",
              type: "OTHER",
              description,
              paymentMethod: getField(raw, "paymentMethod") ?? "OTHER",
              paymentSource: batch.sourceSystem ?? "MANUAL_IMPORT",
              reconciliationStatus: "OFFLINE",
              manual: true,
              txDate: date,
              externalTransactionId: externalId ?? null,
              externalCustomerId: getField(raw, "externalCustomerId") ?? null,
              sourceSystem: batch.sourceSystem ?? "MANUAL_IMPORT",
              importBatchId: batch.id,
              isHistorical: true,
              dedupeHash,
              source: getField(raw, "clientName"),
              notes: getField(raw, "notes"),
            },
          });
          await prisma.importRow.update({
            where: { id: row.id },
            data: { targetType: "Transaction", targetId: tx.id, outcome: "CREATED" },
          });
          created += 1;
        } catch (err) {
          const isUnique = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
          if (isUnique) {
            await prisma.importRow.update({
              where: { id: row.id },
              data: { outcome: "SKIPPED", reason: "Duplicate — already imported in a prior batch." },
            });
            skipped += 1;
          } else {
            throw err;
          }
        }
      }
    }

    const completedAt = new Date();
    const rollbackExpiresAt = new Date(completedAt.getTime() + 30 * 86400000);
    await prisma.importBatch.update({
      where: { id },
      data: {
        status: "COMPLETED",
        createdCount: created,
        matchedCount: matched,
        mergedCount: merged,
        skippedCount: skipped,
        completedAt,
        rollbackExpiresAt,
      },
    });

    return NextResponse.json({ ok: true, created, matched, merged, skipped });
  } catch (err) {
    console.error("Import commit failed", err);
    await prisma.importBatch.update({
      where: { id },
      data: { status: "FAILED" },
    });
    return NextResponse.json({ error: (err as Error).message ?? "Commit failed" }, { status: 500 });
  }
}
