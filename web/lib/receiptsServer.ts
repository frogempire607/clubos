// Receipt inbox — the database side (2026-10-14). Pure rules: lib/receipts.ts.
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { putObject } from "@/lib/storage";
import { receiptHintsFromFileName, suggestMatches, type BankRowLite } from "@/lib/receipts";

export const RECEIPT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "application/pdf",
]);
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Store one receipt file (private: only finances:view can open it) and its inbox row. */
export async function addReceipt(args: { clubId: string; userId: string | null; fileName: string; mimeType: string; buf: Buffer }) {
  const ext = args.fileName.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const storageKey = `${randomBytes(16).toString("hex")}.${ext}`;
  await putObject(storageKey, args.buf, args.mimeType);
  const file = await prisma.uploadedFile.create({
    data: { clubId: args.clubId, uploaderId: args.userId, storageKey, originalName: args.fileName.slice(0, 200), mimeType: args.mimeType, sizeBytes: args.buf.length, kind: "RECEIPT" },
  });
  const hints = receiptHintsFromFileName(args.fileName);
  return prisma.receipt.create({
    data: {
      clubId: args.clubId, fileId: file.id, fileName: args.fileName.slice(0, 200), mimeType: args.mimeType,
      vendor: hints.vendor, amount: hints.amount === null ? null : new Prisma.Decimal(hints.amount),
      receiptDate: hints.date ? new Date(`${hints.date}T00:00:00Z`) : null, uploadedByUserId: args.userId, status: "UNMATCHED",
    },
  });
}

export type ReceiptView = {
  id: string; fileName: string; mimeType: string; url: string; vendor: string | null; amount: number | null; date: string | null;
  notes: string | null; status: string; legalEntityId: string | null; createdAt: string;
  matched: { id: string; date: string; amount: number; name: string; account: string } | null;
  suggestions: { rowId: string; score: number; why: string[]; date: string; amount: number; name: string; account: string }[];
};

/** The inbox. `status` = UNMATCHED (default) | MATCHED | IGNORED | ALL. */
export async function listReceipts(clubId: string, status = "UNMATCHED"): Promise<ReceiptView[]> {
  const receipts = await prisma.receipt.findMany({
    where: { clubId, ...(status === "ALL" ? {} : { status }) },
    orderBy: [{ createdAt: "desc" }],
    take: 300,
  });
  // Candidate bank rows: money out within a week of any receipt date (or the
  // last 18 months for receipts with only an amount).
  const dated = receipts.filter((r) => r.receiptDate).map((r) => r.receiptDate!.getTime());
  const from = new Date(Math.min(Date.now() - 548 * 86_400_000, ...dated.map((t) => t - 8 * 86_400_000)));
  const to = new Date(Math.max(Date.now(), ...dated.map((t) => t + 8 * 86_400_000)));
  const needRows = receipts.some((r) => r.status === "UNMATCHED") || receipts.some((r) => r.plaidTransactionId);
  const rows = needRows
    ? await prisma.plaidTransaction.findMany({
        where: { clubId, amount: { gt: 0 }, date: { gte: from, lte: to } },
        select: { id: true, date: true, amount: true, name: true, merchantName: true, connection: { select: { label: true, institutionName: true } } },
      })
    : [];
  const withReceipt = new Set(receipts.filter((r) => r.status === "MATCHED" && r.plaidTransactionId).map((r) => r.plaidTransactionId!));
  const lite: BankRowLite[] = rows.map((r) => ({ id: r.id, date: ymd(r.date), amount: Number(r.amount), name: r.name, merchantName: r.merchantName, hasReceipt: withReceipt.has(r.id) }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const show = (id: string) => {
    const r = byId.get(id);
    return r ? { id: r.id, date: ymd(r.date), amount: Number(r.amount), name: r.merchantName || r.name, account: r.connection.label || r.connection.institutionName || "Bank" } : null;
  };
  // A matched receipt's row may be outside the candidate window — fetch those directly.
  const missing = receipts.filter((r) => r.plaidTransactionId && !byId.has(r.plaidTransactionId)).map((r) => r.plaidTransactionId!);
  if (missing.length) {
    const extra = await prisma.plaidTransaction.findMany({
      where: { clubId, id: { in: missing } },
      select: { id: true, date: true, amount: true, name: true, merchantName: true, connection: { select: { label: true, institutionName: true } } },
    });
    for (const e of extra) byId.set(e.id, e);
  }
  return receipts.map((r) => {
    const base = {
      id: r.id, fileName: r.fileName, mimeType: r.mimeType, url: `/api/financials/receipts/${r.id}/file`,
      vendor: r.vendor, amount: r.amount === null ? null : Number(r.amount), date: r.receiptDate ? ymd(r.receiptDate) : null,
      notes: r.notes, status: r.status, legalEntityId: r.legalEntityId, createdAt: r.createdAt.toISOString(),
    };
    const matched = r.plaidTransactionId ? show(r.plaidTransactionId) : null;
    const suggestions = r.status === "UNMATCHED"
      ? suggestMatches({ amount: base.amount, date: base.date, vendor: base.vendor }, lite).map((s) => ({ ...s, ...show(s.rowId)! }))
      : [];
    return { ...base, matched, suggestions };
  });
}

/** Attach a receipt to a bank row (the owner confirmed it). */
export async function matchReceipt(clubId: string, id: string, rowId: string, userId: string | null) {
  const [rc, row] = await Promise.all([
    prisma.receipt.findFirst({ where: { id, clubId }, select: { id: true } }),
    prisma.plaidTransaction.findFirst({ where: { id: rowId, clubId }, select: { id: true, legalEntityId: true } }),
  ]);
  if (!rc || !row) return false;
  await prisma.receipt.update({
    where: { id: rc.id },
    data: { status: "MATCHED", plaidTransactionId: row.id, legalEntityId: row.legalEntityId, matchedAt: new Date(), matchedByUserId: userId },
  });
  return true;
}
