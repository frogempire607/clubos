// QuickBooks import — the database side (2026-10-14). Pure rules: lib/ledgerImport.ts.
//
//   createImportDraft  parse the file, guess the mapping, save a DRAFT
//   importPreview      the plan against today's bank rows (nothing written)
//   commitImport       apply the plan; record what changed so it can be undone
//   undoImport         remove the rows it added, put back categories it set
//
// Safety: it never overwrites a category the owner chose in AthletixOS, never
// creates a bank row inside the bank feed's own history (that would double
// count), and an import can be undone as a whole.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  parseCsv, parseQbTable, planImport, suggestAccountMap, MATCH_DAYS,
  type AccountCoverage, type ExistingBankRow, type ImportMapping, type QbRow,
} from "@/lib/ledgerImport";

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));

/** A CSV or Excel export → a table of strings. */
export async function readTable(fileName: string, buf: Buffer): Promise<string[][]> {
  if (/\.xlsx$/i.test(fileName)) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const table: string[][] = [];
    ws?.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const v = cell.value as unknown;
        let s = "";
        if (v instanceof Date) s = `${v.getUTCMonth() + 1}/${v.getUTCDate()}/${v.getUTCFullYear()}`;
        else if (v && typeof v === "object" && "result" in (v as object)) s = String((v as { result: unknown }).result ?? "");
        else if (v && typeof v === "object" && "text" in (v as object)) s = String((v as { text: unknown }).text ?? "");
        else s = v === null || v === undefined ? "" : String(v);
        cells[colNumber - 1] = s;
      });
      table.push(Array.from(cells, (c) => c ?? ""));
    });
    return table;
  }
  return parseCsv(buf.toString("utf8"));
}

async function bankAccountsFor(clubId: string) {
  return prisma.bankAccount.findMany({
    where: { clubId, connection: { deletedAt: null } },
    select: { id: true, name: true, mask: true, plaidConnectionId: true, accountId: true, legalEntityId: true, connection: { select: { kind: true, label: true, institutionName: true } } },
  });
}

export async function createImportDraft(args: { clubId: string; userId: string | null; fileName: string; buf: Buffer }) {
  const table = await readTable(args.fileName, args.buf);
  const parsed = parseQbTable(table);
  if (parsed.rows.length === 0) return { ok: false as const, error: parsed.problems[0] ?? "No transactions found in that file." };
  const accounts = await bankAccountsFor(args.clubId);
  const simple = accounts.map((a) => ({ id: a.id, name: a.name ?? a.connection.label ?? "", mask: a.mask }));
  const mapping: ImportMapping = { accounts: {}, types: {} };
  for (const name of parsed.accounts) mapping.accounts[name] = suggestAccountMap(name, simple);
  for (const t of parsed.types) mapping.types[t] = "AUTO";
  const row = await prisma.ledgerImport.create({
    data: {
      clubId: args.clubId, source: "QUICKBOOKS", fileName: args.fileName.slice(0, 200), status: "DRAFT",
      rows: parsed.rows as unknown as Prisma.InputJsonValue,
      mapping: mapping as unknown as Prisma.InputJsonValue,
      summary: { problems: parsed.problems } as Prisma.InputJsonValue,
      createdByUserId: args.userId,
    },
  });
  return { ok: true as const, id: row.id };
}

type Loaded = { id: string; status: string; fileName: string; rows: QbRow[]; mapping: ImportMapping; problems: string[] };
async function loadImport(clubId: string, id: string): Promise<Loaded | null> {
  const r = await prisma.ledgerImport.findFirst({ where: { id, clubId } });
  if (!r) return null;
  const summary = (r.summary ?? {}) as { problems?: string[] };
  return { id: r.id, status: r.status, fileName: r.fileName, rows: r.rows as unknown as QbRow[], mapping: r.mapping as unknown as ImportMapping, problems: summary.problems ?? [] };
}

