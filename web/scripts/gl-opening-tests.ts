// Accounting Phase 3 — opening balances and the QuickBooks archive, proven.
//
//   npm run test:gl-opening     (and it GATES the build)
//
// No database, no network.
//
// §6 is the load-bearing one: it greps the reports and posting modules to
// prove the read-only QuickBooks archive NEVER reaches the books. That is a
// property of the whole source tree, not of any one function, so a test is the
// only place it can be checked — and "never feeds live reports" is the entire
// promise the archive makes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openingBlockers,
  openingDateFor,
  openingSourceId,
  parseTrialBalance,
  planOpeningEntry,
  suggestMapping,
  suggestTarget,
  type OpeningMapping,
  type TargetAccount,
} from "../lib/glOpening";
import { entryTotals } from "../lib/ledger";

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

const TARGETS: TargetAccount[] = [
  { id: "bank", number: "1000", name: "Operating Checking", type: "ASSET" },
  { id: "savings", number: "1010", name: "Savings", type: "ASSET" },
  { id: "equip", number: "1500", name: "Training Equipment", type: "ASSET" },
  { id: "accumdep", number: "1590", name: "Accumulated Depreciation", type: "ASSET" },
  { id: "card", number: "2100", name: "Credit Cards", type: "LIABILITY" },
  { id: "loan", number: "2700", name: "Loans Payable", type: "LIABILITY" },
  { id: "capital", number: "3000", name: "Owner / Partner Capital", type: "EQUITY" },
  { id: "retained", number: "3900", name: "Retained Earnings", type: "EQUITY" },
  { id: "dues", number: "4000", name: "Membership Revenue", type: "INCOME" },
  { id: "rent", number: "6000", name: "Rent", type: "EXPENSE" },
];

// A QuickBooks trial balance, complete with the title rows it prints above the
// headings and the total row it prints below them.
const QB_TABLE: string[][] = [
  ["Frog Empire Wrestling LLC"],
  ["Trial Balance"],
  ["As of December 31, 2026"],
  [],
  ["Account", "Debit", "Credit"],
  ["1000 · Operating Checking", "20,000.00", ""],
  ["1500 · Training Equipment", "8,000.00", ""],
  ["1590 · Accumulated Depreciation", "", "1,000.00"],
  ["2700 · Loans Payable", "", "5,000.00"],
  ["3000 · Owner Capital", "", "20,000.00"],
  ["4000 · Membership Revenue", "", "9,000.00"],
  ["6000 · Rent", "7,000.00", ""],
  ["TOTAL", "35,000.00", "35,000.00"],
];

