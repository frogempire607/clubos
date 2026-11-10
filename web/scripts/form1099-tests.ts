// Accounting Phase 3 — 1099 threshold reporting, proven.
//
//   npm run test:form1099     (and it GATES the build)
//
// No database, no network.
//
// ⚠️  The first thing this file checks is that NO TAX IDENTIFICATION NUMBER
// exists anywhere in the repo. The brief required a TIN to be encrypted at
// rest, masked, owner-only and never logged, and said to STOP and propose a
// design if the repo had no field-level encryption. It has none. So §1 is a
// standing guard: if a TIN field ever appears without the encryption to go
// with it, the build fails rather than the column quietly filling up with
// social security numbers in plaintext.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXCLUDED_METHODS,
  LAST_SETTLED_YEAR,
  FORM_1099_CSV_HEADERS,
  buildForm1099Report,
  findSuspectedDuplicates,
  form1099CsvRows,
  methodIsExcluded,
  methodIsUnknown,
  statutoryThresholdCents,
  thresholdCentsFor,
  thresholdIsOverridden,
  thresholdNote,
  type ContractorFacts,
  type Form1099Payment,
} from "../lib/form1099";

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

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|sql|prisma)$/.test(p)) out.push(p);
  }
  return out;
}

// ── 1. A TIN MAY ONLY EXIST ENCRYPTED — the standing guard ──────────────────
//
// UPDATED IN PHASE 12.1. Until then this asserted that NO tax-identification
// field existed anywhere, because the repo had no field-level encryption and
// Phase 12 therefore stopped rather than storing one. Julian approved the
// encryption design, so one now exists — and the guard changes shape rather
// than being deleted: a plaintext tax-id field must still never appear, and
// the encrypted one must still be backed by real encryption.
//
// The detailed guard (one decrypting module, audit before decrypt, nothing
// logged, a CHECK constraint on the column) lives in
// scripts/field-crypto-tests.ts §6.
{
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

  // Anchored to the whole field name — a substring search matches
  // "busine(ssN)ame" and "set(tin)gs" and cries wolf.
  const tinFields = [
    ...schema.matchAll(
      /^\s*((?:taxId|tin|ssn|socialSecurity|federalTaxId|payeeTaxId|taxpayerId)[A-Za-z0-9]*)\s+\w/gim,
    ),
  ].map((m) => m[1]);
  const allowed = new Set(["taxIdEncrypted", "taxIdLast4", "taxIdKind"]);
  eq(
    tinFields.filter((f) => !allowed.has(f)),
    [],
    "1.1 the schema declares no PLAINTEXT tax-identification field",
  );
  ok(tinFields.includes("taxIdEncrypted"), "1.1b and the encrypted one exists, so 1.1 is not vacuous");

  // The encryption that justifies the field existing at all.
  const hasEncryption = walk(join(ROOT, "lib")).some((f) => {
    const src = readFileSync(f, "utf8");
    return /createCipheriv|createDecipheriv/.test(src) && /aes-256-gcm/.test(src);
  });
  ok(
    hasEncryption,
    "1.2 AES-256-GCM field encryption exists to protect it",
    "a TIN field without createCipheriv/aes-256-gcm in lib/ must fail the build",
  );

  // The 1099 report still handles no TIN: it reports who needs a form and for
  // how much, and the number itself is only ever read through
  // lib/contractorTin.revealTin.
  for (const f of ["lib/form1099.ts", "lib/form1099Server.ts"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    ok(
      !/\btaxId\b|\bssn\b|socialSecurity|decryptField/i.test(src.replace(/\/\/[^\n]*/g, "")),
      `1.3 ${f} still handles no tax identification number outside its comments`,
    );
  }

  // The CSV must never carry a FULL tax id. Phase 12.1 added a masked last-four
  // column, which is the point of storing the last four in plaintext at all —
  // so the guard is restated precisely rather than dropped: a column may show
  // four digits, never nine.
  ok(
    FORM_1099_CSV_HEADERS.includes("Tax ID (last 4)"),
    "1.4 the CSV's only tax-id column is explicitly the last four",
  );
  ok(
    !FORM_1099_CSV_HEADERS.some((h) => /^(tax id|tin|ssn|ein)$/i.test(h.trim())),
    "1.4b and there is no column that would hold a whole one",
  );
  {
    // The VALUES, not just the heading: a four-digit mask, never nine digits.
    const row = form1099CsvRows(
      buildForm1099Report(
        2026,
        [
          {
            id: "p1",
            source: "CONTRACTOR_PAYMENT" as const,
            contractorId: "c1",
            contractorName: "Dana Ruiz",
            date: "2026-06-01",
            amountCents: 250_000,
            method: "CHECK",
            description: null,
          },
        ],
        [{ id: "c1", name: "Dana Ruiz", email: null, hasW9: true, taxIdLast4: "6789" }],
        null,
      ),
    )[0];
    const cells = row.map(String);
    ok(
      cells.some((c) => /^xxx-xx-6789$/.test(c)),
      "1.4c and the value is masked",
      JSON.stringify(cells),
    );
    ok(!cells.some((c) => /\d{9}/.test(c)), "1.4d with no nine-digit run anywhere in the row");
  }
  // Phase 12.1 ADDED Contractor.address, because a 1099-NEC needs the payee's
  // address and Phase 12 filed its absence as a blocker. So the CSV carries
  // one now, and the report counts the payees still missing it.
  ok(
    FORM_1099_CSV_HEADERS.includes("Address"),
    "1.5 the CSV carries the payee address a 1099-NEC needs",
  );

  // And the decision is written down where the next person will look.
  const plan = readFileSync(join(ROOT, "docs/accounting/plan.md"), "utf8");
  ok(/TIN question/i.test(plan), "1.6 the TIN decision is written up in docs/accounting/plan.md");
}

// ── 2. The threshold, as the law actually sets it ────────────────────────────
{
  eq(statutoryThresholdCents(2024), 60_000, "2.1 2024 is $600");
  eq(statutoryThresholdCents(2025), 60_000, "2.2 2025 is $600 — the long-standing figure");
  eq(statutoryThresholdCents(2026), 200_000, "2.3 2026 is $2,000 — raised by OBBBA");
  eq(statutoryThresholdCents(2027), 200_000, "2.4 and 2027 falls back to $2,000 rather than inventing an indexed figure");
  eq(LAST_SETTLED_YEAR, 2026, "2.5 2026 is the last year whose figure is settled in statute");

  // The club's own figure always wins — that is how a club records the indexed
  // amount for 2027, and how it corrects a figure this code hasn't caught up
  // with.
  eq(thresholdCentsFor(2027, { "2027": 210_000 }), 210_000, "2.6 a club override wins");
  eq(thresholdCentsFor(2026, { "2027": 210_000 }), 200_000, "2.7 and applies only to its own year");
  eq(thresholdCentsFor(2026, null), 200_000, "2.8 no overrides falls back to statute");
  eq(thresholdCentsFor(2026, {}), 200_000, "2.9 an empty override map too");
  eq(thresholdCentsFor(2026, { "2026": 0 }), 0, "2.10 a deliberate zero is honoured — report everything");
  // Junk in the JSON blob must not become a threshold.
  eq(thresholdCentsFor(2026, { "2026": -5 }), 200_000, "2.11 a negative override is ignored");
  eq(thresholdCentsFor(2026, { "2026": 1.5 } as Record<string, number>), 200_000, "2.12 a fractional one is ignored");
  eq(thresholdCentsFor(2026, { "2026": "600" } as unknown as Record<string, number>), 200_000, "2.13 a string one is ignored");

  ok(thresholdIsOverridden(2026, { "2026": 1 }), "2.14 an override is reported as such");
  ok(!thresholdIsOverridden(2026, { "2025": 1 }), "2.15 and another year's is not");

  // The notes have to say which rule applied, and admit when a figure is not
  // known rather than presenting a fallback as fact.
  ok(/2,000/.test(thresholdNote(2026, null)), "2.16 the 2026 note states the amount");
  ok(/One Big Beautiful Bill|OBBBA/.test(thresholdNote(2026, null)), "2.17 and why it changed");
  ok(/600/.test(thresholdNote(2025, null)), "2.18 the 2025 note states $600");
  ok(/not published/.test(thresholdNote(2028, null)), "2.19 a future year ADMITS the figure is not known here");
  ok(/confirm/i.test(thresholdNote(2028, null)), "2.20 and says to confirm it before relying on the report");
  ok(/set for 2026/.test(thresholdNote(2026, { "2026": 1 })), "2.21 an overridden note says the club set it");
}

// ── 3. Card and processor payments are excluded ──────────────────────────────
{
  ok(methodIsExcluded("CARD"), "3.1 a card payment is excluded");
  ok(methodIsExcluded("card"), "3.2 case-insensitively");
  ok(methodIsExcluded("STRIPE"), "3.3 so is a processor payment");
  ok(!methodIsExcluded("CASH"), "3.4 cash is reportable");
  ok(!methodIsExcluded("CHECK"), "3.5 so is a cheque");
  ok(!methodIsExcluded("BANK"), "3.6 and a bank transfer");
  ok(!methodIsExcluded("TRANSFER"), "3.7 and a payouts-page transfer");
  ok(!methodIsExcluded(null), "3.8 an unrecorded method is NOT excluded");
  ok(methodIsUnknown(null), "3.9 it is flagged as unknown instead");
  ok(!methodIsUnknown("CASH"), "3.10 a recorded method is not unknown");
  ok(EXCLUDED_METHODS.includes("CARD"), "3.11 CARD is in the excluded set");
  // Excluding on a guess under-reports, which is the direction that gets a
  // club penalised. This is the invariant that keeps it that way.
  ok(!methodIsExcluded(undefined), "3.12 and undefined is not quietly treated as a card payment");
}

// ── 4. The report ───────────────────────────────────────────────────────────
const pay = (over: Partial<Form1099Payment> & { id: string; amountCents: number }): Form1099Payment => ({
  source: "CONTRACTOR_PAYMENT",
  contractorId: "c1",
  contractorName: "Dana Ruiz",
  date: "2026-06-01",
  method: "CHECK",
  description: null,
  ...over,
});

const CONTRACTORS: ContractorFacts[] = [
  { id: "c1", name: "Dana Ruiz", email: "dana@example.com", hasW9: true },
  { id: "c2", name: "Sam Okafor", email: null, hasW9: false },
];

{
  const payments = [
    pay({ id: "p1", amountCents: 150_000 }),
    pay({ id: "p2", amountCents: 100_000, date: "2026-09-01" }),
    pay({ id: "p3", amountCents: 50_000, contractorId: "c2", contractorName: "Sam Okafor" }),
  ];
  const r = buildForm1099Report(2026, payments, CONTRACTORS, null);

  eq(r.thresholdCents, 200_000, "4.1 the 2026 threshold applies");
  eq(r.rows.length, 2, "4.2 one row per payee");
  eq(r.rows[0].contractorName, "Dana Ruiz", "4.3 payees over the threshold come first");
  eq(r.rows[0].totalCents, 250_000, "4.4 with their payments summed");
  eq(r.rows[0].paymentCount, 2, "4.5 and counted");
  ok(r.rows[0].overThreshold, "4.6 $2,500 is over $2,000");
  ok(!r.rows[1].overThreshold, "4.7 $500 is not");
  eq(r.reportableCount, 1, "4.8 so one form is needed");
  eq(r.reportableTotalCents, 250_000, "4.9 for $2,500");
  ok(!r.rows[0].missingW9, "4.10 a contractor with a W-9 on file is not flagged");
  ok(r.rows[1].missingW9, "4.11 one without it is — that is where the TIN and address come from");

  // Exactly ON the threshold must be reportable: the law is "$2,000 or more".
  const onTheLine = buildForm1099Report(2026, [pay({ id: "x", amountCents: 200_000 })], CONTRACTORS, null);
  ok(onTheLine.rows[0].overThreshold, "4.12 exactly $2,000 IS reportable — the test is 'or more'");
  const justUnder = buildForm1099Report(2026, [pay({ id: "x", amountCents: 199_999 })], CONTRACTORS, null);
  ok(!justUnder.rows[0].overThreshold, "4.13 and one cent under is not");

  // Card payments leave the total entirely.
  const withCard = buildForm1099Report(
    2026,
    [...payments, pay({ id: "p4", amountCents: 500_000, method: "CARD" })],
    CONTRACTORS,
    null,
  );
  eq(withCard.rows[0].totalCents, 250_000, "4.14 a card payment does not inflate the payee's total");
  eq(withCard.excluded.length, 1, "4.15 it is listed as excluded");
  eq(withCard.excludedTotalCents, 500_000, "4.16 with its amount");
  ok(/1099-K/.test(withCard.excluded[0].reason), "4.17 and the reason names the form it IS reported on");

  // An unrecorded method is counted but flagged.
  const withUnknown = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000, method: null })],
    CONTRACTORS,
    null,
  );
  eq(withUnknown.rows[0].totalCents, 250_000, "4.18 an unrecorded method is still counted");
  eq(withUnknown.rows[0].unknownMethodCents, 250_000, "4.19 and flagged, so the gap is visible");
  eq(withUnknown.rows[0].unknownMethodCount, 1, "4.20 by count as well as amount");
  eq(withUnknown.unknownMethodTotalCents, 250_000, "4.21 and totalled on the report");
  eq(withUnknown.excluded.length, 0, "4.22 but never excluded on a guess");

  // Empty year.
  const empty = buildForm1099Report(2026, [], CONTRACTORS, null);
  eq(empty.rows, [], "4.23 a year with no payments has no rows");
  eq(empty.reportableCount, 0, "4.24 and needs no forms");
  eq(empty.excluded, [], "4.25 and excludes nothing");

  // A payee not in the contractor list still reports, under the name on the
  // payment — a deleted contractor's money does not vanish from a 1099.
  const orphan = buildForm1099Report(
    2026,
    [pay({ id: "p9", amountCents: 300_000, contractorId: "gone", contractorName: "Former Ref" })],
    CONTRACTORS,
    null,
  );
  eq(orphan.rows[0].contractorName, "Former Ref", "4.26 a payment to a deleted contractor still reports");
  ok(orphan.rows[0].missingW9, "4.27 flagged as having no W-9, because nothing is known about them");

  // Payments are listed oldest first within a payee, so the detail reads as a
  // statement.
  const ordered = buildForm1099Report(
    2026,
    [pay({ id: "b", amountCents: 100, date: "2026-12-01" }), pay({ id: "a", amountCents: 100, date: "2026-01-01" })],
    CONTRACTORS,
    null,
  );
  eq(ordered.rows[0].payments.map((p) => p.date), ["2026-01-01", "2026-12-01"], "4.28 payments are in date order");
}

