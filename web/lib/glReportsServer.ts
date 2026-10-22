// Accounting Phase 3 — the statements, read from the database.
//
// This module READS. It never writes a gl_* table: lib/ledgerServer.ts is
// still the only module that does, exactly as Phase 1 set up. All the
// arithmetic lives in lib/glReports.ts, which is pure and proven by
// scripts/gl-reports-tests.ts; everything here is loading rows and handing
// them over.
//
// EVERY query is scoped by clubId. Not for tidiness — RLS is the backstop, but
// a report that forgets the scope would read another club's books, and a
// financial statement is the one place that must never happen.

import { prisma } from "@/lib/prisma";
import { bankGlAccountMaps } from "@/lib/glBankAccounts";
import {
  type AccountType,
  type NormalBalance,
} from "@/lib/ledger";
import {
  balanceSheet,
  basisNote,
  cashBasisExclusions,
  cashFlowIndirect,
  classifyForCashFlow,
  filterLines,
  generalLedger,
  monthColumnLabel,
  monthEndDate,
  monthKeys,
  monthStartDate,
  parseBasis,
  profitAndLoss,
  trialBalance,
  type BasisMode,
  type ReportAccount,
  type ReportEntry,
  type ReportLine,
} from "@/lib/glReports";

export type ReportQuery = {
  from?: string | null;
  to?: string | null;
  legalEntityId?: string | null;
  program?: string | null;
  basis?: BasisMode;
};

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/// The fiscal year is the CALENDAR year. There is no fiscal-year field on
/// Club, and inventing one here would be a setting nobody can see or change —
/// so a club on a non-calendar year gets the wrong retained-earnings split,
/// which is why the balance sheet payload states the fiscal year start it
/// used. Noted in docs/accounting/plan.md as a follow-up.
export function fiscalYearStartFor(asOf: string): string {
  return `${asOf.slice(0, 4)}-01-01`;
}

async function loadAccounts(clubId: string): Promise<ReportAccount[]> {
  const rows = await prisma.glAccount.findMany({
    where: { clubId },
    select: {
      id: true,
      number: true,
      name: true,
      type: true,
      subtype: true,
      normalBalance: true,
      isContra: true,
      parentId: true,
      systemKey: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    name: r.name,
    type: r.type as AccountType,
    subtype: r.subtype,
    normalBalance: r.normalBalance as NormalBalance,
    isContra: r.isContra,
    parentId: r.parentId,
    systemKey: r.systemKey,
  }));
}

/// Posted lines in a date window. `status: "POSTED"` on the ENTRY is the only
/// filter that matters for correctness: a VOID entry keeps all its rows (Phase
/// 1 never hard-deletes), so a report that forgot this would count voided
/// money as real.
async function loadLines(
  clubId: string,
  opts: { from?: string | null; to?: string | null },
): Promise<{ lines: ReportLine[]; entries: Map<string, ReportEntry> }> {
  const entryDate: { gte?: Date; lte?: Date } = {};
  if (opts.from) entryDate.gte = new Date(`${opts.from}T00:00:00.000Z`);
  if (opts.to) entryDate.lte = new Date(`${opts.to}T00:00:00.000Z`);

  const rows = await prisma.glJournalLine.findMany({
    where: {
      clubId,
      entry: {
        clubId,
        status: "POSTED",
        ...(opts.from || opts.to ? { entryDate } : {}),
      },
    },
    select: {
      entryId: true,
      accountId: true,
      debitCents: true,
      creditCents: true,
      legalEntityId: true,
      program: true,
      memo: true,
      entry: {
        select: {
          entryDate: true,
          memo: true,
          reference: true,
          sourceType: true,
        },
      },
    },
    orderBy: [{ entryId: "asc" }, { lineNumber: "asc" }],
  });

  const entries = new Map<string, ReportEntry>();
  const lines: ReportLine[] = rows.map((r) => {
    const date = ymd(r.entry.entryDate);
    if (!entries.has(r.entryId)) {
      entries.set(r.entryId, {
        id: r.entryId,
        entryDate: date,
        memo: r.entry.memo,
        reference: r.entry.reference,
        sourceType: r.entry.sourceType,
      });
    }
    return {
      entryId: r.entryId,
      accountId: r.accountId,
      debitCents: r.debitCents,
      creditCents: r.creditCents,
      entryDate: date,
      legalEntityId: r.legalEntityId,
      program: r.program,
      lineMemo: r.memo,
    };
  });
  return { lines, entries };
}

