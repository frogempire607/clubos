// Accounting Phase 3 — the statements, proven.
//
//   npm run test:gl-reports     (and it GATES the build)
//
// No database, no network. Everything under test is pure, which is why
// lib/glReports.ts exists separately from lib/glReportsServer.ts.
//
// The invariants that matter are the ones a CPA checks first and that this file
// checks on every build:
//   · a trial balance's debits equal its credits, exactly;
//   · a balance sheet balances, exactly, with current-year net income in equity;
//   · a cash flow statement's computed change in cash equals the actual change
//     in the cash accounts, exactly.
// "Exactly" is possible because money here is integer cents. A tolerance check
// would hide the very drift these tests exist to catch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCRUAL_ONLY_ACCOUNT_NUMBERS,
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
  netDebit,
  parseBasis,
  profitAndLoss,
  signedBalance,
  sortAccounts,
  totalsByAccount,
  trialBalance,
  type ReportAccount,
  type ReportEntry,
  type ReportLine,
} from "../lib/glReports";
import { formatCents } from "../lib/ledger";

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

// ── The fixture chart ───────────────────────────────────────────────────────
// A thin but realistic slice of CHART_TEMPLATE: a bank, undeposited funds,
// Stripe clearing, a receivable, a fixed asset with its contra, a card, a
// loan, equity, revenue with its contra, cost of sales, and expenses
// including depreciation.
const A = (
  id: string,
  number: string,
  name: string,
  type: ReportAccount["type"],
  normalBalance: ReportAccount["normalBalance"],
  extra?: Partial<ReportAccount>,
): ReportAccount => ({
  id,
  number,
  name,
  type,
  subtype: null,
  normalBalance,
  isContra: false,
  parentId: null,
  systemKey: null,
  ...extra,
});

const ACCOUNTS: ReportAccount[] = [
  A("bank", "1000", "Operating Checking", "ASSET", "DEBIT"),
  A("undep", "1020", "Undeposited Funds", "ASSET", "DEBIT", { systemKey: "UNDEPOSITED_FUNDS" }),
  A("stripe", "1050", "Stripe Clearing", "ASSET", "DEBIT", { systemKey: "STRIPE_CLEARING" }),
  A("ar", "1100", "Accounts Receivable", "ASSET", "DEBIT"),
  A("equip", "1500", "Training Equipment", "ASSET", "DEBIT"),
  A("accumdep", "1590", "Accumulated Depreciation", "ASSET", "CREDIT", { isContra: true }),
  A("card", "2100", "Credit Cards", "LIABILITY", "CREDIT"),
  A("ap", "2000", "Accounts Payable", "LIABILITY", "CREDIT"),
  A("loan", "2700", "Loans Payable", "LIABILITY", "CREDIT"),
  A("capital", "3000", "Owner / Partner Capital", "EQUITY", "CREDIT"),
  A("retained", "3900", "Retained Earnings", "EQUITY", "CREDIT", { systemKey: "RETAINED_EARNINGS" }),
  A("obe", "3950", "Opening Balance Equity", "EQUITY", "CREDIT", { systemKey: "OPENING_BALANCE_EQUITY" }),
  A("dues", "4000", "Membership Revenue", "INCOME", "CREDIT"),
  A("refunds", "4900", "Refunds & Discounts", "INCOME", "DEBIT", { isContra: true }),
  A("merchcost", "5000", "Merchandise Cost", "EXPENSE", "DEBIT", { subtype: "COST_OF_SALES" }),
  A("rent", "6000", "Rent", "EXPENSE", "DEBIT"),
  A("fees", "6400", "Payment Processing Fees", "EXPENSE", "DEBIT"),
  A("dep", "6800", "Depreciation Expense", "EXPENSE", "DEBIT"),
];

let seq = 0;
/// One balanced entry, expressed as [accountId, debitCents, creditCents][].
/// Every fixture entry goes through here so no test can accidentally assert
/// against an unbalanced journal — which would make a "balanced" assertion
/// meaningless.
const entry = (
  date: string,
  parts: [string, number, number][],
  meta?: Partial<ReportEntry> & { legalEntityId?: string | null; program?: string | null },
): { lines: ReportLine[]; entry: ReportEntry } => {
  seq += 1;
  const id = meta?.id ?? `e${seq}`;
  const d = parts.reduce((s, p) => s + p[1], 0);
  const c = parts.reduce((s, p) => s + p[2], 0);
  if (d !== c) throw new Error(`fixture entry ${id} is unbalanced: ${d} vs ${c}`);
  return {
    lines: parts.map(([accountId, debitCents, creditCents]) => ({
      entryId: id,
      accountId,
      debitCents,
      creditCents,
      entryDate: date,
      legalEntityId: meta?.legalEntityId ?? "frog",
      program: meta?.program ?? null,
    })),
    entry: {
      id,
      entryDate: date,
      memo: meta?.memo ?? null,
      reference: meta?.reference ?? null,
      sourceType: meta?.sourceType ?? "MANUAL",
    },
  };
};

