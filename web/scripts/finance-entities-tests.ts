/**
 * Financials: bank accounts per entity, the QuickBooks import, the receipt
 * inbox — and event audiences (pure rules). Exercised, not inspected.
 *
 *   npx tsx scripts/finance-entities-tests.ts
 *
 * Real library code + route handlers on scripts/fake-prisma.ts, fake storage.
 * What it pins:
 *   1. an account belongs to one entity; an entity can have several; moving an
 *      account moves its bank rows; the Tax Summary never mixes entities
 *   2. a QuickBooks row already in the bank feed is MATCHED, never added; its
 *      category is used only when the owner never categorised that row; rows
 *      before the feed are added as history; an unmatched row inside the feed
 *      is never added; a second import of the same file adds nothing; undo
 *      puts everything back
 *   3. receipts are suggested, never attached by themselves; only Financials
 *      can open a receipt file
 *   4. finances:view can look, only finances:full changes anything, never
 *      another club's data
 *   5. event audience: memberships / ages / gender / tags, every rule must match
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { parseCsv, parseMoney, parseQbDate, parseQbTable, planImport, suggestAccountMap, directionOfType } from "../lib/ledgerImport";
import { receiptHintsFromFileName, scoreMatch, suggestMatches } from "../lib/receipts";
import { ageOn, athleteMatches, describeAudience, normalizeAudience, audienceProblem } from "../lib/eventAudience";

const RealDate = Date;
const NOW = RealDate.parse("2026-10-14T16:00:00.000Z");
class PinnedDate extends RealDate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...a: any[]) { if (a.length === 0) super(NOW); else super(...(a as [any])); } // eslint-disable-line @typescript-eslint/no-explicit-any
  static now() { return NOW; }
}
(globalThis as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;

const fake = makeFakeDb({
  relations: {
    bankAccount: { connection: { model: "plaidConnection", kind: "one", fk: "plaidConnectionId" } },
    plaidTransaction: { connection: { model: "plaidConnection", kind: "one", fk: "plaidConnectionId" } },
  },
  uniques: {
    bankAccount: [["plaidConnectionId", "accountId"]],
    plaidTransaction: [["plaidTransactionId"]],
    plaidConnection: [["itemId"]],
  },
});
type Sess = { user: { id: string; role: string; clubId: string; name: string; email: string; permissions: Record<string, unknown> | null } } | null;
let CURRENT: Sess = null;
const STORE = new Map<string, Buffer>();
installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => CURRENT, default: {} },
  "@/lib/auth": { authOptions: {} },
  "@/lib/storage": {
    putObject: async (k: string, b: Buffer) => { STORE.set(k, b); },
    getObject: async (k: string) => STORE.get(k) ?? null,
    isRemoteStorage: () => false,
  },
});
/* eslint-disable @typescript-eslint/no-var-requires */
const guardLib = require("../lib/apiGuard.ts") as typeof import("../lib/apiGuard");
const { computeBankBasedTaxSummary } = require("../lib/taxSummary.ts") as typeof import("../lib/taxSummary");
/* eslint-enable @typescript-eslint/no-var-requires */

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq(label: string, got: unknown, want: unknown) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const section = (t: string) => console.log(`\n${t}`);
const d = (s: string) => new RealDate(`${s}T00:00:00.000Z`);