// ── 1. Parsing ──────────────────────────────────────────────────────────────
{
  const p = parseTrialBalance(QB_TABLE);
  eq(p.rows.length, 7, "1.1 seven account rows are read");
  eq(p.totalDebitCents, 3_500_000, "1.2 debits total $35,000");
  eq(p.totalCreditCents, 3_500_000, "1.3 credits too");
  ok(p.balanced, "1.4 so the file balances");
  ok(
    p.problems.some((x) => /subtotal or total/.test(x)),
    "1.5 and the skipped TOTAL row is reported — counting it would double everything",
  );
  eq(p.rows[0].account, "1000 · Operating Checking", "1.6 account names are kept VERBATIM, because they are the mapping key");
  eq(p.rows[0].debitCents, 2_000_000, "1.7 money parses through the shared parser");
  eq(p.rows[2].creditCents, 100_000, "1.8 including the credit column");

  // Single signed Amount column — most hand-made spreadsheets, and some
  // exports.
  const signed = parseTrialBalance([
    ["Account", "Amount"],
    ["Checking", "20000"],
    ["Loan", "-5000"],
    ["Capital", "-15000"],
  ]);
  eq(signed.rows.length, 3, "1.9 a single signed Amount column is read too");
  eq(signed.rows[0].debitCents, 2_000_000, "1.10 positive is a debit");
  eq(signed.rows[1].creditCents, 500_000, "1.11 negative is a credit");
  ok(signed.balanced, "1.12 and it balances");

  // A negative in the Debit column means a credit — how some exports print a
  // contra balance.
  const negDebit = parseTrialBalance([
    ["Account", "Debit", "Credit"],
    ["Checking", "1000.00", ""],
    ["Accumulated depreciation", "-1000.00", ""],
  ]);
  eq(negDebit.rows[1].creditCents, 100_000, "1.13 a negative debit is read as a credit");
  ok(negDebit.balanced, "1.14 so that file balances");

  // Failure is explained, with what to export instead.
  const nonsense = parseTrialBalance([["some"], ["random"], ["rows"]]);
  eq(nonsense.rows.length, 0, "1.15 an unrecognisable file yields no rows");
  ok(/Trial Balance/.test(nonsense.problems[0]), "1.16 and the message names the report to export");
  ok(!nonsense.balanced, "1.17 and it does not claim to balance");

  // An unbalanced file is reported as unbalanced, not fixed.
  const unbalanced = parseTrialBalance([
    ["Account", "Debit", "Credit"],
    ["Checking", "100.00", ""],
    ["Capital", "", "99.00"],
  ]);
  ok(!unbalanced.balanced, "1.18 an unbalanced file is reported as such");

  // Rows that net to zero carry no information.
  const zeros = parseTrialBalance([
    ["Account", "Debit", "Credit"],
    ["Checking", "100.00", ""],
    ["Closed account", "0.00", "0.00"],
    ["Capital", "", "100.00"],
  ]);
  eq(zeros.rows.length, 2, "1.19 a zero row is dropped");
  // The headings are found below the club name and the report title.
  ok(parseTrialBalance(QB_TABLE).rows.length > 0, "1.20 headings are found below QuickBooks' title rows");
}

// ── 2. Mapping suggestions ──────────────────────────────────────────────────
{
  eq(suggestTarget("Operating Checking", TARGETS), "bank", "2.1 an exact name match");
  eq(suggestTarget("  operating   CHECKING ", TARGETS), "bank", "2.2 case and spacing don't matter");
  eq(suggestTarget("1000 · Operating Checking", TARGETS), "bank", "2.3 a leading account number matches");
  eq(suggestTarget("2700 · Something Else Entirely", TARGETS), "loan", "2.4 the NUMBER wins over the name");
  eq(suggestTarget("Assets:Operating Checking", TARGETS), "bank", "2.5 a QuickBooks sub-account's leaf matches");
  eq(suggestTarget("Rent", TARGETS), "rent", "2.6 a single-word match");
  eq(suggestTarget("Training Equipment", TARGETS), "equip", "2.7 a two-word match");
  eq(suggestTarget("Zephyr Holdings Intangibles", TARGETS), null, "2.8 nothing like anything returns NOTHING, not a guess");
  eq(suggestTarget("", TARGETS), null, "2.9 an empty name returns nothing");
  eq(suggestTarget("Checking", []), null, "2.10 an empty chart returns nothing");
  // Token overlap must not accept a weak match: a wrong suggestion the owner
  // accepts is worse than no suggestion.
  eq(suggestTarget("Equipment Rental Deposit Insurance Fund", TARGETS), null, "2.11 a weak token overlap is rejected");

  const m = suggestMapping(["1000 · Operating Checking", "Nonsense Account"], TARGETS);
  eq(m["1000 · Operating Checking"], "bank", "2.12 suggestMapping maps what it can");
  eq(m["Nonsense Account"], null, "2.13 and leaves the rest for a human");
  eq(Object.keys(m).length, 2, "2.14 with an entry for every account, so none is silently missed");
}