/// What every report needs: the chart, the period's lines, everything before
/// the period (for opening balances and a cumulative balance sheet), and the
/// cash-basis exclusions.
///
/// Exclusions are computed on the DATE-WINDOWED set before the entity and
/// program filters are applied, because an entry is atomic — every line shares
/// its entry's date, so a date window takes whole entries, while an entity or
/// program filter can split one and would hide half an accrual from the test.
async function loadContext(
  clubId: string,
  q: ReportQuery,
  opts?: { withPrior?: boolean; cumulative?: boolean },
) {
  const basis = q.basis ?? "accrual";
  const accounts = await loadAccounts(clubId);

  const periodWindow = opts?.cumulative
    ? { from: null, to: q.to ?? null }
    : { from: q.from ?? null, to: q.to ?? null };

  const { lines: windowLines, entries } = await loadLines(clubId, periodWindow);

  let priorLines: ReportLine[] = [];
  let priorEntries = new Map<string, ReportEntry>();
  if (opts?.withPrior && q.from) {
    const before = dayBefore(q.from);
    const loaded = await loadLines(clubId, { to: before });
    priorLines = loaded.lines;
    priorEntries = loaded.entries;
  }

  const excluded =
    basis === "cash"
      ? cashBasisExclusions(accounts, [...windowLines, ...priorLines])
      : new Set<string>();

  const scope = { legalEntityId: q.legalEntityId ?? null, program: q.program ?? null };
  return {
    accounts,
    basis,
    excludedEntryIds: [...excluded],
    lines: filterLines(windowLines, scope, excluded),
    priorLines: filterLines(priorLines, scope, excluded),
    entries: new Map([...priorEntries, ...entries]),
  };
}

/// The day before a date-only string, by UTC arithmetic. Never by subtracting
/// from a locally-parsed Date — that is the bug class this repo has recorded
/// three separate times (the wall-clock class filter, payrollRange, the month
/// labels), and an opening balance landing a day out would put a whole month's
/// activity in the wrong period.
export function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Trial balance ───────────────────────────────────────────────────────────

export async function trialBalanceReport(clubId: string, q: ReportQuery) {
  const ctx = await loadContext(clubId, q);
  const tb = trialBalance(ctx.accounts, ctx.lines);
  return {
    ...tb,
    from: q.from ?? null,
    to: q.to ?? null,
    basis: ctx.basis,
    basisNote: basisNote(ctx.basis, ctx.excludedEntryIds.length),
    excludedEntryIds: ctx.excludedEntryIds,
  };
}

// ── General ledger ──────────────────────────────────────────────────────────

export async function generalLedgerReport(clubId: string, q: ReportQuery & { accountId?: string | null }) {
  const ctx = await loadContext(clubId, q, { withPrior: true });
  const accounts = q.accountId
    ? ctx.accounts.filter((a) => a.id === q.accountId)
    : ctx.accounts;
  const gl = generalLedger(accounts, ctx.lines, ctx.entries, ctx.priorLines);
  return {
    accounts: gl,
    from: q.from ?? null,
    to: q.to ?? null,
    basis: ctx.basis,
    basisNote: basisNote(ctx.basis, ctx.excludedEntryIds.length),
    excludedEntryIds: ctx.excludedEntryIds,
  };
}

// ── Profit & loss ───────────────────────────────────────────────────────────

export async function profitAndLossReport(
  clubId: string,
  q: ReportQuery & { byMonth?: boolean },
) {
  const ctx = await loadContext(clubId, q);
  const from = q.from ?? earliest(ctx.lines) ?? todayUtc();
  const to = q.to ?? todayUtc();

  const columns =
    q.byMonth && from && to
      ? monthKeys(from, to).map((k) => ({
          key: k,
          label: monthColumnLabel(k),
          // Clamped to the requested range so a part-month column holds only
          // the days asked for, rather than quietly widening the report.
          from: maxDate(monthStartDate(k), from),
          to: minDate(monthEndDate(k), to),
        }))
      : [{ key: "period", label: "Total", from, to }];

  const pnl = profitAndLoss(ctx.accounts, ctx.lines, columns, ctx.basis, ctx.excludedEntryIds);
  return {
    ...pnl,
    from,
    to,
    byMonth: !!q.byMonth,
    basisNote: basisNote(ctx.basis, ctx.excludedEntryIds.length),
  };
}

// ── Balance sheet ───────────────────────────────────────────────────────────