// ── World ───────────────────────────────────────────────────────────────────
const CLUB = "club_1";
const FIN_FULL = { finances: "full" }, FIN_VIEW = { finances: "view" }, COACH = { finances: "none", schedule: "view" };
const user = (id: string, role: string, perms: Record<string, unknown> | null, clubId = CLUB) => ({
  id, clubId, role, deletedAt: null, firstName: id, lastName: "T", email: `${id}@x.test`, staffProfile: perms ? { title: "Staff", permissions: perms } : null,
});
fake.seed("club", [{ id: CLUB, name: "Frog", timezone: "America/New_York", tier: "pro" }, { id: "club_2", name: "Other", timezone: "America/New_York", tier: "pro" }]);
fake.seed("user", [user("owner", "OWNER", null), user("fin", "STAFF", FIN_FULL), user("viewer", "STAFF", FIN_VIEW), user("coach", "STAFF", COACH), user("stranger", "STAFF", FIN_FULL, "club_2")]);
fake.seed("legalEntity", [
  { id: "llc", clubId: CLUB, name: "Frog Empire LLC", entityType: "LLC", createdAt: d("2026-01-01") },
  { id: "fdn", clubId: CLUB, name: "Frog Empire Foundation Inc", entityType: "NONPROFIT", createdAt: d("2026-01-02") },
  { id: "x_ent", clubId: "club_2", name: "Other LLC", entityType: "LLC", createdAt: d("2026-01-01") },
]);
fake.seed("plaidConnection", [
  { id: "c_llc", clubId: CLUB, label: "Frog Empire LLC Checking", institutionName: "Tompkins", accessToken: "t1", itemId: "i1", kind: "PLAID", deletedAt: null, createdAt: d("2026-04-01") },
  { id: "c_fdn", clubId: CLUB, label: "Frog Foundation Checking", institutionName: "Tompkins", accessToken: "t2", itemId: "i2", kind: "PLAID", deletedAt: null, createdAt: d("2026-04-02") },
]);
// The LLC login also holds a savings account — two accounts, one entity.
fake.seed("bankAccount", [
  { id: "ba_llc", clubId: CLUB, plaidConnectionId: "c_llc", accountId: "acc_llc_chk", name: "Checking", mask: "1111", legalEntityId: null, createdAt: d("2026-04-01") },
  { id: "ba_llc_sav", clubId: CLUB, plaidConnectionId: "c_llc", accountId: "acc_llc_sav", name: "Savings", mask: "2222", legalEntityId: null, createdAt: d("2026-04-01") },
  { id: "ba_fdn", clubId: CLUB, plaidConnectionId: "c_fdn", accountId: "acc_fdn", name: "Foundation Checking", mask: "3333", legalEntityId: null, createdAt: d("2026-04-02") },
]);
const bankRow = (id: string, conn: string, acct: string, date: string, amount: number, o: Record<string, unknown> = {}) => ({
  id, clubId: CLUB, plaidConnectionId: conn, plaidTransactionId: `p_${id}`, accountId: acct, amount, date: d(date), name: o.name ?? `Row ${id}`,
  merchantName: o.merchantName ?? null, pending: false, categoryOverride: null, reviewedAt: null, categorizedExpenseId: null,
  markedAsTransfer: false, excludedFromTax: false, legalEntityId: null, source: "PLAID", importId: null, createdAt: d(date), ...o,
});
fake.seed("plaidTransaction", [
  bankRow("r1", "c_llc", "acc_llc_chk", "2026-04-03", 1500, { name: "RENT PAYMENT", merchantName: "Catherwood Realty" }),
  bankRow("r2", "c_llc", "acc_llc_chk", "2026-04-10", 84.17, { name: "HOME DEPOT #123", merchantName: "Home Depot" }),
  bankRow("r3", "c_llc", "acc_llc_chk", "2026-04-12", 29.99, { name: "CANVA", merchantName: "Canva", categoryOverride: "SOFTWARE", reviewedAt: d("2026-04-13") }),
  bankRow("r4", "c_llc", "acc_llc_chk", "2026-05-01", -2000, { name: "STRIPE PAYOUT" }),
  bankRow("r5", "c_fdn", "acc_fdn", "2026-04-20", 300, { name: "AMAZON", merchantName: "Amazon", categoryOverride: "EQUIPMENT", reviewedAt: d("2026-04-21") }),
]);

function sess(id: string): Sess {
  const u = fake.table("user").find((x) => x.id === id)!;
  return { user: { id, clubId: u.clubId, name: u.firstName, email: u.email, role: u.role, permissions: u.staffProfile?.permissions ?? null } };
}
type Out = { status: number | null; body: any; text: string; threw?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(route: string, verb: string, as: string | null, opts: { params?: Record<string, string>; body?: unknown; query?: string; form?: FormData } = {}): Promise<Out> {
  CURRENT = as ? sess(as) : null;
  for (const u of fake.table("user")) guardLib.invalidatePermissionCache(u.id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(route) as Record<string, (r: Request, c?: unknown) => Promise<Response>>;
  const init: RequestInit = { method: verb };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers = { "Content-Type": "application/json" }; }
  const rl = console.log, re = console.error, rw = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    const res = await mod[verb](new Request(`http://localhost/api/x${opts.query ?? ""}`, init), { params: Promise.resolve(opts.params ?? {}) });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text };
  } catch (threw) {
    return { status: null, body: null, text: "", threw };
  } finally {
    console.log = rl; console.error = re; console.warn = rw;
  }
}
const why = (o: Out) => `got ${o.status ?? "a throw"} ${o.threw ? String((o.threw as Error)?.stack ?? o.threw).slice(0, 600) : o.text.slice(0, 300)}`;
const R = (p: string) => require.resolve(`../app/api/${p}/route.ts`);
const ACCTS = R("financials/bank-accounts"), ACCT = R("financials/bank-accounts/[id]");
const IMPORTS = R("financials/imports"), IMPORT = R("financials/imports/[id]"), COMMIT = R("financials/imports/[id]/commit"), UNDO = R("financials/imports/[id]/undo");
const RECEIPTS = R("financials/receipts"), RECEIPT = R("financials/receipts/[id]"), RECEIPT_FILE = R("financials/receipts/[id]/file"), FILES = R("files/[id]");
const rowsOf = (pred: (r: Record<string, unknown>) => boolean = () => true) => fake.table("plaidTransaction").filter(pred);

