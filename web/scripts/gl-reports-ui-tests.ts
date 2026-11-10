// Phase 12.1 Part 1 — the Books → Reports views, server-rendered.
//
//   npm run test:gl-reports-ui     (and it GATES the build)
//
// NO DATABASE, NO BROWSER. react-dom/server renders each view, which proves it
// does not THROW for the states that matter. It does not prove it looks right.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Four of the five reports crashed in production with "Application error: a
// client-side exception has occurred". The trial balance worked, which was the
// clue: it is the default statement, so its payload always matched the view on
// screen. Every other report was reached by CLICKING a statement button —
// which set `statement` synchronously while `data` still held the previous
// statement's payload for that one render, so e.g. GeneralLedgerView was
// handed a trial balance and ran `gl.accounts.map` on `undefined`.
//
// §1 renders every view against an empty club, because the second requirement
// is that a club with a chart of accounts and no postings sees an empty but
// valid report rather than an error. §2 is the regression test for the
// mismatch itself.
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import {
  BalanceSheetView,
  CashFlowView,
  GeneralLedgerView,
  PnlView,
  TrialBalanceView,
  payloadForStatement,
  type Loaded,
} from "../components/financials/ReportsTab";
import { STATEMENT_KEYS } from "../lib/glReportsExport";

const ROOT = join(__dirname, "..");
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, name: string, detail?: string) => {
  if (cond) pass++;
  else fails.push(detail ? `${name} — ${detail}` : name);
};
const eq = <T,>(actual: T, expected: T, name: string) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
/// Renders and returns the markup, or records the throw as a failure. A throw
/// here IS the production symptom.
const renders = (name: string, el: React.ReactElement): string => {
  try {
    const html = renderToStaticMarkup(el);
    pass++;
    return html;
  } catch (e) {
    fails.push(`${name} — THREW: ${(e as Error).message}`);
    return "";
  }
};

const noop = () => {};

// ── Fixtures: exactly what the routes return for a club with a chart of
// accounts, no books start date, and nothing posted ────────────────────────
const SECTION = (key: string, label: string) => ({ key, label, lines: [], cells: [0], totalCents: 0 });

const EMPTY_TB = {
  rows: [],
  totalDebitCents: 0,
  totalCreditCents: 0,
  differenceCents: 0,
  balanced: true,
  from: "2026-10-01",
  to: "2026-10-31",
  basis: "accrual" as const,
  basisNote: "Accrual basis: every posted entry, on the date it is dated.",
  excludedEntryIds: [],
};
const EMPTY_GL = {
  accounts: [],
  from: "2026-10-01",
  to: "2026-10-31",
  basis: "accrual" as const,
  basisNote: "Accrual basis.",
  excludedEntryIds: [],
};
const EMPTY_BS = {
  asOf: "2026-10-31",
  assets: SECTION("assets", "Assets"),
  liabilities: SECTION("liabilities", "Liabilities"),
  equity: {
    ...SECTION("equity", "Equity"),
    // The derived line the balance sheet always adds, even at zero.
    lines: [
      { accountId: "__current_year_net_income__", number: "", name: "Net income — current year", cells: [0], totalCents: 0 },
    ],
  },
  currentYearNetIncomeCents: 0,
  totalAssetsCents: 0,
  totalLiabilitiesCents: 0,
  totalEquityCents: 0,
  differenceCents: 0,
  balanced: true,
  basis: "accrual" as const,
  excludedEntryIds: [],
  fiscalYearStart: "2026-01-01",
  basisNote: "Accrual basis.",
};
const EMPTY_PNL = {
  columns: [{ key: "period", label: "Total" }],
  income: SECTION("income", "Income"),
  costOfSales: SECTION("costOfSales", "Cost of sales"),
  grossProfit: { cells: [0], totalCents: 0 },
  expenses: SECTION("expenses", "Operating expenses"),
  netIncome: { cells: [0], totalCents: 0 },
  basis: "accrual" as const,
  excludedEntryIds: [],
  from: "2026-10-01",
  to: "2026-10-31",
  byMonth: false,
  basisNote: "Accrual basis.",
};
const EMPTY_CF = {
  from: "2026-10-01",
  to: "2026-10-31",
  netIncomeCents: 0,
  depreciationCents: 0,
  operating: { key: "operating", label: "Operating activities", lines: [], totalCents: 0 },
  investing: { key: "investing", label: "Investing activities", lines: [], totalCents: 0 },
  financing: { key: "financing", label: "Financing activities", lines: [], totalCents: 0 },
  netChangeCents: 0,
  openingCashCents: 0,
  closingCashCents: 0,
  actualChangeCents: 0,
  differenceCents: 0,
  ties: true,
  basis: "accrual" as const,
  basisNote: "Accrual basis.",
  noBankAccountsMapped: true,
};

// ── 1. An empty club: every report renders ──────────────────────────────────
// This is the production state the bug report describes — a Pro club with a
// chart of accounts, no books start date and nothing posted.
console.log("[1] empty club");
{
  const tb = renders("1.1 trial balance renders empty", React.createElement(TrialBalanceView, { tb: EMPTY_TB, onDrill: noop }));
  ok(/Nothing posted in this period/.test(tb), "1.2 and says so, rather than showing a bare table");
  ok(/Debits equal credits/.test(tb), "1.3 and still reports that it balances");

  const gl = renders(
    "1.4 general ledger renders empty",
    React.createElement(GeneralLedgerView, { gl: EMPTY_GL, expanded: new Set<string>(), onToggle: noop, onOpenJournal: noop }),
  );
  ok(/Nothing posted in this period/.test(gl), "1.5 and says so");

  const bs = renders("1.6 balance sheet renders empty", React.createElement(BalanceSheetView, { bs: EMPTY_BS, onDrill: noop }));
  ok(/Assets equal liabilities plus equity/.test(bs), "1.7 and an empty balance sheet still balances");
  ok(/Nothing here/.test(bs), "1.8 with each empty section labelled");

  const pnl = renders("1.9 P&L renders empty", React.createElement(PnlView, { pnl: EMPTY_PNL, onDrill: noop }));
  ok(/Net income/.test(pnl), "1.10 with a net income line at zero");

  const cf = renders("1.11 cash flow renders empty", React.createElement(CashFlowView, { cf: EMPTY_CF, onDrill: noop }));
  ok(/change in the cash accounts/.test(cf), "1.12 and reports that it ties");
  ok(/No bank account is linked/.test(cf), "1.13 and explains why cash looks thin with no bank linked");
}