export async function balanceSheetReport(clubId: string, q: ReportQuery) {
  const asOf = q.to ?? todayUtc();
  // Cumulative: a balance sheet is every entry from the beginning of the books
  // through `asOf`, not a period.
  const ctx = await loadContext(clubId, { ...q, from: null, to: asOf }, { cumulative: true });
  const fiscalYearStart = fiscalYearStartFor(asOf);
  const bs = balanceSheet(
    ctx.accounts,
    ctx.lines,
    asOf,
    fiscalYearStart,
    ctx.basis,
    ctx.excludedEntryIds,
  );
  return { ...bs, basisNote: basisNote(ctx.basis, ctx.excludedEntryIds.length) };
}

// ── Cash flow ───────────────────────────────────────────────────────────────

export async function cashFlowReport(clubId: string, q: ReportQuery) {
  const from = q.from ?? todayUtc();
  const to = q.to ?? todayUtc();
  const ctx = await loadContext(clubId, { ...q, from, to }, { withPrior: true });
  // The bank and card GL accounts are the club's own — a hardcoded number list
  // would miss every account it added itself.
  const maps = await bankGlAccountMaps(clubId);
  const bankAndCard = new Set<string>(Object.values(maps.byBankAccount));
  const inputs = classifyForCashFlow(ctx.accounts, bankAndCard);
  const cf = cashFlowIndirect(
    ctx.accounts,
    ctx.lines,
    ctx.priorLines,
    from,
    to,
    inputs,
    ctx.basis,
  );
  return {
    ...cf,
    basisNote: basisNote(ctx.basis, ctx.excludedEntryIds.length),
    /// True when the club has no bank account mapped to a GL account yet, in
    /// which case "cash" is only 1020 and 1050 and the statement will look
    /// thin. Surfaced so the UI can say why rather than showing a bare zero.
    noBankAccountsMapped: bankAndCard.size === 0,
  };
}

// ── Drill-down ──────────────────────────────────────────────────────────────

/// Every figure on every statement comes from journal lines, and this returns
/// the ones behind one account over one window. The UI also deep-links to the
/// existing Journal tab, which is the richer view; this is what makes a number
/// explainable in place.
export async function drilldownReport(
  clubId: string,
  q: ReportQuery & { accountId: string },
) {
  const ctx = await loadContext(clubId, q);
  const mine = ctx.lines.filter((l) => l.accountId === q.accountId);
  const account = ctx.accounts.find((a) => a.id === q.accountId) ?? null;
  const rows = mine
    .map((l) => {
      const e = ctx.entries.get(l.entryId);
      return {
        entryId: l.entryId,
        entryDate: l.entryDate,
        reference: e?.reference ?? null,
        memo: e?.memo ?? null,
        lineMemo: l.lineMemo ?? null,
        sourceType: e?.sourceType ?? "MANUAL",
        program: l.program,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      };
    })
    .sort((a, b) => (a.entryDate === b.entryDate ? a.entryId.localeCompare(b.entryId) : a.entryDate < b.entryDate ? -1 : 1));

  return {
    account: account
      ? { id: account.id, number: account.number, name: account.name, type: account.type }
      : null,
    rows,
    debitCents: rows.reduce((s, r) => s + r.debitCents, 0),
    creditCents: rows.reduce((s, r) => s + r.creditCents, 0),
    from: q.from ?? null,
    to: q.to ?? null,
    basis: ctx.basis,
  };
}

// ── Filter options ──────────────────────────────────────────────────────────

/// The entities and programs a club actually has, so the filters offer real
/// values rather than a free-text box that silently matches nothing.
export async function reportFilterOptions(clubId: string) {
  const [entities, programRows, club, earliestEntry] = await Promise.all([
    prisma.legalEntity.findMany({
      where: { clubId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.glJournalLine.findMany({
      where: { clubId, program: { not: null } },
      select: { program: true },
      distinct: ["program"],
      take: 200,
    }),
    prisma.club.findUnique({ where: { id: clubId }, select: { booksStartDate: true } }),
    prisma.glJournalEntry.findFirst({
      where: { clubId, status: "POSTED" },
      select: { entryDate: true },
      orderBy: { entryDate: "asc" },
    }),
  ]);
  return {
    entities,
    programs: programRows
      .map((r) => r.program)
      .filter((p): p is string => !!p)
      .sort((a, b) => a.localeCompare(b)),
    booksStartDate: club?.booksStartDate ? ymd(club.booksStartDate) : null,
    earliestEntryDate: earliestEntry ? ymd(earliestEntry.entryDate) : null,
  };
}

// ── Small date helpers ──────────────────────────────────────────────────────

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function earliest(lines: ReportLine[]): string | null {
  let min: string | null = null;
  for (const l of lines) if (min === null || l.entryDate < min) min = l.entryDate;
  return min;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export { parseBasis };