// ── 3. The plan ─────────────────────────────────────────────────────────────
{
  const parsed = parseTrialBalance(QB_TABLE);
  const mapping: OpeningMapping = {
    "1000 · Operating Checking": "bank",
    "1500 · Training Equipment": "equip",
    "1590 · Accumulated Depreciation": "accumdep",
    "2700 · Loans Payable": "loan",
    "3000 · Owner Capital": "capital",
    "4000 · Membership Revenue": "dues",
    "6000 · Rent": "rent",
  };
  const plan = planOpeningEntry(parsed, mapping, TARGETS, "retained");

  ok(plan.balanced, "3.1 the opening entry balances", `off by ${plan.differenceCents}`);
  eq(plan.differenceCents, 0, "3.2 to the cent");
  ok(entryTotals(plan.lines.map((l) => ({ ...l, legalEntityId: null }))).balanced, "3.3 and the ledger agrees it balances");

  // Income $9,000 less expenses $7,000 = $2,000 retained.
  eq(plan.retainedEarningsCents, 200_000, "3.4 income less expenses rolls into retained earnings");
  ok(
    !plan.lines.some((l) => l.accountId === "dues" || l.accountId === "rent"),
    "3.5 and NO revenue or expense account is opened with a balance — that would put last year's trading in the new books' first P&L",
  );
  const retained = plan.lines.find((l) => l.accountId === "retained");
  eq(retained?.creditCents, 200_000, "3.6 retained earnings is credited with the net");

  eq(plan.unmapped, [], "3.7 nothing is unmapped");
  eq(plan.skipped, [], "3.8 nothing is skipped");
  // Lines come out in account-number order, so the preview reads like a chart.
  eq(plan.lines.map((l) => l.accountId), ["bank", "equip", "accumdep", "loan", "capital", "retained"], "3.9 lines are in account-number order");

  // Two QuickBooks accounts mapping to ONE of ours become one line.
  const merged = planOpeningEntry(
    parseTrialBalance([
      ["Account", "Debit", "Credit"],
      ["Checking", "600.00", ""],
      ["Checking - old", "400.00", ""],
      ["Capital", "", "1,000.00"],
    ]),
    { Checking: "bank", "Checking - old": "bank", Capital: "capital" },
    TARGETS,
    "retained",
  );
  eq(merged.lines.length, 2, "3.10 two QuickBooks accounts on one of ours produce ONE line");
  eq(merged.lines.find((l) => l.accountId === "bank")?.debitCents, 100_000, "3.11 with the balances summed");
  ok(merged.balanced, "3.12 and it balances");

  // An unmapped account is reported, not guessed at.
  const partial = planOpeningEntry(parsed, { "1000 · Operating Checking": "bank" }, TARGETS, "retained");
  ok(partial.unmapped.length > 0, "3.13 accounts with no mapping decision are reported");
  ok(!partial.balanced, "3.14 and the plan does not balance, which is the honest outcome");

  // A deliberate skip unbalances it — and the blocker says by how much.
  const skipped = planOpeningEntry(parsed, { ...mapping, "2700 · Loans Payable": null }, TARGETS, "retained");
  eq(skipped.skipped.length, 1, "3.15 a deliberate skip is recorded");
  eq(skipped.skipped[0].creditCents, 500_000, "3.16 with its balance, so the gap is explainable");
  ok(!skipped.balanced, "3.17 and the plan refuses to balance rather than plugging the difference");

  // Expenses exceeding income gives a DEBIT to retained earnings.
  const lossy = planOpeningEntry(
    parseTrialBalance([
      ["Account", "Debit", "Credit"],
      ["Rent", "5,000.00", ""],
      ["Checking", "1,000.00", ""],
      ["Capital", "", "6,000.00"],
    ]),
    { Rent: "rent", Checking: "bank", Capital: "capital" },
    TARGETS,
    "retained",
  );
  eq(lossy.retainedEarningsCents, -500_000, "3.18 a loss is negative retained earnings");
  eq(lossy.lines.find((l) => l.accountId === "retained")?.debitCents, 500_000, "3.19 which DEBITS retained earnings");
  ok(lossy.balanced, "3.20 and still balances");

  // A trial balance with no income or expenses needs no retained line at all.
  const cleanOpen = planOpeningEntry(
    parseTrialBalance([
      ["Account", "Debit", "Credit"],
      ["Checking", "1,000.00", ""],
      ["Capital", "", "1,000.00"],
    ]),
    { Checking: "bank", Capital: "capital" },
    TARGETS,
    "retained",
  );
  eq(cleanOpen.retainedEarningsCents, 0, "3.21 no trading means no retained earnings");
  ok(!cleanOpen.lines.some((l) => l.accountId === "retained"), "3.22 and no zero retained-earnings line is written");
}