/** The plan for an import against today's bank rows. */
export async function importPreview(clubId: string, id: string) {
  const imp = await loadImport(clubId, id);
  if (!imp) return null;
  const accounts = await bankAccountsFor(clubId);
  const mappedIds = new Set(Object.values(imp.mapping.accounts).flatMap((m) => (m.kind === "BANK" ? [m.bankAccountId] : [])));
  const relevant = accounts.filter((a) => mappedIds.has(a.id));
  const dates = imp.rows.map((r) => r.date).sort();
  const from = dates.length ? addDays(dates[0], -MATCH_DAYS) : null;
  const to = dates.length ? addDays(dates[dates.length - 1], MATCH_DAYS) : null;
  const acctKey = new Map(relevant.map((a) => [`${a.plaidConnectionId}|${a.accountId}`, a.id]));

  const bankRows = relevant.length
    ? await prisma.plaidTransaction.findMany({
        where: {
          clubId,
          OR: relevant.map((a) => ({ plaidConnectionId: a.plaidConnectionId, accountId: a.accountId })),
          ...(from && to ? { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } } : {}),
        },
        select: { id: true, plaidConnectionId: true, accountId: true, date: true, amount: true, categoryOverride: true, reviewedAt: true, categorizedExpenseId: true, markedAsTransfer: true, excludedFromTax: true, source: true, importId: true },
      })
    : [];
  const firstFeed = relevant.length
    ? await prisma.plaidTransaction.findMany({
        where: { clubId, source: "PLAID", OR: relevant.map((a) => ({ plaidConnectionId: a.plaidConnectionId, accountId: a.accountId })) },
        orderBy: { date: "asc" },
        select: { plaidConnectionId: true, accountId: true, date: true },
      })
    : [];
  const feedStarts = new Map<string, string>();
  for (const f of firstFeed) {
    const id2 = acctKey.get(`${f.plaidConnectionId}|${f.accountId}`);
    if (id2 && !feedStarts.has(id2)) feedStarts.set(id2, ymd(f.date));
  }
  const existing: ExistingBankRow[] = [];
  const alreadyImported: { bankAccountId: string; date: string; amount: number }[] = [];
  for (const b of bankRows) {
    const bankAccountId = acctKey.get(`${b.plaidConnectionId}|${b.accountId}`);
    if (!bankAccountId) continue;
    if (b.source === "QUICKBOOKS") {
      // Rows an earlier import created are never matched again (and never re-created).
      if (b.importId !== imp.id) alreadyImported.push({ bankAccountId, date: ymd(b.date), amount: Number(b.amount) });
      continue;
    }
    existing.push({
      id: b.id, bankAccountId, date: ymd(b.date), amount: Number(b.amount), categoryOverride: b.categoryOverride,
      reviewed: !!b.reviewedAt || !!b.categorizedExpenseId || b.markedAsTransfer || b.excludedFromTax,
    });
  }
  const coverage: AccountCoverage[] = relevant.map((a) => ({
    bankAccountId: a.id, kind: a.connection.kind === "MANUAL" ? "MANUAL" : "PLAID", feedStarts: feedStarts.get(a.id) ?? null,
  }));
  const plan = planImport({ rows: imp.rows, mapping: imp.mapping, existing, coverage, alreadyImported });
  return {
    import: { id: imp.id, status: imp.status, fileName: imp.fileName, problems: imp.problems },
    mapping: imp.mapping,
    accountsInFile: Object.keys(imp.mapping.accounts),
    typesInFile: Object.keys(imp.mapping.types),
    bankAccounts: accounts.map((a) => ({
      id: a.id, name: a.name ?? a.connection.label ?? "Account", mask: a.mask, legalEntityId: a.legalEntityId,
      connectionLabel: a.connection.label || a.connection.institutionName || "Bank", kind: a.connection.kind, feedStarts: feedStarts.get(a.id) ?? null,
    })),
    rows: imp.rows,
    plan: plan.rows,
    summary: plan.summary,
  };
}

export async function saveMapping(clubId: string, id: string, mapping: ImportMapping): Promise<boolean> {
  const imp = await prisma.ledgerImport.findFirst({ where: { id, clubId, status: "DRAFT" }, select: { id: true } });
  if (!imp) return false;
  const accounts = await bankAccountsFor(clubId);
  const valid = new Set(accounts.map((a) => a.id));
  for (const m of Object.values(mapping.accounts)) if (m.kind === "BANK" && !valid.has(m.bankAccountId)) return false;
  await prisma.ledgerImport.update({ where: { id: imp.id }, data: { mapping: mapping as unknown as Prisma.InputJsonValue } });
  return true;
}

type Applied = { matched: { id: string; category: string | null; transfer: boolean }[]; created: number };

