import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import crypto from "crypto";
import {
  autoMapMemberHeaders,
  autoMapTransactionHeaders,
  parseCsv,
} from "@/lib/reportsImports";

// GET /api/reports/imports  — history list.
// POST /api/reports/imports  — new upload:
//   multipart/form-data: file, kind (MEMBERS|TRANSACTIONS), sourceLabel, sourceSystem?
//   returns { batchId, headers[], sampleRows[], suggestedMap, rowCount, warning? }

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 50_000;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const batches = await prisma.importBatch.findMany({
    where: { clubId: session.user.clubId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, kind: true, status: true, sourceLabel: true, sourceSystem: true,
      fileName: true, rowCount: true, createdCount: true, matchedCount: true,
      mergedCount: true, skippedCount: true, errorCount: true, reviewCount: true,
      startedAt: true, completedAt: true, rolledBackAt: true, rollbackExpiresAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ batches });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const kindRaw = String(form?.get("kind") ?? "");
  const sourceLabel = String(form?.get("sourceLabel") ?? "").trim() || null;
  const sourceSystem = String(form?.get("sourceSystem") ?? "").trim() || null;
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (kindRaw !== "MEMBERS" && kindRaw !== "TRANSACTIONS") {
    return NextResponse.json({ error: "kind must be MEMBERS or TRANSACTIONS" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File too large. Max ${MAX_BYTES / (1024 * 1024)} MB.` }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(bytes);
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return NextResponse.json({ error: "CSV is empty or missing headers." }, { status: 400 });
  }
  if (rows.length - 1 > MAX_ROWS) {
    return NextResponse.json({ error: `Too many rows. Max ${MAX_ROWS.toLocaleString()}. Split the file.` }, { status: 400 });
  }

  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1);
  const suggestedMap = kindRaw === "MEMBERS" ? autoMapMemberHeaders(headers) : autoMapTransactionHeaders(headers);
  const sampleRows = dataRows.slice(0, 20).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null])));

  // sha256 the raw bytes.
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");

  // Warn on prior batch with same hash.
  const prior = await prisma.importBatch.findFirst({
    where: { clubId: session.user.clubId, fileHash },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, status: true },
  });
  const warning = prior
    ? `You uploaded this exact file on ${prior.createdAt.toLocaleDateString()}. Re-importing is safe; already-imported rows will be skipped.`
    : null;

  const batch = await prisma.importBatch.create({
    data: {
      clubId: session.user.clubId,
      kind: kindRaw,
      status: "DRAFT",
      sourceLabel,
      sourceSystem,
      fileName: file.name || "upload.csv",
      fileHash,
      rowCount: dataRows.length,
      columnMap: suggestedMap,
      createdById: session.user.id,
    },
    select: { id: true },
  });

  // Persist raw rows as ImportRow so we don't need to re-read the file
  // between wizard steps.
  await prisma.$transaction(
    dataRows.map((raw, i) =>
      prisma.importRow.create({
        data: {
          batchId: batch.id,
          clubId: session.user.clubId,
          rowNumber: i + 1,
          rawData: Object.fromEntries(headers.map((h, ii) => [h, raw[ii] ?? null])),
          outcome: "PENDING_REVIEW",
        },
      }),
    ),
  );

  return NextResponse.json({
    batchId: batch.id,
    headers,
    sampleRows,
    suggestedMap,
    rowCount: dataRows.length,
    warning,
  });
}