// A QuickBooks "Transaction List by Date" export, as QuickBooks writes it.
const QB_CSV = [
  "Frog Empire LLC",
  "Transaction List by Date",
  "January 1 - October 14, 2026",
  "",
  "Date,Transaction type,Num,Posting,Name,Memo/Description,Account,Split,Amount",
  '01/05/2026,Expense,,Yes,Catherwood Realty,January rent,Checking ••1111,Rent & Lease,"-1,500.00"',
  "02/11/2026,Expense,,Yes,Rogue Fitness,Mats,Checking ••1111,Supplies & Materials,-640.00",
  "03/02/2026,Deposit,,Yes,Stripe,Payout,Checking ••1111,Undeposited Funds,950.00",
  '04/03/2026,Expense,,Yes,Catherwood Realty,April rent,Checking ••1111,Rent & Lease,"-1,500.00"',
  "04/09/2026,Expense,,Yes,Home Depot,Hardware,Checking ••1111,Repairs & Maintenance,-84.17",
  "04/12/2026,Expense,,Yes,Canva,Design,Checking ••1111,Advertising & Marketing,-29.99",
  "04/15/2026,Expense,,Yes,Mystery Vendor,Not in the bank,Checking ••1111,Office Supplies,-12.00",
  "03/20/2026,Transfer,,Yes,,To savings,Checking ••1111,Savings ••2222,-200.00",
  "02/01/2026,Invoice,1001,Yes,Smith Family,Tuition,Accounts Receivable,Services,175.00",
  "TOTAL,,,,,,,,",
].join("\r\n");

