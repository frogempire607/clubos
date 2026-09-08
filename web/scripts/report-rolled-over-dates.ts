/**
 * Did the date-rollover bug actually reach production data?
 *
 * REPORT ONLY. No `--apply`, and there will never be one — a rollover is not
 * reversible from the stored value alone, so every correction has to come from
 * the original CSV.
 *
 *   npx tsx scripts/report-rolled-over-dates.ts
 *   npx tsx scripts/report-rolled-over-dates.ts --all   # list clean rows too
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * Until 2026-09-08 both import date parsers built a Date without validating the
 * components, and JavaScript rolls out-of-range values forward rather than
 * failing. `13/01/2026` read as MDY became 2027-01-01; `02/31/2026` became
 * March 3rd. Nothing was rejected — a wrong date was stored instead.
 *
 * That matters most on `dateOfBirth`, which drives minor status, the guardian
 * consent gate and who may sign a document. A birthday that rolled a year could
 * put somebody on the wrong side of 18.
 *
 * ── How this tells a rolled date from a good one ────────────────────────────
 *
 * There is a fingerprint. Every slash-format string reaching the old parser was
 * built with `new Date(y, m, d)` or parsed by V8 as a LOCAL time, so it landed
 * at local midnight — 04:00Z or 05:00Z here. A date that went through the ISO
 * branch, or was written by the app itself, is exactly 00:00Z.
 *
 * So: a date-only column holding anything other than 00:00:00.000Z passed
 * through the slash path, which is the only path that could roll over. That is
 * the primary screen, and it is a strong one.
 *
 * A full timestamp with sub-second precision is a third thing — `new Date()` at
 * write time, not a parsed value at all — and is reported separately so it is
 * not mistaken for either.
 *
 * ── What this CANNOT do ─────────────────────────────────────────────────────
 *
 * It cannot prove a specific date is wrong. 2026-03-03 is a perfectly good date
 * that also happens to be what `02/31/2026` rolls into. Where a stored value is
 * REACHABLE by a rollover the report says so and names the input that would
 * have produced it, so the original file can settle it. It never guesses which
 * reading is right, and it proposes no value.
 */
import { prisma } from "../lib/prisma";

const ALL = process.argv.slice(2).includes("--all");
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const line = (s = "") => console.log(s);

const DAYS_IN = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-indexed

/** Exactly midnight UTC — the app's date-only convention. */
const isMidnightUTC = (d: Date) =>
  d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

/** A real clock reading: `new Date()` at write time, never a parsed date-only value. */
const isClockStamp = (d: Date) => d.getUTCMilliseconds() !== 0 || d.getUTCSeconds() !== 0;

/**
 * Out-of-range inputs a person could plausibly have typed that JavaScript would
 * have rolled INTO this date.
 *
 * Only the SHORT-MONTH OVERFLOW class is reported: a day past the end of the
 * previous month spilling into the first days of this one — 02/31 -> Mar 3,
 * 09/31 -> Oct 1, 02/29 in a common year -> Mar 1. Those are dates a human
 * actually writes, usually a month-end that does not exist.
 *
 * Two other classes are mathematically reachable and DELIBERATELY excluded:
 *
 *   day 0    "07/00/2026" rolls to Jun 30. Nobody types a zero day, and
 *            including it flags EVERY month-end date in the database — which
 *            is most billing dates. All noise, no signal.
 *   month 13 "13/01/2026" rolls to Jan 2027. It flags every early-January
 *            date, and the wizard's convertDate refuses a month over 12
 *            before the value ever reaches the server.
 *
 * A screen that flags everything gets ignored, so it flags the one class worth
 * a look.
 */
function rolloverOrigins(d: Date): string[] {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
  const two = (n: number) => String(n).padStart(2, "0");
  if (dd > 3) return [];
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const inPrev = DAYS_IN(py, pm);
  const overflow = inPrev + dd;
  if (overflow < 29 || overflow > 31) return [];
  return [`${two(pm)}/${two(overflow)}/${py} — day ${overflow} of a ${inPrev}-day month`];
}

