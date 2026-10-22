// Accounting Phase 3 — the financial statements, as a PURE module.
//
// No prisma, no next, no I/O. Everything is a function of its arguments so
// scripts/gl-reports-tests.ts can prove the arithmetic without a database.
// lib/glReportsServer.ts reads the rows and hands them here.
//
// Money is INTEGER CENTS throughout, exactly as lib/ledger.ts explains: it is
// what lets "assets === liabilities + equity" be an exact integer comparison
// instead of a tolerance check. A statement that only balances to within a
// cent is a statement a CPA sends back.
//
// Every statement here reports whether it ties, and by how much when it
// doesn't. A balance sheet that silently doesn't balance is worse than one
// that refuses: the first gets filed.

import {
  ACCOUNT_TYPE_LABELS,
  COST_OF_SALES,
  type AccountType,
  type NormalBalance,
} from "@/lib/ledger";

// ── Inputs ──────────────────────────────────────────────────────────────────

export type ReportAccount = {
  id: string;
  number: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  normalBalance: NormalBalance;
  isContra: boolean;
  parentId: string | null;
  systemKey: string | null;
};

/// One posted journal line, flattened with the few entry fields a report needs.
/// `entryDate` is date-only `YYYY-MM-DD` — never a Date, so no time zone can
/// move a transaction into the wrong month (the bug class CLAUDE.md records
/// twice: the wall-clock class filter and payrollRange).
export type ReportLine = {
  entryId: string;
  accountId: string;
  debitCents: number;
  creditCents: number;
  entryDate: string;
  legalEntityId: string | null;
  program: string | null;
  /// The LINE's memo, distinct from the entry's. Carried on the line rather
  /// than looked up by (entryId, accountId), because that key collides the
  /// moment one entry has two lines on the same account — which a split
  /// deposit does routinely.
  lineMemo?: string | null;
};

/// Entry-level fields the general ledger prints beside each line.
export type ReportEntry = {
  id: string;
  entryDate: string;
  memo: string | null;
  reference: string | null;
  sourceType: string;
};

export type BasisMode = "accrual" | "cash";
export const BASIS_MODES: BasisMode[] = ["accrual", "cash"];

export function parseBasis(raw: string | null | undefined): BasisMode {
  return raw === "cash" ? "cash" : "accrual";
}

// ── The cash/accrual toggle, and exactly what it does ───────────────────────
//
// Nothing in AthletixOS posts into Accounts Receivable, Accounts Payable,
// Deferred Revenue or Prepaid Expenses automatically. Phase 2's engine posts
// when money MOVES: a charge when Stripe charges, a refund when it refunds, a
// payout when it pays out, an expense when it is recorded as paid, a bank row
// when the bank shows it. So for a club that has written no accruals by hand,
// cash and accrual are the SAME numbers — and `basisNote()` below says so
// rather than implying a difference that isn't there.
//
// The only way an accrual can exist is a manual journal entry a bookkeeper
// wrote. Cash basis therefore means: leave out every entry that touches an
// accrual-only account.
//
// THE LIMITATION, STATED PLAINLY: that drops both halves of a hand-written
// accrual — the invoice (A/R ↔ revenue) AND the entry that settles it
// (bank ↔ A/R). So a manually invoiced sale appears in neither period on a
// cash basis. Tracing a settlement back to the invoice it pays would need a
// link this ledger does not store, and guessing the link is how a report
// starts quietly double-counting. Instead every cash-basis payload carries
// `excludedEntryIds` and `excludedCount`, the UI shows them, and they drill
// down to the entries — so the number is visibly incomplete rather than
// invisibly wrong.
export const ACCRUAL_ONLY_ACCOUNT_NUMBERS = ["1100", "1300", "2000", "2200"];

export function isAccrualOnlyAccount(a: Pick<ReportAccount, "number">): boolean {
  return ACCRUAL_ONLY_ACCOUNT_NUMBERS.includes(a.number);
}