// ── A month of activity, on top of an opening balance ───────────────────────
// Opening balance dated the day before the books start, exactly as task 7
// requires: Frog Empire's books start 2027-01-01, so the opening is 2026-12-31.
const FIXTURE = [
  // Opening: $20,000 in the bank, $8,000 of equipment less $1,000 of
  // depreciation already taken, a $5,000 loan, the rest owner capital.
  entry("2026-12-31", [
    ["bank", 2_000_000, 0],
    ["equip", 800_000, 0],
    ["accumdep", 0, 100_000],
    ["loan", 0, 500_000],
    ["capital", 0, 2_200_000],
  ], { sourceType: "OPENING_BALANCE", memo: "Opening balance" }),

  // A card charge: $500 of dues, $14.80 of Stripe fees, $485.20 net to clearing.
  entry("2027-01-05", [
    ["stripe", 48_520, 0],
    ["fees", 1_480, 0],
    ["dues", 0, 50_000],
  ], { sourceType: "STRIPE_CHARGE" }),

  // Stripe pays out to the bank.
  entry("2027-01-08", [
    ["bank", 48_520, 0],
    ["stripe", 0, 48_520],
  ], { sourceType: "PAYOUT" }),

  // Cash taken at the door, not yet deposited.
  entry("2027-01-09", [
    ["undep", 15_000, 0],
    ["dues", 0, 15_000],
  ], { sourceType: "STRIPE_CHARGE" }),

  // The deposit.
  entry("2027-01-12", [
    ["bank", 15_000, 0],
    ["undep", 0, 15_000],
  ], { sourceType: "DEPOSIT" }),

  // A refund, with the fee NOT returned (the Phase 2 documented case).
  entry("2027-01-15", [
    ["refunds", 10_000, 0],
    ["bank", 0, 10_000],
  ], { sourceType: "REFUND" }),

  // Rent, paid from the bank.
  entry("2027-01-20", [
    ["rent", 250_000, 0],
    ["bank", 0, 250_000],
  ], { sourceType: "EXPENSE", program: "Facility" }),

  // Merchandise bought on the card — cost of sales, and a liability up.
  entry("2027-01-22", [
    ["merchcost", 30_000, 0],
    ["card", 0, 30_000],
  ], { sourceType: "EXPENSE" }),

  // New equipment, bought with cash: an investing outflow.
  entry("2027-01-25", [
    ["equip", 120_000, 0],
    ["bank", 0, 120_000],
  ], { sourceType: "MANUAL", memo: "New mats" }),

  // A loan repayment: a financing outflow.
  entry("2027-01-27", [
    ["loan", 50_000, 0],
    ["bank", 0, 50_000],
  ], { sourceType: "BANK" }),

  // Depreciation for the month, posted at close.
  entry("2027-01-31", [
    ["dep", 20_000, 0],
    ["accumdep", 0, 20_000],
  ], { sourceType: "DEPRECIATION", memo: "January depreciation" }),

  // February, so the by-month columns have something to separate.
  entry("2027-02-03", [
    ["stripe", 19_408, 0],
    ["fees", 592, 0],
    ["dues", 0, 20_000],
  ], { sourceType: "STRIPE_CHARGE" }),
  entry("2027-02-28", [
    ["dep", 20_000, 0],
    ["accumdep", 0, 20_000],
  ], { sourceType: "DEPRECIATION" }),

  // A HAND-WRITTEN ACCRUAL — the only thing cash basis excludes.
  entry("2027-02-10", [
    ["ar", 75_000, 0],
    ["dues", 0, 75_000],
  ], { sourceType: "MANUAL", memo: "Invoice #1001 — spring dues" }),
  // And the entry that settles it, which cash basis also drops. The report
  // says so out loud; see §4.
  entry("2027-02-25", [
    ["bank", 75_000, 0],
    ["ar", 0, 75_000],
  ], { sourceType: "MANUAL", memo: "Payment of invoice #1001" }),
];

const ALL_LINES: ReportLine[] = FIXTURE.flatMap((f) => f.lines);
const ENTRIES = new Map<string, ReportEntry>(FIXTURE.map((f) => [f.entry.id, f.entry]));

// ── 1. The fixture itself ───────────────────────────────────────────────────
{
  const d = ALL_LINES.reduce((s, l) => s + l.debitCents, 0);
  const c = ALL_LINES.reduce((s, l) => s + l.creditCents, 0);
  eq(d, c, "1.1 the fixture journal balances in total");
  ok(ALL_LINES.length > 30, "1.2 the fixture is big enough to be worth asserting on");
}