// ── 5. The two tables, and the double-count risk between them ───────────────
{
  // Contractor money lives in ContractorPayment AND Payout with no link, so
  // the same payment can be recorded twice.
  const dupA = pay({ id: "cp:1", amountCents: 40_000, date: "2026-03-10" });
  const dupB = pay({ id: "po:1", amountCents: 40_000, date: "2026-03-11", source: "PAYOUT", method: "CHECK" });
  const dups = findSuspectedDuplicates([dupA, dupB]);
  eq(dups.length, 1, "5.1 the same amount in both tables, a day apart, is flagged");
  ok(/counted twice/.test(dups[0].reason), "5.2 and the reason says what the consequence is");

  eq(findSuspectedDuplicates([dupA, { ...dupB, amountCents: 40_001 }]).length, 0, "5.3 a cent apart is not a duplicate");
  eq(findSuspectedDuplicates([dupA, { ...dupB, date: "2026-03-20" }]).length, 0, "5.4 ten days apart is not either");
  eq(findSuspectedDuplicates([dupA, { ...dupB, contractorId: "c2" }]).length, 0, "5.5 nor a different contractor");
  // Two equal payments in the SAME table are not duplicates — a referee can
  // genuinely work two weekends at the same rate.
  eq(
    findSuspectedDuplicates([dupA, pay({ id: "cp:2", amountCents: 40_000, date: "2026-03-11" })]).length,
    0,
    "5.6 two equal payments in the same table are not flagged — that is a real pattern",
  );
  // One payout cannot be the duplicate of two contractor payments.
  const two = findSuspectedDuplicates([dupA, pay({ id: "cp:2", amountCents: 40_000, date: "2026-03-10" }), dupB]);
  eq(two.length, 1, "5.7 each payout is matched at most once");

  // And they are REPORTED, never merged — the total still includes both.
  const r = buildForm1099Report(2026, [dupA, dupB], CONTRACTORS, null);
  eq(r.rows[0].totalCents, 80_000, "5.8 a suspected duplicate is NOT silently merged out of the total");
  eq(r.suspectedDuplicates.length, 1, "5.9 it is surfaced for a human to resolve");
}

