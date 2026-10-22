// Accounting Phase 3 — the opening-balance import and the QuickBooks history
// archive, written to the database.
//
// The opening entry goes through createEntry from lib/ledgerServer.ts, like
// every other entry: the lock date, the balance check and the audit trail all
// apply. The rules are in lib/glOpening.ts (pure).
//
// The history archive goes nowhere NEAR the ledger — see the comment on
// `importHistory` below.
//
// Parsing reuses readTable from lib/ledgerImportServer.ts and parseQbTable
// from lib/ledgerImport.ts. There are already two hand-rolled CSV parsers in
// this repo with different behaviour; a third would be a mistake.
//
// Every query is scoped by clubId.

import { prisma } from "@/lib/prisma";
import { LedgerError, createEntry, voidEntry, type Actor } from "@/lib/ledgerServer";
import { readTable } from "@/lib/ledgerImportServer";
import { parseQbTable } from "@/lib/ledgerImport";
import {
  type OpeningMapping,
  type ParsedTrialBalance,
  type TargetAccount,
  openingBlockers,
  openingDateFor,
  openingSourceId,
  parseTrialBalance,
  planOpeningEntry,
  suggestMapping,
} from "@/lib/glOpening";

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

async function targetAccounts(clubId: string): Promise<TargetAccount[]> {
  const rows = await prisma.glAccount.findMany({
    where: { clubId, active: true },
    select: { id: true, number: true, name: true, type: true },
    orderBy: { number: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    name: r.name,
    type: r.type as TargetAccount["type"],
  }));
}

// ── Opening balance ─────────────────────────────────────────────────────────

export type OpeningImportView = {
  id: string;
  fileName: string;
  status: string;
  asOfDate: string | null;
  createdAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  entryIds: string[];
  parsed: ParsedTrialBalance;
  mapping: OpeningMapping;
  accounts: TargetAccount[];
  plan: ReturnType<typeof planOpeningEntry> | null;
  blockers: ReturnType<typeof openingBlockers>;
  booksStartDate: string | null;
  lockedThrough: string | null;
  legalEntityId: string | null;
  legalEntityName: string | null;
  /// Set once any month has been closed: the import can no longer be replaced.
  hasClosedMonth: boolean;
};

/// Upload and parse. Nothing is posted — this creates a DRAFT with a suggested
/// mapping the owner then corrects.
export async function createOpeningDraft(
  clubId: string,
  fileName: string,
  buf: Buffer,
  actor: Actor,
): Promise<string> {
  const table = await readTable(fileName, buf);
  const parsed = parseTrialBalance(table);
  if (parsed.rows.length === 0) {
    throw new LedgerError(parsed.problems[0] ?? "Nothing could be read from that file.");
  }
  const targets = await targetAccounts(clubId);
  if (targets.length === 0) {
    throw new LedgerError(
      "This club has no chart of accounts yet. Seed it under Chart of Accounts before importing an opening balance.",
      409,
    );
  }
  const mapping = suggestMapping(parsed.accounts, targets);

  const row = await prisma.glOpeningImport.create({
    data: {
      clubId,
      fileName: fileName.slice(0, 250),
      status: "DRAFT",
      rows: parsed as unknown as object,
      mapping: mapping as unknown as object,
      createdByUserId: actor.userId,
    },
    select: { id: true },
  });
  return row.id;
}