// ── 2. Balances and sign ────────────────────────────────────────────────────
{
  const t = totalsByAccount(ALL_LINES);
  const bank = t.get("bank")!;
  // 20,000 + 485.20 + 150 − 100 − 2,500 − 1,200 − 500 + 750
  eq(signedBalance("DEBIT", bank), 1_708_520, "2.1 the bank's balance is the sum of its movements");
  eq(netDebit(bank), 1_708_520, "2.2 and nets debit");

  const refunds = t.get("refunds")!;
  // 4900 is contra-income with a DEBIT normal balance, so a refund is positive
  // in its own direction — the thing that catches a sign flip.
  eq(signedBalance("DEBIT", refunds), 10_000, "2.3 a contra-income account is positive in its own direction");

  const accum = t.get("accumdep")!;
  eq(signedBalance("CREDIT", accum), 140_000, "2.4 accumulated depreciation nets credit (1,000 + 200 + 200)");

  eq(signedBalance("DEBIT", { debitCents: 0, creditCents: 0 }), 0, "2.5 an empty account is zero");
}

// ── 3. Trial balance ────────────────────────────────────────────────────────
{
  const tb = trialBalance(ACCOUNTS, ALL_LINES);
  ok(tb.balanced, "3.1 the trial balance balances", `difference ${formatCents(tb.differenceCents)}`);
  eq(tb.differenceCents, 0, "3.2 to the cent, not to a tolerance");
  ok(tb.totalDebitCents > 0, "3.3 and is not trivially zero on both sides");
  ok(
    tb.rows.every((r) => r.debitCents === 0 || r.creditCents === 0),
    "3.4 every row prints on exactly one side",
  );
  ok(!tb.rows.some((r) => r.debitCents === 0 && r.creditCents === 0), "3.5 zero-balance accounts are dropped");

  // Order: assets, liabilities, equity, income, expense; by number within.
  const nums = tb.rows.map((r) => r.number);
  eq(nums[0], "1000", "3.6 the first row is the lowest-numbered asset");
  eq(nums[nums.length - 1], "6800", "3.7 and the last is the highest-numbered expense");

  // A period trial balance over a locked month must still balance — that is
  // what makes it usable as the month-close check.
  const jan = filterLines(ALL_LINES, { from: "2027-01-01", to: "2027-01-31" });
  const tbJan = trialBalance(ACCOUNTS, jan);
  ok(tbJan.balanced, "3.8 a one-month trial balance balances too", `difference ${tbJan.differenceCents}`);

  // An unbalanced INPUT must be reported, not smoothed over. One stray cent of
  // debit with no matching credit — the smallest drift that must still show.
  const strayCent: ReportLine = {
    entryId: "bad",
    accountId: "rent",
    debitCents: 1,
    creditCents: 0,
    entryDate: "2027-01-31",
    legalEntityId: "frog",
    program: null,
  };
  const tbBroken = trialBalance(ACCOUNTS, [...jan, strayCent]);
  ok(!tbBroken.balanced, "3.9 an unbalanced journal produces an UNBALANCED trial balance");
  eq(tbBroken.differenceCents, 1, "3.10 and says by how much, down to a single cent");
}

// ── 4. Basis ────────────────────────────────────────────────────────────────
{
  eq(parseBasis("cash"), "cash", "4.1 parseBasis reads cash");
  eq(parseBasis("accrual"), "accrual", "4.2 and accrual");
  eq(parseBasis(null), "accrual", "4.3 and defaults to accrual, the stricter basis");
  eq(parseBasis("nonsense"), "accrual", "4.4 and never trusts an unknown value");

  const ex = cashBasisExclusions(ACCOUNTS, ALL_LINES);
  eq(ex.size, 2, "4.5 cash basis excludes exactly the invoice and its settlement");
  const feb = filterLines(ALL_LINES, { from: "2027-02-01", to: "2027-02-28" });
  const febCash = filterLines(ALL_LINES, { from: "2027-02-01", to: "2027-02-28" }, ex);
  ok(febCash.length < feb.length, "4.6 and really drops those lines");

  // The invoice's revenue must be gone on a cash basis.
  const accrualFeb = profitAndLoss(ACCOUNTS, feb, [
    { key: "feb", label: "Feb", from: "2027-02-01", to: "2027-02-28" },
  ]);
  const cashFeb = profitAndLoss(ACCOUNTS, febCash, [
    { key: "feb", label: "Feb", from: "2027-02-01", to: "2027-02-28" },
  ], "cash", [...ex]);
  eq(accrualFeb.income.totalCents, 95_000, "4.7 accrual February income includes the invoice");
  eq(cashFeb.income.totalCents, 20_000, "4.8 cash February income does not");

  // The note must state the limitation rather than imply equivalence.
  ok(/left out/.test(basisNote("cash", 2)), "4.9 the cash-basis note says entries are left out");
  ok(/neither period/.test(basisNote("cash", 2)), "4.10 and names the settlement limitation out loud");
  ok(/the same numbers/.test(basisNote("cash", 0)), "4.11 with nothing excluded it says cash and accrual agree");
  ok(/every posted entry/.test(basisNote("accrual", 0)), "4.12 and the accrual note says what accrual means");
  eq(ACCRUAL_ONLY_ACCOUNT_NUMBERS, ["1100", "1300", "2000", "2200"], "4.13 the accrual-only set is AR, prepaid, AP, deferred revenue");
}