// ── 2. The mismatch that crashed production ─────────────────────────────────
// `payloadForStatement` is the fix: a loaded payload carries the statement it
// was fetched for, and a view can only be handed a payload that belongs to it.
console.log("\n[2] a payload can never reach the wrong view");
{
  const loaded: Loaded = { statement: "trial-balance", payload: EMPTY_TB };

  eq(payloadForStatement("trial-balance", loaded), EMPTY_TB, "2.1 a matching payload is returned");
  eq(payloadForStatement("general-ledger", loaded), null, "2.2 a trial-balance payload is NOT handed to the general ledger");
  eq(payloadForStatement("balance-sheet", loaded), null, "2.3 nor to the balance sheet");
  eq(payloadForStatement("pnl", loaded), null, "2.4 nor to the P&L");
  eq(payloadForStatement("cash-flow", loaded), null, "2.5 nor to the cash flow");
  eq(payloadForStatement("trial-balance", null), null, "2.6 and nothing is returned before anything has loaded");

  // Every pair, both directions: the only payload a view ever sees is its own.
  const wrong: string[] = [];
  for (const a of STATEMENT_KEYS) {
    for (const b of STATEMENT_KEYS) {
      // Cast is the point of the test: feeding deliberately mismatched
      // (statement, payload) pairs is what the live page used to do.
      const got = payloadForStatement(b, { statement: a, payload: EMPTY_TB } as Loaded);
      if (a === b ? got === null : got !== null) wrong.push(`${a}→${b}`);
    }
  }
  eq(wrong, [], "2.7 across all 25 statement pairs, a payload reaches exactly its own view");
}

// ── 3. The crash itself, still reproducible on the raw views ───────────────
// Proof that the fix in §2 is load-bearing rather than belt-and-braces: handed
// the wrong payload directly, these views still throw. That is what the live
// page was doing for one render after every statement click.
console.log("\n[3] the raw views still throw on a mismatched payload (so §2 must hold)");
{
  const throwsOn = (name: string, run: () => void) => {
    try {
      run();
      fails.push(`${name} — did NOT throw, so this test no longer proves anything`);
    } catch {
      pass++;
    }
  };
  throwsOn("3.1 GeneralLedgerView throws on a trial-balance payload", () =>
    renderToStaticMarkup(
      React.createElement(GeneralLedgerView, { gl: EMPTY_TB as never, expanded: new Set<string>(), onToggle: noop, onOpenJournal: noop }),
    ),
  );
  throwsOn("3.2 BalanceSheetView throws on a trial-balance payload", () =>
    renderToStaticMarkup(React.createElement(BalanceSheetView, { bs: EMPTY_TB as never, onDrill: noop })),
  );
  throwsOn("3.3 PnlView throws on a trial-balance payload", () =>
    renderToStaticMarkup(React.createElement(PnlView, { pnl: EMPTY_TB as never, onDrill: noop })),
  );
  throwsOn("3.4 CashFlowView throws on a trial-balance payload", () =>
    renderToStaticMarkup(React.createElement(CashFlowView, { cf: EMPTY_TB as never, onDrill: noop })),
  );
  throwsOn("3.5 TrialBalanceView throws on a P&L payload (switching back)", () =>
    renderToStaticMarkup(React.createElement(TrialBalanceView, { tb: EMPTY_PNL as never, onDrill: noop })),
  );
}

// ── 4. Source guarantees ────────────────────────────────────────────────────
console.log("\n[4] source guarantees");
{
  const raw = readFileSync(join(ROOT, "components/financials/ReportsTab.tsx"), "utf8");
  /// Blank comments rather than delete them, so line numbers stay true —
  /// the same helper shape scripts/permission-boundary-guard.ts uses. Needed
  /// here because the comment explaining the bug QUOTES the old cast, and a
  /// naive grep matches its own documentation.
  const strip = (x: string) =>
    x
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);
  const src = strip(raw);

  // The bug was a cast that asserted a type nobody had checked. If one comes
  // back, so does the crash.
  ok(
    !/\bdata as (Tb|Gl|Bs|Pnl|Cf)\b/.test(src),
    "4.1 no view is handed a payload through an unchecked `data as …` cast",
  );
  ok(
    /data as Gl/.test(raw),
    "4.1b …and the comment that explains the old bug is still there (if this fails, the grep above may be passing vacuously)",
  );
  ok(
    /payloadForStatement\(/.test(src),
    "4.2 the statement and its payload are matched before anything renders",
  );
  // A try/catch would have hidden this rather than fixed it.
  ok(
    !/componentDidCatch|ErrorBoundary/.test(src),
    "4.3 and it is fixed at the source, not wrapped in an error boundary",
  );
  // A superseded request must not land after a newer one.
  ok(
    /cancelled/.test(src),
    "4.4 an in-flight request is abandoned when the statement changes, so a slow response can't overwrite a newer one",
  );
}

console.log(`\n${fails.length ? "✗" : "✓"} gl-reports-ui: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
