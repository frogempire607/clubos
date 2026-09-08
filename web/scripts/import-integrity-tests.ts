/**
 * Phase 6 §6B — "Test CSV imports with duplicate and malformed records."
 *
 *   npm run test:import-integrity
 *
 * Pure functions from lib/reportsImports.ts. No database, no file system.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * An import is the one path where a person hands the system a file of unknown
 * quality and the system writes hundreds of rows from it. Everything else in
 * the app is a form with a validator on one record at a time.
 *
 * The two failure modes §6B names are opposites, and both are silent:
 *
 *   DUPLICATE   the same payment lands twice and the club's revenue is
 *               overstated. `Transaction` carries TWO unique indexes for this
 *               — (clubId, sourceSystem, externalTransactionId) when the
 *               vendor gave an id, and (clubId, dedupeHash) when it did not.
 *               The hash is the only defence for the no-id case, so what goes
 *               INTO it decides what counts as "the same payment twice", and
 *               that is a judgement call worth pinning.
 *
 *   MALFORMED   a row that cannot be read is skipped or, worse, half-read. The
 *               validators split this into errors (row is refused) and warnings
 *               (row imports, human should look). Which side of that line each
 *               case falls on is a product decision, not an implementation
 *               detail, so it is asserted rather than assumed.
 */
import {
  parseCsv,
  makeDedupeHash,
  parseDateWith,
  inferDateFormat,
  parseMoney,
  normalizeEmail,
  normalizePhone,
  normalizeStatus,
  validateMemberRow,
  validateTransactionRow,
  autoMapMemberHeaders,
} from "../lib/reportsImports";
import { parseFlexibleDate } from "../lib/migration";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
const section = (s: string) => console.log(`\n${s}`);

// ═══════════════════════════════════════════════════════════════════════════
section("MALFORMED — the CSV itself");
// ═══════════════════════════════════════════════════════════════════════════
{
  // A quoted comma is the classic column-shift bug: read naively, "Smith, Jr"
  // becomes two cells and every field after it lands one column left, so a
  // phone number is imported as an email and nobody notices until it bounces.
  const rows = parseCsv('first,last,email\nJohn,"Smith, Jr",j@x.com\n');
  check("a quoted comma does not shift the columns",
    rows[1]?.length === 3 && rows[1][1] === "Smith, Jr" && rows[1][2] === "j@x.com",
    JSON.stringify(rows[1]));
}
{
  const rows = parseCsv('a,b\n"say ""hi""",2\n');
  check("an escaped double-quote survives", rows[1]?.[0] === 'say "hi"', JSON.stringify(rows[1]));
}
{
  const rows = parseCsv('a,b\r\n1,2\r\n');
  check("CRLF (every Windows export) parses as one row", rows.length === 2 && rows[1][1] === "2",
    JSON.stringify(rows));
}
{
  const rows = parseCsv("a,b\n1,2\n\n\n");
  check("trailing blank lines are not imported as empty members", rows.length === 2,
    `${rows.length} rows`);
}
{
  // A newline inside quotes — a pasted address, typically.
  const rows = parseCsv('name,addr\nJo,"12 Main St\nApt 4"\n');
  check("a newline inside quotes stays one row", rows.length === 2 && rows[1][1].includes("\n"),
    JSON.stringify(rows));
}
{
  const rows = parseCsv("a,b\n1\n");
  check("a short row is returned short, not padded — the validator decides",
    rows[1]?.length === 1, JSON.stringify(rows[1]));
}