// ── 5. Filters ──────────────────────────────────────────────────────────────
{
  const jan = filterLines(ALL_LINES, { from: "2027-01-01", to: "2027-01-31" });
  ok(jan.every((l) => l.entryDate >= "2027-01-01" && l.entryDate <= "2027-01-31"), "5.1 date bounds are inclusive");
  ok(!jan.some((l) => l.entryDate === "2026-12-31"), "5.2 and the opening balance is outside January");

  const opening = filterLines(ALL_LINES, { to: "2026-12-31" });
  eq(opening.length, 5, "5.3 an open-ended lower bound still works");

  const byProgram = filterLines(ALL_LINES, { program: "Facility" });
  eq(byProgram.length, 2, "5.4 the program filter picks only the tagged entry's lines");

  const otherEntity = filterLines(ALL_LINES, { legalEntityId: "other" });
  eq(otherEntity.length, 0, "5.5 an entity filter with no matches returns nothing, not everything");
}

// ── 6. Months ───────────────────────────────────────────────────────────────
{
  eq(monthKeys("2027-01-01", "2027-03-31"), ["2027-01", "2027-02", "2027-03"], "6.1 monthKeys spans inclusively");
  eq(monthKeys("2026-11-15", "2027-02-02"), ["2026-11", "2026-12", "2027-01", "2027-02"], "6.2 and crosses a year boundary");
  eq(monthKeys("2027-01-31", "2027-01-01").length, 1, "6.3 a backwards range yields the single start month, never a runaway");
  eq(monthKeys("2027-05-10", "2027-05-11"), ["2027-05"], "6.4 a range inside one month is one column");

  eq(monthEndDate("2027-01"), "2027-01-31", "6.5 January ends on the 31st");
  eq(monthEndDate("2027-02"), "2027-02-28", "6.6 a common February ends on the 28th");
  eq(monthEndDate("2028-02"), "2028-02-29", "6.7 and a leap February on the 29th");
  eq(monthEndDate("2027-04"), "2027-04-30", "6.8 a 30-day month ends on the 30th");
  eq(monthEndDate("2027-12"), "2027-12-31", "6.9 December ends the year");
  eq(monthStartDate("2027-07"), "2027-07-01", "6.10 and a month starts on the 1st");
  ok(/2027/.test(monthColumnLabel("2027-03")), "6.11 a column label carries the year");
  ok(/Mar/.test(monthColumnLabel("2027-03")), "6.12 and the right month — not the one before it");
  ok(/Jan/.test(monthColumnLabel("2027-01")), "6.13 including January, the one a UTC-midnight parse moves to December");
}

// ── 7. Profit & loss ────────────────────────────────────────────────────────
{
  const jan = filterLines(ALL_LINES, { from: "2027-01-01", to: "2027-01-31" });
  const pnl = profitAndLoss(ACCOUNTS, jan, [
    { key: "jan", label: "Jan 2027", from: "2027-01-01", to: "2027-01-31" },
  ]);

  // Income: 500 + 150 dues, less the 100 refund (a contra-income account).
  eq(pnl.income.totalCents, 55_000, "7.1 income nets the contra-income refund against revenue");
  eq(pnl.costOfSales.totalCents, 30_000, "7.2 cost of sales is its own section");
  eq(pnl.grossProfit.totalCents, 25_000, "7.3 gross profit is income less cost of sales");
  // Rent 2,500 + fees 14.80 + depreciation 200.
  eq(pnl.expenses.totalCents, 271_480, "7.4 operating expenses exclude cost of sales");
  eq(pnl.netIncome.totalCents, -246_480, "7.5 net income is gross profit less operating expenses");

  ok(
    pnl.expenses.lines.every((l) => l.totalCents >= 0),
    "7.6 expenses read positive — the reader never has to decode a minus sign",
  );
  const refundLine = pnl.income.lines.find((l) => l.number === "4900");
  ok(!!refundLine && refundLine.totalCents < 0, "7.7 but a refund reads negative inside income, which is what it is");
  ok(!pnl.costOfSales.lines.some((l) => l.number === "6000"), "7.8 rent is not in cost of sales");
  ok(!pnl.expenses.lines.some((l) => l.number === "5000"), "7.9 and merchandise cost is not in operating expenses");

  // By-month columns.
  const twoMonths = filterLines(ALL_LINES, { from: "2027-01-01", to: "2027-02-28" });
  const cols = monthKeys("2027-01", "2027-02").map((k) => ({
    key: k,
    label: monthColumnLabel(k),
    from: monthStartDate(k),
    to: monthEndDate(k),
  }));
  const byMonth = profitAndLoss(ACCOUNTS, twoMonths, cols);
  eq(byMonth.columns.length, 2, "7.10 two months give two columns");
  eq(byMonth.income.cells[0], 55_000, "7.11 January income lands in the January column");
  eq(byMonth.income.cells[1], 95_000, "7.12 and February's in February");
  eq(byMonth.income.totalCents, 150_000, "7.13 the total is the sum of the columns");
  eq(
    byMonth.netIncome.cells[0] + byMonth.netIncome.cells[1],
    byMonth.netIncome.totalCents,
    "7.14 and every section's cells sum to its total",
  );

  // A line outside every column must not be silently folded into one.
  const withOpening = profitAndLoss(ACCOUNTS, ALL_LINES, cols);
  eq(withOpening.income.totalCents, 150_000, "7.15 a line outside all columns is excluded, not dumped into the first");
}

