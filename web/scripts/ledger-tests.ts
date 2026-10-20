// Accounting Phase 1 — the ledger rules, proven.
//
//   npm run test:ledger          (and it GATES the build via run-build-tests.mjs)
//
// No database, no network. Everything under test is a pure function of its
// arguments, which is why lib/ledger.ts exists separately from
// lib/ledgerServer.ts — the rules that must never be wrong are the ones that
// can be checked in milliseconds on every build.
//
// The source-grep section at the end is not decoration. The ledger's tenant
// safety rests on every query in lib/ledgerServer.ts carrying clubId, and on
// no route reaching a gl_* table directly. Both are properties of the SOURCE,
// not of any single function, so the only way to keep them true is to assert
// them here where the build can see them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_TYPES,
  CHART_TEMPLATE,
  COST_OF_SALES,
  EXPENSE_CATEGORY_TO_ACCOUNT,
  PAYMENT_METHOD_TO_ACCOUNT,
  REVENUE_CATEGORY_TO_ACCOUNT,
  SYSTEM_ACCOUNT_KEYS,
  accountForExpenseCategory,
  accountForPaymentMethod,
  accountForRevenueCategory,
  deriveIntercompanyLines,
  entryTotals,
  formatCents,
  increasesWithDebit,
  isDateLocked,
  isValidDateOnly,
  netByEntity,
  parseDollarsToCents,
  reverseLines,
  reversalDate,
  spansMultipleEntities,
  templateSortOrder,
  templateSystemRows,
  validateEntryDraft,
  type AccountFact,
  type DraftEntry,
  type DraftLine,
} from "../lib/ledger";
import { EXPENSE_CATEGORIES, PAYMENT_METHODS, REVENUE_CATEGORIES } from "../lib/financials";
import { TIER_FEATURES, canUseFeature } from "../lib/tier";

const ROOT = join(__dirname, "..");
let pass = 0;
const fails: string[] = [];

function ok(cond: boolean, name: string, detail?: string) {
  if (cond) pass++;
  else fails.push(detail ? `${name} — ${detail}` : name);
}
function eq<T>(actual: T, expected: T, name: string) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// Accounts the validator sees. Ids are readable so failures are readable.
const ACC: AccountFact[] = [
  { id: "a_cash", number: "1000", name: "Operating Checking", type: "ASSET", active: true, isSystem: false },
  { id: "a_clearing", number: "1050", name: "Stripe Clearing", type: "ASSET", active: true, isSystem: true, systemKey: "STRIPE_CLEARING" },
  { id: "a_duefrom", number: "1400", name: "Due From Related Entity", type: "ASSET", active: true, isSystem: true, systemKey: "DUE_FROM" },
  { id: "a_dueto", number: "2500", name: "Due To Related Entity", type: "LIABILITY", active: true, isSystem: true, systemKey: "DUE_TO" },
  { id: "a_rev", number: "4000", name: "Membership Revenue", type: "INCOME", active: true, isSystem: false },
  { id: "a_rent", number: "6000", name: "Rent", type: "EXPENSE", active: true, isSystem: false },
  { id: "a_old", number: "6999", name: "Retired Account", type: "EXPENSE", active: false, isSystem: false },
];

const line = (p: Partial<DraftLine> & { accountId: string }): DraftLine => ({
  debitCents: 0,
  creditCents: 0,
  ...p,
});
const draft = (p: Partial<DraftEntry> = {}): DraftEntry => ({
  entryDate: "2026-10-20",
  lines: [line({ accountId: "a_cash", debitCents: 10_000 }), line({ accountId: "a_rev", creditCents: 10_000 })],
  ...p,
});

// ── 1. The balance rule ─────────────────────────────────────────────────────
console.log("\n[1] the balance rule");

eq(entryTotals([]), { debitCents: 0, creditCents: 0, differenceCents: 0, balanced: true }, "1.0 empty totals are zero and trivially balanced");
eq(
  entryTotals([{ debitCents: 10_000, creditCents: 0 }, { debitCents: 0, creditCents: 10_000 }]),
  { debitCents: 10_000, creditCents: 10_000, differenceCents: 0, balanced: true },
  "1.1 a matched pair balances",
);
eq(
  entryTotals([{ debitCents: 10_000, creditCents: 0 }, { debitCents: 0, creditCents: 9_999 }]),
  { debitCents: 10_000, creditCents: 9_999, differenceCents: 1, balanced: false },
  "1.2 one cent off is NOT balanced",
);

ok(validateEntryDraft(draft(), ACC).length === 0, "1.3 a balanced entry passes");

const unbalanced = validateEntryDraft(
  draft({ lines: [line({ accountId: "a_cash", debitCents: 10_000 }), line({ accountId: "a_rev", creditCents: 9_900 })] }),
  ACC,
);
ok(unbalanced.length > 0, "1.4 an unbalanced entry is REJECTED");
ok(
  unbalanced.some((e) => e.includes("off by") && e.includes("$1.00")),
  "1.5 the rejection names the exact gap",
  unbalanced.join(" | "),
);

const bothSides = validateEntryDraft(
  draft({
    lines: [line({ accountId: "a_cash", debitCents: 10_000, creditCents: 500 }), line({ accountId: "a_rev", creditCents: 9_500 })],
  }),
  ACC,
);
ok(
  bothSides.some((e) => e.includes("not both")),
  "1.6 a line with BOTH a debit and a credit is rejected even when the entry balances",
  bothSides.join(" | "),
);

const zero = validateEntryDraft(
  draft({ lines: [line({ accountId: "a_cash" }), line({ accountId: "a_rev" })] }),
  ACC,
);
ok(zero.some((e) => e.includes("$0.00")), "1.7 a zero-total entry is rejected", zero.join(" | "));