/// The entries a cash-basis report leaves out. Accrual basis excludes nothing.
export function cashBasisExclusions(
  accounts: ReportAccount[],
  lines: ReportLine[],
): Set<string> {
  const accrualIds = new Set(accounts.filter(isAccrualOnlyAccount).map((a) => a.id));
  const out = new Set<string>();
  if (accrualIds.size === 0) return out;
  for (const l of lines) if (accrualIds.has(l.accountId)) out.add(l.entryId);
  return out;
}

export function basisNote(basis: BasisMode, excludedCount: number): string {
  if (basis === "accrual") {
    return "Accrual basis: every posted entry, on the date it is dated.";
  }
  if (excludedCount === 0) {
    return "Cash basis. Nothing is excluded, because no entry in this period touches Accounts Receivable, Accounts Payable, Deferred Revenue or Prepaid Expenses — so for this period cash and accrual are the same numbers.";
  }
  return `Cash basis. ${excludedCount} ${excludedCount === 1 ? "entry" : "entries"} touching Accounts Receivable, Accounts Payable, Deferred Revenue or Prepaid Expenses ${excludedCount === 1 ? "is" : "are"} left out — including any entry that SETTLES one, so a hand-written invoice shows up in neither period on this basis. Switch to accrual to see them.`;
}

// ── Filtering ───────────────────────────────────────────────────────────────

export type ReportFilters = {
  from?: string | null;
  to?: string | null;
  legalEntityId?: string | null;
  program?: string | null;
  basis?: BasisMode;
};

/// Applies the filters. Date bounds are INCLUSIVE and compared as strings,
/// which is exactly right for `YYYY-MM-DD` and immune to time zones.
export function filterLines(
  lines: ReportLine[],
  filters: ReportFilters,
  excludedEntryIds?: Set<string>,
): ReportLine[] {
  const { from, to, legalEntityId, program } = filters;
  return lines.filter((l) => {
    if (from && l.entryDate < from) return false;
    if (to && l.entryDate > to) return false;
    if (legalEntityId && l.legalEntityId !== legalEntityId) return false;
    if (program && (l.program ?? "") !== program) return false;
    if (excludedEntryIds && excludedEntryIds.has(l.entryId)) return false;
    return true;
  });
}

// ── Balances ────────────────────────────────────────────────────────────────

export type Totals = { debitCents: number; creditCents: number };

export function totalsByAccount(lines: ReportLine[]): Map<string, Totals> {
  const m = new Map<string, Totals>();
  for (const l of lines) {
    const t = m.get(l.accountId) ?? { debitCents: 0, creditCents: 0 };
    t.debitCents += l.debitCents;
    t.creditCents += l.creditCents;
    m.set(l.accountId, t);
  }
  return m;
}

/// The balance in the account's OWN normal direction, so a positive number
/// always means "more of what this account is for". A contra account's normal
/// balance is already the contra side (1590 Accumulated Depreciation is an
/// ASSET whose normalBalance is CREDIT), so no extra flip is needed here —
/// which is why `isContra` affects presentation, not sign.
export function signedBalance(normalBalance: NormalBalance, t: Totals): number {
  return normalBalance === "DEBIT"
    ? t.debitCents - t.creditCents
    : t.creditCents - t.debitCents;
}

/// Net debit minus net credit, the raw direction a trial balance prints.
export function netDebit(t: Totals): number {
  return t.debitCents - t.creditCents;
}

// ── Trial balance ───────────────────────────────────────────────────────────

export type TrialBalanceRow = {
  accountId: string;
  number: string;
  name: string;
  type: AccountType;
  /// What goes in the Debit column (0 when the account nets credit).
  debitCents: number;
  /// What goes in the Credit column (0 when the account nets debit).
  creditCents: number;
};

export type TrialBalance = {
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  differenceCents: number;
  balanced: boolean;
};