// ═══════════════════════════════════════════════════════════════════════════
section("MALFORMED — dates, the field most likely to be wrong");
// ═══════════════════════════════════════════════════════════════════════════
{
  // 03/04/2026 is March 4th in the US and April 3rd everywhere else. The
  // importer cannot guess per row; it infers ONE format for the file.
  const mdy = parseDateWith("03/04/2026", "MDY");
  const dmy = parseDateWith("03/04/2026", "DMY");
  check("the same ambiguous date reads differently under MDY vs DMY",
    mdy?.getUTCMonth() === 2 && dmy?.getUTCMonth() === 3,
    JSON.stringify([mdy?.toISOString(), dmy?.toISOString()]));
}
{
  // A day > 12 anywhere in the sample settles the file's format.
  check("a 13+ day in the samples infers DMY",
    inferDateFormat(["03/04/2026", "25/12/2026", "01/01/2026"]) === "DMY");
  check("a 13+ month position infers MDY",
    inferDateFormat(["12/25/2026", "01/01/2026"]) === "MDY");
  check("all-ambiguous falls back to the caller's default, not a guess",
    inferDateFormat(["01/02/2026", "03/04/2026"], "DMY") === "DMY");
}
{
  check("garbage is null, not Invalid Date", parseDateWith("not a date", "MDY") === null);
  check("an empty cell is null", parseDateWith("", "MDY") === null);
  // Found by this file on 2026-09-08: Date.UTC rolls over rather than failing,
  // so every one of these was being accepted as a DIFFERENT, wrong date.
  check("a 13th month is refused, not rolled into next January",
    parseDateWith("13/01/2026", "MDY") === null, String(parseDateWith("13/01/2026", "MDY")));
  check("a 31st of February is refused, not rolled into March",
    parseDateWith("02/31/2026", "MDY") === null, String(parseDateWith("02/31/2026", "MDY")));
  check("a 0th day is refused", parseDateWith("01/00/2026", "MDY") === null,
    String(parseDateWith("01/00/2026", "MDY")));
  check("a 32nd day is refused", parseDateWith("32/01/2026", "DMY") === null,
    String(parseDateWith("32/01/2026", "DMY")));
  check("a real leap day still parses", parseDateWith("02/29/2024", "MDY")?.getUTCDate() === 29,
    String(parseDateWith("02/29/2024", "MDY")));
  check("a leap day in a non-leap year is refused",
    parseDateWith("02/29/2026", "MDY") === null, String(parseDateWith("02/29/2026", "MDY")));
  check("a two-digit year still expands", parseDateWith("01/02/26", "MDY")?.getUTCFullYear() === 2026,
    String(parseDateWith("01/02/26", "MDY")));
}

// ═══════════════════════════════════════════════════════════════════════════
section("MALFORMED — the OTHER date parser (members import)");
// ═══════════════════════════════════════════════════════════════════════════
// app/api/members/import uses lib/migration.parseFlexibleDate, not
// reportsImports.parseDateWith. It had the identical rollover bug and was
// fixed in the same commit — a suite that covered only one parser would have
// left the member-facing import still storing wrong dates.
{
  check("13th month refused", parseFlexibleDate("13/01/2026") === null,
    String(parseFlexibleDate("13/01/2026")));
  check("31st of February refused", parseFlexibleDate("02/31/2026") === null,
    String(parseFlexibleDate("02/31/2026")));
  check("0th day refused", parseFlexibleDate("01/00/2026") === null,
    String(parseFlexibleDate("01/00/2026")));
  check("leap day in a non-leap year refused", parseFlexibleDate("02/29/2026") === null,
    String(parseFlexibleDate("02/29/2026")));
  check("a real date still parses", parseFlexibleDate("07/14/2026")?.getDate() === 14,
    String(parseFlexibleDate("07/14/2026")));
  check("a real leap day still parses", parseFlexibleDate("02/29/2024")?.getDate() === 29,
    String(parseFlexibleDate("02/29/2024")));
  check("ISO still parses", parseFlexibleDate("2026-07-14") !== null);
  check("garbage is null", parseFlexibleDate("whenever") === null);
}

// ═══════════════════════════════════════════════════════════════════════════
section("MALFORMED — money");
// ═══════════════════════════════════════════════════════════════════════════
{
  check("currency symbols and thousands separators parse", parseMoney("$1,234.56") === 1234.56,
    String(parseMoney("$1,234.56")));
  check("a parenthesised negative is negative", parseMoney("(45.00)") === -45,
    String(parseMoney("(45.00)")));
  check("a non-numeric amount is null, never 0 — 0 would import as a free membership",
    parseMoney("free") === null, String(parseMoney("free")));
  check("an empty amount is null", parseMoney("") === null);
}