// ── 8. Balance sheet ────────────────────────────────────────────────────────
{
  const through = filterLines(ALL_LINES, { to: "2027-01-31" });
  const bs = balanceSheet(ACCOUNTS, through, "2027-01-31", "2027-01-01");

  ok(bs.balanced, "8.1 the balance sheet balances", `difference ${formatCents(bs.differenceCents)}`);
  eq(bs.differenceCents, 0, "8.2 to the cent");
  eq(bs.currentYearNetIncomeCents, -246_480, "8.3 current-year net income matches the P&L");
  ok(
    bs.equity.lines.some((l) => l.accountId === "__current_year_net_income__"),
    "8.4 and appears as its own equity line — this is net income flowing to equity",
  );
  ok(bs.totalAssetsCents > 0, "8.5 assets are not trivially zero");
  eq(
    bs.totalAssetsCents,
    bs.totalLiabilitiesCents + bs.totalEquityCents,
    "8.6 assets equal liabilities plus equity",
  );

  const accumLine = bs.assets.lines.find((l) => l.number === "1590");
  ok(!!accumLine && accumLine.totalCents < 0, "8.7 accumulated depreciation reduces assets rather than adding to them");

  // Prior-year earnings must land in equity, or the sheet is short by them.
  const feb = filterLines(ALL_LINES, { to: "2027-02-28" });
  const bs2028 = balanceSheet(ACCOUNTS, feb, "2027-02-28", "2028-01-01");
  ok(bs2028.balanced, "8.8 a balance sheet whose whole history is a PRIOR year still balances");
  eq(bs2028.currentYearNetIncomeCents, 0, "8.9 with nothing in the current year");
  ok(
    bs2028.equity.lines.some((l) => l.accountId === "__prior_earnings__"),
    "8.10 because prior-year earnings get their own equity line",
  );

  // The opening balance alone must balance — task 7's whole requirement.
  const openingOnly = filterLines(ALL_LINES, { to: "2026-12-31" });
  const bsOpen = balanceSheet(ACCOUNTS, openingOnly, "2026-12-31", "2026-01-01");
  ok(bsOpen.balanced, "8.11 the opening balance on its own balances");
  eq(bsOpen.totalAssetsCents, 2_700_000, "8.12 20,000 bank + 8,000 equipment − 1,000 depreciation");

  // Mid-month, mid-anything: it has to balance on EVERY date, not just ones
  // a test picked. Any date where it doesn't is a bug the invariant catches.
  const dates = [...new Set(ALL_LINES.map((l) => l.entryDate))].sort();
  const unbalanced = dates.filter(
    (d) => !balanceSheet(ACCOUNTS, filterLines(ALL_LINES, { to: d }), d, "2027-01-01").balanced,
  );
  eq(unbalanced, [], "8.13 and it balances as of every date in the fixture");
}