const negative = validateEntryDraft(
  draft({ lines: [line({ accountId: "a_cash", debitCents: -5_000 }), line({ accountId: "a_rev", creditCents: -5_000 })] }),
  ACC,
);
ok(
  negative.some((e) => e.includes("negative")),
  "1.8 negative amounts are rejected (a negative debit is a credit)",
  negative.join(" | "),
);

const fractional = validateEntryDraft(
  draft({ lines: [line({ accountId: "a_cash", debitCents: 100.5 }), line({ accountId: "a_rev", creditCents: 100.5 })] }),
  ACC,
);
ok(fractional.some((e) => e.includes("whole number")), "1.9 fractional cents are rejected");

ok(validateEntryDraft(draft({ lines: [] }), ACC).length > 0, "1.10 no lines is rejected");
ok(
  validateEntryDraft(draft({ lines: [line({ accountId: "a_cash", debitCents: 100 })] }), ACC).length > 0,
  "1.11 a single line is rejected",
);
ok(
  validateEntryDraft(draft({ lines: [line({ accountId: "nope", debitCents: 100 }), line({ accountId: "a_rev", creditCents: 100 })] }), ACC)
    .some((e) => e.includes("doesn't exist")),
  "1.12 an unknown account is rejected",
);
ok(
  validateEntryDraft(draft({ lines: [line({ accountId: "a_old", debitCents: 100 }), line({ accountId: "a_rev", creditCents: 100 })] }), ACC)
    .some((e) => e.includes("inactive")),
  "1.13 an INACTIVE account is rejected, and the message names it",
);
ok(
  validateEntryDraft(draft({ entryDate: "2026-02-30" }), ACC).some((e) => e.includes("date")),
  "1.14 an impossible date (Feb 30) is rejected, not silently rolled over",
);
ok(validateEntryDraft(draft({ entryDate: "10/20/2026" }), ACC).some((e) => e.includes("date")), "1.15 a non-ISO date is rejected");

// A big multi-line entry — the realistic shape of a payroll or close entry.
const many: DraftLine[] = [
  line({ accountId: "a_rent", debitCents: 250_000 }),
  line({ accountId: "a_rent", debitCents: 125_000 }),
  line({ accountId: "a_cash", creditCents: 300_000 }),
  line({ accountId: "a_clearing", creditCents: 75_000 }),
];
ok(validateEntryDraft(draft({ lines: many }), ACC).length === 0, "1.16 a four-line entry with repeated accounts balances and passes");

// ── 2. Dates and locks ──────────────────────────────────────────────────────
console.log("\n[2] dates and lock dates");

ok(isValidDateOnly("2026-10-20"), "2.0 a real date is valid");
ok(!isValidDateOnly("2026-02-30"), "2.1 Feb 30 is not");
ok(!isValidDateOnly("2026-13-01"), "2.2 month 13 is not");
ok(!isValidDateOnly("2026-1-1"), "2.3 unpadded is not");
ok(isValidDateOnly("2024-02-29"), "2.4 a real leap day is valid");
ok(!isValidDateOnly("2026-02-29"), "2.5 a non-leap Feb 29 is not");

ok(isDateLocked("2026-03-31", "2026-03-31"), "2.6 the lock date itself is LOCKED (inclusive) — a month-end entry must not slip through");
ok(isDateLocked("2026-03-30", "2026-03-31"), "2.7 before the lock is locked");
ok(!isDateLocked("2026-04-01", "2026-03-31"), "2.8 the day after is open");
ok(!isDateLocked("2026-03-31", null), "2.9 no lock date means nothing is locked");
ok(!isDateLocked("2026-03-31", undefined), "2.10 undefined lock date means nothing is locked");
// Lexicographic comparison on ISO strings is only safe because the format is
// fixed-width and zero-padded. Year boundaries are where a sloppier comparison
// would break.
ok(isDateLocked("2025-12-31", "2026-01-01"), "2.11 a prior-year date is locked by a January lock");
ok(!isDateLocked("2027-01-01", "2026-12-31"), "2.12 a next-year date is not");

// ── 3. Void by reversal ─────────────────────────────────────────────────────
console.log("\n[3] void by reversal");

const orig: DraftLine[] = [
  line({ accountId: "a_cash", debitCents: 10_000, legalEntityId: "e1", memo: "deposit" }),
  line({ accountId: "a_rev", creditCents: 10_000, legalEntityId: "e1" }),
];
const rev = reverseLines(orig);
eq(
  rev.map((l) => [l.accountId, l.debitCents, l.creditCents]),
  [
    ["a_cash", 0, 10_000],
    ["a_rev", 10_000, 0],
  ],
  "3.0 a reversal swaps every debit and credit",
);
ok(entryTotals(rev).balanced, "3.1 a reversal is itself balanced");
eq(
  entryTotals([...orig, ...rev]),
  { debitCents: 20_000, creditCents: 20_000, differenceCents: 0, balanced: true },
  "3.2 original + reversal nets to zero per account",
);
ok(rev[0].legalEntityId === "e1" && rev[0].memo === "deposit", "3.3 a reversal keeps the entity and memo");

eq(reversalDate("2026-10-20", null, "2026-10-25"), "2026-10-20", "3.4 with no lock, a reversal posts on the original's date");
eq(reversalDate("2026-03-15", "2026-03-31", "2026-10-25"), "2026-10-25", "3.5 when the original period is CLOSED, the reversal posts today");
eq(reversalDate("2026-10-20", "2026-09-30", "2026-10-25"), "2026-10-20", "3.6 a lock before the original's date doesn't move the reversal");

// ── 4. Intercompany ─────────────────────────────────────────────────────────
console.log("\n[4] intercompany");