// ═══════════════════════════════════════════════════════════════════════════
section("MALFORMED — which rows are REFUSED vs merely flagged");
// ═══════════════════════════════════════════════════════════════════════════
const MFIELDS = {
  First: "firstName", Last: "lastName", Email: "email", DOB: "dateOfBirth",
  Start: "membershipStartDate", End: "membershipEndDate", Phone: "phone",
  Status: "memberStatus",
} as const;
const mrow = (v: Record<string, string>) =>
  validateMemberRow(v, MFIELDS as never, "MDY");
{
  const r = mrow({ First: "", Last: "", Email: "", DOB: "" });
  check("a row with no name, email or external id is REFUSED", r.errors.length > 0);
}
{
  const r = mrow({ First: "", Last: "", Email: "jo@x.com" });
  check("an email alone is enough to identify somebody", r.errors.length === 0,
    JSON.stringify(r.errors));
}
{
  const r = mrow({ First: "Jo", DOB: "31/31/2026" });
  check("an unparseable DOB REFUSES the row", r.errors.some((e) => e.field === "dateOfBirth"));
}
{
  const r = mrow({ First: "Jo", Start: "01/01/2026", End: "01/01/2025" });
  check("membership ending before it starts REFUSES the row", r.errors.length > 0);
}
{
  const r = mrow({ First: "Jo", DOB: "01/01/2200" });
  check("a future DOB is a WARNING, not a refusal — typos are recoverable",
    r.errors.length === 0 && r.warnings.some((w) => w.field === "dateOfBirth"),
    JSON.stringify(r));
}
{
  const r = mrow({ First: "Jo", Phone: "n/a" });
  check("an unnormalizable phone WARNS but still imports the person",
    r.errors.length === 0 && r.warnings.some((w) => w.field === "phone"), JSON.stringify(r));
}
{
  // "frozen" is RECOGNISED (it maps to PAUSED), so it must not warn. Picking it
  // as the unrecognised example is how the first run of this file produced a
  // false failure.
  const known = mrow({ First: "Jo", Status: "frozen" });
  check("a recognised status does not warn",
    !known.warnings.some((w) => w.field === "memberStatus"), JSON.stringify(known.warnings));
  const r = mrow({ First: "Jo", Status: "Gold Tier" });
  check("a genuinely unrecognized status WARNS and says what it became",
    r.warnings.some((w) => w.field === "memberStatus" && /INACTIVE/.test(w.message)),
    JSON.stringify(r.warnings));
}

const TFIELDS = {
  Date: "transactionDate", Gross: "grossAmount", Refund: "refundAmount",
  Fee: "processingFee", Net: "netAmount",
} as const;
const trow = (v: Record<string, string>) => validateTransactionRow(v, TFIELDS as never, "MDY");
{
  check("a transaction with no readable date is REFUSED",
    trow({ Date: "??", Gross: "10" }).errors.some((e) => e.field === "transactionDate"));
  check("a transaction with a non-numeric amount is REFUSED",
    trow({ Date: "01/01/2026", Gross: "ten dollars" }).errors.some((e) => e.field === "grossAmount"));
}
{
  // Money that does not add up is a WARNING: the vendor's own arithmetic may
  // use a convention we do not model, and refusing the row would lose real
  // revenue. Flagging it puts a human on it.
  const r = trow({ Date: "01/01/2026", Gross: "100", Refund: "0", Fee: "3", Net: "50" });
  check("a net that doesn't reconcile WARNS rather than dropping the money",
    r.errors.length === 0 && r.warnings.length > 0, JSON.stringify(r));
  const ok = trow({ Date: "01/01/2026", Gross: "100", Refund: "0", Fee: "3", Net: "97" });
  check("arithmetic that reconciles is silent", ok.warnings.length === 0, JSON.stringify(ok));
}