export async function loadOpeningImport(
  clubId: string,
  id: string,
  opts?: { legalEntityId?: string | null },
): Promise<OpeningImportView> {
  const row = await prisma.glOpeningImport.findFirst({ where: { id, clubId } });
  if (!row) throw new LedgerError("That import doesn't exist.", 404);

  const [targets, club, retained, closes] = await Promise.all([
    targetAccounts(clubId),
    prisma.club.findUnique({
      where: { id: clubId },
      select: { booksStartDate: true, defaultLegalEntityId: true },
    }),
    prisma.glAccount.findFirst({
      where: { clubId, systemKey: "RETAINED_EARNINGS" },
      select: { id: true },
    }),
    prisma.glMonthClose.count({ where: { clubId, status: "CLOSED" } }),
  ]);

  const legalEntityId =
    opts?.legalEntityId ?? club?.defaultLegalEntityId ?? null;
  const [entity, lock] = await Promise.all([
    legalEntityId
      ? prisma.legalEntity.findFirst({ where: { id: legalEntityId, clubId }, select: { name: true } })
      : Promise.resolve(null),
    legalEntityId
      ? prisma.glLockDate.findFirst({
          where: { clubId, legalEntityId },
          select: { lockedThrough: true },
        })
      : Promise.resolve(null),
  ]);

  const parsed = row.rows as unknown as ParsedTrialBalance;
  const mapping = (row.mapping ?? {}) as OpeningMapping;
  const booksStartDate = club?.booksStartDate ? ymd(club.booksStartDate) : null;
  const asOfDate = row.asOfDate
    ? ymd(row.asOfDate)
    : booksStartDate
      ? openingDateFor(booksStartDate)
      : null;

  const plan = retained ? planOpeningEntry(parsed, mapping, targets, retained.id) : null;
  const lockedThrough = lock?.lockedThrough ? ymd(lock.lockedThrough) : null;

  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    asOfDate,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    entryIds: Array.isArray(row.entryIds) ? (row.entryIds as string[]) : [],
    parsed,
    mapping,
    accounts: targets,
    plan,
    blockers: plan
      ? openingBlockers({
          booksStartDate,
          asOfDate,
          lockedThrough,
          // Only blocks a REPLACEMENT. A first import into a club that has
          // somehow closed a month already is still refused, which is the
          // safe direction.
          hasClosedMonth: closes > 0,
          plan,
          parsed,
        })
      : [
          {
            code: "NO_RETAINED_EARNINGS",
            message:
              "This chart has no Retained Earnings account (normally 3900). Income and expense balances roll into it, so seed the chart of accounts first.",
          },
        ],
    booksStartDate,
    lockedThrough,
    legalEntityId,
    legalEntityName: entity?.name ?? null,
    hasClosedMonth: closes > 0,
  };
}

export async function saveOpeningMapping(
  clubId: string,
  id: string,
  mapping: OpeningMapping,
): Promise<void> {
  const row = await prisma.glOpeningImport.findFirst({
    where: { id, clubId },
    select: { id: true, status: true },
  });
  if (!row) throw new LedgerError("That import doesn't exist.", 404);
  if (row.status !== "DRAFT") {
    throw new LedgerError("This import has been posted. Void it first if the mapping was wrong.", 409);
  }
  await prisma.glOpeningImport.update({
    where: { id },
    data: { mapping: mapping as unknown as object },
  });
}

/// Post the opening entry — ONE per legal entity, dated the day before the
/// books start.
///
/// "One per entity" is the requirement, and this posts for the entity the
/// caller names. A club with two entities imports a trial balance per entity,
/// because QuickBooks exports one company file at a time: a single file that
/// mixed two entities could not be split without a per-row entity column that
/// QuickBooks does not print.
export async function postOpeningImport(
  clubId: string,
  id: string,
  legalEntityId: string | null,
  actor: Actor,
): Promise<{ entryId: string; asOfDate: string }> {
  const view = await loadOpeningImport(clubId, id, { legalEntityId });
  if (view.status === "POSTED") throw new LedgerError("This import is already posted.", 409);
  if (!view.plan) throw new LedgerError(view.blockers[0]?.message ?? "This import can't be posted.", 409);
  if (view.blockers.length > 0) {
    throw new LedgerError(view.blockers.map((b) => b.message).join(" "), 409);
  }
  if (!view.asOfDate) throw new LedgerError("There is no opening date to post to.", 409);

  const entry = await createEntry(
    clubId,
    {
      entryDate: view.asOfDate,
      memo: `Opening balance from QuickBooks — ${view.fileName}`,
      reference: "Opening balance",
      legalEntityId,
      sourceType: "OPENING_BALANCE",
      // Keyed on the import and the entity, so posting the same import twice
      // for the same entity hits the unique index rather than doubling the
      // club's opening position.
      sourceId: openingSourceId(id, legalEntityId),
      lines: view.plan.lines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        legalEntityId,
        memo: l.memo,
      })),
    },
    actor,
  );

  await prisma.glOpeningImport.update({
    where: { id },
    data: {
      status: "POSTED",
      asOfDate: asDate(view.asOfDate),
      entryIds: [...view.entryIds, entry.id] as unknown as object,
      summary: {
        totalDebitCents: view.plan.totalDebitCents,
        totalCreditCents: view.plan.totalCreditCents,
        retainedEarningsCents: view.plan.retainedEarningsCents,
        lineCount: view.plan.lines.length,
        skipped: view.plan.skipped.length,
      } as unknown as object,
      postedAt: new Date(),
      postedByUserId: actor.userId,
    },
  });

  return { entryId: entry.id, asOfDate: view.asOfDate };
}

