/**
 * The late call-out banner counts minutes DOWN — "1h 59m", never rounded up to
 * "2h" (lib/classStaff.ts fmtCountdown / lateCalloutBanner / calloutNotice).
 *
 *   npx tsx scripts/late-callout-format-tests.ts
 *
 * No database, no network. Every time is an offset from now.
 */
import fs from "node:fs";
import path from "node:path";
import { LATE_CALLOUT_MS, calloutNotice, clubTodayYmd, fmtCountdown, isLateCallout, lateCalloutBanner } from "../lib/classStaff";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(label: string, got: T, want: T) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function section(name: string, fn: () => void) { console.log(`\n${name}`); fn(); }

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const now = new Date(Date.now());
const startIn = (ms: number) => new Date(now.getTime() + ms);

section("hours and minutes, counted down", () => {
  eq("1h 59m", fmtCountdown(HOUR + 59 * MIN), "1h 59m");
  eq("1h 59m 30s is still 1h 59m (it used to round up to 2h)", fmtCountdown(HOUR + 59 * MIN + 30 * SEC), "1h 59m");
  eq("1h 59m 59s is still 1h 59m", fmtCountdown(2 * HOUR - SEC), "1h 59m");
  eq("exactly two hours → 2h", fmtCountdown(2 * HOUR), "2h");
  eq("exactly one hour → 1h", fmtCountdown(HOUR), "1h");
  eq("under an hour → minutes only", fmtCountdown(45 * MIN), "45m");
  eq("59m 59s → 59m, not 1h", fmtCountdown(HOUR - SEC), "59m");
  eq("1h 20m", fmtCountdown(80 * MIN), "1h 20m");
  eq("1h 0m 40s → 1h (no stray minutes)", fmtCountdown(HOUR + 40 * SEC), "1h");
  eq("a negative span reads the same (time since)", fmtCountdown(-(HOUR + 59 * MIN + 30 * SEC)), "1h 59m");
  eq("3h 5m", fmtCountdown(3 * HOUR + 5 * MIN), "3h 5m");
});

section("the banner a late call-out carries", () => {
  eq("1h 59m before the start", lateCalloutBanner(startIn(HOUR + 59 * MIN), now), "LATE CALL-OUT — class starts in 1h 59m");
  eq("one second inside the window never reads 2h", lateCalloutBanner(startIn(LATE_CALLOUT_MS - SEC), now), "LATE CALL-OUT — class starts in 1h 59m");
  eq("45 minutes before", lateCalloutBanner(startIn(45 * MIN), now), "LATE CALL-OUT — class starts in 45m");
  eq("exactly an hour before", lateCalloutBanner(startIn(HOUR), now), "LATE CALL-OUT — class starts in 1h");
  eq("under a minute before", lateCalloutBanner(startIn(20 * SEC), now), "LATE CALL-OUT — class starts in under 1m");
  eq("just after the start", lateCalloutBanner(startIn(-20 * SEC), now), "LATE CALL-OUT — class has just started");
  eq("after the start", lateCalloutBanner(startIn(-(HOUR + 10 * MIN + 30 * SEC)), now), "LATE CALL-OUT — class started 1h 10m ago");
  for (let s = 1; s < 2 * 60 * 60; s += 61) {
    const start = startIn(LATE_CALLOUT_MS - s * SEC);
    if (isLateCallout(start, now) && / 2h/.test(lateCalloutBanner(start, now))) {
      check(`no late call-out reads "2h" (${s}s inside the window)`, false, lateCalloutBanner(start, now));
      return;
    }
  }
  check('no call-out inside the late window ever reads "2h"', true);
  check("exactly two hours out is not late at all (so there is no banner to round)", !isLateCallout(startIn(LATE_CALLOUT_MS), now));
});

section("the notice (in-app message + email share it)", () => {
  const today = clubTodayYmd(null, now);
  const n = calloutNotice({
    className: "Evening Group", dateYmd: today, startsAt: startIn(HOUR + 59 * MIN + 30 * SEC), coachName: "Sal Rivera",
    late: true, startInstant: startIn(HOUR + 59 * MIN + 30 * SEC), now, todayYmd: today,
  });
  eq("the banner", n.banner, "LATE CALL-OUT — class starts in 1h 59m");
  check("the body opens with it", n.body.startsWith("LATE CALL-OUT — class starts in 1h 59m. "), n.body);
  check("the subject says it is late", n.subject.startsWith("Late call-out: Evening Group today "), n.subject);
  const calm = calloutNotice({
    className: "Evening Group", dateYmd: today, startsAt: startIn(5 * HOUR), coachName: "Sal Rivera",
    late: false, startInstant: startIn(5 * HOUR), now, todayYmd: today,
  });
  eq("a call-out outside the window has no banner", calm.banner, null);
});

section("one formatter, every caller", () => {
  const root = path.join(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const lib = read("lib/classStaff.ts");
  check("fmtCountdown floors (no Math.round on the minutes)", /export function fmtCountdown[\s\S]{0,140}Math\.floor\(Math\.abs\(ms\) \/ 60000\)/.test(lib) && !/export function fmtCountdown[\s\S]{0,200}Math\.round/.test(lib));
  check("the banner is built from it", /export function lateCalloutBanner[\s\S]{0,420}fmtCountdown\(diff\)/.test(lib));
  check("the notices use the lib banner, not their own arithmetic", read("lib/classStaffNotify.ts").includes("notice.banner") && !/36e5|3_600_000|3600000/.test(read("lib/classStaffNotify.ts")));
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const own = [...walk("components/staff/schedule"), ...walk("app/dashboard/staff/schedule"), "lib/classStaffUi.ts", "lib/classStaffApi.ts"];
  const offenders = own.filter((f) => /starts in \$\{|Math\.(round|ceil)\([^)]*(36e5|3_?600_?000|\/ ?60)/.test(read(f)));
  eq("no staff-schedule screen formats a countdown of its own", offenders, []);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
