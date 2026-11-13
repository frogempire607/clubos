/**
 * The staff-change Review step names the ROLE a coach is being added in
 * (lib/classStaff.ts describeScopeChange → POST /api/classes/[id]/staffing/preview
 * → components/staff/schedule/ClassDaySheet "Review").
 *
 *   npx tsx scripts/staff-review-role-tests.ts
 *
 * No database, no network. Dates are offsets from today.
 */
import fs from "node:fs";
import path from "node:path";
import {
  addDaysYmd,
  clubTodayYmd,
  describeScopeChange,
  dowOfYmd,
  fmtDayShort,
  fmtMonthDay,
  roleLabel,
  type ChangeScope,
  type DayStaffRow,
  type DesiredStaff,
  type StaffRule,
} from "../lib/classStaff";

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

const PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const today = clubTodayYmd(null, new Date(Date.now()));
const start = addDaysYmd(today, -60); // the rules began two months ago
const day = addDaysYmd(today, 7); // the change is made for a class day next week
const dow = dowOfYmd(day);
const other = (dow + 2) % 7;
const classDays = [dow, other].sort((a, b) => a - b);

const NAMES: Record<string, string> = { sam: "Sam", kim: "Kim", lee: "Lee", pat: "Pat" };
const nameOf = (id: string) => NAMES[id] ?? id;
const rule = (id: string, userId: string, roleName: string | null = null, dayOfWeek: number | null = null): StaffRule =>
  ({ id, classId: "c1", userId, roleName, dayOfWeek, effectiveFrom: start, effectiveTo: null });
const row = (id: string, userId: string, roleName: string | null = null, status: DayStaffRow["status"] = "SCHEDULED"): DayStaffRow =>
  ({ id, sessionId: "s1", userId, roleName, kind: "REGULAR", status, source: "RULE", ruleId: null, replacesStaffId: null, lateCallout: false });

const rules = [rule("r1", "lee", "Head coach")];
const dayRows = [row("d1", "lee", "Head coach")];
const words = (scope: ChangeScope, desired: DesiredStaff[], currentDayStaff: DayStaffRow[] = dayRows, currentRules: StaffRule[] = rules) =>
  describeScopeChange({ scope, classDays, date: day, dayOfWeek: scope === "WEEKDAY_FORWARD" ? dow : undefined, currentRules, currentDayStaff, desired, nameOf });

section("one class day", () => {
  const w = words("OCCURRENCE", [{ userId: "lee" }, { userId: "sam", roleName: "Assistant coach" }]);
  eq("the heading", w.heading, `${fmtDayShort(day)} only`);
  eq("the added coach is named WITH the role", w.lines[0], "Sam is added as Assistant coach.");
  eq("the whole sentence", w.text, `${fmtDayShort(day)} only: Sam is added as Assistant coach. The recurring schedule is not changed.`);
  eq("no role chosen → the default role, said out loud", words("OCCURRENCE", [{ userId: "lee" }, { userId: "sam" }]).lines[0], `Sam is added as ${roleLabel(null)}.`);
  eq("a swap says the role the new coach takes", words("OCCURRENCE", [{ userId: "sam", roleName: "Assistant coach" }]).lines[0], "Sam replaces Lee as Assistant coach.");
  eq("two coaches, two roles → one sentence each",
    words("OCCURRENCE", [{ userId: "lee" }, { userId: "sam", roleName: "Assistant coach" }, { userId: "kim", roleName: "Volunteer" }]).lines.slice(0, 2),
    ["Sam is added as Assistant coach.", "Kim is added as Volunteer."]);
  eq("two coaches, one role → one sentence",
    words("OCCURRENCE", [{ userId: "lee" }, { userId: "sam", roleName: "Volunteer" }, { userId: "kim", roleName: "Volunteer" }]).lines[0],
    "Sam and Kim are added, each as Volunteer.");
  const back = words("OCCURRENCE", [{ userId: "lee" }, { userId: "pat", roleName: "Assistant coach" }], [...dayRows, row("d2", "pat", null, "REMOVED")]);
  eq("a coach put BACK on the day is named with the role too", back.lines[0], "Pat is added as Assistant coach.");
  eq("added ids are unchanged for the callers", w.added, ["sam"]);
});

section("recurring scopes", () => {
  const md = fmtMonthDay(day);
  const all = words("ALL_FUTURE", [{ userId: "lee" }, { userId: "sam", roleName: "Assistant coach" }]);
  eq("every class day", all.text, `Every class day from ${md}: Sam is added as Assistant coach. Class days already edited by hand keep their own coaches.`);
  const wk = words("WEEKDAY_FORWARD", [{ userId: "lee" }, { userId: "sam", roleName: "Volunteer" }]);
  eq("one weekday going forward", wk.text, `${PLURAL[dow]} from ${md}: Sam is added as Volunteer. Class days already edited by hand keep their own coaches.`);
  const swap = words("WEEKDAY_FORWARD", [{ userId: "sam", roleName: "Assistant coach" }]);
  eq("a weekday swap", swap.lines.slice(0, 2), ["Sam replaces Lee as Assistant coach.", `Lee stays on ${PLURAL[other]}.`]);
  eq("no role chosen → the default role", words("ALL_FUTURE", [{ userId: "lee" }, { userId: "sam" }]).lines[0], `Sam is added as ${roleLabel(null)}.`);
});

section("what did not change", () => {
  eq("a role change on someone already there still reads as a role change", words("OCCURRENCE", [{ userId: "lee", roleName: "Assistant coach" }]).lines[0], "Lee becomes Assistant coach.");
  eq("taking someone off names no role", words("OCCURRENCE", [{ userId: "lee" }], [...dayRows, row("d2", "sam", "Volunteer")]).lines[0], "Sam comes off.");
  const same = words("OCCURRENCE", [{ userId: "lee" }]);
  eq("no change is still no change", [same.changed, same.text], [false, `${fmtDayShort(day)} only: no change.`]);
});

section("wiring", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const lib = read("lib/classStaff.ts");
  check("the role comes from the one role-label helper", /const as = \(id: string\) => roleLabel\(addedRole\.get\(id\)\)/.test(lib));
  check("the preview route sends these lines to the screen", /plan: \{ heading: words\.heading, lines: words\.lines, text: words\.text \}/.test(read("app/api/classes/[id]/staffing/preview/route.ts")));
  const sheet = read("components/staff/schedule/ClassDaySheet.tsx");
  check("the Review step prints them as they come", sheet.includes("title = `Review — ${className}`") && /p\.plan\.lines\.map\(\(l, i\) => \(/.test(sheet));
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