/// Void a posted opening import, so it can be mapped again and re-imported.
///
/// The entry is REVERSED, never deleted — voidEntry writes a reversing entry
/// and keeps both, which is the Phase 1 rule and the only version of "undo"
/// an auditor accepts. Refused once a month has been closed: changing the
/// opening position then would change statements already signed off.
export async function voidOpeningImport(
  clubId: string,
  id: string,
  reason: string,
  actor: Actor,
): Promise<void> {
  const row = await prisma.glOpeningImport.findFirst({ where: { id, clubId } });
  if (!row) throw new LedgerError("That import doesn't exist.", 404);
  if (row.status !== "POSTED") throw new LedgerError("Only a posted import can be voided.", 409);

  const closed = await prisma.glMonthClose.count({ where: { clubId, status: "CLOSED" } });
  if (closed > 0) {
    throw new LedgerError(
      "A month has already been closed, so the opening balance can't be voided — it would change statements that have been signed off. Post a correcting journal entry instead.",
      409,
    );
  }

  const entryIds = Array.isArray(row.entryIds) ? (row.entryIds as string[]) : [];
  for (const entryId of entryIds) {
    // Already voided, or voided by hand in the Journal: not an error.
    try {
      await voidEntry(clubId, entryId, reason, actor);
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
    }
  }

  await prisma.glOpeningImport.update({
    where: { id },
    data: {
      status: "VOIDED",
      voidedAt: new Date(),
      voidedByUserId: actor.userId,
      voidReason: reason.trim().slice(0, 500),
    },
  });
}

export async function listOpeningImports(clubId: string) {
  const rows = await prisma.glOpeningImport.findMany({
    where: { clubId },
    select: {
      id: true,
      fileName: true,
      status: true,
      asOfDate: true,
      createdAt: true,
      postedAt: true,
      voidedAt: true,
      summary: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    ...r,
    asOfDate: r.asOfDate ? ymd(r.asOfDate) : null,
    createdAt: r.createdAt.toISOString(),
    postedAt: r.postedAt?.toISOString() ?? null,
    voidedAt: r.voidedAt?.toISOString() ?? null,
  }));
}

// ── The QuickBooks history archive (task 8) ─────────────────────────────────
//
// ⚠️  READ-ONLY. These rows NEVER post, NEVER appear in a statement, and no
// balance is ever derived from them. They exist so a club can answer "what did
// we pay that vendor in 2024?" after leaving QuickBooks, and for nothing else.
//
// The guarantee is structural rather than a promise: qbo_history_rows has no
// relation to any gl_* table, nothing in lib/glReports*.ts or
// lib/glPosting*.ts reads it, and scripts/gl-opening-tests.ts greps the
// reports and posting modules on every build to keep it that way.
//
// Parsing reuses parseQbTable — the same parser the existing QuickBooks
// importer uses, whose output shape (date, type, num, name, memo, account,
// split, amount) is exactly what the archive stores.

export type HistoryKind = "GENERAL_LEDGER" | "TRANSACTION_DETAIL" | "OTHER";

