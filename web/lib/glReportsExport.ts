// Accounting Phase 3 — statements shaped for a CPA. PURE.
//
// Turns the payloads from lib/glReports.ts into flat tables, which
// lib/exporters.ts then writes as CSV or as one sheet of a workbook. Nothing
// here reads a database or a clock.
//
// ── Money leaves the ledger as a NUMBER, not a string ───────────────────────
// Inside the ledger money is integer cents (lib/ledger.ts explains why). An
// export is the one place it becomes dollars, and it becomes a real number —
// never "$1,234.56" and never "(1,234.56)" — because the CPA's first action is
// to sum the column, and a formatted string sums to zero. The sign carries the
// meaning instead.

import {
  type BalanceSheet,
  type CashFlowStatement,
  type GeneralLedgerAccount,
  type ProfitAndLoss,
  type TrialBalance,
} from "@/lib/glReports";

export type ExportTable = {
  /// Sheet name and CSV filename stem. buildWorkbook truncates and de-dupes.
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
};

export const STATEMENT_KEYS = [
  "trial-balance",
  "general-ledger",
  "balance-sheet",
  "pnl",
  "cash-flow",
] as const;
export type StatementKey = (typeof STATEMENT_KEYS)[number];

export const STATEMENT_LABELS: Record<StatementKey, string> = {
  "trial-balance": "Trial Balance",
  "general-ledger": "General Ledger",
  "balance-sheet": "Balance Sheet",
  pnl: "Profit and Loss",
  "cash-flow": "Cash Flow",
};

export function parseStatementKey(raw: string | null | undefined): StatementKey | null {
  return STATEMENT_KEYS.includes(raw as StatementKey) ? (raw as StatementKey) : null;
}

/// Cents → dollars as a number. `cents` is always an integer here, so the
/// division is exact to the cent at every magnitude a club will ever see.
export function dollars(cents: number): number {
  return cents / 100;
}

// ── Trial balance ───────────────────────────────────────────────────────────

export function trialBalanceTable(tb: TrialBalance, heading?: string): ExportTable {
  const rows: (string | number | null)[][] = tb.rows.map((r) => [
    r.number,
    r.name,
    r.type,
    r.debitCents ? dollars(r.debitCents) : null,
    r.creditCents ? dollars(r.creditCents) : null,
  ]);
  rows.push([]);
  rows.push(["", "TOTAL", "", dollars(tb.totalDebitCents), dollars(tb.totalCreditCents)]);
  // The proof line. A CPA opening this wants to see that it balances without
  // adding the column up themselves — and if it does not, wants to know before
  // they build anything on it.
  rows.push([
    "",
    tb.balanced ? "In balance" : "OUT OF BALANCE — do not file",
    "",
    null,
    tb.balanced ? null : dollars(tb.differenceCents),
  ]);
  return {
    title: heading ?? STATEMENT_LABELS["trial-balance"],
    headers: ["Account", "Name", "Type", "Debit", "Credit"],
    rows,
  };
}

// ── General ledger ──────────────────────────────────────────────────────────

/// One flat sheet with the account repeated on each row, rather than a sheet
/// per account: a CPA filters and pivots this, and 60 sheets cannot be.
export function generalLedgerTable(
  accounts: GeneralLedgerAccount[],
  heading?: string,
): ExportTable {
  const rows: (string | number | null)[][] = [];
  for (const a of accounts) {
    rows.push([
      a.number,
      a.name,
      "",
      "Opening balance",
      "",
      "",
      null,
      null,
      dollars(a.openingCents),
    ]);
    for (const r of a.rows) {
      rows.push([
        a.number,
        a.name,
        r.entryDate,
        [r.memo, r.lineMemo].filter(Boolean).join(" · ") || "",
        r.reference ?? "",
        r.program ?? "",
        r.debitCents ? dollars(r.debitCents) : null,
        r.creditCents ? dollars(r.creditCents) : null,
        dollars(r.balanceCents),
      ]);
    }
    rows.push([
      a.number,
      a.name,
      "",
      "Closing balance",
      "",
      "",
      dollars(a.debitCents),
      dollars(a.creditCents),
      dollars(a.closingCents),
    ]);
    rows.push([]);
  }
  return {
    title: heading ?? STATEMENT_LABELS["general-ledger"],
    headers: [
      "Account",
      "Name",
      "Date",
      "Memo",
      "Reference",
      "Program",
      "Debit",
      "Credit",
      "Balance",
    ],
    rows,
  };
}

// ── Balance sheet ───────────────────────────────────────────────────────────