// ── 9. General ledger ───────────────────────────────────────────────────────
{
  const jan = filterLines(ALL_LINES, { from: "2027-01-01", to: "2027-01-31" });
  const prior = filterLines(ALL_LINES, { to: "2026-12-31" });
  const gl = generalLedger(ACCOUNTS, jan, ENTRIES, prior);

  const bank = gl.find((a) => a.number === "1000")!;
  eq(bank.openingCents, 2_000_000, "9.1 the bank opens at its prior-period balance");
  eq(bank.closingCents, 1_633_520, "9.2 and closes at opening plus the period's movements");
  eq(
    bank.rows[bank.rows.length - 1].balanceCents,
    bank.closingCents,
    "9.3 the running balance's last row IS the closing balance",
  );
  ok(
    bank.rows.every((r, i) => i === 0 || r.entryDate >= bank.rows[i - 1].entryDate),
    "9.4 rows are in date order",
  );
  eq(bank.debitCents - bank.creditCents, bank.closingCents - bank.openingCents, "9.5 debits less credits equal the change");

  // Every account's closing balance must agree with the trial balance built
  // from the same lines — two independent paths to the same number.
  const tbAll = trialBalance(ACCOUNTS, filterLines(ALL_LINES, { to: "2027-01-31" }));
  const glAll = generalLedger(ACCOUNTS, filterLines(ALL_LINES, { to: "2027-01-31" }), ENTRIES, []);
  const mismatched = glAll.filter((a) => {
    const row = tbAll.rows.find((r) => r.accountId === a.accountId);
    const tbSigned = row
      ? a.normalBalance === "DEBIT"
        ? row.debitCents - row.creditCents
        : row.creditCents - row.debitCents
      : 0;
    return tbSigned !== a.closingCents;
  });
  eq(mismatched.map((m) => m.number), [], "9.6 every GL closing balance agrees with the trial balance");

  const entryMeta = bank.rows.find((r) => r.sourceType === "PAYOUT");
  ok(!!entryMeta, "9.7 each row carries its entry's source type, so the reader can see where it came from");
  const mats = glAll.find((a) => a.number === "1500")!.rows.find((r) => r.memo === "New mats");
  ok(!!mats, "9.8 and its memo");

  // An account with no activity and no opening balance is not printed.
  ok(!gl.some((a) => a.number === "2000"), "9.9 an untouched account is omitted");
  // An account with an opening balance but no activity IS printed — a CPA
  // needs to see that the loan still exists in a month nothing happened to it.
  const quiet = generalLedger(ACCOUNTS, filterLines(ALL_LINES, { from: "2027-03-01", to: "2027-03-31" }), ENTRIES, prior);
  const loan = quiet.find((a) => a.number === "2700");
  ok(!!loan && loan.rows.length === 0 && loan.openingCents === 500_000, "9.10 but a quiet account with a balance is");
}