/// A trial balance prints each account's NET on one side. Accounts that net to
/// zero are dropped — a CPA does not want 60 zero rows, and a zero row carries
/// no information a balance check can use.
export function trialBalance(accounts: ReportAccount[], lines: ReportLine[]): TrialBalance {
  const totals = totalsByAccount(lines);
  const rows: TrialBalanceRow[] = [];
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  for (const a of sortAccounts(accounts)) {
    const t = totals.get(a.id);
    if (!t) continue;
    const net = netDebit(t);
    if (net === 0) continue;
    const debitCents = net > 0 ? net : 0;
    const creditCents = net < 0 ? -net : 0;
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;
    rows.push({
      accountId: a.id,
      number: a.number,
      name: a.name,
      type: a.type,
      debitCents,
      creditCents,
    });
  }

  const differenceCents = totalDebitCents - totalCreditCents;
  return {
    rows,
    totalDebitCents,
    totalCreditCents,
    differenceCents,
    balanced: differenceCents === 0,
  };
}

/// Number order within type, types in balance-sheet-then-P&L order. The one
/// sort every statement here uses, so the CPA package reads consistently.
export function sortAccounts(accounts: ReportAccount[]): ReportAccount[] {
  const typeRank: Record<AccountType, number> = {
    ASSET: 0,
    LIABILITY: 1,
    EQUITY: 2,
    INCOME: 3,
    EXPENSE: 4,
  };
  return [...accounts].sort((x, y) => {
    const t = typeRank[x.type] - typeRank[y.type];
    if (t !== 0) return t;
    const n = x.number.localeCompare(y.number, "en", { numeric: true });
    if (n !== 0) return n;
    return x.name.localeCompare(y.name);
  });
}

// ── General ledger ──────────────────────────────────────────────────────────

export type GeneralLedgerRow = {
  entryId: string;
  entryDate: string;
  reference: string | null;
  memo: string | null;
  sourceType: string;
  lineMemo: string | null;
  program: string | null;
  debitCents: number;
  creditCents: number;
  /// Running balance in the account's normal direction, opening included.
  balanceCents: number;
};

export type GeneralLedgerAccount = {
  accountId: string;
  number: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  openingCents: number;
  rows: GeneralLedgerRow[];
  debitCents: number;
  creditCents: number;
  closingCents: number;
};

/// Per-account detail with a running balance. `priorLines` are the lines
/// BEFORE the period — they make the opening balance, which is what turns a
/// list of transactions into a ledger. An INCOME or EXPENSE account opens at
/// zero every fiscal year, but the GL is a period report and the caller
/// decides the period, so opening is computed the same way for every type.
export function generalLedger(
  accounts: ReportAccount[],
  lines: ReportLine[],
  entries: Map<string, ReportEntry>,
  priorLines: ReportLine[] = [],
): GeneralLedgerAccount[] {
  const priorTotals = totalsByAccount(priorLines);
  const byAccount = new Map<string, ReportLine[]>();
  for (const l of lines) {
    const arr = byAccount.get(l.accountId);
    if (arr) arr.push(l);
    else byAccount.set(l.accountId, [l]);
  }

  const out: GeneralLedgerAccount[] = [];
  for (const a of sortAccounts(accounts)) {
    const mine = byAccount.get(a.id) ?? [];
    const prior = priorTotals.get(a.id);
    const openingCents = prior ? signedBalance(a.normalBalance, prior) : 0;
    if (mine.length === 0 && openingCents === 0) continue;

    const sorted = [...mine].sort((x, y) => {
      if (x.entryDate !== y.entryDate) return x.entryDate < y.entryDate ? -1 : 1;
      return x.entryId.localeCompare(y.entryId);
    });

    let running = openingCents;
    let debitCents = 0;
    let creditCents = 0;
    const rows: GeneralLedgerRow[] = sorted.map((l) => {
      const delta =
        a.normalBalance === "DEBIT"
          ? l.debitCents - l.creditCents
          : l.creditCents - l.debitCents;
      running += delta;
      debitCents += l.debitCents;
      creditCents += l.creditCents;
      const e = entries.get(l.entryId);
      return {
        entryId: l.entryId,
        entryDate: l.entryDate,
        reference: e?.reference ?? null,
        memo: e?.memo ?? null,
        sourceType: e?.sourceType ?? "MANUAL",
        lineMemo: l.lineMemo ?? null,
        program: l.program,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        balanceCents: running,
      };
    });

    out.push({
      accountId: a.id,
      number: a.number,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      openingCents,
      rows,
      debitCents,
      creditCents,
      closingCents: running,
    });
  }
  return out;
}