async function main() {
  section("1. Pure: QuickBooks parsing");
  eq("money", [parseMoney("$1,234.56"), parseMoney("-12.00"), parseMoney("(40.00)"), parseMoney(""), parseMoney("abc")], [1234.56, -12, -40, null, null]);
  eq("dates", [parseQbDate("01/05/2026"), parseQbDate("1/5/26"), parseQbDate("2026-03-02"), parseQbDate("13/40/2026"), parseQbDate("Total")], ["2026-01-05", "2026-01-05", "2026-03-02", null, null]);
  eq("CSV with quoted commas and CRLF", parseCsv('a,"b,c",d\r\n"x ""q""",2,3'), [["a", "b,c", "d"], ['x "q"', "2", "3"]]);
  const parsed = parseQbTable(parseCsv(QB_CSV));
  eq("finds the header under the report title and reads every transaction line", parsed.rows.length, 9);
  eq("the totals line is ignored", parsed.rows.some((r) => /total/i.test(r.date)), false);
  check("the accounts used are listed", ["Checking ••1111", "Rent & Lease", "Savings ••2222", "Undeposited Funds"].every((a) => parsed.accounts.includes(a)), parsed.accounts.join(" | "));
  const banks = [{ id: "ba_llc", name: "Checking", mask: "1111" }, { id: "ba_llc_sav", name: "Savings", mask: "2222" }];
  eq("guesses: bank accounts by their last 4, categories by name", [
    suggestAccountMap("Checking ••1111", banks), suggestAccountMap("Savings ••2222", banks), suggestAccountMap("Rent & Lease", banks),
    suggestAccountMap("Undeposited Funds", banks), suggestAccountMap("Uncategorized Expense", banks), suggestAccountMap("Bank Charges & Fees", banks),
  ], [{ kind: "BANK", bankAccountId: "ba_llc" }, { kind: "BANK", bankAccountId: "ba_llc_sav" }, { kind: "CATEGORY", category: "RENT" },
    { kind: "CATEGORY", category: "stripe_payout" }, { kind: "CATEGORY", category: null }, { kind: "CATEGORY", category: "FEES" }]);
  eq("transaction types", ["Expense", "Deposit", "Transfer", "Check", "Bill Payment", "Journal Entry"].map(directionOfType), ["OUT", "IN", "TRANSFER", "OUT", "OUT", null]);

  {
    // An Excel export reads the same as the CSV.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    for (const line of parseCsv(QB_CSV)) ws.addRow(line.map((c) => (/^-?[\d,]+\.\d\d$/.test(c) ? Number(c.replace(/,/g, "")) : c)));
    ws.getCell("A6").value = new Date(Date.UTC(2026, 0, 5));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readTable } = require("../lib/ledgerImportServer.ts") as typeof import("../lib/ledgerImportServer");
    const fromXlsx = parseQbTable(await readTable("TransactionList.xlsx", buf));
    eq("an Excel export gives the same rows (dates and numbers as cells)", [fromXlsx.rows.length, fromXlsx.rows[0].date, fromXlsx.rows[0].amount], [9, "2026-01-05", -1500]);
  }

  section("1b. Pure: the plan");
  {
    const mapping = { accounts: { "Checking ••1111": { kind: "BANK" as const, bankAccountId: "A" }, "Rent & Lease": { kind: "CATEGORY" as const, category: "RENT" } }, types: {} };
    const row = (idx: number, date: string, amount: number, o = {}) => ({ idx, date, type: "Expense", num: "", name: "x", memo: "", account: "Checking ••1111", split: "Rent & Lease", amount, ...o });
    const existing = [
      { id: "e1", bankAccountId: "A", date: "2026-04-04", amount: 1500, categoryOverride: null, reviewed: false },
      { id: "e2", bankAccountId: "A", date: "2026-04-20", amount: 1500, categoryOverride: "OTHER", reviewed: true },
    ];
    const cov = [{ bankAccountId: "A", kind: "PLAID" as const, feedStarts: "2026-04-01" }];
    const p = planImport({ rows: [row(0, "2026-04-03", -1500), row(1, "2026-04-20", -1500), row(2, "2026-01-05", -1500), row(3, "2026-05-01", -1500)], mapping, existing, coverage: cov });
    eq("a row in the feed matches within 3 days and gets the category", [p.rows[0].action, p.rows[0].matchedRowId, p.rows[0].appliesCategory], ["MATCH", "e1", true]);
    eq("…a row the owner already categorised keeps the owner's choice", [p.rows[1].action, p.rows[1].appliesCategory], ["MATCH", false]);
    eq("before the feed began → added as history", [p.rows[2].action, p.rows[2].bankAmount, p.rows[2].category], ["CREATE", 1500, "RENT"]);
    eq("inside the feed with no match → NOT added (no double count)", [p.rows[3].action, /bank feed already covers/.test(p.rows[3].reason)], ["SKIP", true]);
    const again = planImport({ rows: [row(2, "2026-01-05", -1500)], mapping, existing: [], coverage: cov, alreadyImported: [{ bankAccountId: "A", date: "2026-01-05", amount: 1500 }] });
    eq("a row an earlier import already added is not added again", again.rows[0].action, "SKIP");
    const split = planImport({ rows: [row(0, "2026-01-05", 1500, { account: "Rent & Lease", split: "Checking ••1111" })], mapping, existing: [], coverage: cov });
    eq("bank in the Split column: the sign is read from the bank's side", [split.rows[0].action, split.rows[0].bankAmount], ["CREATE", 1500]);
  }

  section("1c. Pure: receipts");
  eq("file name hints", [
    receiptHintsFromFileName("Home Depot 2026-04-09 $84.17.pdf"),
    receiptHintsFromFileName("receipt_04-12-2026_29.99.jpg"),
    receiptHintsFromFileName("IMG_4411.HEIC"),
  ], [{ amount: 84.17, date: "2026-04-09", vendor: "Home Depot" }, { amount: 29.99, date: "2026-04-12", vendor: null }, { amount: null, date: null, vendor: null }]);
  {
    const rows = [
      { id: "a", date: "2026-04-10", amount: 84.17, name: "HOME DEPOT #123", merchantName: "Home Depot", hasReceipt: false },
      { id: "b", date: "2026-04-10", amount: 84.17, name: "LOWES", merchantName: "Lowes", hasReceipt: false },
      { id: "c", date: "2026-05-30", amount: 84.17, name: "HOME DEPOT", merchantName: "Home Depot", hasReceipt: false },
      { id: "d", date: "2026-04-10", amount: -84.17, name: "REFUND", merchantName: null, hasReceipt: false },
    ];
    const s = suggestMatches({ amount: 84.17, date: "2026-04-09", vendor: "Home Depot" }, rows);
    eq("same amount + close date + same vendor ranks first; far dates and money in are never offered", s.map((x) => x.rowId), ["a", "b"]);
    check("…and says why", s[0].why.includes("same amount") && s[0].why.some((w) => /home|depot/.test(w)), JSON.stringify(s[0].why));
    eq("a different amount far off is never suggested", scoreMatch({ amount: 500, date: "2026-04-09", vendor: null }, rows[0]), null);
  }

  section("1d. Pure: event audience");
  {
    const aud = normalizeAudience({ membershipIds: ["jr"], minAge: 8, maxAge: 12, genders: [], tags: [] });
    eq("empty rules are dropped; nothing set = everyone", [aud, normalizeAudience({ membershipIds: [], genders: [] })], [{ membershipIds: ["jr"], minAge: 8, maxAge: 12 }, null]);
    eq("age on the event's first day (birthday exactly then counts)", [ageOn(d("2018-11-06"), d("2026-11-06")), ageOn(d("2018-11-07"), d("2026-11-06"))], [8, 7]);
    const kid = (o = {}) => ({ dateOfBirth: d("2016-03-01"), gender: "Female", tags: "Competition team", activeMembershipIds: ["jr"], ...o });
    eq("every rule must match", [
      athleteMatches(aud, kid(), d("2026-11-06")).ok,
      athleteMatches(aud, kid({ activeMembershipIds: ["mshs"] }), d("2026-11-06")).missing,
      athleteMatches(aud, kid({ dateOfBirth: d("2012-01-01") }), d("2026-11-06")).missing,
      athleteMatches(aud, kid({ dateOfBirth: null }), d("2026-11-06")).missing,
    ], [true, ["needs a jr membership"], ["must be 12 or younger"], ["needs a date of birth on file"]]);
    eq("gender and tags (case doesn't matter)", [
      athleteMatches({ genders: ["Female"] }, kid({ gender: "female" }), d("2026-11-06")).ok,
      athleteMatches({ genders: ["Female"] }, kid({ gender: "Male" }), d("2026-11-06")).ok,
      athleteMatches({ tags: ["competition team"] }, kid(), d("2026-11-06")).ok,
    ], [true, false, true]);
    eq("in words", describeAudience({ membershipIds: ["jr", "tad"], minAge: 8, maxAge: 12, genders: ["Female"] }, (id) => (id === "jr" ? "Jr Frogs" : "Tadpoles")), "Jr Frogs or Tadpoles members · ages 8–12 · Female");
    eq("youngest above oldest is refused", audienceProblem({ minAge: 12, maxAge: 8 }), "The youngest age is above the oldest age.");
  }

  section("2. Bank accounts per entity");
  {
    eq("a coach can't see bank accounts; another club's admin sees none of ours", [(await call(ACCTS, "GET", "coach")).status, (await call(ACCTS, "GET", "stranger")).body?.accounts?.length], [403, 0]);
    const v = await call(ACCTS, "GET", "viewer");
    check("finances:view sees every account, all unassigned to start", v.status === 200 && v.body.accounts.length === 3 && v.body.unassigned === 3, why(v));
    eq("finances:view can't move an account", (await call(ACCT, "PATCH", "viewer", { params: { id: "ba_llc" }, body: { legalEntityId: "llc" } })).status, 403);
    eq("another club's entity is refused", (await call(ACCT, "PATCH", "fin", { params: { id: "ba_llc" }, body: { legalEntityId: "x_ent" } })).status, 400);
    eq("another club can't move our account", (await call(ACCT, "PATCH", "stranger", { params: { id: "ba_llc" }, body: { legalEntityId: null } })).status, 404);
    const m1 = await call(ACCT, "PATCH", "fin", { params: { id: "ba_llc" }, body: { legalEntityId: "llc" } });
    await call(ACCT, "PATCH", "fin", { params: { id: "ba_llc_sav" }, body: { legalEntityId: "llc" } });
    await call(ACCT, "PATCH", "owner", { params: { id: "ba_fdn" }, body: { legalEntityId: "fdn" } });
    eq("moving the LLC checking re-stamps its 4 rows", [m1.status, m1.body?.moved], [200, 4]);
    eq("two accounts on the LLC, one on the Foundation", ["llc", "fdn"].map((e) => fake.table("bankAccount").filter((a) => a.legalEntityId === e).length), [2, 1]);
    eq("every bank row now carries its entity", rowsOf().map((r) => [r.id, r.legalEntityId]), [["r1", "llc"], ["r2", "llc"], ["r3", "llc"], ["r4", "llc"], ["r5", "fdn"]]);
    const tLlc = await computeBankBasedTaxSummary(CLUB, { entity: "llc" });
    const tFdn = await computeBankBasedTaxSummary(CLUB, { entity: "fdn" });
    eq("Tax Summary: the Foundation's $300 is never in the LLC's expenses", [tLlc.expenses.total, tFdn.expenses.total], [29.99, 300]);
    const man = await call(ACCTS, "POST", "fin", { body: { name: "Chase card", mask: "4411", legalEntityId: "llc", type: "credit card" } });
    check("an account kept by hand can be added (for imported history)", man.status === 201 && fake.table("plaidConnection").some((c) => c.kind === "MANUAL"), why(man));
  }

  section("3. QuickBooks import");
  {
    const form = () => { const f = new FormData(); f.append("file", new File([QB_CSV], "TransactionList.csv", { type: "text/csv" })); return f; };
    eq("finances:view can't import", (await call(IMPORTS, "POST", "viewer", { form: form() })).status, 403);
    const up = await call(IMPORTS, "POST", "fin", { form: form() });
    check("the file becomes a draft", up.status === 201 && !!up.body?.id, why(up));
    const id = up.body.id;
    const before = JSON.stringify(rowsOf());
    const pv = await call(IMPORT, "GET", "fin", { params: { id } });
    check("preview loads", pv.status === 200, why(pv));
    eq("the guessed mapping: Checking ••1111 → our LLC checking; Savings ••2222 → our savings", [pv.body.mapping.accounts["Checking ••1111"], pv.body.mapping.accounts["Savings ••2222"]], [{ kind: "BANK", bankAccountId: "ba_llc" }, { kind: "BANK", bankAccountId: "ba_llc_sav" }]);
    eq("previewing wrote nothing", JSON.stringify(rowsOf()), before);
    const plan = (n: string) => pv.body.plan.find((p: { idx: number }) => pv.body.rows[p.idx].name === n || pv.body.rows[p.idx].memo === n);
    eq("April rent is MATCHED to the bank row, its category applied", [plan("April rent").action, plan("April rent").matchedRowId, plan("April rent").appliesCategory], ["MATCH", "r1", true]);
    eq("Home Depot (bank row 1 day later) matches", [plan("Home Depot").action, plan("Home Depot").matchedRowId], ["MATCH", "r2"]);
    eq("Canva matches but keeps the SOFTWARE category the owner chose", [plan("Canva").action, plan("Canva").appliesCategory], ["MATCH", false]);
    eq("January rent and February mats (before the feed) are added", [plan("January rent").action, plan("Mats").action], ["CREATE", "CREATE"]);
    eq("the March Stripe payout before the feed is added as a payout, not income", [plan("Payout").action, plan("Payout").category, plan("Payout").bankAmount], ["CREATE", "stripe_payout", -950]);
    eq("the transfer to savings is a transfer", [plan("To savings").action, plan("To savings").transfer, plan("To savings").category], ["CREATE", true, "TRANSFER"]);
    eq("a row inside the feed with no bank match is NOT added", [plan("Not in the bank").action], ["SKIP"]);
    eq("an invoice (no bank account in it) is skipped", plan("Tuition").action, "SKIP");
    eq("finances:view can't commit; another club can't even see it", [(await call(COMMIT, "POST", "viewer", { params: { id } })).status, (await call(IMPORT, "GET", "stranger", { params: { id } })).status], [403, 404]);
    eq("a mapping pointing at another club's account is refused", (await call(IMPORT, "PATCH", "fin", { params: { id }, body: { mapping: { ...pv.body.mapping, accounts: { ...pv.body.mapping.accounts, "Checking ••1111": { kind: "BANK", bankAccountId: "nope" } } } } })).status, 409);
    const c = await call(COMMIT, "POST", "fin", { params: { id } });
    check("commit", c.status === 200, why(c));
    const qb = rowsOf((r) => r.source === "QUICKBOOKS");
    eq("4 history rows added, each on the right account and entity", qb.map((r) => [r.accountId, r.legalEntityId, Number(r.amount), r.categoryOverride]).sort(), [
      ["acc_llc_chk", "llc", -950, "stripe_payout"], ["acc_llc_chk", "llc", 1500, "RENT"], ["acc_llc_chk", "llc", 200, "TRANSFER"], ["acc_llc_chk", "llc", 640, "EQUIPMENT"],
    ].sort());
    eq("matched rows: rent & Home Depot categorised from QuickBooks; Canva untouched", ["r1", "r2", "r3"].map((x) => rowsOf((r) => r.id === x)[0].categoryOverride), ["RENT", "MAINTENANCE", "SOFTWARE"]);
    eq("committing twice is refused", (await call(COMMIT, "POST", "fin", { params: { id } })).status, 409);
    const up2 = await call(IMPORTS, "POST", "fin", { form: form() });
    const pv2 = await call(IMPORT, "GET", "fin", { params: { id: up2.body.id } });
    eq("the same file imported again adds nothing", pv2.body.summary.create, 0);
    const u = await call(UNDO, "POST", "owner", { params: { id } });
    eq("undo removes the 4 rows and puts back the 2 categories", [u.status, u.body?.removed, u.body?.restored], [200, 4, 2]);
    eq("…the books are exactly as before", [rowsOf((r) => r.source === "QUICKBOOKS").length, ["r1", "r2", "r3"].map((x) => rowsOf((r) => r.id === x)[0].categoryOverride)], [0, [null, null, "SOFTWARE"]]);
  }

  section("4. Receipts");
  {
    const f = new FormData();
    f.append("file", new File([Buffer.from("%PDF-1.4")], "Home Depot 2026-04-09 $84.17.pdf", { type: "application/pdf" }));
    f.append("file", new File([Buffer.from("x")], "notes.txt", { type: "text/plain" }));
    eq("finances:view can't upload", (await call(RECEIPTS, "POST", "viewer", { form: f })).status, 403);
    const f2 = new FormData();
    f2.append("file", new File([Buffer.from("%PDF-1.4")], "Home Depot 2026-04-09 $84.17.pdf", { type: "application/pdf" }));
    f2.append("file", new File([Buffer.from("x")], "notes.txt", { type: "text/plain" }));
    const up = await call(RECEIPTS, "POST", "fin", { form: f2 });
    eq("PDFs and photos only", [up.status, up.body?.added, up.body?.rejected?.length], [201, 1, 1]);
    const list = await call(RECEIPTS, "GET", "viewer");
    const rc = list.body.receipts[0];
    eq("the file name filled in vendor, amount and date", [rc.vendor, rc.amount, rc.date], ["Home Depot", 84.17, "2026-04-09"]);
    eq("the Home Depot bank row is suggested first — and nothing was attached", [rc.suggestions[0]?.rowId, rc.status, fake.table("receipt")[0].plaidTransactionId], ["r2", "UNMATCHED", null]);
    eq("a coach can't open the receipt file, either way", [(await call(RECEIPT_FILE, "GET", "coach", { params: { id: rc.id } })).status, (await call(FILES, "GET", "coach", { params: { id: fake.table("receipt")[0].fileId } })).status], [403, 403]);
    eq("finances:view can open it", (await call(RECEIPT_FILE, "GET", "viewer", { params: { id: rc.id } })).status, 200);
    eq("another club's bank row can't be attached", (await call(RECEIPT, "PATCH", "stranger", { params: { id: rc.id }, body: { matchRowId: "r2" } })).status, 404);
    const m = await call(RECEIPT, "PATCH", "fin", { params: { id: rc.id }, body: { matchRowId: "r2" } });
    eq("attaching it (owner-confirmed) — it takes the bank row's entity", [m.status, fake.table("receipt")[0].status, fake.table("receipt")[0].legalEntityId], [200, "MATCHED", "llc"]);
    eq("an attached receipt can't be deleted until detached", (await call(RECEIPT, "DELETE", "fin", { params: { id: rc.id } })).status, 409);
  }

  console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