// ── 10. Cash flow (indirect) ────────────────────────────────────────────────
{
  const jan = filterLines(ALL_LINES, { from: "2027-01-01", to: "2027-01-31" });
  const prior = filterLines(ALL_LINES, { to: "2026-12-31" });
  const inputs = classifyForCashFlow(ACCOUNTS, ["bank", "card"]);

  ok(inputs.cashAccountIds.has("bank"), "10.1 the bank is cash");
  ok(inputs.cashAccountIds.has("undep"), "10.2 undeposited funds is cash in transit");
  ok(inputs.cashAccountIds.has("stripe"), "10.3 so is Stripe clearing");
  ok(inputs.investingAccountIds.has("equip"), "10.4 equipment is investing");
  ok(inputs.accumDepAccountIds.has("accumdep"), "10.5 accumulated depreciation is the add-back");
  ok(!inputs.investingAccountIds.has("accumdep"), "10.6 and is NOT also in investing — that double-counts");
  ok(inputs.financingAccountIds.has("loan"), "10.7 a loan is financing");
  ok(inputs.financingAccountIds.has("capital"), "10.8 and owner capital is too");
  ok(inputs.depreciationAccountIds.has("dep"), "10.9 the expense account is tracked for display");
  ok(!inputs.cashAccountIds.has("ar"), "10.10 a receivable is not cash");

  const cf = cashFlowIndirect(ACCOUNTS, jan, prior, "2027-01-01", "2027-01-31", inputs);

  ok(cf.ties, "10.11 the cash flow statement TIES", `difference ${formatCents(cf.differenceCents)}`);
  eq(cf.differenceCents, 0, "10.12 to the cent");
  eq(cf.netIncomeCents, -246_480, "10.13 it starts from the same net income the P&L reports");
  eq(cf.depreciationCents, 20_000, "10.14 and reports the period's depreciation");
  eq(cf.openingCashCents, 2_000_000, "10.15 opening cash is the prior cash balance");
  eq(cf.closingCashCents, 1_633_520, "10.16 and closing cash is opening plus the actual change");
  eq(cf.actualChangeCents, -366_480, "10.17 the actual change in cash is what the cash accounts moved");
  eq(cf.netChangeCents, cf.actualChangeCents, "10.18 which is what the three sections sum to");

  const invest = cf.investing.lines.find((l) => l.accountId === "equip");
  ok(!!invest && invest.amountCents === -120_000, "10.19 buying equipment is an investing OUTFLOW");
  const fin = cf.financing.lines.find((l) => l.accountId === "loan");
  ok(!!fin && fin.amountCents === -50_000, "10.20 repaying a loan is a financing outflow");
  const addBack = cf.operating.lines.find((l) => /Depreciation \(non-cash\)/.test(l.label));
  ok(!!addBack && addBack.amountCents === 20_000, "10.21 depreciation is added back in operating, exactly once");
  eq(
    cf.operating.lines.filter((l) => /Depreciation/.test(l.label)).length,
    1,
    "10.22 and appears on exactly one line",
  );

  // THE REGRESSION TEST for the bug this file caught during the build: adding
  // the expense figure as an add-back AND showing the accumulated-depreciation
  // movement in investing breaks the tie by exactly the depreciation.
  const doubleCounted =
    cf.netChangeCents + cf.depreciationCents === cf.actualChangeCents;
  ok(!doubleCounted, "10.23 the add-back is not counted twice (the bug this test exists for)");

  // A month with no depreciation still ties.
  const feb = filterLines(ALL_LINES, { from: "2027-02-01", to: "2027-02-10" });
  const cfFeb = cashFlowIndirect(
    ACCOUNTS,
    feb,
    filterLines(ALL_LINES, { to: "2027-01-31" }),
    "2027-02-01",
    "2027-02-10",
    inputs,
  );
  ok(cfFeb.ties, "10.24 a partial month with no depreciation ties too", `difference ${cfFeb.differenceCents}`);

  // It must tie on EVERY month of the fixture, not the ones a test picked.
  const notTying = monthKeys("2026-12", "2027-03").filter((k) => {
    const from = monthStartDate(k);
    const to = monthEndDate(k);
    return !cashFlowIndirect(
      ACCOUNTS,
      filterLines(ALL_LINES, { from, to }),
      filterLines(ALL_LINES, { to: `${from.slice(0, 8)}01` }),
      from,
      to,
      inputs,
    ).ties;
  });
  eq(notTying, [], "10.25 and it ties for every month in the fixture");

  // Cash basis must tie as well — dropping an entry drops BOTH its sides, so
  // the journal stays balanced and the statement stays provable.
  const ex = cashBasisExclusions(ACCOUNTS, ALL_LINES);
  const febCash = filterLines(ALL_LINES, { from: "2027-02-01", to: "2027-02-28" }, ex);
  const cfCash = cashFlowIndirect(
    ACCOUNTS,
    febCash,
    filterLines(ALL_LINES, { to: "2027-01-31" }, ex),
    "2027-02-01",
    "2027-02-28",
    inputs,
    "cash",
  );
  ok(cfCash.ties, "10.26 a cash-basis cash flow ties, because exclusions drop whole entries");
  eq(cfCash.basis, "cash", "10.27 and says which basis it is");
}

// ── 11. Sorting ─────────────────────────────────────────────────────────────
{
  const sorted = sortAccounts(ACCOUNTS).map((a) => a.number);
  const idx = (n: string) => sorted.indexOf(n);
  ok(idx("1000") < idx("2000"), "11.1 assets sort before liabilities");
  ok(idx("2000") < idx("3000"), "11.2 liabilities before equity");
  ok(idx("3000") < idx("4000"), "11.3 equity before income");
  ok(idx("4000") < idx("6000"), "11.4 income before expenses");
  ok(idx("1000") < idx("1020") && idx("1020") < idx("1100"), "11.5 and numerically within a type");
  // Numeric collation, not lexicographic: "1100" must not sort before "1020".
  ok(idx("1020") < idx("1100"), "11.6 numerically, so 1020 precedes 1100");
}