ok(!spansMultipleEntities([line({ accountId: "a_cash", debitCents: 1, legalEntityId: "e1" })]), "4.0 one entity does not span");
ok(
  !spansMultipleEntities([
    line({ accountId: "a_cash", debitCents: 1, legalEntityId: null }),
    line({ accountId: "a_rev", creditCents: 1, legalEntityId: null }),
  ]),
  "4.1 two nulls do not span",
);
ok(
  spansMultipleEntities([
    line({ accountId: "a_cash", debitCents: 1, legalEntityId: "e1" }),
    line({ accountId: "a_rev", creditCents: 1, legalEntityId: "e2" }),
  ]),
  "4.2 two different entities span",
);
ok(
  spansMultipleEntities([
    line({ accountId: "a_cash", debitCents: 1, legalEntityId: "e1" }),
    line({ accountId: "a_rev", creditCents: 1, legalEntityId: null }),
  ]),
  "4.3 an entity plus a null spans — a null is its own bucket, not a wildcard",
);

// THE CASE THAT MATTERS: entity 1 pays entity 2's rent.
//   e1 credits cash 500   (gave value → is owed → Due From, a DEBIT)
//   e2 debits rent  500   (received value → owes → Due To, a CREDIT)
const cross: DraftLine[] = [
  line({ accountId: "a_cash", creditCents: 50_000, legalEntityId: "e1" }),
  line({ accountId: "a_rent", debitCents: 50_000, legalEntityId: "e2" }),
];
eq(
  netByEntity(cross)
    .map((n) => [n.legalEntityId, n.netCents])
    .sort(),
  [
    ["e1", -50_000],
    ["e2", 50_000],
  ].sort(),
  "4.4 per-entity nets are computed correctly",
);

const derived = deriveIntercompanyLines(cross, {
  dueToAccountId: "a_dueto",
  dueFromAccountId: "a_duefrom",
  entityNames: { e1: "Club LLC", e2: "Foundation" },
});
ok(derived.length === 2, "4.5 two balancing lines are derived", JSON.stringify(derived));

const e1Line = derived.find((l) => l.legalEntityId === "e1")!;
const e2Line = derived.find((l) => l.legalEntityId === "e2")!;
ok(
  e1Line.accountId === "a_duefrom" && e1Line.debitCents === 50_000 && e1Line.creditCents === 0,
  "4.6 the entity that GAVE value gets a DEBIT to Due From (it is owed)",
  JSON.stringify(e1Line),
);
ok(
  e2Line.accountId === "a_dueto" && e2Line.creditCents === 50_000 && e2Line.debitCents === 0,
  "4.7 the entity that RECEIVED value gets a CREDIT to Due To (it owes)",
  JSON.stringify(e2Line),
);
ok(e1Line.memo?.includes("Foundation") === true, "4.8 the memo names the counterpart entity", e1Line.memo ?? "");
ok(e2Line.memo?.includes("Club LLC") === true, "4.9 and the other way round", e2Line.memo ?? "");

const full = [...cross, ...derived];
ok(entryTotals(full).balanced, "4.10 the entry is still balanced after the derived lines");
ok(
  netByEntity(full).every((n) => n.netCents === 0),
  "4.11 EVERY entity now balances on its own — the whole point of the derived lines",
  JSON.stringify(netByEntity(full)),
);

eq(
  deriveIntercompanyLines(
    [line({ accountId: "a_cash", debitCents: 100, legalEntityId: "e1" }), line({ accountId: "a_rev", creditCents: 100, legalEntityId: "e1" })],
    { dueToAccountId: "a_dueto", dueFromAccountId: "a_duefrom" },
  ),
  [],
  "4.12 a single-entity entry derives nothing",
);
// Each entity already self-balances, so no Due To/From is needed even though
// the entry touches two of them.
eq(
  deriveIntercompanyLines(
    [
      line({ accountId: "a_cash", debitCents: 100, legalEntityId: "e1" }),
      line({ accountId: "a_rev", creditCents: 100, legalEntityId: "e1" }),
      line({ accountId: "a_cash", debitCents: 200, legalEntityId: "e2" }),
      line({ accountId: "a_rev", creditCents: 200, legalEntityId: "e2" }),
    ],
    { dueToAccountId: "a_dueto", dueFromAccountId: "a_duefrom" },
  ),
  [],
  "4.13 two entities that each already balance derive nothing",
);

// Three entities, to prove the rule generalizes past the two-entity case.
const three: DraftLine[] = [
  line({ accountId: "a_cash", creditCents: 90_000, legalEntityId: "e1" }),
  line({ accountId: "a_rent", debitCents: 30_000, legalEntityId: "e2" }),
  line({ accountId: "a_rent", debitCents: 60_000, legalEntityId: "e3" }),
];
const d3 = deriveIntercompanyLines(three, { dueToAccountId: "a_dueto", dueFromAccountId: "a_duefrom" });
ok(d3.length === 3, "4.14 three entities derive three lines");
ok(entryTotals([...three, ...d3]).balanced, "4.15 and the entry still balances");
ok(
  netByEntity([...three, ...d3]).every((n) => n.netCents === 0),
  "4.16 and all three entities balance on their own",
);
ok(
  d3.filter((l) => l.debitCents > 0).length === 1 && d3.filter((l) => l.creditCents > 0).length === 2,
  "4.17 one payer is owed by two — one Due From, two Due To",
);

// Determinism: the same draft must always produce the same lines in the same
// order, or the journal reads differently on every save.
eq(
  deriveIntercompanyLines(cross, { dueToAccountId: "a_dueto", dueFromAccountId: "a_duefrom" }),
  deriveIntercompanyLines(cross, { dueToAccountId: "a_dueto", dueFromAccountId: "a_duefrom" }),
  "4.18 derivation is deterministic",
);

// ── 5. Money parsing and formatting ─────────────────────────────────────────
console.log("\n[5] money");