type Row = { who: string; column: string; value: Date; note: string[] };

async function main() {
  line("\n" + "━".repeat(78));
  line("ROLLED-OVER DATES — did the import bug reach the data?");
  line("━".repeat(78));

  const members = await prisma.member.findMany({
    where: { deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, isMinor: true,
      dateOfBirth: true, membershipStartDate: true, nextBillingDate: true,
      commitmentEndDate: true, billingAnchorDate: true,
      legacySource: true, importedAt: true, importBatchId: true, userId: true,
      guardianEmail: true,
    },
  });
  const who = (m: (typeof members)[number]) => `${m.firstName} ${m.lastName}`.trim();
  const COLUMNS: Array<[string, (m: (typeof members)[number]) => Date | null]> = [
    ["dateOfBirth", (m) => m.dateOfBirth],
    ["membershipStartDate", (m) => m.membershipStartDate],
    ["nextBillingDate", (m) => m.nextBillingDate],
    ["commitmentEndDate", (m) => m.commitmentEndDate],
    ["billingAnchorDate", (m) => m.billingAnchorDate],
  ];

  // ── 1. The fingerprint screen ────────────────────────────────────────────
  const slashPath: Row[] = [];
  const clockStamps: Row[] = [];
  let scanned = 0;
  for (const m of members) {
    for (const [col, get] of COLUMNS) {
      const v = get(m);
      if (!v) continue;
      scanned++;
      if (isMidnightUTC(v)) continue;
      const row = { who: who(m), column: col, value: v, note: [] as string[] };
      if (isClockStamp(v)) clockStamps.push(row);
      else slashPath.push(row);
    }
  }

  line("\n1. FINGERPRINT — which stored dates went through the slash parser at all");
  line("   A date-only column is 00:00:00.000Z unless it was parsed as a local time,");
  line("   which only the slash path does. That path is the only one that could roll.");
  line("");
  line(`   scanned:              ${scanned} date values across ${members.length} members`);
  line(`   local-midnight:       ${slashPath.length}  ← the only rollover candidates`);
  line(`   clock stamps:         ${clockStamps.length}  (new Date() at write time, not parsed)`);
  if (slashPath.length === 0) {
    line("");
    line("   ✓ NOT ONE date-only value carries the slash-parser fingerprint.");
    line("     Every one is exactly 00:00Z, so every one came through the ISO branch");
    line("     or was written by the app. V8 rejects an invalid ISO day outright");
    line("     (new Date(\"2026-02-31\") is Invalid Date), and the migration wizard's");
    line("     own convertDate refuses an out-of-range month or day rather than");
    line("     converting it. On this evidence the rollover never fired here.");
  } else {
    line("");
    line("   ✗ these went through the parser that could roll over:");
    for (const r of slashPath) {
      line(`      ${pad(r.who, 22)} ${pad(r.column, 20)} ${r.value.toISOString()}`);
    }
  }
  if (clockStamps.length && ALL) {
    line("\n   clock stamps (informational — written, not parsed):");
    for (const r of clockStamps) line(`      ${pad(r.who, 22)} ${pad(r.column, 20)} ${r.value.toISOString()}`);
  } else if (clockStamps.length) {
    line(`   (${clockStamps.length} clock stamp(s); --all to list)`);
  }

  // ── 2. Reachability — values a rollover COULD have produced ──────────────
  line("\n" + "─".repeat(78));
  line("2. REACHABLE BY A ROLLOVER — cross-check these against the original file");
  line("   A date here is NOT wrong. It is a value that a malformed input would");
  line("   also have produced, listed with the input that would produce it.");
  line("");
  const reachable: Row[] = [];
  for (const m of members) {
    const imported = !!(m.legacySource || m.importedAt || m.importBatchId);
    if (!imported) continue;
    for (const [col, get] of COLUMNS) {
      const v = get(m);
      if (!v || isClockStamp(v)) continue;
      const origins = rolloverOrigins(v);
      if (origins.length) reachable.push({ who: who(m), column: col, value: v, note: origins });
    }
  }
  if (!reachable.length) line("   ✓ no imported date sits on a short-month overflow boundary");
  for (const r of reachable) {
    line(`   ${pad(r.who, 22)} ${pad(r.column, 20)} ${day(r.value)}`);
    for (const n of r.note) line(`   ${" ".repeat(22)} ${" ".repeat(20)} could be ${n}`);
  }

  // ── 3. The consequence, checked independently of the cause ───────────────
  line("\n" + "─".repeat(78));
  line("3. MINOR STATUS — checked against the stored DOB, whatever put it there");
  line("   This is the thing the bug would have broken, so it is worth checking on");
  line("   its own merits. A disagreement here is real regardless of any rollover.");
  line("");
  const now = new Date();
  const ageOf = (d: Date) => {
    let a = now.getUTCFullYear() - d.getUTCFullYear();
    const before = now.getUTCMonth() < d.getUTCMonth()
      || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
    if (before) a--;
    return a;
  };
  const treatedAdultIsMinor: string[] = [];
  const treatedMinorIsAdult: string[] = [];
  const implausible: string[] = [];
  for (const m of members) {
    if (!m.dateOfBirth) continue;
    const age = ageOf(m.dateOfBirth);
    const label = `${pad(who(m), 22)} DOB ${day(m.dateOfBirth)}  age ${String(age).padStart(3)}` +
      `  isMinor=${m.isMinor ? "true " : "false"}  ${m.legacySource ?? "not imported"}`;
    if (!m.isMinor && age < 18) treatedAdultIsMinor.push(label);
    else if (m.isMinor && age >= 18) treatedMinorIsAdult.push(label);
    if (age < 3 || age > 100) implausible.push(label);
  }
  line(`✗ TREATED AS AN ADULT, DOB SAYS MINOR — ${treatedAdultIsMinor.length}`);
  line("  No guardian consent gate, no parental controls, may sign their own documents.");
  for (const l of treatedAdultIsMinor) line(`   ${l}`);
  line("");
  line(`· flagged minor, DOB says adult — ${treatedMinorIsAdult.length}`);
  line("  Usually just someone who aged out; nothing recomputes isMinor on a birthday.");
  if (ALL) for (const l of treatedMinorIsAdult) line(`   ${l}`);
  else line(`   (--all to list)`);
  line("");
  line(`· implausible age (<3 or >100) — ${implausible.length}`);
  line("  A DOB column holding a join date looks exactly like this.");
  for (const l of implausible) line(`   ${l}`);

  // ── Where to start ───────────────────────────────────────────────────────
  line("\n" + "─".repeat(78));
  line("WHERE TO START IN THE ORIGINAL FILE");
  line("");
  const reachableNames = new Set(reachable.filter((r) => r.column === "dateOfBirth").map((r) => r.who));
  const bothLists = implausible
    .map((l) => l.trim().split("  DOB")[0].trim())
    .filter((n) => reachableNames.has(n));
  if (slashPath.length === 0) {
    line("  The fingerprint in §1 is the strongest evidence here, and it is negative:");
    line("  no stored date went through the parser that could roll. Sections 2 and 3");
    line("  are worth reading anyway, because they find problems the rollover did not");
    line("  cause.");
    line("");
  }
  if (bothLists.length) {
    line("  Appear in BOTH §2 and §3 — check these first:");
    for (const n of bothLists) line(`     ${n}`);
    line("     (a rollover would not change the YEAR here, so an implausible age is a");
    line("      separate problem — most likely a DOB column holding a join date)");
    line("");
  }
  line(`  §2 gives ${reachable.length} date(s) to confirm against the file.`);
  line(`  §3 gives ${treatedAdultIsMinor.length} member(s) whose minor status contradicts their own DOB,`);
  line("     which needs deciding regardless of what any CSV says.");

  line("\n" + "━".repeat(78));
  line("REPORT ONLY — nothing was written. A rollover cannot be reversed from the");
  line("stored value, so any correction must come from the original CSV and go");
  line("through its own dry-run script.");
  line("");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