// ── 6. CSV ──────────────────────────────────────────────────────────────────
{
  const r = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000 }), pay({ id: "p2", amountCents: 50_000, contractorId: "c2", contractorName: "Sam Okafor" })],
    CONTRACTORS,
    null,
  );
  const rows = form1099CsvRows(r);
  // Addressed by COLUMN NAME, not index: §6 broke when Phase 12.1 inserted
  // columns, and an index-based test breaks again the next time.
  const col = (name: string) => FORM_1099_CSV_HEADERS.indexOf(name);
  eq(rows.length, 1, "6.1 by default the CSV holds only the payees who need a form");
  eq(rows[0][col("Payee")], "Dana Ruiz", "6.2 named");
  eq(rows[0][col("Total paid")], 2500, "6.3 with the amount as a NUMBER in dollars, so the column sums");
  eq(typeof rows[0][col("Total paid")], "number", "6.4 genuinely a number, not a formatted string");
  eq(rows[0][col("W-9 on file")], "Yes (uploaded)", "6.5 and whether a W-9 is on file, and where it came from");

  const all = form1099CsvRows(r, { includeBelow: true });
  eq(all.length, 2, "6.6 including the below-threshold payees is opt-in");
  eq(FORM_1099_CSV_HEADERS.length, rows[0].length, "6.7 every row matches the header width");
  ok(col("Address") > -1 && col("Tax ID (last 4)") > -1, "6.8 the 1099-NEC columns are present");
}