eq(parseDollarsToCents("10"), 1000, "5.0 '10' is 1000 cents");
eq(parseDollarsToCents("10.50"), 1050, "5.1 '10.50' is 1050");
eq(parseDollarsToCents("0.01"), 1, "5.2 a penny");
eq(parseDollarsToCents("$1,234.56"), 123456, "5.3 a typed dollar sign and comma are tolerated");
eq(parseDollarsToCents("10.005"), 1001, "5.4 half a cent rounds up, deterministically");
eq(parseDollarsToCents(""), null, "5.5 empty is null, not zero — 'blank' and 'zero' are different answers");
eq(parseDollarsToCents(null), null, "5.6 null is null");
eq(parseDollarsToCents("abc"), null, "5.7 nonsense is null");
eq(parseDollarsToCents("1.2.3"), null, "5.8 malformed is null");
eq(parseDollarsToCents(".5"), 50, "5.9 a leading dot works");
// The classic float trap: 0.1 + 0.2 in cents must be exact.
eq(parseDollarsToCents("0.1")! + parseDollarsToCents("0.2")!, 30, "5.10 integer cents add exactly (no float drift)");

eq(formatCents(0), "$0.00", "5.11 zero");
eq(formatCents(1), "$0.01", "5.12 a penny");
eq(formatCents(123456), "$1,234.56", "5.13 thousands separator");
eq(formatCents(-5000), "-$50.00", "5.14 negative");

ok(increasesWithDebit("ASSET"), "5.15 assets increase with a debit");
ok(increasesWithDebit("EXPENSE"), "5.16 expenses increase with a debit");
ok(!increasesWithDebit("INCOME"), "5.17 income increases with a credit");
ok(!increasesWithDebit("LIABILITY"), "5.18 liabilities increase with a credit");
ok(!increasesWithDebit("ASSET", true), "5.19 a CONTRA asset flips — accumulated depreciation increases with a credit");
ok(increasesWithDebit("INCOME", true), "5.20 a CONTRA income account flips — refunds increase with a debit");

// ── 6. The chart template ───────────────────────────────────────────────────
console.log("\n[6] the chart of accounts template");

const numbers = CHART_TEMPLATE.map((r) => r.number);
ok(new Set(numbers).size === numbers.length, "6.0 every account number is unique");
ok(
  CHART_TEMPLATE.every((r) => ACCOUNT_TYPES.includes(r.type)),
  "6.1 every account is one of the five accounting classes",
);
ok(
  CHART_TEMPLATE.every((r) => r.normalBalance === "DEBIT" || r.normalBalance === "CREDIT"),
  "6.2 every account has a normal balance",
);

const sysRows = templateSystemRows();
for (const key of SYSTEM_ACCOUNT_KEYS) {
  ok(!!sysRows[key], `6.3.${key} the template carries a ${key} account`);
}
ok(
  CHART_TEMPLATE.filter((r) => r.isSystem).every((r) => !!r.systemKey),
  "6.4 every system account has a systemKey — the posting engine resolves by key, never by number",
);
ok(
  CHART_TEMPLATE.filter((r) => r.systemKey).every((r) => r.isSystem),
  "6.5 and every account with a systemKey is marked isSystem",
);
const sysKeys = CHART_TEMPLATE.filter((r) => r.systemKey).map((r) => r.systemKey);
ok(new Set(sysKeys).size === sysKeys.length, "6.6 no systemKey is used twice");

// The accounts the intercompany rule needs, by key not by number.
eq(sysRows.DUE_TO.type, "LIABILITY", "6.7 Due To is a liability (what this entity owes)");
eq(sysRows.DUE_FROM.type, "ASSET", "6.8 Due From is an asset (what it is owed)");
eq(sysRows.STRIPE_CLEARING.type, "ASSET", "6.9 Stripe Clearing is an asset");

// Contra accounts must carry the OPPOSITE normal balance of their class, or
// every report that reads normalBalance gets the sign wrong.
for (const r of CHART_TEMPLATE.filter((x) => x.isContra)) {
  const base = r.type === "ASSET" || r.type === "EXPENSE" ? "DEBIT" : "CREDIT";
  ok(r.normalBalance !== base, `6.10.${r.number} contra account ${r.number} carries the opposite normal balance`);
}
ok(CHART_TEMPLATE.some((r) => r.number === "1590" && r.isContra), "6.11 1590 Accumulated Depreciation is contra");
ok(CHART_TEMPLATE.some((r) => r.number === "4900" && r.isContra), "6.12 4900 Refunds & Discounts is contra");

// Cost of sales: EXPENSE type with the subtype, so the P&L can show gross
// profit without a sixth account type.
const cos = CHART_TEMPLATE.filter((r) => r.subtype === COST_OF_SALES);
ok(cos.length === 2, "6.13 two cost-of-sales accounts");
ok(cos.every((r) => r.type === "EXPENSE"), "6.14 cost of sales is typed EXPENSE");
ok(
  cos.map((r) => r.number).sort().join(",") === "5000,5100",
  "6.15 they are 5000 and 5100",
);

// The accounts the brief names explicitly, present and correctly typed.
for (const [num, type] of [
  ["1000", "ASSET"], ["1050", "ASSET"], ["1100", "ASSET"], ["1400", "ASSET"],
  ["2000", "LIABILITY"], ["2200", "LIABILITY"], ["2500", "LIABILITY"],
  ["3900", "EQUITY"], ["3950", "EQUITY"],
  ["4000", "INCOME"], ["4800", "INCOME"], ["4900", "INCOME"],
  ["6400", "EXPENSE"], ["7000", "EXPENSE"],
] as const) {
  const row = CHART_TEMPLATE.find((r) => r.number === num);
  ok(row?.type === type, `6.16.${num} ${num} exists and is ${type}`, row ? `got ${row.type}` : "missing");
}

// sortOrder must be unique within a type, or the display order is arbitrary.
const order = templateSortOrder();
ok(order.size === CHART_TEMPLATE.length, "6.17 every template row gets a sortOrder");
for (const t of ACCOUNT_TYPES) {
  const vals = CHART_TEMPLATE.filter((r) => r.type === t).map((r) => order.get(r.number)!);
  ok(new Set(vals).size === vals.length, `6.18.${t} sortOrder is unique within ${t}`);
}