// ── Months and columns ──────────────────────────────────────────────────────

/// Inclusive list of `YYYY-MM` keys spanning two date-only strings. Built by
/// integer arithmetic on the year and month, never by stepping a Date — which
/// is how a 31st rolls into the wrong month.
export function monthKeys(from: string, to: string): string[] {
  const [fy, fm] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  if (!fy || !fm || !ty || !tm) return [];
  const out: string[] = [];
  let y = fy;
  let m = fm;
  // A runaway loop here would hang a report route, so the span is capped at
  // 50 years rather than trusted.
  for (let guard = 0; guard < 600; guard += 1) {
    if (y > ty || (y === ty && m > tm)) break;
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function monthEndDate(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  // Day 0 of the next month is the last day of this one, computed in UTC.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function monthStartDate(monthKey: string): string {
  return `${monthKey}-01`;
}

export function monthColumnLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  return new Date(y, m - 1, 15).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

// ── Profit & loss ───────────────────────────────────────────────────────────

export type StatementLine = {
  accountId: string;
  number: string;
  name: string;
  /// One cell per column, in column order, plus `totalCents` for the whole
  /// period. A single-column report has one cell and they are equal.
  cells: number[];
  totalCents: number;
};

export type StatementSection = {
  key: string;
  label: string;
  lines: StatementLine[];
  cells: number[];
  totalCents: number;
};

export type ProfitAndLoss = {
  columns: { key: string; label: string }[];
  income: StatementSection;
  costOfSales: StatementSection;
  grossProfit: { cells: number[]; totalCents: number };
  expenses: StatementSection;
  netIncome: { cells: number[]; totalCents: number };
  basis: BasisMode;
  excludedEntryIds: string[];
};

function emptyCells(n: number): number[] {
  return new Array(n).fill(0);
}

function sumCells(cells: number[]): number {
  return cells.reduce((a, b) => a + b, 0);
}

function subtractCells(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}

/// Income and expenses, with a gross-profit line when the club uses the
/// COST_OF_SALES subtype. Columns are either one period or one per month.
///
/// Sign convention: every section's numbers are POSITIVE in the direction that
/// section runs — income positive when earned, expenses positive when spent —
/// so the reader never has to decide what a minus sign means. 4900 Refunds &
/// Discounts is a contra-income account, so a refund arrives here as a
/// NEGATIVE income line, which is exactly how it should read.
export function profitAndLoss(
  accounts: ReportAccount[],
  lines: ReportLine[],
  columns: { key: string; label: string; from: string; to: string }[],
  basis: BasisMode = "accrual",
  excludedEntryIds: string[] = [],
): ProfitAndLoss {
  const n = columns.length;
  const byAccountCol = new Map<string, number[]>();

  for (const l of lines) {
    let col = -1;
    for (let i = 0; i < n; i += 1) {
      if (l.entryDate >= columns[i].from && l.entryDate <= columns[i].to) {
        col = i;
        break;
      }
    }
    if (col === -1) continue;
    const cells = byAccountCol.get(l.accountId) ?? emptyCells(n);
    cells[col] += l.creditCents - l.debitCents; // credit-positive; flipped below for expenses
    byAccountCol.set(l.accountId, cells);
  }

  const build = (
    key: string,
    label: string,
    pick: (a: ReportAccount) => boolean,
    creditPositive: boolean,
  ): StatementSection => {
    const sectionCells = emptyCells(n);
    const sl: StatementLine[] = [];
    for (const a of sortAccounts(accounts)) {
      if (!pick(a)) continue;
      const raw = byAccountCol.get(a.id);
      if (!raw) continue;
      const cells = raw.map((v) => (creditPositive ? v : -v));
      const totalCents = sumCells(cells);
      if (totalCents === 0 && cells.every((c) => c === 0)) continue;
      cells.forEach((v, i) => {
        sectionCells[i] += v;
      });
      sl.push({ accountId: a.id, number: a.number, name: a.name, cells, totalCents });
    }
    return { key, label, lines: sl, cells: sectionCells, totalCents: sumCells(sectionCells) };
  };

  const income = build("income", ACCOUNT_TYPE_LABELS.INCOME, (a) => a.type === "INCOME", true);
  const costOfSales = build(
    "costOfSales",
    "Cost of sales",
    (a) => a.type === "EXPENSE" && a.subtype === COST_OF_SALES,
    false,
  );
  const expenses = build(
    "expenses",
    "Operating expenses",
    (a) => a.type === "EXPENSE" && a.subtype !== COST_OF_SALES,
    false,
  );

  const grossCells = subtractCells(income.cells, costOfSales.cells);
  const netCells = subtractCells(grossCells, expenses.cells);

  return {
    columns: columns.map((c) => ({ key: c.key, label: c.label })),
    income,
    costOfSales,
    grossProfit: { cells: grossCells, totalCents: sumCells(grossCells) },
    expenses,
    netIncome: { cells: netCells, totalCents: sumCells(netCells) },
    basis,
    excludedEntryIds,
  };
}

// ── Balance sheet ───────────────────────────────────────────────────────────

export type BalanceSheet = {
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /// Current-year earnings, shown as its own equity line because the ledger
  /// has no year-end closing entry: income and expense accounts keep their
  /// balances, so the balance sheet has to fold them into equity itself or it
  /// cannot balance. This IS the "net income flows to equity" requirement.
  currentYearNetIncomeCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  differenceCents: number;
  balanced: boolean;
  basis: BasisMode;
  excludedEntryIds: string[];
  fiscalYearStart: string;
};

/// `lines` must be EVERY posted line from the beginning of the books through
/// `asOf` — a balance sheet is cumulative, not a period report. `fiscalYearStart`
/// splits income and expenses into prior-year earnings (which belong in
/// retained earnings) and current-year earnings (its own line).
export function balanceSheet(
  accounts: ReportAccount[],
  lines: ReportLine[],
  asOf: string,
  fiscalYearStart: string,
  basis: BasisMode = "accrual",
  excludedEntryIds: string[] = [],
): BalanceSheet {
  const byId = new Map(accounts.map((a) => [a.id, a]));

  let currentYearNetIncomeCents = 0;
  let priorYearEarningsCents = 0;
  const balanceSheetTotals = new Map<string, Totals>();

  for (const l of lines) {
    const a = byId.get(l.accountId);
    if (!a) continue;
    if (a.type === "INCOME" || a.type === "EXPENSE") {
      // Credit-positive earnings, which is right for BOTH classes without a
      // branch: an income credit adds to earnings and an expense debit
      // subtracts from them, so one subtraction covers both.
      const earned = l.creditCents - l.debitCents;
      if (l.entryDate >= fiscalYearStart) currentYearNetIncomeCents += earned;
      else priorYearEarningsCents += earned;
      continue;
    }
    const t = balanceSheetTotals.get(l.accountId) ?? { debitCents: 0, creditCents: 0 };
    t.debitCents += l.debitCents;
    t.creditCents += l.creditCents;
    balanceSheetTotals.set(l.accountId, t);
  }

  const build = (key: string, label: string, type: AccountType): StatementSection => {
    const sl: StatementLine[] = [];
    let total = 0;
    for (const a of sortAccounts(accounts)) {
      if (a.type !== type) continue;
      const t = balanceSheetTotals.get(a.id);
      if (!t) continue;
      const v = signedBalance(a.normalBalance, t);
      if (v === 0) continue;
      // A contra account prints as a negative inside its parent's section —
      // accumulated depreciation reduces assets rather than adding to them.
      const shown = a.isContra ? -v : v;
      total += shown;
      sl.push({
        accountId: a.id,
        number: a.number,
        name: a.name,
        cells: [shown],
        totalCents: shown,
      });
    }
    return { key, label, lines: sl, cells: [total], totalCents: total };
  };

  const assets = build("assets", ACCOUNT_TYPE_LABELS.ASSET, "ASSET");
  const liabilities = build("liabilities", ACCOUNT_TYPE_LABELS.LIABILITY, "LIABILITY");
  const equity = build("equity", ACCOUNT_TYPE_LABELS.EQUITY, "EQUITY");

  // Prior-year earnings that were never closed out to 3900 by an entry belong
  // in equity too, or the sheet is short by exactly that amount.
  if (priorYearEarningsCents !== 0) {
    equity.lines.push({
      accountId: "__prior_earnings__",
      number: "",
      name: "Earnings from prior years",
      cells: [priorYearEarningsCents],
      totalCents: priorYearEarningsCents,
    });
    equity.totalCents += priorYearEarningsCents;
    equity.cells = [equity.totalCents];
  }

  equity.lines.push({
    accountId: "__current_year_net_income__",
    number: "",
    name: "Net income — current year",
    cells: [currentYearNetIncomeCents],
    totalCents: currentYearNetIncomeCents,
  });
  const totalEquityCents = equity.totalCents + currentYearNetIncomeCents;
  equity.totalCents = totalEquityCents;
  equity.cells = [totalEquityCents];

  const totalAssetsCents = assets.totalCents;
  const totalLiabilitiesCents = liabilities.totalCents;
  const differenceCents = totalAssetsCents - (totalLiabilitiesCents + totalEquityCents);

  return {
    asOf,
    assets,
    liabilities,
    equity,
    currentYearNetIncomeCents,
    totalAssetsCents,
    totalLiabilitiesCents,
    totalEquityCents,
    differenceCents,
    balanced: differenceCents === 0,
    basis,
    excludedEntryIds,
    fiscalYearStart,
  };
}

// ── Cash flow (indirect) ────────────────────────────────────────────────────

export type CashFlowLine = { label: string; accountId: string | null; amountCents: number };

export type CashFlowSection = { key: string; label: string; lines: CashFlowLine[]; totalCents: number };

export type CashFlowStatement = {
  from: string;
  to: string;
  netIncomeCents: number;
  /// Depreciation charged in the period, for the reader. Display only: the
  /// operating section's add-back is the accumulated-depreciation movement.
  depreciationCents: number;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangeCents: number;
  openingCashCents: number;
  closingCashCents: number;
  /// The statement's own proof: the change it computes must equal the change
  /// the cash accounts actually show. When it doesn't, `ties` is false and
  /// `differenceCents` says by how much — surfaced, never swallowed.
  actualChangeCents: number;
  differenceCents: number;
  ties: boolean;
  basis: BasisMode;
};

/// Which accounts hold cash. The bank and card GL accounts come from
/// lib/glBankAccounts (an account per bank, under 1000; per card, under 2100),
/// so the caller passes their ids — a hardcoded number list would miss every
/// account a club added itself.
export type CashFlowInputs = {
  cashAccountIds: Set<string>;
  /// Investing: fixed-asset and accumulated-depreciation accounts.
  investingAccountIds: Set<string>;
  /// Financing: loans and owner equity.
  financingAccountIds: Set<string>;
  /// ACCUMULATED depreciation (contra asset). Its movement IS the non-cash
  /// add-back, so it is shown in operating rather than investing — see the
  /// note on cashFlowIndirect for why adding depreciation separately AND
  /// showing this movement would double-count and stop the statement tying.
  accumDepAccountIds: Set<string>;
  /// Depreciation EXPENSE accounts. Reported for display only; the arithmetic
  /// uses accumDepAccountIds.
  depreciationAccountIds: Set<string>;
};

/// Default classification by account number, used when the caller has no
/// better information. Deliberately conservative: anything unrecognised falls
/// to operating, which is where an unclassified working-capital movement
/// belongs on an indirect statement.
export function classifyForCashFlow(
  accounts: ReportAccount[],
  bankAndCardAccountIds: Iterable<string>,
): CashFlowInputs {
  const cashAccountIds = new Set<string>();
  const investingAccountIds = new Set<string>();
  const financingAccountIds = new Set<string>();
  const accumDepAccountIds = new Set<string>();
  const depreciationAccountIds = new Set<string>();

  for (const id of bankAndCardAccountIds) cashAccountIds.add(id);

  for (const a of accounts) {
    // Undeposited funds and Stripe clearing are cash in transit: money the
    // club holds or is owed by its processor, not an operating receivable.
    if (a.systemKey === "UNDEPOSITED_FUNDS" || a.systemKey === "STRIPE_CLEARING") {
      cashAccountIds.add(a.id);
      continue;
    }
    if (a.type === "EXPENSE" && (a.number === "6800" || /depreciation/i.test(a.name))) {
      depreciationAccountIds.add(a.id);
      continue;
    }
    // A contra ASSET is accumulated depreciation: its own section, so the
    // add-back lands in operating exactly once.
    if (a.type === "ASSET" && a.isContra) {
      accumDepAccountIds.add(a.id);
      continue;
    }
    // Fixed assets start at 1500 in the template. String comparison is safe
    // here because every template number is four digits; a club that invents
    // "150" would sort oddly, which is why this is a default the caller may
    // override rather than the only classification.
    if (a.type === "ASSET" && a.number >= "1500") {
      investingAccountIds.add(a.id);
      continue;
    }
    if (a.type === "LIABILITY" && a.number === "2700") financingAccountIds.add(a.id);
    if (a.type === "EQUITY") financingAccountIds.add(a.id);
  }
  // A cash account is never also an investing, financing or add-back account.
  for (const id of cashAccountIds) {
    investingAccountIds.delete(id);
    financingAccountIds.delete(id);
    accumDepAccountIds.delete(id);
  }
  return {
    cashAccountIds,
    investingAccountIds,
    financingAccountIds,
    accumDepAccountIds,
    depreciationAccountIds,
  };
}

/// The indirect method: start from net income, add back the non-cash charges,
/// then show the change in every other balance-sheet account as a source or
/// use of cash. Because every entry balances, net income plus every
/// balance-sheet movement MUST equal the movement in cash — which is why this
/// function can check itself.
///
/// THE ADD-BACK IS THE ACCUMULATED-DEPRECIATION MOVEMENT, not a separate
/// figure read off the expense account. Both are the same number, so showing
/// the expense as an add-back AND the accumulated-depreciation movement in
/// investing counts it twice and the statement stops tying by exactly the
/// period's depreciation. Routing the contra-asset movement into operating
/// gives the standard presentation (add-back in operating, gross asset
/// purchases in investing) and ties by construction. `depreciationCents` is
/// reported for display and is NEVER added to a section total.
export function cashFlowIndirect(
  accounts: ReportAccount[],
  periodLines: ReportLine[],
  priorLines: ReportLine[],
  from: string,
  to: string,
  inputs: CashFlowInputs,
  basis: BasisMode = "accrual",
): CashFlowStatement {
  const byId = new Map(accounts.map((a) => [a.id, a]));

  let netIncomeCents = 0;
  let depreciationCents = 0;
  // Movement in each non-cash balance-sheet account, as the cash EFFECT:
  // a liability going up is cash in, an asset going up is cash out.
  const movement = new Map<string, number>();
  let actualChangeCents = 0;

  for (const l of periodLines) {
    const a = byId.get(l.accountId);
    if (!a) continue;

    if (inputs.cashAccountIds.has(a.id)) {
      // Cash accounts can be assets (bank, 1020, 1050) or liabilities (cards).
      // The change in cash is the change in the net asset position, so a card
      // balance growing is NOT cash in — it is excluded from cash and treated
      // as a financing-style liability movement below. Keep assets only here.
      if (a.type === "ASSET") actualChangeCents += l.debitCents - l.creditCents;
      else {
        const prev = movement.get(a.id) ?? 0;
        movement.set(a.id, prev + (l.creditCents - l.debitCents));
      }
      continue;
    }

    if (a.type === "INCOME" || a.type === "EXPENSE") {
      netIncomeCents += l.creditCents - l.debitCents;
      // Display only — see the note above. Adding this to a section total
      // would double-count against the accumulated-depreciation movement.
      if (inputs.depreciationAccountIds.has(a.id)) {
        depreciationCents += l.debitCents - l.creditCents;
      }
      continue;
    }

    // Balance-sheet account. Cash effect = credit movement.
    const prev = movement.get(a.id) ?? 0;
    movement.set(a.id, prev + (l.creditCents - l.debitCents));
  }

  const operatingLines: CashFlowLine[] = [];
  const investingLines: CashFlowLine[] = [];
  const financingLines: CashFlowLine[] = [];

  for (const [accountId, amountCents] of movement) {
    if (amountCents === 0) continue;
    const a = byId.get(accountId);
    if (!a) continue;
    const label = `${a.number ? `${a.number} ` : ""}${a.name}`;
    if (inputs.accumDepAccountIds.has(accountId)) {
      // The non-cash add-back, counted here and nowhere else.
      operatingLines.push({
        label: `Depreciation (non-cash) — ${label}`,
        accountId,
        amountCents,
      });
    } else if (inputs.investingAccountIds.has(accountId)) {
      investingLines.push({ label, accountId, amountCents });
    } else if (inputs.financingAccountIds.has(accountId)) {
      financingLines.push({ label, accountId, amountCents });
    } else {
      operatingLines.push({ label: `Change in ${label}`, accountId, amountCents });
    }
  }

  const sortLines = (ls: CashFlowLine[]) =>
    ls.sort((x, y) => x.label.localeCompare(y.label, "en", { numeric: true }));
  sortLines(operatingLines);
  sortLines(investingLines);
  sortLines(financingLines);

  const sectionTotal = (ls: CashFlowLine[]) => ls.reduce((s, l) => s + l.amountCents, 0);

  const operating: CashFlowSection = {
    key: "operating",
    label: "Operating activities",
    lines: operatingLines,
    totalCents: netIncomeCents + sectionTotal(operatingLines),
  };
  const investing: CashFlowSection = {
    key: "investing",
    label: "Investing activities",
    lines: investingLines,
    totalCents: sectionTotal(investingLines),
  };
  const financing: CashFlowSection = {
    key: "financing",
    label: "Financing activities",
    lines: financingLines,
    totalCents: sectionTotal(financingLines),
  };

  const netChangeCents = operating.totalCents + investing.totalCents + financing.totalCents;

  let openingCashCents = 0;
  for (const l of priorLines) {
    const a = byId.get(l.accountId);
    if (!a || !inputs.cashAccountIds.has(a.id) || a.type !== "ASSET") continue;
    openingCashCents += l.debitCents - l.creditCents;
  }

  const differenceCents = netChangeCents - actualChangeCents;
  return {
    from,
    to,
    netIncomeCents,
    depreciationCents,
    operating,
    investing,
    financing,
    netChangeCents,
    openingCashCents,
    closingCashCents: openingCashCents + actualChangeCents,
    actualChangeCents,
    differenceCents,
    ties: differenceCents === 0,
    basis,
  };
}
