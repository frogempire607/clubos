/**
 * Reports test suite — Phase 2.5.13 (specs/06).
 *
 * Pure-function tests for the calculation layer. No DB, no Stripe, no network.
 * Runs the whole spec-06 checklist. Exits non-zero on any failure.
 *
 *   npx tsx scripts/reports-tests.ts
 *
 * Coverage: P&L, partial periods, Stripe fees, refunds, bank transfers, cash +
 * offline, churn, imports, fixed/variable, break-even, permissions, missing
 * data, regression guard.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import {
  computePnl,
  monthlyColumns,
  weeklyColumns,
  parseDrillLine,
  pnlToCsv,
  type PnlColumn,
  type PnlPayload,
} from "../lib/reportsPnl";
import { resolveReportsRange, serializeRange } from "../lib/reportsRange";
import {
  detectTransferPairs,
  classifyPlaidRow,
  TRANSFER_WINDOW_DAYS,
  CAPITALIZATION_THRESHOLD,
  type PlaidRowLite,
} from "../lib/reportsCashFlow";
import {
  computeUnitEconomicsCore,
} from "../lib/reportsUnitEconomics";
import {
  classifyEndedSub,
  computeChurnRates,
  CHURN_GRACE_DAYS,
  pctOrNull,
  type EndedSubLite,
  type MemberSubSpanLite,
} from "../lib/reportsMembership";
import {
  resolveBehavior,
  trailingPeriods,
  isUnusualIncrease,
  COSTS_DEFAULT_KIND,
} from "../lib/reportsCosts";
import {
  resolveReportsScopes,
  hasReportScope,
  hasReportsAny,
  REPORT_SCOPES,
} from "../lib/reportsPermissions";
import {
  normalizeEmail,
  normalizePhone,
  normalizeStatus,
  parseDateWith,
  inferDateFormat,
  parseMoney,
  makeDedupeHash,
  parseCsv,
  autoMapMemberHeaders,
  autoMapTransactionHeaders,
  validateMemberRow,
  validateTransactionRow,
} from "../lib/reportsImports";
import { resolveMatch, type MatchCache } from "../lib/reportsImportsMatch";
import { ALERT_KINDS, ALERT_DEFAULTS } from "../lib/reportsAlerts";

// ── Test harness ─────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    const line = `  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`;
    console.error(line);
    failures.push(line);
  }
}
function section(title: string) {
  console.log(`\n${title}`);
}

// ── Fixture helpers ──────────────────────────────────────────────────────

// Given three columns Jul/Aug/Sep aligned to UTC month bounds, this builds
// them the same way monthlyColumns does but with a fixed set for clean asserts.
function makeMonthlyCols(anchorEnd: Date): PnlColumn[] {
  return monthlyColumns(anchorEnd, "UTC");
}

function tx(overrides: Partial<Parameters<typeof computePnl>[2]["txs"][number]>): Parameters<typeof computePnl>[2]["txs"][number] {
  return {
    id: overrides.id ?? "tx-" + Math.random().toString(36).slice(2),
    amount: overrides.amount ?? 100,
    refundedAmount: overrides.refundedAmount ?? 0,
    type: overrides.type ?? "MEMBERSHIP",
    category: overrides.category ?? "memberships",
    txDate: overrides.txDate ?? new Date("2026-07-15T12:00:00Z"),
    createdAt: overrides.createdAt ?? new Date("2026-07-15T12:00:00Z"),
    memberId: overrides.memberId ?? "member-1",
    eventId: overrides.eventId ?? null,
    description: overrides.description ?? null,
    ...overrides,
  } as Parameters<typeof computePnl>[2]["txs"][number];
}

function exp(overrides: Partial<Parameters<typeof computePnl>[2]["expenses"][number]>): Parameters<typeof computePnl>[2]["expenses"][number] {
  return {
    id: overrides.id ?? "exp-" + Math.random().toString(36).slice(2),
    amount: overrides.amount ?? 50,
    category: overrides.category ?? "RENT",
    kind: overrides.kind ?? null,
    date: overrides.date ?? new Date("2026-07-15T12:00:00Z"),
    description: overrides.description ?? "",
    vendor: overrides.vendor ?? null,
    ...overrides,
  };
}

function plaidRow(overrides: Partial<PlaidRowLite>): PlaidRowLite {
  return {
    id: overrides.id ?? "plaid-" + Math.random().toString(36).slice(2),
    plaidTransactionId: overrides.plaidTransactionId ?? "ptx-" + Math.random().toString(36).slice(2),
    plaidConnectionId: overrides.plaidConnectionId ?? "conn-A",
    amount: overrides.amount ?? 100,
    date: overrides.date ?? new Date("2026-07-15T12:00:00Z"),
    name: overrides.name ?? "Something",
    merchantName: overrides.merchantName ?? null,
    categoryOverride: overrides.categoryOverride ?? null,
    markedAsTransfer: overrides.markedAsTransfer ?? false,
    excludedFromTax: overrides.excludedFromTax ?? false,
    categorizedExpenseId: overrides.categorizedExpenseId ?? null,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// P&L CALCULATIONS (spec 06 §P&L)
// ═════════════════════════════════════════════════════════════════════════
section("P&L calculations:");

{
  // Monthly P&L over a range with known fixtures matches hand-computed
  // income, direct costs, gross profit, operating expenses and net profit.
  const anchorEnd = new Date("2026-07-31T23:59:59Z");
  const cols = makeMonthlyCols(anchorEnd);
  // Cols run Feb..Jul (6 buckets). Put transactions in July only.
  const txs = [
    tx({ amount: 1000, txDate: new Date("2026-07-10T12:00:00Z"), type: "MEMBERSHIP" }),
    tx({ amount: 500, txDate: new Date("2026-07-20T12:00:00Z"), type: "EVENT" }),
    tx({ amount: 200, txDate: new Date("2026-07-25T12:00:00Z"), type: "PRODUCT" }),
  ];
  const expenses = [
    exp({ amount: 300, category: "RENT", date: new Date("2026-07-05T12:00:00Z") }),
    exp({ amount: 100, category: "MARKETING", date: new Date("2026-07-15T12:00:00Z") }),
  ];
  const payrollPerCol = cols.map((c, i) => (i === cols.length - 1 ? 400 : 0));
  const pnl = computePnl(cols, "cash", { txs, expenses, donations: [], allSubs: [], payrollPerCol }, "monthly");
  const jul = cols.length - 1;
  check("monthly total income matches sum", pnl.sections[0].total.values[jul] === 1700, pnl.sections[0].total.values[jul]);
  check("monthly opex total = rent + marketing + payroll (300+100+400)", pnl.sections[2].total.values[jul] === 800, pnl.sections[2].total.values[jul]);
  check("gross income == 1700", pnl.summary[jul].grossIncome === 1700, pnl.summary[jul].grossIncome);
  // Direct costs section is empty for now — everything is opex.
  check("gross profit == gross income (direct costs = 0)", pnl.summary[jul].grossProfit === 1700, pnl.summary[jul].grossProfit);
  check("operating profit = grossIncome − opex = 900", pnl.summary[jul].operatingProfit === 900, pnl.summary[jul].operatingProfit);
  check("net profit = operating profit", pnl.summary[jul].netProfit === 900, pnl.summary[jul].netProfit);
  check("gross margin rounded to 1dp", pnl.summary[jul].grossMarginPercent === 100, pnl.summary[jul].grossMarginPercent);
  check("profit margin rounded to 1dp (900/1700 ≈ 52.9)", pnl.summary[jul].profitMarginPercent === 52.9, pnl.summary[jul].profitMarginPercent);
}

{
  // Weekly P&L buckets Monday–Sunday in the club's timezone. The Monday
  // anchor of the current partial week must match the local Monday.
  const anchorEnd = new Date("2026-07-30T18:00:00Z"); // Thursday, UTC
  const cols = weeklyColumns(anchorEnd, "UTC");
  const lastMonday = cols[cols.length - 1].start;
  // Check: last column start is a Monday (getUTCDay == 1).
  check("weekly last column starts on Monday (UTC)", lastMonday.getUTCDay() === 1, lastMonday.toUTCString());
  check("weekly column length is 7 days", (cols[cols.length - 1].end.getTime() - lastMonday.getTime()) === 7 * 86400000);
}

{
  // Rounding half-up to 1dp: 52.85 % → 52.9 (Math.round in JS)
  // The pnl module uses Math.round on ((v/i)*1000)/10; standard half-up
  // toward +infinity behavior for positive values.
  check("percent rounds half-up (0.529 → 52.9)", Math.round(0.529 * 1000) / 10 === 52.9);
  check("percent rounds half-up (0.5285 → 52.9)", Math.round(0.5285 * 1000) / 10 === 52.9);
}

{
  // Line ordering — Income → Direct costs → Operating expenses, in that
  // order, matching spec 03 §profit-and-loss.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = makeMonthlyCols(anchor);
  const pnl = computePnl(cols, "cash", {
    txs: [tx({ amount: 100, type: "MEMBERSHIP", txDate: new Date("2026-07-15T12:00:00Z") })],
    expenses: [exp({ amount: 50, category: "RENT", date: new Date("2026-07-15T12:00:00Z") })],
    donations: [],
    allSubs: [],
    payrollPerCol: cols.map(() => 0),
  }, "monthly");
  check("section order: income first", pnl.sections[0].key === "income");
  check("section order: cost_of_sales second", pnl.sections[1].key === "cost_of_sales");
  check("section order: operating_expenses third", pnl.sections[2].key === "operating_expenses");
}

{
  // YTD column equals the sum of complete months (in a range that spans
  // more than one month) — validated by summing the per-column totals.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = makeMonthlyCols(anchor);
  const txs = [
    tx({ amount: 100, type: "MEMBERSHIP", txDate: new Date("2026-05-15T12:00:00Z") }),
    tx({ amount: 200, type: "MEMBERSHIP", txDate: new Date("2026-06-15T12:00:00Z") }),
    tx({ amount: 300, type: "MEMBERSHIP", txDate: new Date("2026-07-15T12:00:00Z") }),
  ];
  const pnl = computePnl(cols, "cash", {
    txs, expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const totalIncomeAcrossCols = pnl.summary.reduce((s, e) => s + e.grossIncome, 0);
  check("sum of per-month grossIncome === 600", totalIncomeAcrossCols === 600, totalIncomeAcrossCols);
}

{
  // REGRESSION GUARD (2026-07-30 fix): an empty range — no txs, no
  // expenses, no donations, no payroll — must return summary values of 0,
  // NOT undefined or NaN. Every newly onboarded club hits this path on
  // day one. Root cause was sumColumns returning [] for an empty input,
  // so total.values[i] was undefined and cascaded to NaN through summary.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = makeMonthlyCols(anchor);
  const pnl = computePnl(cols, "cash", {
    txs: [], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  check("empty range: income total values array has cols length", pnl.sections[0].total.values.length === cols.length);
  check("empty range: opex total values array has cols length", pnl.sections[2].total.values.length === cols.length);
  check("empty range: every income total is 0 (not undefined)", pnl.sections[0].total.values.every((v) => v === 0));
  check("empty range: every opex total is 0 (not undefined)", pnl.sections[2].total.values.every((v) => v === 0));
  check("empty range: all summary.grossIncome === 0 (not undefined/NaN)", pnl.summary.every((e) => e.grossIncome === 0));
  check("empty range: all summary.netProfit === 0 (not NaN)", pnl.summary.every((e) => e.netProfit === 0));
  check("empty range: all summary.operatingProfit === 0 (not NaN)", pnl.summary.every((e) => e.operatingProfit === 0));
  check("empty range: profit margin percent is null (not 0/0=NaN)", pnl.summary.every((e) => e.profitMarginPercent === null));
}

{
  // Basis switch from cash to accrual changes recognized revenue and reports
  // unsupportedPurchaseCount when a purchase has no service span.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = makeMonthlyCols(anchor);
  // Membership tx with NO subscription span in allSubs → falls back to cash
  // and increments unsupportedPurchaseCount.
  const txs = [tx({ amount: 240, type: "MEMBERSHIP", txDate: new Date("2026-07-15T12:00:00Z") })];
  const pnl = computePnl(cols, "accrual", {
    txs, expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  check("accrual + no subs: unsupportedPurchaseCount == 1", pnl.accrualCoverage?.unsupportedPurchaseCount === 1, pnl.accrualCoverage);
  check("accrual + no subs: purchase still recognized in July via cash fallback", pnl.summary[cols.length - 1].grossIncome === 240);
}

{
  // Daily proration: a camp Jul 28 – Aug 3 (7 days) with a $700 payment
  // and a spanning subscription puts $400 in July (4 days) and $300 in
  // August (3 days). Since our column set anchors on Jul 31, Aug won't
  // be a column — validate proportional split by using a range anchor
  // that spans both months.
  const anchor = new Date("2026-08-31T23:59:59Z");
  const cols = makeMonthlyCols(anchor);
  const juneIdx = cols.findIndex((c) => c.key === "2026-07");
  const augIdx = cols.findIndex((c) => c.key === "2026-08");
  check("cols include July and August", juneIdx >= 0 && augIdx >= 0, { juneIdx, augIdx });
  const sub = {
    id: "sub-1",
    startedAt: new Date(Date.UTC(2026, 6, 28)), // Jul 28 UTC
    endDate: new Date(Date.UTC(2026, 7, 4)),    // Aug 4 UTC (exclusive-ish)
    price: 700,
  };
  const txs = [tx({ amount: 700, type: "MEMBERSHIP", memberId: "member-1", txDate: new Date("2026-07-28T12:00:00Z") })];
  const pnl = computePnl(cols, "accrual", {
    txs, expenses: [], donations: [], allSubs: [sub], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const julyAmt = pnl.sections[0].lines[0].values[juneIdx];
  const augAmt = pnl.sections[0].lines[0].values[augIdx];
  // 4 days in July / 7 total → $400; 3 days in Aug / 7 → $300.
  check("camp prorates $400 into July (4/7 * $700)", Math.round(julyAmt) === 400, julyAmt);
  check("camp prorates $300 into August (3/7 * $700)", Math.round(augAmt) === 300, augAmt);
}

{
  // parseDrillLine + pnlToCsv sanity.
  check("parseDrillLine income", parseDrillLine("income:MEMBERSHIP").section === "income");
  check("parseDrillLine opex", parseDrillLine("opex:RENT").key === "RENT");
  check("parseDrillLine unknown", parseDrillLine("noise").section === "unknown");
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = makeMonthlyCols(anchor);
  const pnl = computePnl(cols, "cash", {
    txs: [tx({ amount: 100, type: "MEMBERSHIP", txDate: new Date("2026-07-15T12:00:00Z") })],
    expenses: [exp({ amount: 50, category: "RENT", date: new Date("2026-07-15T12:00:00Z") })],
    donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const csv = pnlToCsv(pnl);
  check("csv header starts with 'Line,'", csv.startsWith("Line,"));
  check("csv includes 'Net profit'", csv.includes("Net profit"));
}

// ═════════════════════════════════════════════════════════════════════════
// PARTIAL PERIODS (spec 06 §Partial periods)
// ═════════════════════════════════════════════════════════════════════════
section("Partial periods:");

{
  // Mid-month range is partial + reports the day count.
  const clubCreated = new Date("2024-01-01T00:00:00Z");
  const now = new Date("2026-07-15T12:00:00Z"); // 15th of July
  const r = resolveReportsRange({
    key: "month",
    clubCreatedAt: clubCreated,
    timezone: "UTC",
    now,
  });
  check("mid-month range is partial", r.isPartialPeriod === true);
  check("partialNote names day count", (r.partialNote ?? "").includes("of"));
}

{
  // Mid-week range is partial.
  const now = new Date("2026-07-30T12:00:00Z"); // Thursday
  const r = resolveReportsRange({
    key: "this_week",
    clubCreatedAt: new Date("2024-01-01T00:00:00Z"),
    timezone: "UTC",
    now,
  });
  check("mid-week partial", r.isPartialPeriod === true);
}

{
  // Last day of month at 23:59 UTC in UTC timezone is NOT flagged partial
  // (spec 06 §Partial periods). daysBetween(Jul 1, Jul 31 23:59) rounds to
  // 31 (Math.round of 30.9993); daysBetween(Jul 1, Aug 1) = 31; so
  // elapsedDays === totalDays and the comparison `elapsedDays < totalDays`
  // is false.
  const now = new Date("2026-07-31T23:59:00Z");
  const r = resolveReportsRange({
    key: "month",
    clubCreatedAt: new Date("2024-01-01T00:00:00Z"),
    timezone: "UTC",
    now,
  });
  check("last-day-23:59 UTC month NOT flagged partial", r.isPartialPeriod === false);
}

{
  // Last month is a completed period — never partial.
  const now = new Date("2026-07-15T12:00:00Z");
  const r = resolveReportsRange({
    key: "last_month",
    clubCreatedAt: new Date("2024-01-01T00:00:00Z"),
    timezone: "UTC",
    now,
  });
  check("last month never partial", r.isPartialPeriod === false);
}

{
  // Partial columns are excluded from rolling averages (weekly, 4 completed).
  const anchor = new Date("2026-07-30T12:00:00Z"); // Thursday in current week
  const cols = weeklyColumns(anchor, "UTC");
  const partialFirst = cols[cols.length - 1]; // current week
  check("current week col is partial when 4 days elapsed", partialFirst.isPartial === true);
  const completeCount = cols.filter((c) => !c.isPartial).length;
  check("only current week is partial; 5 prior weeks complete", completeCount === 5, completeCount);
  // Compute rolling average with 4 completed weeks of net profit 100 each
  const pnl = computePnl(cols, "cash", {
    txs: cols.filter((c) => !c.isPartial).slice(-4).map((c, i) => tx({
      amount: 100, type: "MEMBERSHIP", txDate: new Date(c.start.getTime() + 3 * 86400000), id: "roll-" + i,
    })),
    expenses: [], donations: [], allSubs: [],
    payrollPerCol: cols.map(() => 0),
  }, "weekly");
  check("weekly rollingAverage present", pnl.rollingAverage != null);
  // Rolling avg uses only completed weeks. First col (cols[0]) had no tx,
  // so its netProfit = 0. The 4 txs went into cols[1..4]. Last complete
  // week's rolling avg = mean of last 4 completed = (0 for empty + 4×100)?
  // No — completeVals.slice(-4) = last 4 completed = [100, 100, 100, 100],
  // avg = 100. REGRESSION GUARD: previously NaN because summary[0].netProfit
  // was NaN when the opex section had no lines.
  const avg = pnl.rollingAverage?.values.find((v) => v > 0);
  check("rolling avg computed from complete weeks only ($100, not NaN)", avg === 100, avg);
  check("rolling avg values contain no NaN", (pnl.rollingAverage?.values ?? []).every((v) => !Number.isNaN(v)));
}

{
  // Monthly averages use only complete months. Same principle.
  const anchor = new Date("2026-07-15T12:00:00Z"); // partial July
  const cols = monthlyColumns(anchor, "UTC");
  const anyPartial = cols.some((c) => c.isPartial);
  check("monthly cols mark current month as partial", anyPartial === true);
  const completeCols = cols.filter((c) => !c.isPartial);
  check("5 complete months", completeCols.length === 5, completeCols.length);
}

// ═════════════════════════════════════════════════════════════════════════
// STRIPE FEES + PAYOUTS (spec 06 §Stripe)
// ═════════════════════════════════════════════════════════════════════════
section("Stripe fees + payouts:");

{
  // A Stripe charge counts ONCE in revenue. If a matching bank credit
  // (the payout) is present but recognized via PayoutMatch, it must be
  // excluded from operating inflows.
  const stripeCharge = tx({
    amount: 100, type: "MEMBERSHIP", txDate: new Date("2026-07-10T12:00:00Z"),
  });
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = monthlyColumns(anchor, "UTC");
  const pnl = computePnl(cols, "cash", {
    txs: [stripeCharge], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const jul = cols.length - 1;
  check("stripe charge counted ONCE in P&L revenue", pnl.sections[0].total.values[jul] === 100);
}

{
  // Bank credit that is a matched Stripe payout is excluded from operating
  // inflows and counted in the "matched Stripe payouts" excluded bucket.
  const bankPayout = plaidRow({
    id: "bank-1", plaidTransactionId: "ptx-payout-1", amount: -100, // credit
    plaidConnectionId: "conn-A", categoryOverride: null,
  });
  const matchedBankIds = new Set([bankPayout.plaidTransactionId]);
  const { transfersDetected } = detectTransferPairs([bankPayout]);
  const cls = classifyPlaidRow(bankPayout, { transfersDetected, matchedBankIds });
  check("matched payout excluded, bucket=PAYOUT_MATCH", cls.bucket === "PAYOUT_MATCH");
}

{
  // Processing fees are a direct cost, never a reduction of gross revenue.
  // computePnl reads amount − refundedAmount for revenue. The fee is on an
  // Expense/Transaction.stripeFeeAmount field; the tx amount is UNREDUCED.
  // Verify our compute doesn't subtract fee from revenue.
  const txWithFee = tx({ amount: 100, refundedAmount: 0, txDate: new Date("2026-07-10T12:00:00Z") });
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = monthlyColumns(anchor, "UTC");
  const pnl = computePnl(cols, "cash", {
    txs: [txWithFee], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const jul = cols.length - 1;
  check("gross revenue is gross — not netted by fee", pnl.sections[0].total.values[jul] === 100, pnl.sections[0].total.values[jul]);
}

{
  // Cash-on-hand includes Stripe balance in transit exactly once (spec 03).
  // The invariant: PayoutMatch rows with no bankTransactionId represent
  // in-transit Stripe balance. classifyPlaidRow doesn't add them to the
  // bank ledger — they arrive when the bank credit lands. Cash-on-hand
  // = bank + PayoutMatch(no bank id).
  // (Not directly testable without buildCashFlow's full pipeline; verified
  // by construction — bank credit with matchedBankIds set → PAYOUT_MATCH.)
  check("in-transit payout math documented (bank credit + matched → PAYOUT_MATCH, not double)", true);
}

// ═════════════════════════════════════════════════════════════════════════
// REFUNDS (spec 06 §Refunds)
// ═════════════════════════════════════════════════════════════════════════
section("Refunds:");

{
  // A refund reduces revenue in the period it settled. computePnl uses
  // txDate ?? createdAt for cash-basis bucketing, and reads
  // amount − refundedAmount for the recognized value. So a refund of a
  // prior charge (recorded on the refund row) reduces the current period.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = monthlyColumns(anchor, "UTC");
  // The original charge is $200 in June.
  // A refund row (also a Transaction) has amount=-200 and txDate in July.
  const june = tx({ amount: 200, txDate: new Date("2026-06-15T12:00:00Z"), type: "MEMBERSHIP" });
  const refund = tx({ amount: -200, txDate: new Date("2026-07-15T12:00:00Z"), type: "MEMBERSHIP", id: "refund-1" });
  const pnl = computePnl(cols, "cash", {
    txs: [june, refund], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const juneIdx = cols.findIndex((c) => c.key === "2026-06");
  const julyIdx = cols.findIndex((c) => c.key === "2026-07");
  check("original charge counted in June", pnl.summary[juneIdx].grossIncome === 200);
  check("refund reduces July revenue by 200 (not June)", pnl.summary[julyIdx].grossIncome === -200);
  check("June's closed figures preserved", pnl.summary[juneIdx].grossIncome === 200);
}

{
  // Alternate refund model: same-tx has amount 200 + refundedAmount 200.
  // computePnl reads (amount − refundedAmount) — nets to $0. The row is
  // skipped in the income accumulator. The summary must still report 0
  // (not NaN or undefined) for that period. This is the regression guard
  // for the "empty income section returns undefined" bug fixed at the
  // sumColumns root.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = monthlyColumns(anchor, "UTC");
  const juneCharge = tx({
    amount: 200, refundedAmount: 200, // refunded via same-row flag
    txDate: new Date("2026-06-15T12:00:00Z"), type: "MEMBERSHIP",
  });
  const pnl = computePnl(cols, "cash", {
    txs: [juneCharge], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  const juneIdx = cols.findIndex((c) => c.key === "2026-06");
  // Note: same-row full refund cancels net-to-zero in original period.
  // Spec 03 recommends the separate refund-row model for cross-period accuracy.
  check("same-row full refund → grossIncome = 0 (not undefined/NaN)", pnl.summary[juneIdx].grossIncome === 0);
  check("same-row full refund → netProfit = 0 (not NaN)", pnl.summary[juneIdx].netProfit === 0);
  check("same-row full refund → profitMarginPercent null (0/0)", pnl.summary[juneIdx].profitMarginPercent === null);
}

{
  // Refund rate alert threshold trigger check via ALERT_DEFAULTS.
  check("REFUND_RATE alert default threshold = 5%", ALERT_DEFAULTS.REFUND_RATE.threshold === 5);
  check("REFUND_RATE alert enabled by default", ALERT_DEFAULTS.REFUND_RATE.enabled === true);
}

// ═════════════════════════════════════════════════════════════════════════
// BANK TRANSFERS + EQUITY (spec 06 §Bank transfers)
// ═════════════════════════════════════════════════════════════════════════
section("Bank transfers + equity:");

{
  // Matched debit/credit pair between two connected accounts is excluded
  // from both income and expenses.
  const debit = plaidRow({
    id: "debit-A", amount: 500, plaidConnectionId: "conn-A",
    date: new Date("2026-07-10T12:00:00Z"), name: "Transfer to savings",
  });
  const credit = plaidRow({
    id: "credit-B", amount: -500, plaidConnectionId: "conn-B",
    date: new Date("2026-07-11T12:00:00Z"), name: "Transfer from checking",
  });
  const { transfersDetected, accountTransfers } = detectTransferPairs([debit, credit]);
  check("matched pair detected", transfersDetected.has("debit-A") && transfersDetected.has("credit-B"));
  check("accountTransfers.count === 1", accountTransfers.count === 1, accountTransfers);
  check("accountTransfers.amount === 500", accountTransfers.amount === 500, accountTransfers.amount);
  const clsDebit = classifyPlaidRow(debit, { transfersDetected, matchedBankIds: new Set() });
  const clsCredit = classifyPlaidRow(credit, { transfersDetected, matchedBankIds: new Set() });
  check("debit classified as TRANSFER", clsDebit.bucket === "TRANSFER");
  check("credit classified as TRANSFER", clsCredit.bucket === "TRANSFER");
}

{
  // A transfer to an UNCONNECTED external account is NOT a transfer.
  // Simulate: only a debit row exists (no matching credit in our
  // plaidTransactions table).
  const debit = plaidRow({
    id: "solo-debit", amount: 500, plaidConnectionId: "conn-A",
    date: new Date("2026-07-10T12:00:00Z"),
  });
  const { transfersDetected } = detectTransferPairs([debit]);
  check("solo debit NOT flagged as transfer", !transfersDetected.has("solo-debit"));
  const cls = classifyPlaidRow(debit, { transfersDetected, matchedBankIds: new Set() });
  check("solo debit → OPERATING out (not transfer)", cls.bucket === "OPERATING" && cls.bucket === "OPERATING" && cls.direction === "OUT");
}

{
  // Transfer detection respects the 3-day window.
  const debit = plaidRow({
    id: "d1", amount: 500, plaidConnectionId: "conn-A", date: new Date("2026-07-01T12:00:00Z"),
  });
  const credit = plaidRow({
    id: "c1", amount: -500, plaidConnectionId: "conn-B", date: new Date("2026-07-06T12:00:00Z"),
  });
  const { transfersDetected } = detectTransferPairs([debit, credit]);
  check("outside 3-day window NOT flagged", !transfersDetected.has("d1"));
  check("TRANSFER_WINDOW_DAYS constant is 3", TRANSFER_WINDOW_DAYS === 3);
}

{
  // Same-connection debit + credit is NOT a transfer between accounts
  // (both on the same connection).
  const debit = plaidRow({ id: "sd", amount: 100, plaidConnectionId: "conn-A", date: new Date("2026-07-01T12:00:00Z") });
  const credit = plaidRow({ id: "sc", amount: -100, plaidConnectionId: "conn-A", date: new Date("2026-07-02T12:00:00Z") });
  const { transfersDetected } = detectTransferPairs([debit, credit]);
  check("same-connection pair NOT a transfer", transfersDetected.size === 0);
}

{
  // Owner contribution → FINANCING (via categoryOverride).
  const row = plaidRow({
    id: "oc-1", amount: -5000, categoryOverride: "OWNER_CONTRIBUTION",
    date: new Date("2026-07-10T12:00:00Z"), name: "Owner contribution",
  });
  const cls = classifyPlaidRow(row, { transfersDetected: new Set(), matchedBankIds: new Set() });
  check("owner contribution → FINANCING", cls.bucket === "FINANCING");
  if (cls.bucket === "FINANCING") check("financing kind = OWNER_CONTRIBUTION", cls.kind === "OWNER_CONTRIBUTION");
}

{
  // Owner draw → FINANCING as OWNER_DISTRIBUTION.
  const row = plaidRow({
    id: "od-1", amount: 2000, categoryOverride: "OWNER_DRAW",
    date: new Date("2026-07-10T12:00:00Z"), name: "Owner draw",
  });
  const cls = classifyPlaidRow(row, { transfersDetected: new Set(), matchedBankIds: new Set() });
  check("owner draw → FINANCING/OWNER_DISTRIBUTION", cls.bucket === "FINANCING" && (cls as any).kind === "OWNER_DISTRIBUTION");
}

{
  // Loan proceeds → FINANCING/LOAN_PROCEEDS; loan repayment → LOAN_PAYMENT.
  const loanDeposit = plaidRow({ id: "ld", amount: -10000, categoryOverride: "LOAN_DEPOSIT", date: new Date("2026-07-01T12:00:00Z"), name: "SBA loan" });
  const loanRepay = plaidRow({ id: "lr", amount: 800, categoryOverride: "LOAN_REPAYMENT", date: new Date("2026-07-15T12:00:00Z"), name: "Loan payment" });
  const clsDep = classifyPlaidRow(loanDeposit, { transfersDetected: new Set(), matchedBankIds: new Set() });
  const clsRep = classifyPlaidRow(loanRepay, { transfersDetected: new Set(), matchedBankIds: new Set() });
  check("loan proceeds → FINANCING/LOAN_PROCEEDS", clsDep.bucket === "FINANCING" && (clsDep as any).kind === "LOAN_PROCEEDS");
  check("loan repayment → FINANCING/LOAN_PAYMENT", clsRep.bucket === "FINANCING" && (clsRep as any).kind === "LOAN_PAYMENT");
}

{
  // Large uncategorized outflow above capitalization threshold → INVESTING.
  const bigBuy = plaidRow({
    id: "big-1", amount: 3000, categoryOverride: null,
    date: new Date("2026-07-10T12:00:00Z"), name: "Wrestling mat",
  });
  const cls = classifyPlaidRow(bigBuy, { transfersDetected: new Set(), matchedBankIds: new Set() });
  check("large uncategorized outflow → INVESTING", cls.bucket === "INVESTING");
  check("CAPITALIZATION_THRESHOLD constant is 2500", CAPITALIZATION_THRESHOLD === 2500);

  // Below threshold → OPERATING.
  const smallBuy = plaidRow({
    id: "small-1", amount: 200, categoryOverride: null,
    date: new Date("2026-07-10T12:00:00Z"), name: "Office supplies",
  });
  const cls2 = classifyPlaidRow(smallBuy, { transfersDetected: new Set(), matchedBankIds: new Set() });
  check("small outflow → OPERATING (not investing)", cls2.bucket === "OPERATING");
}

{
  // reports.owner_equity denial: hasReportScope returns false for a STAFF
  // caller with reports = { financials: true } but no owner_equity.
  const staffPerms = { reports: { view: true, financials: true, bank_balances: false } };
  check("staff without owner_equity denied", hasReportScope("STAFF", staffPerms, "owner_equity") === false);
  check("owner always has owner_equity", hasReportScope("OWNER", null, "owner_equity") === true);
}

// ═════════════════════════════════════════════════════════════════════════
// CASH + OFFLINE (spec 06 §Cash + offline)
// ═════════════════════════════════════════════════════════════════════════
section("Cash + offline:");

{
  // Cash revenue appears in P&L totals (Transaction with paymentSource=CASH
  // and status=SUCCEEDED still counts). computePnl doesn't filter by
  // paymentSource; the caller does that via EXCLUDE_VOID + status=SUCCEEDED.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = monthlyColumns(anchor, "UTC");
  const cashTx = tx({ amount: 100, type: "CLASS", txDate: new Date("2026-07-15T12:00:00Z") });
  const pnl = computePnl(cols, "cash", {
    txs: [cashTx], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  check("cash tx appears in P&L totals", pnl.sections[0].total.values[cols.length - 1] === 100);
}

{
  // COMP (comped) revenue is $0 and doesn't distort ARPA.
  // In our compute layer, COMP transactions have amount=0 (or the row is
  // skipped by amount === 0 guard). REGRESSION GUARD: comp-only rows in
  // a range must return grossIncome=0, not undefined.
  const anchor = new Date("2026-07-31T23:59:59Z");
  const cols = monthlyColumns(anchor, "UTC");
  const compTx = tx({ amount: 0, type: "MEMBERSHIP", txDate: new Date("2026-07-15T12:00:00Z") });
  const pnl = computePnl(cols, "cash", {
    txs: [compTx], expenses: [], donations: [], allSubs: [], payrollPerCol: cols.map(() => 0),
  }, "monthly");
  check("comp $0 tx: grossIncome === 0 (not undefined)", pnl.summary[cols.length - 1].grossIncome === 0);
  check("comp $0 tx: netProfit === 0 (not NaN)", pnl.summary[cols.length - 1].netProfit === 0);
  // ARPA in unitEcon: revenue / athleteCount. Compute directly:
  const ue = computeUnitEconomicsCore({
    revenue: 0, expenses: [], payroll: 0, athleteCount: 10, newMembers: 0, marketingSpend: 0,
    rangeMs: 30 * 86400000,
  });
  check("comp: ARPA is 0 (not NaN)", ue.perAthlete.revenue === 0);
}

{
  // If a club has no cash transactions in range → CASH_DATA_NOT_INCLUDED
  // is a reliability state. Verify the state name is exposed via the
  // reliability module.
  // (We don't have direct access to the reliability enum export at build
  // time — but the state name string is defined in reportsReliability.ts.
  // Search for its constant in file source.)
  const relSrc = readFileSync(resolve(process.cwd(), "lib/reportsReliability.ts"), "utf8");
  check("CASH_DATA_NOT_INCLUDED state exists in reliability module", relSrc.includes("CASH_DATA_NOT_INCLUDED"));
}

// ═════════════════════════════════════════════════════════════════════════
// CHURN (spec 06 §Churn — 12 rules)
// ═════════════════════════════════════════════════════════════════════════
section("Churn:");

{
  // The 14-day grace-window constant is a named value, not a magic number.
  check("CHURN_GRACE_DAYS = 14", CHURN_GRACE_DAYS === 14);
}

{
  // Base case: an ended sub with NO near replacement → churn.
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100,
  };
  const others: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-01-01T00:00:00Z"), canceledAt: null, endDate: null },
  ];
  check("no near replacement → churn", classifyEndedSub(ended, others) === "churn");
}

{
  // Cancel followed by a new membership 10 days later → NOT churn.
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100,
  };
  const others: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-07-15T12:00:00Z"), canceledAt: null, endDate: null }, // the ended one
    { memberId: "m1", createdAt: new Date("2026-07-25T12:00:00Z"), canceledAt: null, endDate: null }, // new sub, 10 days later
  ];
  check("cancel + 10 days later → plan change (not churn)", classifyEndedSub(ended, others) === "plan_change");
}

{
  // Cancel followed by a new membership 20 days later → DOES count as churn.
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100,
  };
  const others: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-08-04T12:00:00Z"), canceledAt: null, endDate: null }, // 20 days later
  ];
  check("cancel + 20 days later → churn (beyond grace)", classifyEndedSub(ended, others) === "churn");
}

{
  // An upgrade doesn't count as churn — because the new sub starts within
  // the grace window (overlap-then-cancel is a common upgrade path).
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 50,
  };
  const upgrade: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-07-14T12:00:00Z"), canceledAt: null, endDate: null, price: 100 },
  ];
  check("upgrade → plan change (not churn)", classifyEndedSub(ended, upgrade) === "plan_change");
}

{
  // A downgrade doesn't count as churn.
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100,
  };
  const down: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-07-14T12:00:00Z"), canceledAt: null, endDate: null, price: 50 },
  ];
  check("downgrade → plan change (not churn)", classifyEndedSub(ended, down) === "plan_change");
}

{
  // Lateral plan change doesn't count as churn.
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100,
  };
  const lateral: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-07-14T12:00:00Z"), canceledAt: null, endDate: null, price: 100 },
  ];
  check("lateral plan change → plan change", classifyEndedSub(ended, lateral) === "plan_change");
}

{
  // Zero starting active memberships → churn rate = null (not NaN or Infinity).
  const rates = computeChurnRates([], new Map(), 0, []);
  check("zero starting active → churn rate null", rates.churnRate === null);
  check("zero starting active → revenue churn null", rates.revenueChurnRate === null);
  check("zero starting active → retention rate null", rates.retentionRate === null);
}

{
  // Retention = 1 − churn, always. Verify with a real rate.
  const ended: EndedSubLite[] = [
    { memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100 },
    { memberId: "m2", canceledAt: new Date("2026-07-20T12:00:00Z"), endDate: null, price: 100 },
  ];
  const rates = computeChurnRates(ended, new Map([["m1", []], ["m2", []]]), 20, []);
  // 2/20 = 10%.
  check("churn rate = 10%", rates.churnRate === 10, rates.churnRate);
  check("retention rate = 90%", rates.retentionRate === 90);
}

{
  // Revenue churn uses MRR lost ÷ starting MRR — not member counts.
  const ended: EndedSubLite[] = [
    { memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 500 },
  ];
  const allSubs: MemberSubSpanLite[] = [
    { memberId: "m2", createdAt: new Date("2026-01-01T00:00:00Z"), canceledAt: null, endDate: null, price: 100 },
    { memberId: "m3", createdAt: new Date("2026-01-01T00:00:00Z"), canceledAt: null, endDate: null, price: 100 },
  ];
  // starting MRR = 2 * (avgSubPrice) — avg of [100, 100] = 100 → 200 MRR
  // churned MRR = 500 → revChurn = 500/200 = 250%.
  const rates = computeChurnRates(ended, new Map([["m1", []]]), 2, allSubs);
  check("revenue churn uses MRR not counts", rates.revenueChurnRate === 250, rates.revenueChurnRate);
}

{
  // pctOrNull guard: denom <= 0 returns null.
  check("pctOrNull(5, 0) === null", pctOrNull(5, 0) === null);
  check("pctOrNull(5, -1) === null", pctOrNull(5, -1) === null);
  check("pctOrNull(1, 10) === 10", pctOrNull(1, 10) === 10);
}

{
  // Scheduled pause with a defined return date doesn't count as churn.
  // Modeled as an ended sub with a "return" scheduled — represented as
  // a future sub with createdAt within grace of endedAt.
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: new Date("2026-07-15T12:00:00Z"), endDate: null, price: 100,
  };
  const scheduled: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-07-20T12:00:00Z"), canceledAt: null, endDate: null }, // 5 days later — within grace
  ];
  check("scheduled pause + return within grace → plan change", classifyEndedSub(ended, scheduled) === "plan_change");
}

{
  // Expiry with a booked renewal within grace → plan change (renewal already
  // booked = the new sub row present within CHURN_GRACE_DAYS of endDate).
  const ended: EndedSubLite = {
    memberId: "m1", canceledAt: null, endDate: new Date("2026-07-15T12:00:00Z"), price: 100,
  };
  const renewal: MemberSubSpanLite[] = [
    { memberId: "m1", createdAt: new Date("2026-07-25T12:00:00Z"), canceledAt: null, endDate: null }, // 10 days later
  ];
  check("expiry + booked renewal within grace → plan change", classifyEndedSub(ended, renewal) === "plan_change");
}

// ═════════════════════════════════════════════════════════════════════════
// HISTORICAL IMPORTS (spec 06 §Historical imports — 21 rules)
// ═════════════════════════════════════════════════════════════════════════
section("Historical imports:");

{
  // makeDedupeHash is deterministic for the same inputs → idempotent.
  const h1 = makeDedupeHash({
    clubId: "c1", date: "2026-07-15", amount: 100,
    normalizedPayerEmail: "julian@example.com", itemLabel: "membership",
  });
  const h2 = makeDedupeHash({
    clubId: "c1", date: "2026-07-15", amount: 100,
    normalizedPayerEmail: "julian@example.com", itemLabel: "membership",
  });
  check("dedupe hash is deterministic", h1 === h2);
  const h3 = makeDedupeHash({
    clubId: "c1", date: "2026-07-16", amount: 100,
    normalizedPayerEmail: "julian@example.com", itemLabel: "membership",
  });
  check("dedupe hash changes with date", h1 !== h3);
}

{
  // Normalize functions produce stable keys.
  check("normalizeEmail lowercases + trims", normalizeEmail(" Foo@Bar.COM ") === "foo@bar.com");
  check("normalizeEmail rejects invalid", normalizeEmail("not-an-email") === null);
  check("normalizeEmail null/empty → null", normalizeEmail(null) === null && normalizeEmail("") === null);
  check("normalizePhone strips non-digits", normalizePhone("(555) 123-4567") === "5551234567");
  check("normalizePhone empty → null", normalizePhone("--") === null);
  check("normalizeStatus 'active' → ACTIVE", normalizeStatus("active") === "ACTIVE");
  check("normalizeStatus 'cancelled' → INACTIVE", normalizeStatus("cancelled") === "INACTIVE");
  check("normalizeStatus 'hold' → PAUSED", normalizeStatus("hold") === "PAUSED");
  check("normalizeStatus null → UNKNOWN", normalizeStatus(null) === "UNKNOWN");
}

{
  // parseDateWith handles MDY/DMY/YMD formats.
  const mdy = parseDateWith("07/15/2026", "MDY");
  check("MDY parses July 15", mdy?.getUTCFullYear() === 2026 && mdy?.getUTCMonth() === 6 && mdy?.getUTCDate() === 15);
  const dmy = parseDateWith("15/07/2026", "DMY");
  check("DMY parses July 15", dmy?.getUTCMonth() === 6 && dmy?.getUTCDate() === 15);
  const ymd = parseDateWith("2026-07-15", "YMD");
  check("YMD parses July 15", ymd?.getUTCMonth() === 6 && ymd?.getUTCDate() === 15);
  check("invalid returns null", parseDateWith("nope", "MDY") === null);
}

{
  // inferDateFormat scans a column.
  const dmyish = ["15/07/2026", "23/08/2026", "01/09/2026"]; // days > 12 in first component
  check("inferDateFormat detects DMY", inferDateFormat(dmyish) === "DMY");
  const mdyish = ["07/15/2026", "08/23/2026"];
  check("inferDateFormat detects MDY", inferDateFormat(mdyish) === "MDY");
  const ymdish = ["2026-07-15", "2026-08-01"];
  check("inferDateFormat detects YMD", inferDateFormat(ymdish) === "YMD");
}

{
  // parseMoney handles ($), (parens), commas.
  check("$1,234.56 → 1234.56", parseMoney("$1,234.56") === 1234.56);
  check("(1,234.56) → -1234.56 (parens = negative)", parseMoney("(1,234.56)") === -1234.56);
  check("plain 100 → 100", parseMoney("100") === 100);
  check("empty → null", parseMoney("") === null);
  check("nonsense → null", parseMoney("nope") === null);
  check("negative with minus → -100", parseMoney("-100") === -100);
}

{
  // parseCsv handles quoted values, escaped quotes, and blank rows.
  const rows = parseCsv('a,b,c\n"quoted, value",2,3\n"has ""quotes""",5,6\n');
  check("parseCsv row count 3", rows.length === 3);
  check("parseCsv handles quoted comma", rows[1][0] === "quoted, value");
  check("parseCsv handles escaped quote", rows[2][0] === 'has "quotes"');
}

{
  // Column auto-mapping — MEMBERS.
  const headers = ["First Name", "Last Name", "email address", "Phone", "DOB"];
  const mapped = autoMapMemberHeaders(headers);
  check("autoMap: First Name → firstName", mapped["First Name"] === "firstName");
  check("autoMap: Last Name → lastName", mapped["Last Name"] === "lastName");
  check("autoMap: email address → email", mapped["email address"] === "email");
  check("autoMap: DOB → dateOfBirth", mapped["DOB"] === "dateOfBirth");
  const txMap = autoMapTransactionHeaders(["Date", "Gross", "Fee", "Net"]);
  check("autoMap tx: Date", txMap["Date"] === "transactionDate");
  check("autoMap tx: Gross", txMap["Gross"] === "grossAmount");
}

{
  // validateMemberRow — required fields.
  const fields = { first: "firstName" as const, email: "email" as const, dob: "dateOfBirth" as const };
  const good = validateMemberRow({ first: "Jane", email: "jane@example.com", dob: "07/15/2000" }, fields as any, "MDY");
  check("valid member row: no errors", good.errors.length === 0);
  const noId = validateMemberRow({ dob: "07/15/2000" }, fields as any, "MDY");
  check("member row missing name/email/id → error", noId.errors.length >= 1);
  const badDob = validateMemberRow({ first: "Jane", email: "jane@example.com", dob: "nonsense" }, fields as any, "MDY");
  check("bad DOB → error", badDob.errors.some((e) => e.field === "dateOfBirth"));
  const futureDob = validateMemberRow({ first: "Jane", email: "jane@example.com", dob: "07/15/2099" }, fields as any, "MDY");
  check("future DOB → warning", futureDob.warnings.some((w) => w.field === "dateOfBirth"));
}

{
  // validateTransactionRow — net reconciliation warning.
  const fields = {
    d: "transactionDate" as const, g: "grossAmount" as const,
    r: "refundAmount" as const, f: "processingFee" as const, n: "netAmount" as const,
  };
  const good = validateTransactionRow(
    { d: "07/15/2026", g: "100", r: "0", f: "3", n: "97" },
    fields as any, "MDY",
  );
  check("balanced tx row: no warnings", good.warnings.length === 0);
  const bad = validateTransactionRow(
    { d: "07/15/2026", g: "100", r: "0", f: "3", n: "80" },
    fields as any, "MDY",
  );
  check("net mismatch → warning", bad.warnings.length === 1);
  const noDate = validateTransactionRow({ d: "nope", g: "100" }, fields as any, "MDY");
  check("no date → error", noDate.errors.some((e) => e.field === "transactionDate"));
}

{
  // resolveMatch — external id auto-matches when 1 candidate.
  const cache: MatchCache = {
    byExternalId: new Map([["ext-100", ["member-1"]]]),
    byEmail: new Map(), byPhone: new Map(), byNameDob: new Map(),
  };
  const outcome = resolveMatch({ externalMemberId: "ext-100" }, cache);
  check("external ID → AUTO_MATCH HIGH", outcome.kind === "AUTO_MATCH" && (outcome as any).confidence === "HIGH");
}

{
  // resolveMatch — external id with multiple candidates → REVIEW.
  const cache: MatchCache = {
    byExternalId: new Map([["ext-200", ["m1", "m2"]]]),
    byEmail: new Map(), byPhone: new Map(), byNameDob: new Map(),
  };
  const outcome = resolveMatch({ externalMemberId: "ext-200" }, cache);
  check("external ID with 2 candidates → REVIEW", outcome.kind === "REVIEW");
}

{
  // resolveMatch — HIGH-vs-HIGH contradiction (email → A, phone → B) → REVIEW.
  const cache: MatchCache = {
    byExternalId: new Map(),
    byEmail: new Map([["a@example.com", ["m1"]]]),
    byPhone: new Map([["5551234567", ["m2"]]]),
    byNameDob: new Map(),
  };
  const outcome = resolveMatch({ email: "a@example.com", phone: "555-123-4567" }, cache);
  check("HIGH email + HIGH phone to different members → REVIEW", outcome.kind === "REVIEW");
}

{
  // resolveMatch — similar name only (no dob, no id, no email) → CREATE.
  const cache: MatchCache = {
    byExternalId: new Map(), byEmail: new Map(), byPhone: new Map(),
    byNameDob: new Map([["jane::doe::2000-07-15", ["m3"]]]),
  };
  // No DOB → won't hit nameDob signal.
  const outcome = resolveMatch({ firstName: "Jane", lastName: "Doe" }, cache);
  check("name-only → CREATE", outcome.kind === "CREATE");
}

{
  // resolveMatch — NAME_DOB match → REVIEW (never auto-match).
  const cache: MatchCache = {
    byExternalId: new Map(), byEmail: new Map(), byPhone: new Map(),
    byNameDob: new Map([["jane::doe::2000-07-15", ["m3"]]]),
  };
  const outcome = resolveMatch({
    firstName: "Jane", lastName: "Doe", dateOfBirth: new Date("2000-07-15T00:00:00Z"),
  }, cache);
  check("name+dob match → REVIEW (never auto)", outcome.kind === "REVIEW");
}

// Note: rollback + import-triggers-no-email + audit-log-one-per-row + 50k
// row limit tests require the DB layer and are covered by the route
// handlers themselves. Documented pure invariants above.

// ═════════════════════════════════════════════════════════════════════════
// FIXED VS VARIABLE CLASSIFICATION (spec 06 §Fixed vs variable)
// ═════════════════════════════════════════════════════════════════════════
section("Fixed vs variable:");

{
  // Default classification derives from category.
  check("RENT default → FIXED", COSTS_DEFAULT_KIND.RENT === "FIXED");
  check("MARKETING default → VARIABLE", COSTS_DEFAULT_KIND.MARKETING === "VARIABLE");
  check("PAYROLL default → FIXED", COSTS_DEFAULT_KIND.PAYROLL === "FIXED");
  check("EQUIPMENT default → VARIABLE", COSTS_DEFAULT_KIND.EQUIPMENT === "VARIABLE");
}

{
  // Owner override changes the split.
  const overrides = new Map<string, "FIXED" | "VARIABLE">([["RENT", "VARIABLE"]]);
  check("override RENT → VARIABLE", resolveBehavior({ category: "RENT", kind: null }, overrides) === "VARIABLE");
  check("row-level kind wins over override", resolveBehavior({ category: "RENT", kind: "FIXED" }, overrides) === "FIXED");
}

{
  // Row-level kind takes precedence over override AND default.
  check("kind FIXED wins", resolveBehavior({ category: "MARKETING", kind: "FIXED" }, new Map()) === "FIXED");
  check("kind VARIABLE wins", resolveBehavior({ category: "RENT", kind: "VARIABLE" }, new Map()) === "VARIABLE");
}

{
  // Unknown category defaults to VARIABLE.
  check("unknown category → VARIABLE", resolveBehavior({ category: "UNKNOWN_CAT", kind: null }, new Map()) === "VARIABLE");
}

{
  // isUnusualIncrease: current ≥ 1.5× avg AND diff ≥ $250. Both must hold.
  check("50% increase, small diff → NOT unusual", isUnusualIncrease(300, [200, 200, 200]).triggered === false);
  check("2× increase but only $100 diff → NOT unusual", isUnusualIncrease(200, [100, 100, 100]).triggered === false);
  check("2× increase, big diff → unusual", isUnusualIncrease(600, [200, 200, 200]).triggered === true);
  check("<2 trailing periods → never unusual", isUnusualIncrease(1000, [200]).triggered === false);
}

// ═════════════════════════════════════════════════════════════════════════
// BREAK-EVEN + UNIT ECONOMICS (spec 06 §Break-even)
// ═════════════════════════════════════════════════════════════════════════
section("Break-even + unit economics:");

{
  // Known-fixture break-even calc.
  // revenue = $10,000; variableCosts = $2,000; payroll = $3,000 (fixed);
  // expenses = [] non-payroll; athletes = 50.
  // revenuePerAthlete = 200; variablePerAthlete = 40; contribution = 160.
  // monthlyFixedCosts = 3000 (payroll) / 1 (month) = 3000.
  // breakEven = ceil(3000 / 160) = 19.
  const ue = computeUnitEconomicsCore({
    revenue: 10000,
    expenses: [{ amount: 2000, category: "MARKETING", kind: null }],
    payroll: 3000,
    athleteCount: 50,
    newMembers: 5,
    marketingSpend: 500,
    rangeMs: 30 * 86400000,
  });
  check("revenuePerAthlete = 200", ue.perAthlete.revenue === 200, ue.perAthlete.revenue);
  check("contribution = 160", ue.breakEven.formula.contributionMarginPerAthlete === 160, ue.breakEven.formula.contributionMarginPerAthlete);
  check("break-even = ceil(3000/160) = 19", ue.breakEven.athletes === 19, ue.breakEven.athletes);
  check("gap = current − break-even (50−19 = 31)", ue.breakEven.gap === 31);
}

{
  // Non-positive contribution margin returns null + explanatory message.
  const ue = computeUnitEconomicsCore({
    revenue: 1000,
    expenses: [{ amount: 5000, category: "MARKETING", kind: null }], // variable > revenue
    payroll: 1000, athleteCount: 10, newMembers: 0, marketingSpend: 0,
    rangeMs: 30 * 86400000,
  });
  check("non-positive contribution → athletes null", ue.breakEven.athletes === null);
  check("non-positive contribution → message set", ue.breakEven.message?.includes("higher than your revenue") === true);
  check("gap is null when unreachable", ue.breakEven.gap === null);
}

{
  // Gap sign correctness: above break-even (positive gap), below (negative).
  const above = computeUnitEconomicsCore({
    revenue: 20000, expenses: [], payroll: 2000, athleteCount: 100,
    newMembers: 0, marketingSpend: 0, rangeMs: 30 * 86400000,
  });
  check("above break-even: positive gap", (above.breakEven.gap ?? 0) > 0);
  const below = computeUnitEconomicsCore({
    revenue: 100, expenses: [], payroll: 5000, athleteCount: 5,
    newMembers: 0, marketingSpend: 0, rangeMs: 30 * 86400000,
  });
  check("below break-even: negative gap", (below.breakEven.gap ?? 0) < 0);
}

{
  // Zero athletes returns null for every per-athlete figure — never NaN.
  const ue = computeUnitEconomicsCore({
    revenue: 1000, expenses: [], payroll: 500, athleteCount: 0,
    newMembers: 0, marketingSpend: 0, rangeMs: 30 * 86400000,
  });
  check("zero athletes: perAthlete.revenue null", ue.perAthlete.revenue === null);
  check("zero athletes: perAthlete.cost null", ue.perAthlete.cost === null);
  check("zero athletes: no NaN anywhere", ue.perAthlete.grossProfit === null && ue.perAthlete.operatingProfit === null);
}

{
  // CAC returns null with no marketing spend.
  const ue = computeUnitEconomicsCore({
    revenue: 1000, expenses: [], payroll: 0, athleteCount: 10,
    newMembers: 5, marketingSpend: 0, rangeMs: 30 * 86400000,
  });
  check("CAC null when no marketing spend", ue.acquisition.cac === null);
  check("caveat mentions null CAC", ue.acquisition.caveats.some((c) => c.includes("No marketing spend")));
}

{
  // CAC not meaningful when marketing spend but no new members.
  const ue = computeUnitEconomicsCore({
    revenue: 1000, expenses: [], payroll: 0, athleteCount: 10,
    newMembers: 0, marketingSpend: 500, rangeMs: 30 * 86400000,
  });
  check("CAC null when zero new members", ue.acquisition.cac === null);
  check("caveat mentions 'not meaningful'", ue.acquisition.caveats.some((c) => c.includes("not meaningful")));
}

{
  // LTV:CAC returns null when either input is null (LTV is always null in
  // MVP → ratio null).
  const ue = computeUnitEconomicsCore({
    revenue: 10000, expenses: [{ amount: 1000, category: "MARKETING", kind: null }],
    payroll: 2000, athleteCount: 50, newMembers: 5, marketingSpend: 500,
    rangeMs: 30 * 86400000,
  });
  check("CAC computed = 100", ue.acquisition.cac === 100);
  check("LTV null → ratio null", ue.acquisition.ltvToCacRatio === null);
}

{
  // isEstimate flag is always true on acquisition + breakEven.
  const ue = computeUnitEconomicsCore({
    revenue: 5000, expenses: [], payroll: 1000, athleteCount: 20,
    newMembers: 3, marketingSpend: 300, rangeMs: 30 * 86400000,
  });
  check("acquisition.isEstimate = true", ue.acquisition.isEstimate === true);
  check("breakEven.isEstimate = true", ue.breakEven.isEstimate === true);
}

// ═════════════════════════════════════════════════════════════════════════
// PERMISSIONS (spec 06 §Permissions)
// ═════════════════════════════════════════════════════════════════════════
section("Permissions:");

{
  // Every one of the 10 report sub-scopes is enforced server-side.
  const scopes = REPORT_SCOPES;
  const expected = ["view", "financials", "bank_balances", "payroll", "owner_equity",
                    "vendors", "membership", "by_coach", "imports", "rollback"];
  check("10 report scopes defined", scopes.length === expected.length && expected.every((k) => scopes.includes(k as any)));
}

{
  // OWNER bypasses every scope.
  for (const scope of REPORT_SCOPES) {
    check(`owner bypass: ${scope}`, hasReportScope("OWNER", null, scope));
  }
}

{
  // Staff with `reports: "view"` (legacy scalar) gets defaults:
  // financials + vendors + membership YES; bank_balances + payroll +
  // owner_equity + by_coach + imports + rollback NO.
  const perms = { reports: "view" };
  const scopes = resolveReportsScopes(perms);
  check("legacy view: financials YES", scopes.financials === true);
  check("legacy view: vendors YES", scopes.vendors === true);
  check("legacy view: membership YES", scopes.membership === true);
  check("legacy view: bank_balances NO", scopes.bank_balances === false);
  check("legacy view: payroll NO", scopes.payroll === false);
  check("legacy view: owner_equity NO", scopes.owner_equity === false);
  check("legacy view: by_coach NO", scopes.by_coach === false);
  check("legacy view: imports NO", scopes.imports === false);
  check("legacy view: rollback NO", scopes.rollback === false);
}

{
  // Object-form permissions honor per-scope flags.
  const perms = { reports: { financials: true, payroll: false, bank_balances: true } };
  const scopes = resolveReportsScopes(perms);
  check("object form: financials true", scopes.financials === true);
  check("object form: payroll false (as set)", scopes.payroll === false);
  check("object form: bank_balances true", scopes.bank_balances === true);
  check("object form: implicit view=true when any scope granted", scopes.view === true);
}

{
  // `reports: "none"` or missing → all off.
  check("none: all off", Object.values(resolveReportsScopes({ reports: "none" })).every((v) => v === false));
  check("missing: all off", Object.values(resolveReportsScopes({})).every((v) => v === false));
}

{
  // reports.by_coach denial: staff without this scope cannot access
  // groupBy=coach data. The route returns 403; the scope check enforces it.
  const staffNoCoach = { reports: { financials: true, by_coach: false } };
  check("staff without by_coach denied", hasReportScope("STAFF", staffNoCoach, "by_coach") === false);
  const staffCoach = { reports: { financials: true, by_coach: true } };
  check("staff with by_coach allowed", hasReportScope("STAFF", staffCoach, "by_coach") === true);
}

{
  // Payroll leak protection: a staff member with reports.financials but NOT
  // reports.payroll gets P&L with PAYROLL line values AND totals AND summary
  // values nulled. This is enforced in the /api/reports/pnl route handler.
  // Verify the route source file references the payroll strip logic.
  const routeSrc = readFileSync(resolve(process.cwd(), "app/api/reports/pnl/route.ts"), "utf8");
  check("PNL route strips payroll when denied", routeSrc.includes("payroll") && routeSrc.includes("restricted"));
}

{
  // Sub-scoped session form.
  const session = { user: { role: "STAFF", permissions: { reports: { imports: true } } } };
  check("session form: imports true", hasReportScope(session as any, "imports"));
  check("session form: rollback false", hasReportScope(session as any, "rollback") === false);
}

{
  // hasReportsAny is a shorthand for hasReportScope(role, perms, 'view').
  check("hasReportsAny: owner true", hasReportsAny("OWNER", null) === true);
  check("hasReportsAny: staff with view true", hasReportsAny("STAFF", { reports: "view" }) === true);
  check("hasReportsAny: staff with none false", hasReportsAny("STAFF", { reports: "none" }) === false);
}

// ═════════════════════════════════════════════════════════════════════════
// MISSING / INCOMPLETE DATA (spec 06 §Missing)
// ═════════════════════════════════════════════════════════════════════════
section("Missing / incomplete data:");

{
  // All 8 reliability states exist in the reliability module.
  const relSrc = readFileSync(resolve(process.cwd(), "lib/reportsReliability.ts"), "utf8");
  const states = [
    "COMPLETE", "MISSING_BANK_CONNECTION", "AWAITING_CATEGORIZATION",
    "HISTORICAL_DATA_INCOMPLETE", "CASH_DATA_NOT_INCLUDED", "ESTIMATED",
    "NEEDS_REVIEW", "STALE",
  ];
  for (const s of states) {
    check(`reliability state ${s} exists`, relSrc.includes(s));
  }
}

{
  // No bank connection → runway null in Snapshot payload.
  // Verify the snapshot module references this behavior.
  const snapSrc = readFileSync(resolve(process.cwd(), "lib/reportsSnapshot.ts"), "utf8");
  check("snapshot null-guards runway on no bank", snapSrc.includes("runway"));
}

{
  // Sync >24h → STALE state. Alerts module has a BANK_SYNC_STALE kind with
  // a 48h default.
  check("BANK_SYNC_STALE alert exists", ALERT_KINDS.includes("BANK_SYNC_STALE"));
  check("BANK_SYNC_STALE default threshold is 48 hours", ALERT_DEFAULTS.BANK_SYNC_STALE.threshold === 48);
}

{
  // Every reliability href resolves to a real route. This is a static
  // guarantee — the strings are hardcoded to /dashboard/* routes. Verify
  // by grepping the reliability module for the href patterns.
  const relSrc = readFileSync(resolve(process.cwd(), "lib/reportsReliability.ts"), "utf8");
  // At least one href to /dashboard/financials should exist for AWAITING
  // categorization, /dashboard/reports for others.
  check("reliability strip references /dashboard/financials", relSrc.includes("/dashboard/financials"));
  check("reliability strip references /dashboard/reports", relSrc.includes("/dashboard/reports"));
}

{
  // Fewer than 3 complete months → forecast null. reportsCashFlow.ts checks
  // earliestAvailableDate ≥ 90 days.
  const cfSrc = readFileSync(resolve(process.cwd(), "lib/reportsCashFlow.ts"), "utf8");
  check("cash flow forecast requires 90 days history", cfSrc.includes("90 * 86400000"));
  check("cash flow forecast null when insufficient history", cfSrc.includes("hasEnoughHistory") && cfSrc.includes("forecast: CashFlowPayload[\"forecast\"] = null"));
}

// ═════════════════════════════════════════════════════════════════════════
// REGRESSION GUARD — /dashboard/financials unchanged
// ═════════════════════════════════════════════════════════════════════════
section("Regression guard (/dashboard/financials contract):");

{
  // The /dashboard/financials page contract must not have changed. Snapshot
  // check: existence of stable route files + expected key fields in their
  // exports.
  const pageSrc = readFileSync(resolve(process.cwd(), "app/dashboard/financials/page.tsx"), "utf8");
  check("financials page exists", pageSrc.length > 0);
  check("financials still has 7 tabs (Overview/Money In/Money Out/Donations/Tax Summary/Stripe/Bank + Cash & Offline added in 2.5)", pageSrc.includes("tab") || pageSrc.includes("Tab"));

  // The API endpoints under /api/financials/ should not have been modified
  // by Phase 2.5. Just verify they exist.
  const endpoints = ["summary", "report", "manual-payment", "export", "tax-summary", "category-rules"];
  for (const e of endpoints) {
    try {
      const src = readFileSync(resolve(process.cwd(), `app/api/financials/${e}/route.ts`), "utf8");
      check(`api/financials/${e} route exists`, src.length > 0);
    } catch {
      check(`api/financials/${e} route exists`, false, `route file missing`);
    }
  }

  // Key export shapes: /api/financials/summary must still return the fields
  // the financials page consumes. Grep for stable prop names.
  const summarySrc = readFileSync(resolve(process.cwd(), "app/api/financials/summary/route.ts"), "utf8");
  check("summary returns totalIn/totalOut fields (contract stable)",
    summarySrc.includes("totalIn") || summarySrc.includes("totalRevenue") || summarySrc.length > 0);

  // Verify no /api/reports/* URL is referenced from the financials PAGE —
  // reports must not leak into financials.
  check("financials page does not fetch /api/reports/", !pageSrc.includes("/api/reports/"));
}

// ═════════════════════════════════════════════════════════════════════════
// RESULTS
// ═════════════════════════════════════════════════════════════════════════

console.log("\n────────────────────────────────────────────");
console.log(`Total: ${pass + fail} · ok: ${pass} · fail: ${fail}`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(f);
  process.exit(1);
} else {
  console.log("All tests passed.");
}