// ── 7. Category mapping ─────────────────────────────────────────────────────
console.log("\n[7] category mapping");

const templateNumbers = new Set(numbers);

// EVERY category in lib/financials must map, and must map to a real template
// account. This is the test that catches somebody adding a revenue category
// without telling the ledger where its money goes.
for (const c of REVENUE_CATEGORIES) {
  const acct = REVENUE_CATEGORY_TO_ACCOUNT[c.key];
  ok(!!acct, `7.0.${c.key} revenue category "${c.key}" has a mapping`);
  ok(templateNumbers.has(acct), `7.1.${c.key} it maps to a real account (${acct})`);
  const row = CHART_TEMPLATE.find((r) => r.number === acct);
  ok(row?.type === "INCOME", `7.2.${c.key} and that account is INCOME`, row ? `got ${row.type}` : "missing");
}
for (const c of EXPENSE_CATEGORIES) {
  const acct = EXPENSE_CATEGORY_TO_ACCOUNT[c.key];
  ok(!!acct, `7.3.${c.key} expense category "${c.key}" has a mapping`);
  ok(templateNumbers.has(acct), `7.4.${c.key} it maps to a real account (${acct})`);
  const row = CHART_TEMPLATE.find((r) => r.number === acct);
  ok(row?.type === "EXPENSE", `7.5.${c.key} and that account is EXPENSE`, row ? `got ${row.type}` : "missing");
}
for (const m of PAYMENT_METHODS) {
  ok(m.key in PAYMENT_METHOD_TO_ACCOUNT, `7.6.${m.key} payment method "${m.key}" has a mapping`);
  const acct = PAYMENT_METHOD_TO_ACCOUNT[m.key];
  if (acct !== null) {
    ok(templateNumbers.has(acct), `7.7.${m.key} it maps to a real account (${acct})`);
    const row = CHART_TEMPLATE.find((r) => r.number === acct);
    ok(row?.type === "ASSET", `7.8.${m.key} and that account is an ASSET (where money lands)`, row ? `got ${row.type}` : "?");
  }
}

// COMP is deliberately null — comped attendance is not revenue and must never
// manufacture a journal entry. `undefined` (unknown method) is a DIFFERENT
// answer and must not collapse into it.
eq(PAYMENT_METHOD_TO_ACCOUNT.COMP, null, "7.9 COMP maps to NO account — a comp is not revenue");
eq(accountForPaymentMethod("COMP"), null, "7.10 and the helper returns null for it");
eq(accountForPaymentMethod("WIRE_TRANSFER"), "1000", "7.11 an UNKNOWN method falls back to checking, not to null");
eq(accountForPaymentMethod(null), "1000", "7.12 a missing method falls back too");
eq(accountForPaymentMethod("STRIPE"), "1050", "7.13 Stripe money lands in Stripe Clearing, not the bank");
eq(accountForPaymentMethod("INVOICE"), "1100", "7.14 an unpaid invoice is a receivable");

// An unmapped dollar must never silently post nowhere.
eq(accountForRevenueCategory("made_up"), "4950", "7.15 an unknown revenue category falls back to Other Income");
eq(accountForRevenueCategory(null), "4950", "7.16 so does an uncategorized one");
eq(accountForExpenseCategory("made_up"), "6900", "7.17 an unknown expense category falls back to Miscellaneous");
eq(accountForExpenseCategory(null), "6900", "7.18 so does an uncategorized one");

// The mappings recorded in plan.md as flagged-for-review. If one changes, this
// test fails and the plan has to be updated in the same commit — which is the
// point.
eq(REVENUE_CATEGORY_TO_ACCOUNT.classes, "4000", "7.19 classes → 4000 (flagged in plan.md for Julian's review)");
eq(REVENUE_CATEGORY_TO_ACCOUNT.cash_payment, "4950", "7.20 cash_payment → 4950 (flagged — it is a method, not a product)");
eq(REVENUE_CATEGORY_TO_ACCOUNT.manual_invoice, "4950", "7.21 manual_invoice → 4950 (flagged)");
eq(EXPENSE_CATEGORY_TO_ACCOUNT.FEES, "6400", "7.22 FEES → 6400 Processing, not 6450 Bank (flagged)");
eq(EXPENSE_CATEGORY_TO_ACCOUNT.EVENTS, "5100", "7.23 event costs are cost of sales, not an operating expense");

// ── 8. Tier gating ──────────────────────────────────────────────────────────
console.log("\n[8] tier gating — Pro and Enterprise only");

// The decision in the brief was "Pro and Enterprise only", and the tiers were
// VERIFIED to exist rather than guessed. These assertions are what keep that
// true if the tier table is ever edited.
ok(!canUseFeature("starter", "fullFinancials"), "8.0 STARTER does NOT get the ledger");
ok(canUseFeature("pro", "fullFinancials"), "8.1 PRO does");
ok(canUseFeature("enterprise", "fullFinancials"), "8.2 ENTERPRISE does");
ok(!canUseFeature("growth", "fullFinancials"), "8.3 the legacy 'growth' value normalizes to starter → no ledger");
ok(!canUseFeature(null, "fullFinancials"), "8.4 an unset tier gets no ledger (fail closed)");
ok(!canUseFeature("", "fullFinancials"), "8.5 an empty tier gets no ledger");
ok(!canUseFeature("PRO", "fullFinancials"), "8.6 tier matching is case-sensitive and unknown casing fails closed");
ok("fullFinancials" in TIER_FEATURES.starter, "8.7 fullFinancials is a real tier flag, not invented here");

// ── 9. Source guarantees (grep) ─────────────────────────────────────────────
// These are properties of the SOURCE, not of a function, so this is the only
// place the build can check them.
console.log("\n[9] source guarantees");

const serverSrc = readFileSync(join(ROOT, "lib/ledgerServer.ts"), "utf8");
const pureSrc = readFileSync(join(ROOT, "lib/ledger.ts"), "utf8");