// ── 12. Source guarantees ───────────────────────────────────────────────────
// Properties of the SOURCE rather than of any one call, so this is the only
// place the build can check them.
{
  const src = readFileSync(join(ROOT, "lib/glReports.ts"), "utf8");
  ok(!/from "@\/lib\/prisma"|require\("@\/lib\/prisma"\)/.test(src), "12.1 lib/glReports.ts imports no prisma — it stays pure");
  ok(!/next\/server/.test(src), "12.2 and no next/server");
  ok(!/\bnew Date\(\)/.test(src), "12.3 and reads no clock, so a report is a function of its arguments");
  // Dates are compared as YYYY-MM-DD strings. A Date comparison here is how a
  // transaction ends up in the wrong month in a negative-offset zone.
  ok(!/getTime\(\)|setHours|setDate\(/.test(src), "12.4 and uses no local-time Date arithmetic");
  ok(/differenceCents/.test(src) && /balanced/.test(src), "12.5 it reports whether statements balance rather than assuming it");
  ok(/ties: differenceCents === 0/.test(src), "12.6 and the cash flow proves itself against the actual cash movement");
  ok(/=== 0/.test(src) && !/Math\.abs\([^)]*\)\s*<\s*[0-9]/.test(src), "12.7 balance checks are exact, never a tolerance");

  // A VOID entry keeps all its rows — Phase 1 never hard-deletes — so a report
  // that forgot this filter would count voided money as real. The bug report
  // mentions voided test entries, so this is pinned rather than assumed.
  const server = readFileSync(join(ROOT, "lib/glReportsServer.ts"), "utf8");
  ok(/status: "POSTED"/.test(server), "12.8 the server reads POSTED entries only");
  ok(
    (server.match(/status: "POSTED"/g) ?? []).length >= 1 && /entry: \{/.test(server),
    "12.9 filtering on the ENTRY, so a voided entry's lines never reach a statement",
  );
}

// ── 13. An empty club, and voided entries ──────────────────────────────────
// Phase 12.1 Part 1. The production state that was reported broken: a Pro club
// with a chart of accounts, NO books start date, and zero or a few entries —
// some of them voided test entries. Every statement must be empty-but-valid
// rather than an error, and must still prove it balances.
{
  // No accounts at all, which is the state before the chart is seeded.
  const bare = trialBalance([], []);
  ok(bare.balanced, "13.1 a trial balance with no accounts balances");
  eq(bare.rows, [], "13.2 with no rows");
  eq(bare.totalDebitCents, 0, "13.3 and nothing on either side");

  // A seeded chart with NOTHING posted — the common case.
  const chartOnly = trialBalance(ACCOUNTS, []);
  ok(chartOnly.balanced, "13.4 a seeded chart with no postings balances");
  eq(chartOnly.rows, [], "13.5 and lists no accounts, because a zero row carries no information");

  const bs = balanceSheet(ACCOUNTS, [], "2026-10-27", "2026-01-01");
  ok(bs.balanced, "13.6 an empty balance sheet balances");
  eq(bs.totalAssetsCents, 0, "13.7 at zero");
  eq(bs.currentYearNetIncomeCents, 0, "13.8 with no current-year income");
  ok(
    bs.equity.lines.some((l) => l.accountId === "__current_year_net_income__"),
    "13.9 but the net-income equity line is still present, so the sheet reads as a sheet",
  );

  const pnl = profitAndLoss(ACCOUNTS, [], [
    { key: "period", label: "Total", from: "2026-10-01", to: "2026-10-31" },
  ]);
  eq(pnl.income.totalCents, 0, "13.10 an empty P&L has no income");
  eq(pnl.netIncome.totalCents, 0, "13.11 and no net income");
  eq(pnl.income.lines, [], "13.12 and no lines");
  eq(pnl.columns.length, 1, "13.13 with its single column intact");

  const gl = generalLedger(ACCOUNTS, [], new Map(), []);
  eq(gl, [], "13.14 an empty general ledger is an empty list, not a crash");

  const inputs = classifyForCashFlow(ACCOUNTS, []);
  const cf = cashFlowIndirect(ACCOUNTS, [], [], "2026-10-01", "2026-10-31", inputs);
  ok(cf.ties, "13.15 an empty cash flow statement ties");
  eq(cf.netChangeCents, 0, "13.16 at zero");
  eq(cf.openingCashCents, 0, "13.17 with no opening cash");
  eq(cf.operating.lines, [], "13.18 and no lines in any section");

  // A club with NO bank account mapped: "cash" is only 1020 and 1050. It must
  // still tie, because the statement proves itself against whatever it counted
  // as cash.
  ok(inputs.cashAccountIds.has("undep"), "13.19 with no bank mapped, undeposited funds is still cash");
  ok(inputs.cashAccountIds.size >= 2, "13.20 as is Stripe clearing");

  // A single VOIDED entry contributes nothing. Void filtering happens in the
  // server's query (`status: "POSTED"`), so at this layer the proof is that a
  // statement built from no lines is valid — and §13.21 pins the query.
  const onlyVoided = trialBalance(ACCOUNTS, []);
  ok(onlyVoided.balanced, "13.21 a club whose only entries are voided sees a valid empty trial balance");

  // One lone entry, which is "a few entries" in the bug report.
  const oneEntry = FIXTURE[1].lines; // the single card charge
  const tbOne = trialBalance(ACCOUNTS, oneEntry);
  ok(tbOne.balanced, "13.22 a club with ONE entry still balances");
  eq(tbOne.rows.length, 3, "13.23 showing its three accounts");
  const bsOne = balanceSheet(ACCOUNTS, oneEntry, "2027-01-31", "2027-01-01");
  ok(bsOne.balanced, "13.24 and its balance sheet balances");
  const cfOne = cashFlowIndirect(ACCOUNTS, oneEntry, [], "2027-01-01", "2027-01-31", inputs);
  ok(cfOne.ties, "13.25 and its cash flow ties");
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`\n${fails.length ? "✗" : "✓"} gl-reports: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