export async function commitImport(clubId: string, id: string, userId: string | null) {
  const pv = await importPreview(clubId, id);
  if (!pv) return { ok: false as const, error: "Import not found." };
  if (pv.import.status !== "DRAFT") return { ok: false as const, error: "This import was already committed or undone." };
  const accounts = await bankAccountsFor(clubId);
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const rowByIdx = new Map(pv.rows.map((r) => [r.idx, r]));
  const now = new Date();
  const applied: Applied = { matched: [], created: 0 };
  const creates: Prisma.PlaidTransactionCreateManyInput[] = [];
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const p of pv.plan) {
    if (p.action === "MATCH" && p.appliesCategory && p.matchedRowId) {
      // Guarded: only a row that is STILL uncategorised changes.
      ops.push(prisma.plaidTransaction.updateMany({
        where: { id: p.matchedRowId, clubId, categoryOverride: null, reviewedAt: null, categorizedExpenseId: null },
        data: { categoryOverride: p.category, reviewedAt: now, reviewedByUserId: userId, ...(p.transfer ? { markedAsTransfer: true } : {}) },
      }));
      applied.matched.push({ id: p.matchedRowId, category: p.category, transfer: p.transfer });
    } else if (p.action === "CREATE" && p.bankAccountId && p.bankAmount !== null) {
      const a = acct.get(p.bankAccountId);
      const r = rowByIdx.get(p.idx);
      if (!a || !r) continue;
      const label = r.name || r.memo || r.type || "QuickBooks transaction";
      creates.push({
        clubId, plaidConnectionId: a.plaidConnectionId, accountId: a.accountId,
        plaidTransactionId: `qb:${id}:${p.idx}`, amount: new Prisma.Decimal(p.bankAmount), isoCurrencyCode: "USD",
        date: new Date(`${r.date}T00:00:00Z`), name: label.slice(0, 250), merchantName: r.name || null,
        pending: false, legalEntityId: a.legalEntityId, source: "QUICKBOOKS", importId: id,
        categoryOverride: p.category, markedAsTransfer: p.transfer,
        reviewedAt: p.category ? now : null, reviewedByUserId: p.category ? userId : null,
        notes: [r.memo, `QuickBooks ${r.type}${r.num ? ` #${r.num}` : ""}`].filter(Boolean).join(" · ").slice(0, 500),
      });
    }
  }
  applied.created = creates.length;
  if (creates.length) ops.push(prisma.plaidTransaction.createMany({ data: creates, skipDuplicates: true }));
  ops.push(prisma.ledgerImport.update({
    where: { id },
    data: {
      status: "COMMITTED", committedAt: now,
      applied: applied as unknown as Prisma.InputJsonValue,
      summary: { problems: pv.import.problems, ...pv.summary } as unknown as Prisma.InputJsonValue,
    },
  }));
  // One batch: all of it lands, or none of it.
  await prisma.$transaction(ops);
  return { ok: true as const, summary: pv.summary };
}

export async function undoImport(clubId: string, id: string) {
  const imp = await prisma.ledgerImport.findFirst({ where: { id, clubId } });
  if (!imp) return { ok: false as const, error: "Import not found." };
  if (imp.status !== "COMMITTED") return { ok: false as const, error: "Only a committed import can be undone." };
  const applied = (imp.applied ?? { matched: [], created: 0 }) as unknown as Applied;
  const created = await prisma.plaidTransaction.findMany({ where: { clubId, importId: id, source: "QUICKBOOKS" }, select: { id: true } });
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  if (created.length) {
    ops.push(prisma.receipt.updateMany({
      where: { clubId, plaidTransactionId: { in: created.map((c) => c.id) } },
      data: { status: "UNMATCHED", plaidTransactionId: null, matchedAt: null, matchedByUserId: null },
    }));
    ops.push(prisma.plaidTransaction.deleteMany({ where: { clubId, importId: id, source: "QUICKBOOKS" } }));
  }
  for (const m of applied.matched) {
    // Put back only what the import set and nobody has changed since.
    ops.push(prisma.plaidTransaction.updateMany({
      where: { id: m.id, clubId, categoryOverride: m.category },
      data: { categoryOverride: null, reviewedAt: null, reviewedByUserId: null, ...(m.transfer ? { markedAsTransfer: false } : {}) },
    }));
  }
  ops.push(prisma.ledgerImport.update({ where: { id }, data: { status: "UNDONE", undoneAt: new Date() } }));
  await prisma.$transaction(ops);
  return { ok: true as const, removed: created.length, restored: applied.matched.length };
}

export async function listImports(clubId: string) {
  const rows = await prisma.ledgerImport.findMany({
    where: { clubId }, orderBy: { createdAt: "desc" }, take: 30,
    select: { id: true, fileName: true, status: true, summary: true, createdAt: true, committedAt: true, undoneAt: true },
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), committedAt: r.committedAt?.toISOString() ?? null, undoneAt: r.undoneAt?.toISOString() ?? null }));
}