// ── 4. Dates and keys ───────────────────────────────────────────────────────
{
  // THE DECISION: books start 2027-01-01, so the opening is dated 2026-12-31.
  eq(openingDateFor("2027-01-01"), "2026-12-31", "4.1 the opening is the day BEFORE the books start");
  eq(openingDateFor("2027-03-01"), "2027-02-28", "4.2 across a month boundary");
  eq(openingDateFor("2028-03-01"), "2028-02-29", "4.3 and a leap year");
  eq(openingDateFor("2027-01-02"), "2027-01-01", "4.4 and inside a month");

  eq(openingSourceId("imp1", "frog"), "imp1:frog", "4.5 the key is the import and the entity");
  eq(openingSourceId("imp1", null), "imp1:none", "4.6 with a stable stand-in when there is no entity");
  // One entry per entity: the same import for two entities must be two
  // different keys, or the second would hit the unique index.
  ok(openingSourceId("imp1", "a") !== openingSourceId("imp1", "b"), "4.7 so two entities get two entries, not a collision");
  // And the SAME entity twice must collide, which is what stops a club
  // doubling its own opening position.
  eq(openingSourceId("imp1", "a"), openingSourceId("imp1", "a"), "4.8 while posting the same import twice collides, as it must");
}

// ── 5. Blockers ─────────────────────────────────────────────────────────────
{
  const parsed = parseTrialBalance(QB_TABLE);
  const mapping: OpeningMapping = {
    "1000 · Operating Checking": "bank",
    "1500 · Training Equipment": "equip",
    "1590 · Accumulated Depreciation": "accumdep",
    "2700 · Loans Payable": "loan",
    "3000 · Owner Capital": "capital",
    "4000 · Membership Revenue": "dues",
    "6000 · Rent": "rent",
  };
  const plan = planOpeningEntry(parsed, mapping, TARGETS, "retained");
  const base = {
    booksStartDate: "2027-01-01",
    asOfDate: "2026-12-31",
    lockedThrough: null as string | null,
    hasClosedMonth: false,
    plan,
    parsed,
  };

  eq(openingBlockers(base), [], "5.1 a clean import has no blockers");

  const noBooks = openingBlockers({ ...base, booksStartDate: null });
  ok(noBooks.some((b) => b.code === "NO_BOOKS_START_DATE"), "5.2 no books start date blocks it");
  ok(/day before/.test(noBooks[0].message), "5.3 and the message says why it is needed");

  const locked = openingBlockers({ ...base, lockedThrough: "2026-12-31" });
  ok(locked.some((b) => b.code === "LOCKED"), "5.4 a lock date covering the opening date blocks it");
  const notLocked = openingBlockers({ ...base, lockedThrough: "2026-11-30" });
  eq(notLocked, [], "5.5 a lock date BEFORE the opening date does not");

  ok(
    openingBlockers({ ...base, hasClosedMonth: true }).some((b) => b.code === "MONTH_CLOSED"),
    "5.6 a closed month blocks it — changing the opening would change signed-off statements",
  );

  const unmapped = planOpeningEntry(parsed, { "1000 · Operating Checking": "bank" }, TARGETS, "retained");
  const u = openingBlockers({ ...base, plan: unmapped });
  ok(u.some((b) => b.code === "UNMAPPED"), "5.7 unmapped accounts block it");
  ok(/no mapping yet/.test(u.find((b) => b.code === "UNMAPPED")!.message), "5.8 and are named");

  const brokenFile = parseTrialBalance([
    ["Account", "Debit", "Credit"],
    ["Checking", "100.00", ""],
    ["Capital", "", "99.00"],
  ]);
  const bf = openingBlockers({
    ...base,
    parsed: brokenFile,
    plan: planOpeningEntry(brokenFile, { Checking: "bank", Capital: "capital" }, TARGETS, "retained"),
  });
  ok(bf.some((b) => b.code === "FILE_UNBALANCED"), "5.9 an unbalanced FILE blocks it");
  ok(
    /broken export, not a mapping problem/.test(bf.find((b) => b.code === "FILE_UNBALANCED")!.message),
    "5.10 and says which kind of problem it is, so the owner doesn't hunt the mapping",
  );

  const skippedPlan = planOpeningEntry(parsed, { ...mapping, "2700 · Loans Payable": null }, TARGETS, "retained");
  const sp = openingBlockers({ ...base, plan: skippedPlan });
  ok(sp.some((b) => b.code === "PLAN_UNBALANCED"), "5.11 a skipped account unbalances the plan and blocks it");
  ok(
    /skipped/.test(sp.find((b) => b.code === "PLAN_UNBALANCED")!.message),
    "5.12 and the message points at the skip rather than leaving it a mystery",
  );

  // Every blocker at once, so the owner fixes everything in one pass.
  const many = openingBlockers({
    ...base,
    booksStartDate: null,
    hasClosedMonth: true,
    plan: unmapped,
  });
  ok(many.length >= 3, "5.13 every blocker is returned at once, not one per round trip");
}