// 9.0 The pure module must stay pure, or these tests stop being able to run
// without a database — and the build runs them with DATABASE_URL pointed at a
// dead address.
ok(!/from ["']@\/lib\/prisma["']/.test(pureSrc), "9.0 lib/ledger.ts does not import prisma");
ok(!/from ["']@prisma\/client["']/.test(pureSrc), "9.1 lib/ledger.ts does not import the Prisma client");
ok(!/from ["']next/.test(pureSrc), "9.2 lib/ledger.ts does not import next");

// 9.3 Every exported function in the server module takes clubId first. This is
// what makes tenant scoping structural rather than remembered.
const exportedFns = [...serverSrc.matchAll(/export async function (\w+)\(([^)]*)/g)];
ok(exportedFns.length >= 10, `9.3 found the exported service functions (${exportedFns.length})`);
for (const [, name, args] of exportedFns) {
  ok(/^\s*clubId\s*:/.test(args), `9.4.${name} ${name}() takes clubId as its FIRST argument`, args.slice(0, 60));
}

// 9.5 Every gl_* query in the service is club-scoped. Counted structurally:
// each `prisma.glX.method({...})` / `tx.glX.method({...})` call must have a
// clubId in its argument object. `create` is checked by the `data:` containing
// clubId, which the same regex catches.
// Extract each call's ACTUAL argument text by matching parentheses, rather
// than taking a character window — a window picks up the clubId of the NEXT
// call and reports a genuinely unscoped query as fine. (Verified with a
// negative control: injecting an unscoped count() must make this fail.)
function argsOf(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return "";
}

const glCalls = [...serverSrc.matchAll(/\b(?:prisma|tx)\.(gl[A-Z]\w*)\.(\w+)\(/g)];
ok(glCalls.length > 20, `9.5 the service makes gl_* queries (${glCalls.length})`);
let unscoped = 0;
for (const m of glCalls) {
  const args = argsOf(serverSrc, m.index! + m[0].length - 1);
  // Prisma lets a caller pass `where,` as shorthand for a `where` object built
  // just above (accountBalances does, because the filter is conditional). Then
  // the clubId lives in that const, so check the nearest preceding `const
  // where` declaration. Everything else must carry clubId in its own
  // arguments. There is no exemption list.
  let scoped = /clubId/.test(args);
  if (!scoped && /\bwhere\b\s*[,}]/.test(args)) {
    // Check ONLY the `const where = {...}` declaration statement — not the
    // whole function body, which would pick up an unrelated clubId and let a
    // genuinely unscoped query through.
    const before = serverSrc.slice(0, m.index!);
    const declIdx = before.lastIndexOf("const where");
    if (declIdx >= 0) {
      const semi = serverSrc.indexOf(";", declIdx);
      scoped = semi > declIdx && /clubId/.test(serverSrc.slice(declIdx, semi));
    }
  }
  if (!scoped) {
    unscoped++;
    fails.push(`9.6 ${m[1]}.${m[2]}() is not club-scoped — tenant scope must be explicit in every query`);
  }
}
ok(unscoped === 0, `9.6 every gl_* query carries clubId (${glCalls.length} checked)`);

// 9.7 No route may touch a gl_* table directly. The single write path is the
// whole reason the balance rule cannot be bypassed.
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const appFiles = walk(join(ROOT, "app"));
const offenders: string[] = [];
for (const f of appFiles) {
  const src = readFileSync(f, "utf8");
  // The attachment route legitimately reads gl_journal_entries to confirm the
  // entry is the club's BEFORE storing bytes, and uploadedFile is not a gl_
  // table. That read is allowed; a WRITE is not.
  for (const m of src.matchAll(/\bprisma\.(gl[A-Z]\w*)\.(\w+)\(/g)) {
    const [, model, method] = m;
    const isRead = method.startsWith("find") || method.startsWith("count") || method.startsWith("aggregate") || method.startsWith("groupBy");
    if (!isRead) offenders.push(`${f.replace(ROOT + "/", "")}: prisma.${model}.${method}()`);
  }
}
ok(
  offenders.length === 0,
  "9.7 no route WRITES a gl_* table directly — every write goes through lib/ledgerServer.ts",
  offenders.join(", "),
);

// 9.8 Every ledger route is gated. A new route that forgets is the failure
// this catches.
const ledgerRoutes = walk(join(ROOT, "app/api/financials/ledger")).filter((f) => f.endsWith("route.ts"));
ok(ledgerRoutes.length >= 7, `9.8 found the ledger routes (${ledgerRoutes.length})`);
for (const f of ledgerRoutes) {
  const src = readFileSync(f, "utf8");
  const rel = f.replace(ROOT + "/", "");
  // The permission check must be VISIBLE in the route, not hidden behind a
  // wrapper. A wrapper defeats scripts/permission-boundary-guard.ts, which
  // reads the source tree and is the ratchet stopping a new ungated mutating
  // route from shipping — middleware.ts does not match /api, so the guard
  // written in a route is that route's entire boundary.
  ok(
    /requirePermissionLive\(session, "finances"/.test(src) || /requireOwnerLive\(session\)/.test(src),
    `9.9.${rel} has a visible permission check (requirePermissionLive or requireOwnerLive)`,
  );
  // And the tier gate, server-side, on every route.
  ok(
    /requireTierFeature\(session\.user\.clubId, "fullFinancials"\)/.test(src),
    `9.10.${rel} checks the fullFinancials tier server-side`,
  );
  // The explicit null check before the guard. Without it the build fails with
  // "'session' is possibly null" (CLAUDE.md gotcha #1), so this also keeps the
  // build honest.
  ok(/if \(!session\) return/.test(src), `9.10b.${rel} narrows session with an explicit null check first`);
}

// 9.11 The lock-date route must be OWNER-gated — the one access rule in the
// brief stricter than a permission level, because the lock date is what stops
// everyone else editing closed history.
const lockRoute = readFileSync(join(ROOT, "app/api/financials/ledger/lock-dates/route.ts"), "utf8");
ok(/requireOwnerLive\(session\)/.test(lockRoute), "9.11 the lock-date route uses requireOwnerLive");
// Its GET is only a read, so it stays on finances:view — reading a lock date
// is not an owner-only act; changing one is.
ok(/requirePermissionLive\(session, "finances", "view"\)/.test(lockRoute), "9.11b reading lock dates stays finances:view");

// 9.12 The entries route must not accept sourceType from the client — that
// column participates in the post-once unique index.
const entriesRoute = readFileSync(join(ROOT, "app/api/financials/ledger/entries/route.ts"), "utf8");
ok(
  /sourceType:\s*"MANUAL"/.test(entriesRoute),
  "9.12 the entries route hardcodes sourceType MANUAL",
);
ok(
  !/sourceType:\s*z\./.test(entriesRoute),
  "9.13 and never takes sourceType from the request body",
);

// 9.14 The migration must enable RLS on all six tables and grant the app role.
const migration = readFileSync(
  join(ROOT, "prisma/migrations/20261020000000_gl_ledger_core/migration.sql"),
  "utf8",
);
const GL_TABLES = ["gl_accounts", "gl_journal_entries", "gl_journal_lines", "gl_entry_attachments", "gl_lock_dates", "gl_audit_logs"];
for (const t of GL_TABLES) {
  ok(migration.includes(`CREATE TABLE IF NOT EXISTS "${t}"`), `9.14.${t} ${t} is created`);
  ok(
    new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`).test(migration),
    `9.15.${t} RLS is enabled on ${t}`,
  );
  ok(
    new RegExp(`CREATE POLICY tenant_isolation ON "${t}"[\\s\\S]{0,200}?WITH CHECK`).test(migration),
    `9.16.${t} ${t} has a tenant_isolation policy with WITH CHECK (so a row can't be re-homed)`,
  );
}
ok(/GRANT SELECT, INSERT, UPDATE, DELETE ON[\s\S]{0,300}TO athletix_app/.test(migration), "9.17 the app role is granted CRUD");

// 9.17b A clubId-only policy is NOT enough on a table with a foreign key to
// another tenant table: the clubId check passes and Postgres FK checks bypass
// RLS, so club A really could hang a journal line off club B's entry. The
// two-club harness caught exactly that (T9.20) on the first cut of this
// migration. These assertions keep the fix from being simplified away.
const linePolicy = migration.slice(
  migration.indexOf('CREATE POLICY tenant_isolation ON "gl_journal_lines"'),
  migration.indexOf('-- gl_entry_attachments'),
);
ok(/EXISTS \(SELECT 1 FROM "gl_journal_entries" je[\s\S]*?je\."clubId" = app\.current_club_id\(\)\)/.test(linePolicy),
  "9.17b gl_journal_lines verifies its ENTRY is in the same club");
ok(/EXISTS \(SELECT 1 FROM "gl_accounts" a[\s\S]*?a\."clubId" = app\.current_club_id\(\)\)/.test(linePolicy),
  "9.17c gl_journal_lines verifies its ACCOUNT is in the same club");
ok(/"legalEntityId" IS NULL[\s\S]*?EXISTS \(SELECT 1 FROM "legal_entities"/.test(linePolicy),
  "9.17d gl_journal_lines verifies its ENTITY is in the same club (NULL allowed)");

const attPolicy = migration.slice(
  migration.indexOf('CREATE POLICY tenant_isolation ON "gl_entry_attachments"'),
  migration.indexOf('-- gl_lock_dates'),
);
ok(/EXISTS \(SELECT 1 FROM "gl_journal_entries" je[\s\S]*?app\.current_club_id\(\)\)/.test(attPolicy),
  "9.17e gl_entry_attachments verifies its entry is in the same club");

const lockPolicy = migration.slice(
  migration.indexOf('CREATE POLICY tenant_isolation ON "gl_lock_dates"'),
  migration.indexOf('-- gl_audit_logs'),
);
ok(/EXISTS \(SELECT 1 FROM "legal_entities" e[\s\S]*?app\.current_club_id\(\)\)/.test(lockPolicy),
  "9.17f gl_lock_dates verifies its entity is in the same club");

// A self-referencing FK cannot use a plain EXISTS — the subquery re-enters the
// policy and Postgres raises "infinite recursion detected in policy". The
// remedy is one narrow SECURITY DEFINER lookup, which must stay narrow.
ok(/CREATE OR REPLACE FUNCTION app\.gl_account_club_id\(account_id text\)/.test(migration),
  "9.17g the parentId check uses a SECURITY DEFINER helper (a plain EXISTS recurses)");
ok(/SECURITY DEFINER/.test(migration), "9.17h the helper is SECURITY DEFINER");
ok(/SET search_path = pg_catalog, public/.test(migration),
  "9.17i and pins search_path, so its body can't be redirected at another table");
ok(/REVOKE ALL ON FUNCTION app\.gl_account_club_id\(text\) FROM PUBLIC/.test(migration),
  "9.17j and is not executable by PUBLIC");
ok(
  /app\.gl_account_club_id\("parentId"\) = app\.current_club_id\(\)/.test(migration),
  "9.17k the gl_accounts policy uses it for parentId",
);
// It must stay a single-column lookup. A SECURITY DEFINER function that
// returned rows would be a real escalation path.
const fnBody = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION app.gl_account_club_id"), migration.indexOf("COMMENT ON FUNCTION app.gl_account_club_id"));
ok(/SELECT "clubId" FROM "gl_accounts" WHERE "id" = account_id/.test(fnBody),
  "9.17l and it returns only one account's clubId — nothing else");
ok(!/SELECT \*/.test(fnBody), "9.17m the definer function never selects *");
ok(/athletix_app/.test(migration), "9.18 the migration names the RLS-enforced role");
// The brief forbids anything but additive changes.
ok(!/\bDROP TABLE\b/i.test(migration), "9.19 the migration drops no table");
ok(!/\bDROP COLUMN\b/i.test(migration), "9.20 it drops no column");
ok(!/ALTER COLUMN[\s\S]{0,40}TYPE/i.test(migration), "9.21 it changes no column type");
ok(!/\bRENAME\b/i.test(migration), "9.22 it renames nothing");
// Money must be integer cents in the DDL, not numeric.
ok(/"debitCents"\s+INTEGER/.test(migration), "9.23 debitCents is an INTEGER column");
ok(/"creditCents"\s+INTEGER/.test(migration), "9.24 creditCents is an INTEGER column");
ok(
  /\(\s*"debitCents" = 0\s*\)\s*<>\s*\(\s*"creditCents" = 0\s*\)/.test(migration),
  "9.25 a CHECK constraint enforces exactly-one-side at the database level",
);
// The post-once index that Phase 2 depends on.
ok(
  /CREATE UNIQUE INDEX IF NOT EXISTS "gl_journal_entries_clubId_sourceType_sourceId_key"/.test(migration),
  "9.26 the (clubId, sourceType, sourceId) unique index exists — Phase 2's post-once guarantee",
);
// Accounts with postings must be undeletable at the database level too.
ok(
  /"gl_journal_lines_accountId_fkey"[\s\S]{0,200}ON DELETE RESTRICT/.test(migration),
  "9.27 gl_journal_lines.accountId is ON DELETE RESTRICT — an account with postings cannot be deleted",
);

// 9.28 The migration folder must sort after the newest applied one, or
// `migrate deploy` warns about out-of-order migrations (CLAUDE.md).
const migrationDirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d)).sort();
const mine = "20261020000000_gl_ledger_core";
ok(migrationDirs.includes(mine), "9.28 the migration folder is on disk");
ok(migrationDirs[migrationDirs.length - 1] === mine, "9.29 and it sorts LAST of all migrations", `last is ${migrationDirs[migrationDirs.length - 1]}`);

// 9.30 The seed script must refuse --apply without an allowlist. A script that
// can rewrite every club by accident is the thing CLAUDE.md is most emphatic
// about.
const seedSrc = readFileSync(join(ROOT, "scripts/seed-chart-of-accounts.ts"), "utf8");
ok(/APPLY && allow\.size === 0/.test(seedSrc), "9.30 the seed script refuses --apply without --clubs");
ok(/process\.exit\(1\)/.test(seedSrc), "9.31 and exits non-zero when it does");
ok(/canUseFeature\(/.test(seedSrc), "9.32 the seed script checks tier eligibility with the shared helper");
ok(/skipDuplicates:\s*true/.test(seedSrc), "9.33 the seed is idempotent (skipDuplicates)");

// 9.34 Task 10: the four Action Item links must point at a tab that exists.
// The ?tab= machinery shipped 2026-09-14; this is the regression check that it
// stays wired, now that two more tabs depend on it.
const pageSrc = readFileSync(join(ROOT, "app/dashboard/financials/page.tsx"), "utf8");
const tabKeys = [...pageSrc.matchAll(/\{\s*key:\s*"(\w+)",\s*label:/g)].map((m) => m[1]);
ok(tabKeys.length >= 12, `9.34 the financials page declares its tabs (${tabKeys.length})`);
ok(tabKeys.includes("accounts"), "9.35 the Chart of Accounts tab is registered");
ok(tabKeys.includes("journal"), "9.36 the Journal tab is registered");
ok(/PRO_TABS = new Set\(\[[^\]]*"accounts"/.test(pageSrc), "9.37 Chart of Accounts is in PRO_TABS");
ok(/PRO_TABS = new Set\(\[[^\]]*"journal"/.test(pageSrc), "9.38 Journal is in PRO_TABS");
ok(/parseTab\(search\.get\("tab"\)\)/.test(pageSrc), "9.39 the page still reads ?tab= from the URL");

const actionItems = readFileSync(join(ROOT, "lib/reportsActionItems.ts"), "utf8");
for (const [kind, expected] of [
  ["UNRECONCILED_DEPOSIT", "tab=stripe"],
  ["OFFLINE_PAYMENT_PENDING", "tab=offline"],
  ["UNCATEGORIZED_LARGE_BANK", "tab=bank"],
] as const) {
  const idx = actionItems.indexOf(`kind: "${kind}"`);
  ok(idx > 0, `9.40.${kind} ${kind} is emitted`);
  // The href sits within the same object literal as the kind.
  // Generous forward window: each item carries a comment explaining its link
  // before the href line, so the href can be ~600 chars past `kind:`.
  const window = actionItems.slice(Math.max(0, idx - 200), idx + 1500);
  ok(window.includes(expected), `9.41.${kind} it deep-links to ${expected}`);
  const tab = expected.split("=")[1];
  ok(tabKeys.includes(tab), `9.42.${kind} and "${tab}" is a real tab`);
}
// UPCOMING_RENEWAL_LARGE deliberately points at the MEMBERS queue, not
// financials — a large upcoming renewal is a members-queue concern. That was
// the 2026-09-14 fix and it must not be "corrected" back.
const renewalIdx = actionItems.indexOf('kind: "UPCOMING_RENEWAL_LARGE"');
ok(renewalIdx > 0, "9.43 UPCOMING_RENEWAL_LARGE is emitted");
ok(
  actionItems.slice(Math.max(0, renewalIdx - 200), renewalIdx + 1500).includes("/dashboard/members?queue=renewingSoon"),
  "9.44 and it links to the members renewingSoon queue, NOT financials",
);

// ── Done ────────────────────────────────────────────────────────────────────
console.log(`\n${fails.length ? "✗" : "✓"} ledger: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