// ── 7. Source guarantees ────────────────────────────────────────────────────
{
  const pure = readFileSync(join(ROOT, "lib/form1099.ts"), "utf8");
  const server = readFileSync(join(ROOT, "lib/form1099Server.ts"), "utf8");
  const route = readFileSync(join(ROOT, "app/api/financials/ledger/form1099/route.ts"), "utf8");

  ok(!/from "@\/lib\/prisma"/.test(pure), "7.1 lib/form1099.ts imports no prisma");
  ok(!/\bnew Date\(\)/.test(pure), "7.2 and reads no clock");

  // Nothing files anything.
  ok(!/fetch\(|axios|https?:\/\//.test(server.replace(/\/\/[^\n]*/g, "")), "7.3 the server module calls no external service — it files nothing");
  ok(!/prisma\.\w+\.(create|update|delete|upsert)\(/.test(server.replace(/setThreshold[\s\S]*$/, "")), "7.4 and writes nothing except the threshold setting");

  // Every read is club-scoped.
  const reads = server.match(/prisma\.\w+\.(findMany|findFirst|findUnique|aggregate|count)\(/g) ?? [];
  ok(reads.length >= 4, "7.5 the server module does read the database");
  ok(
    (server.match(/clubId/g) ?? []).length >= reads.length,
    "7.6 and every read carries a clubId",
  );

  // Both routes gated, and the PATCH needs full finance access because it
  // changes what gets reported to the IRS.
  ok(/requirePermissionLive\(session, "finances", "view"\)/.test(route), "7.7 the report needs finances:view");
  ok(/requirePermissionLive\(session, "finances", "full"\)/.test(route), "7.8 and setting the threshold needs finances:full");
  ok(/requireTierFeature\(session\.user\.clubId, "fullFinancials"\)/.test(route), "7.9 both are tier-gated");
  ok(/if \(!session\) return/.test(route), "7.10 with the explicit null check the build needs");

  // The money conversion. Decimal(10,2) → cents must round, not truncate: a
  // value arriving as 40.0000001 must become 4000, never 3999.
  ok(/Math\.round\(Number\(r\.amount\) \* 100\)/.test(server), "7.11 Decimal→cents rounds rather than truncating");

  // A 1099 is cash-basis, so a payout counts in the year it was PAID.
  ok(/paidAt: \{ gte: from, lte: to \}/.test(server), "7.12 a payout is dated by when it was paid, not when it was created");
  ok(/status: "PAID"/.test(server), "7.13 and only paid payouts count");
}

// ── 8. Phase 12.1: employees are excluded, and the W-9 is the authority ─────
console.log("");
{
  // The pure layer carries the count the server computed, so the UI can say
  // how many people were left out rather than leaving a silent gap.
  const r = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000 })],
    CONTRACTORS,
    null,
    { excludedEmployeeCount: 3 },
  );
  eq(r.excludedEmployeeCount, 3, "8.1 the report reports how many employees were excluded");
  eq(
    buildForm1099Report(2026, [], CONTRACTORS, null).excludedEmployeeCount,
    0,
    "8.2 and zero when none were",
  );

  // A 1099-NEC needs an address. The report counts the payees still missing
  // one, because that is work the club must do before filing.
  const noAddress = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000 })],
    [{ id: "c1", name: "Dana Ruiz", email: null, hasW9: true, address: null }],
    null,
  );
  eq(noAddress.missingAddressCount, 1, "8.3 a reportable payee with no address is counted");
  const withAddress = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000 })],
    [{ id: "c1", name: "Dana Ruiz", email: null, hasW9: true, address: "14 Mill Road, Dayton, OH 45402" }],
    null,
  );
  eq(withAddress.missingAddressCount, 0, "8.4 and one with an address is not");
  eq(withAddress.rows[0].address, "14 Mill Road, Dayton, OH 45402", "8.5 which is carried onto the row");
  // Only payees who actually need a form are counted — chasing an address for
  // somebody under the threshold is busywork.
  const under = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 1_000 })],
    [{ id: "c1", name: "Dana Ruiz", email: null, hasW9: true, address: null }],
    null,
  );
  eq(under.missingAddressCount, 0, "8.6 a below-threshold payee's missing address is not counted");

  // "W-9 on file" distinguishes data we hold from a PDF somebody uploaded.
  const inApp = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000 })],
    [{ id: "c1", name: "Dana Ruiz", email: null, hasW9: true, w9InApp: true, taxIdLast4: "6789" }],
    null,
  );
  ok(inApp.rows[0].w9InApp, "8.7 a W-9 completed in the app is marked as such");
  eq(inApp.rows[0].taxIdLast4, "6789", "8.8 and its masked tax id is available without a decryption");
  ok(!inApp.rows[0].missingW9, "8.9 and it counts as on file");
  const uploaded = buildForm1099Report(
    2026,
    [pay({ id: "p1", amountCents: 250_000 })],
    [{ id: "c1", name: "Dana Ruiz", email: null, hasW9: true, w9InApp: false }],
    null,
  );
  ok(!uploaded.rows[0].w9InApp, "8.10 an uploaded paper W-9 is distinguished from one in the app");
  ok(!uploaded.rows[0].missingW9, "8.11 but still counts as on file — a club that collected paper has what it needs");

  // Source: the server must do the excluding, and must prefer the W-9's legal
  // name — a club's label for a contractor may be "Ref - Dana", and a 1099
  // needs the name on their tax return.
  const server = readFileSync(join(ROOT, "lib/form1099Server.ts"), "utf8");
  ok(/workerType: "EMPLOYEE"/.test(server), "8.12 the server looks up who is classified EMPLOYEE");
  ok(
    /payments\.filter\(\(p\) => !employeeContractorIds\.has\(p\.contractorId\)\)/.test(server),
    "8.13 and leaves their payments out of the report entirely",
  );
  ok(
    /\.filter\(\(c\) => !employeeContractorIds\.has\(c\.id\)\)/.test(server),
    "8.14 and leaves them out of the payee list too, so they cannot appear with a zero",
  );
  ok(
    /c\.w9Current\?\.legalName \?\? c\.name/.test(server),
    "8.15 the W-9's legal name is preferred over the club's own label for the contractor",
  );
  ok(
    /convertedUserId/.test(server),
    "8.16 using the existing contractor↔staff link rather than a second one",
  );
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`\n${fails.length ? "✗" : "✓"} form1099: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