// ── 6. The archive NEVER reaches the books ──────────────────────────────────
// The whole promise of the read-only QuickBooks history is that it never feeds
// a report or a posting. That is a property of the source tree, so this is the
// only place it can be enforced.
{
  const mustNotRead = [
    "lib/glReports.ts",
    "lib/glReportsServer.ts",
    "lib/glReportsExport.ts",
    "lib/glPosting.ts",
    "lib/glPostingServer.ts",
    "lib/ledger.ts",
    "lib/ledgerServer.ts",
    "lib/glCloseServer.ts",
    "lib/glAssetsServer.ts",
    "lib/glReconcileServer.ts",
  ];
  for (const f of mustNotRead) {
    const src = readFileSync(join(ROOT, f), "utf8");
    ok(
      !/qboHistoryRow|qboHistoryFile|qbo_history/.test(src),
      `6.1 ${f} does not read the QuickBooks archive`,
      "the archive must never feed a report, a balance or a posting",
    );
  }

  // And the archive's own module must not post.
  const openingServer = readFileSync(join(ROOT, "lib/glOpeningServer.ts"), "utf8");
  const historySection = openingServer.slice(openingServer.indexOf("export type HistoryKind"));
  ok(historySection.length > 0, "6.2 the archive section is findable in the source");
  ok(
    !/createEntry\(/.test(historySection),
    "6.3 and nothing in it calls createEntry — the archive posts nothing, ever",
  );
  ok(
    /READ-ONLY/.test(openingServer),
    "6.4 with the guarantee written where the next person will read it",
  );

  // The opening import, by contrast, MUST post through the ledger service.
  const openingSection = openingServer.slice(0, openingServer.indexOf("export type HistoryKind"));
  ok(/createEntry\(/.test(openingSection), "6.5 the opening import posts through the Phase 1 ledger service");
  ok(/voidEntry\(/.test(openingSection), "6.6 and voids by REVERSING, never by deleting");
  ok(
    !/prisma\.glJournalLine\.create/.test(openingServer),
    "6.7 neither writes a journal line directly",
  );

  // No third CSV parser.
  ok(
    /readTable/.test(openingServer) && /parseQbTable/.test(openingServer),
    "6.8 both reuse the existing table reader and QuickBooks parser",
  );
  const pure = readFileSync(join(ROOT, "lib/glOpening.ts"), "utf8");
  ok(
    !/function parseCsv/.test(pure),
    "6.9 and lib/glOpening.ts adds no third hand-rolled CSV parser — there are already two with different behaviour",
  );
  ok(!/from "@\/lib\/prisma"/.test(pure), "6.10 lib/glOpening.ts imports no prisma");
  ok(!/\bnew Date\(\)/.test(pure), "6.11 and reads no clock");

  // Every query club-scoped, and no findUnique on a tenant row.
  ok(
    !/prisma\.(glOpeningImport|qboHistoryFile|qboHistoryRow|glAccount|glMonthClose)\.findUnique\(/.test(openingServer),
    "6.12 no tenant row is fetched by id alone",
  );
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`\n${fails.length ? "✗" : "✓"} gl-opening: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