export async function importHistory(
  clubId: string,
  fileName: string,
  buf: Buffer,
  kind: HistoryKind,
  actor: Actor,
  opts?: { fileId?: string | null; notes?: string | null },
): Promise<{ fileId: string; rowCount: number; problems: string[] }> {
  const table = await readTable(fileName, buf);
  const parsed = parseQbTable(table);
  if (parsed.rows.length === 0) {
    throw new LedgerError(
      parsed.problems[0] ??
        'Nothing could be read from that file. Export QuickBooks\' "General Ledger" or "Transaction Detail by Account" report as CSV or Excel.',
    );
  }

  const file = await prisma.qboHistoryFile.create({
    data: {
      clubId,
      fileName: fileName.slice(0, 250),
      kind,
      rowCount: parsed.rows.length,
      fileId: opts?.fileId ?? null,
      notes: opts?.notes?.slice(0, 1000) ?? null,
      uploadedByUserId: actor.userId,
    },
    select: { id: true },
  });

  // createMany in chunks: a year's general ledger is tens of thousands of
  // rows, and one statement with 40,000 parameter sets exceeds what the
  // driver will send.
  const CHUNK = 1000;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    await prisma.qboHistoryRow.createMany({
      data: parsed.rows.slice(i, i + CHUNK).map((r) => ({
        clubId,
        fileId: file.id,
        txDate: r.date ? asDate(r.date) : null,
        txType: r.type || null,
        num: r.num || null,
        name: r.name || null,
        memo: r.memo || null,
        account: r.account || null,
        split: r.split || null,
        amountCents: Math.round(r.amount * 100),
        raw: r as unknown as object,
        rowIndex: r.idx,
      })),
    });
  }

  return { fileId: file.id, rowCount: parsed.rows.length, problems: parsed.problems };
}

export async function listHistoryFiles(clubId: string) {
  const rows = await prisma.qboHistoryFile.findMany({
    where: { clubId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    kind: r.kind,
    rowCount: r.rowCount,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type HistoryQuery = {
  q?: string | null;
  account?: string | null;
  from?: string | null;
  to?: string | null;
  fileId?: string | null;
  take?: number;
  skip?: number;
};

/// Search the archive. Read-only by construction: there is no write path to
/// these rows other than importHistory, and no update path at all.
export async function searchHistory(clubId: string, q: HistoryQuery) {
  const take = Math.min(Math.max(q.take ?? 100, 1), 500);
  const skip = Math.max(q.skip ?? 0, 0);
  const term = q.q?.trim();

  const where = {
    clubId,
    ...(q.fileId ? { fileId: q.fileId } : {}),
    ...(q.account ? { account: { contains: q.account, mode: "insensitive" as const } } : {}),
    ...(q.from || q.to
      ? {
          txDate: {
            ...(q.from ? { gte: asDate(q.from) } : {}),
            ...(q.to ? { lte: asDate(q.to) } : {}),
          },
        }
      : {}),
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" as const } },
            { memo: { contains: term, mode: "insensitive" as const } },
            { num: { contains: term, mode: "insensitive" as const } },
            { account: { contains: term, mode: "insensitive" as const } },
            { split: { contains: term, mode: "insensitive" as const } },
            { txType: { contains: term, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total, accounts] = await Promise.all([
    prisma.qboHistoryRow.findMany({
      where,
      orderBy: [{ txDate: "desc" }, { rowIndex: "asc" }],
      take,
      skip,
      select: {
        id: true,
        txDate: true,
        txType: true,
        num: true,
        name: true,
        memo: true,
        account: true,
        split: true,
        amountCents: true,
        fileId: true,
      },
    }),
    prisma.qboHistoryRow.count({ where }),
    prisma.qboHistoryRow.findMany({
      where: { clubId, account: { not: null } },
      select: { account: true },
      distinct: ["account"],
      take: 400,
      orderBy: { account: "asc" },
    }),
  ]);

  return {
    rows: rows.map((r) => ({ ...r, txDate: r.txDate ? ymd(r.txDate) : null })),
    total,
    take,
    skip,
    accounts: accounts.map((a) => a.account).filter((a): a is string => !!a),
  };
}

/// Delete one uploaded file and its rows. The archive is read-only as far as
/// the BOOKS are concerned; removing a file somebody uploaded by mistake is
/// housekeeping, not an accounting act, and nothing is derived from these rows
/// so nothing downstream changes.
export async function deleteHistoryFile(clubId: string, fileId: string): Promise<number> {
  const file = await prisma.qboHistoryFile.findFirst({
    where: { id: fileId, clubId },
    select: { id: true, rowCount: true },
  });
  if (!file) throw new LedgerError("That file doesn't exist.", 404);
  // The rows cascade from the file's FK, but deleting them explicitly keeps
  // the count honest in the response.
  const removed = await prisma.qboHistoryRow.deleteMany({ where: { clubId, fileId } });
  await prisma.qboHistoryFile.delete({ where: { id: fileId } });
  return removed.count;
}