// ═══════════════════════════════════════════════════════════════════════════
section("DUPLICATE — what counts as the same payment twice");
// ═══════════════════════════════════════════════════════════════════════════
const base = {
  clubId: "club_1", date: "2026-07-14", amount: 545.37,
  normalizedPayerEmail: "m@x.com", itemLabel: "MS/HS Quarterly",
};
{
  check("the same row hashed twice collides — a re-uploaded file cannot double-count",
    makeDedupeHash(base) === makeDedupeHash({ ...base }));
}
{
  check("a different club does NOT collide — the hash is tenant-scoped",
    makeDedupeHash(base) !== makeDedupeHash({ ...base, clubId: "club_2" }));
  check("a different date does not collide",
    makeDedupeHash(base) !== makeDedupeHash({ ...base, date: "2026-07-15" }));
  check("a different amount does not collide",
    makeDedupeHash(base) !== makeDedupeHash({ ...base, amount: 545.38 }));
  check("a different payer does not collide",
    makeDedupeHash(base) !== makeDedupeHash({ ...base, normalizedPayerEmail: "other@x.com" }));
  check("a different item does not collide",
    makeDedupeHash(base) !== makeDedupeHash({ ...base, itemLabel: "Jr Frogs Monthly" }));
}
{
  // The amount is joined as toFixed(2), so these must be the same payment.
  check("545.4 and 545.40 are the same payment",
    makeDedupeHash({ ...base, amount: 545.4 }) === makeDedupeHash({ ...base, amount: 545.4 }));
  check("a null payer and a null item hash without throwing",
    typeof makeDedupeHash({ ...base, normalizedPayerEmail: null, itemLabel: null }) === "string");
}
{
  // KNOWN AND ACCEPTED: two genuinely distinct payments of the same amount, by
  // the same payer, for the same item, on the same day collide and the second
  // is refused by the unique index. A family paying two children's identical
  // dues in one sitting is the real shape.
  //
  // This is the deliberate trade: the vendor gave no transaction id, so there
  // is nothing else to tell them apart, and under-counting a duplicate is
  // recoverable where double-counting revenue is not. The import wizard's
  // duplicate step (specs/04 §step-6) is where a human resolves it.
  const twin = makeDedupeHash(base) === makeDedupeHash({ ...base });
  check("two identical same-day payments collide — accepted, resolved by the wizard", twin);
}

// ═══════════════════════════════════════════════════════════════════════════
section("DUPLICATE — the normalizers the member match relies on");
// ═══════════════════════════════════════════════════════════════════════════
{
  check("email case and whitespace do not create a second person",
    normalizeEmail("  Jo@X.COM ") === normalizeEmail("jo@x.com"),
    `${normalizeEmail("  Jo@X.COM ")} vs ${normalizeEmail("jo@x.com")}`);
  check("a blank email normalizes to null, not an empty-string match key",
    normalizeEmail("   ") === null);
}
{
  const a = normalizePhone("(555) 123-4567");
  const b = normalizePhone("555-123-4567");
  check("phone formatting does not create a second person", a !== null && a === b, `${a} vs ${b}`);
  check("an unusable phone is null rather than a junk match key",
    normalizePhone("call me") === null, String(normalizePhone("call me")));
}
{
  check("status vocabulary collapses to the app's own",
    normalizeStatus("Cancelled") === "INACTIVE" && normalizeStatus("cancelled") === "INACTIVE",
    `${normalizeStatus("Cancelled")} / ${normalizeStatus("cancelled")}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("HEADER MAPPING — the step before any of the above runs");
// ═══════════════════════════════════════════════════════════════════════════
{
  const m = autoMapMemberHeaders(["First Name", "Last Name", "E-mail", "Nonsense Column"]);
  check("recognisable headers map themselves",
    m["First Name"] === "firstName" && m["Last Name"] === "lastName");
  check("an unrecognised header maps to null rather than guessing",
    m["Nonsense Column"] === null, String(m["Nonsense Column"]));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