export function balanceSheetTable(bs: BalanceSheet, heading?: string): ExportTable {
  const rows: (string | number | null)[][] = [];
  const section = (label: string, lines: { number: string; name: string; totalCents: number }[], totalCents: number) => {
    rows.push([label, "", null]);
    for (const l of lines) rows.push([l.number, l.name, dollars(l.totalCents)]);
    rows.push(["", `Total ${label.toLowerCase()}`, dollars(totalCents)]);
    rows.push([]);
  };
  section("Assets", bs.assets.lines, bs.totalAssetsCents);
  section("Liabilities", bs.liabilities.lines, bs.totalLiabilitiesCents);
  section("Equity", bs.equity.lines, bs.totalEquityCents);
  rows.push([
    "",
    "Total liabilities and equity",
    dollars(bs.totalLiabilitiesCents + bs.totalEquityCents),
  ]);
  rows.push([
    "",
    bs.balanced ? "Balances" : "DOES NOT BALANCE — do not file",
    bs.balanced ? null : dollars(bs.differenceCents),
  ]);
  return {
    title: heading ?? STATEMENT_LABELS["balance-sheet"],
    headers: [`As of ${bs.asOf}`, "", "Amount"],
    rows,
  };
}

// ── Profit & loss ───────────────────────────────────────────────────────────

export function pnlTable(pnl: ProfitAndLoss, heading?: string): ExportTable {
  const multi = pnl.columns.length > 1;
  const headers = ["Account", "Name", ...pnl.columns.map((c) => c.label)];
  if (multi) headers.push("Total");

  const rows: (string | number | null)[][] = [];
  const cells = (cs: number[], total: number) =>
    multi ? [...cs.map(dollars), dollars(total)] : [dollars(total)];

  const section = (label: string, s: ProfitAndLoss["income"]) => {
    rows.push([label, "", ...new Array(multi ? pnl.columns.length + 1 : 1).fill(null)]);
    for (const l of s.lines) rows.push([l.number, l.name, ...cells(l.cells, l.totalCents)]);
    rows.push(["", `Total ${label.toLowerCase()}`, ...cells(s.cells, s.totalCents)]);
    rows.push([]);
  };

  section("Income", pnl.income);
  if (pnl.costOfSales.lines.length) {
    section("Cost of sales", pnl.costOfSales);
    rows.push(["", "Gross profit", ...cells(pnl.grossProfit.cells, pnl.grossProfit.totalCents)]);
    rows.push([]);
  }
  section("Operating expenses", pnl.expenses);
  rows.push(["", "Net income", ...cells(pnl.netIncome.cells, pnl.netIncome.totalCents)]);
  return { title: heading ?? STATEMENT_LABELS.pnl, headers, rows };
}

// ── Cash flow ───────────────────────────────────────────────────────────────

export function cashFlowTable(cf: CashFlowStatement, heading?: string): ExportTable {
  const rows: (string | number | null)[][] = [
    ["Net income", dollars(cf.netIncomeCents)],
    [],
  ];
  const section = (s: CashFlowStatement["operating"]) => {
    rows.push([s.label, null]);
    for (const l of s.lines) rows.push([l.label, dollars(l.amountCents)]);
    rows.push([`Net cash from ${s.label.toLowerCase()}`, dollars(s.totalCents)]);
    rows.push([]);
  };
  section(cf.operating);
  section(cf.investing);
  section(cf.financing);
  rows.push(["Net change in cash", dollars(cf.netChangeCents)]);
  rows.push(["Cash at start of period", dollars(cf.openingCashCents)]);
  rows.push(["Cash at end of period", dollars(cf.closingCashCents)]);
  rows.push([
    cf.ties
      ? "Ties to the movement in the cash accounts"
      : "DOES NOT TIE to the movement in the cash accounts — do not file",
    cf.ties ? null : dollars(cf.differenceCents),
  ]);
  return {
    title: heading ?? STATEMENT_LABELS["cash-flow"],
    headers: [`${cf.from} to ${cf.to}`, "Amount"],
    rows,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/// A leading `=`, `+`, `-` or `@` makes a spreadsheet treat a cell as a
/// formula, which is a real injection route when any of this text came from a
/// club's own account or program names. Prefixing a single quote neutralises
/// it and is what Excel and Sheets both read as "literal text".
///
/// Numbers are exempt — a negative amount must stay a negative amount, and it
/// is a number here, never a string.
export function csvSafe(v: string | number | null | undefined): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function tableToCsvRows(t: ExportTable): (string | number)[][] {
  const width = Math.max(t.headers.length, ...t.rows.map((r) => r.length), 1);
  const pad = (r: (string | number | null)[]) => {
    const out: (string | number)[] = [];
    for (let i = 0; i < width; i += 1) out.push(csvSafe(r[i]));
    return out;
  };
  return [pad(t.headers), ...t.rows.map(pad)];
}
