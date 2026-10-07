/**
 * Class coach assignments — the pure rules (lib/classStaff.ts).
 *
 *   npx tsx scripts/class-staff-tests.ts
 *
 * No database, no network. Pins: the switch-on seam (legacy before the date,
 * rows after), additive recurring rules, the three edit scopes including the
 * weekday split, materialization that never touches a manual / coverage /
 * ended day, the late call-out boundary, conflict detection, the cancellation
 * audience, the switch-on planner's idempotency, and the dual-write values.
 */
import { effectiveClassStaff } from "../lib/staffAssignments";
import {
  CLASS_STAFF_ROLES,
  DEFAULT_SCHEDULE_SETTINGS,
  LATE_CALLOUT_MS,
  SUBSTITUTE_ROLE_NAME,
  addDaysYmd,
  applyRuleOps,
  classStartInstant,
  clubTodayYmd,
  coachingUserIds,
  dowOfYmd,
  effectiveStaffForSession,
  findStaffConflicts,
  fmtTimeRange,
  groupRecipientsByEmail,
  instantToWallClock,
  isLateCallout,
  isSwitchedOn,
  legacyOverrideFor,
  legacySeriesStaffIds,
  makeStaffResolver,
  mergeAudience,
  normalizeScheduleSettings,
  pickCoverageRecipients,
  planDayEdit,
  planDayStaff,
  planEndUserRules,
  planScopeChange,
  planSwitchOn,
  proposedSlot,
  roleLabel,
  ruleOccurrenceSlots,
  rulesForDay,
  sessionCountsForPay,
  summarizeConflicts,
  type BusySlot,
  type DayStaffRow,
  type StaffRule,
  type SwitchOnSession,
} from "../lib/classStaff";

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

const NY = "America/New_York";

let ruleN = 0;
const rule = (userId: string, o: Partial<StaffRule> = {}): StaffRule => ({
  id: o.id ?? `r${++ruleN}`, classId: "c1", userId, roleName: null, dayOfWeek: null,
  effectiveFrom: "2026-10-12", effectiveTo: null, ...o,
});
let rowN = 0;
const row = (userId: string, o: Partial<DayStaffRow> = {}): DayStaffRow => ({
  id: o.id ?? `s${++rowN}`, sessionId: "cs1", userId, roleName: null, kind: "REGULAR", status: "SCHEDULED",
  source: "RULE", ruleId: null, replacesStaffId: null, lateCallout: false, ...o,
});
const ids = (xs: { userId: string }[]) => xs.map((x) => x.userId);

// ── Roles ───────────────────────────────────────────────────────────────────
section("Roles");
eq("the standard role list, as display names", CLASS_STAFF_ROLES.map((r) => r.label), ["Lead Coach", "Assistant Coach", "Substitute", "Volunteer"]);
eq("a row with no role shows as Coach", [roleLabel(null), roleLabel("  "), roleLabel("Lead Coach")], ["Coach", "Coach", "Lead Coach"]);
eq("a substitute defaults to the Substitute role", SUBSTITUTE_ROLE_NAME, "Substitute");

// ── The switch-on seam ──────────────────────────────────────────────────────
section("Switch-on date");
check("null start date = never switched on", !isSwitchedOn(null, "2030-01-01"));
check("the day before is legacy", !isSwitchedOn("2026-10-12", "2026-10-11"));
check("the switch-on day itself is new", isSwitchedOn("2026-10-12", "2026-10-12"));
check("later days are new", isSwitchedOn("2026-10-12", "2027-01-01"));

section("Resolver — a legacy day is EXACTLY effectiveClassStaff");
{
  const cases: [unknown, unknown][] = [
    [["julian", "sal"], null], [["julian"], undefined], [["julian"], []], [["julian"], ["sal"]],
    ["nope", null], [[1, "a", null, ""], null], [["a"], "junk"], [[], ["x", "x", 3]],
  ];
  for (const startOn of [null, "2026-10-12"]) {
    for (const [series, over] of cases) {
      const legacy = effectiveClassStaff(series, over);
      const got = effectiveStaffForSession({
        assignmentsStartOn: startOn, dateYmd: "2026-10-11", seriesStaffIds: series, staffOverride: over,
        // Rows on a legacy day must be ignored even if some exist.
        rows: [row("ghost")],
      });
      eq(`start ${startOn ?? "null"} · series ${JSON.stringify(series)} · override ${JSON.stringify(over)}`,
        { staffIds: got.staffIds, isSubstitute: got.isSubstitute }, legacy);
    }
  }
  const leg = effectiveStaffForSession({ assignmentsStartOn: null, dateYmd: "2026-10-20", rows: [], seriesStaffIds: ["a", "b"], staffOverride: null });
  check("legacy rows are synthetic SCHEDULED rows with no id", leg.rows.length === 2 && leg.rows.every((r) => r.id === null && r.status === "SCHEDULED" && r.source === "LEGACY"));
  check("legacy day is not 'switched'", leg.switched === false && leg.needsCoverage === false);
}

section("Resolver — a day on/after the switch-on date follows its rows");
{
  const orig = row("sal", { id: "o1", status: "REPLACED" });
  const rows = [
    row("julian", { roleName: "Lead Coach" }),
    orig,
    row("adrian", { kind: "SUBSTITUTE", source: "MANUAL", replacesStaffId: "o1", roleName: "Substitute" }),
    row("mia", { status: "NEEDS_COVERAGE", lateCallout: true }),
    row("noah", { status: "NO_SHOW" }),
    row("zoe", { status: "REMOVED" }),
  ];
  const eff = effectiveStaffForSession({ assignmentsStartOn: "2026-10-12", dateYmd: "2026-10-12", rows, seriesStaffIds: ["legacy-only"], staffOverride: ["legacy-override"] });
  eq("only SCHEDULED rows coach — the substitute is in, the replaced / called-out / no-show / removed coaches are out", eff.staffIds, ["julian", "adrian"]);
  check("the legacy lists are ignored", !eff.staffIds.includes("legacy-only") && !eff.staffIds.includes("legacy-override"));
  check("every row is still returned, with its status", eff.rows.length === 6 && eff.rows[3].status === "NEEDS_COVERAGE" && eff.rows[3].lateCallout === true);
  check("needsCoverage is flagged", eff.needsCoverage === true);
  check("a substitute makes it a one-day change", eff.isSubstitute === true);
  eq("no rows = nobody (never falls back to the series)",
    effectiveStaffForSession({ assignmentsStartOn: "2026-10-12", dateYmd: "2026-10-13", rows: [], seriesStaffIds: ["julian"], staffOverride: null }).staffIds, []);
  const plain = effectiveStaffForSession({ assignmentsStartOn: "2026-10-12", dateYmd: "2026-10-13", rows: [row("julian"), row("sal")], seriesStaffIds: [], staffOverride: null });
  check("plain rule rows are not a one-day change", plain.isSubstitute === false && plain.needsCoverage === false);
  eq("…and they are the day's recurring coaches", plain.seriesStaffIds, ["julian", "sal"]);
  check("a hand-edited day is a one-day change", effectiveStaffForSession({ assignmentsStartOn: "2026-10-12", dateYmd: "2026-10-13", rows: [row("julian")], seriesStaffIds: [], staffOverride: null, staffManual: true }).isSubstitute);
  eq("coachingUserIds dedupes", coachingUserIds([row("a"), row("a"), row("b", { status: "REMOVED" })]), ["a"]);
}

section("Does a class day count for pay?");
check("legacy day: not canceled counts — even in the future (unchanged behaviour)", sessionCountsForPay({ switched: false, canceled: false, ended: false }));
check("legacy day: canceled never counts, even if marked paid", !sessionCountsForPay({ switched: false, canceled: true, cancelPaid: true, ended: true }));
check("new day: a class that has not ended never counts", !sessionCountsForPay({ switched: true, canceled: false, ended: false }));
check("new day: ended and not canceled counts", sessionCountsForPay({ switched: true, canceled: false, ended: true }));
check("new day: canceled does not count", !sessionCountsForPay({ switched: true, canceled: true, cancelPaid: false, ended: true }));
check("new day: canceled but paid counts", sessionCountsForPay({ switched: true, canceled: true, cancelPaid: true, ended: true }));
check("new day: canceled-but-paid still waits for the end time", !sessionCountsForPay({ switched: true, canceled: true, cancelPaid: true, ended: false }));
{
  const r = makeStaffResolver({ assignmentsStartOn: "2026-10-12", timezone: NY, rows: [row("julian", { sessionId: "x1" })] });
  // 6:00–7:00 PM wall clock on Oct 13 in New York ends at 23:00Z.
  const s = { date: new Date("2026-10-13T00:00:00Z"), endsAt: new Date("2026-10-13T19:00:00Z"), canceled: false };
  check("resolver: not yet ended at 6:59 PM club time", !r.countsForPay(s, new Date("2026-10-13T22:59:00Z")));
  check("resolver: ended at 7:00 PM club time", r.countsForPay(s, new Date("2026-10-13T23:00:00Z")));
  check("resolver: the raw stamp (19:00Z) is NOT used as an instant", !r.countsForPay(s, new Date("2026-10-13T19:30:00Z")));
  const before = { date: new Date("2026-10-11T00:00:00Z"), endsAt: new Date("2026-10-11T19:00:00Z"), canceled: false };
  check("resolver: a legacy day counts whatever the clock says", r.countsForPay(before, new Date("2026-01-01T00:00:00Z")));
  eq("resolver: rows are found by session id", r.forSession({ id: "x1", date: "2026-10-13" }, ["zzz"]).staffIds, ["julian"]);
  eq("resolver: a legacy session uses the lists", r.forSession({ id: "x1", date: "2026-10-01", staffOverride: null }, ["zzz"]).staffIds, ["zzz"]);
}

// ── Rules ───────────────────────────────────────────────────────────────────
section("rulesForDay — additive per coach");
{
  const rules = [
    rule("sal"),
    rule("adrian", { dayOfWeek: 2 }),
    rule("mia", { effectiveFrom: "2026-11-01" }),
    rule("noah", { effectiveTo: "2026-10-20" }),
  ];
  eq("Tuesday: the all-days coaches AND the Tuesday coach", ids(rulesForDay(rules, "2026-10-13")), ["sal", "adrian", "noah"]);
  eq("Wednesday: the Tuesday coach is not on", ids(rulesForDay(rules, "2026-10-14")), ["sal", "noah"]);
  eq("effectiveTo is inclusive", ids(rulesForDay(rules, "2026-10-20")), ["sal", "adrian", "noah"]);
  eq("…and the day after it is off", ids(rulesForDay(rules, "2026-10-21")), ["sal"]);
  eq("effectiveFrom is inclusive", ids(rulesForDay(rules, "2026-11-01")), ["sal", "mia"]);
  eq("before any rule starts: nobody", rulesForDay(rules, "2026-10-11"), []);
  const two = [rule("sal", { id: "all", roleName: "Assistant Coach" }), rule("sal", { id: "tue", dayOfWeek: 2, roleName: "Lead Coach" })];
  eq("one coach, two rules: listed once, the weekday rule decides the role", rulesForDay(two, "2026-10-13"), [{ userId: "sal", roleName: "Lead Coach", ruleId: "tue" }]);
  eq("…and on other days the all-days rule does", rulesForDay(two, "2026-10-14"), [{ userId: "sal", roleName: "Assistant Coach", ruleId: "all" }]);
  check("weekday comes from the date (2026-10-13 is a Tuesday)", dowOfYmd("2026-10-13") === 2);
}

section("Scope: this occurrence only");
{
  const rows = [row("julian", { id: "a" }), row("sal", { id: "b" })];
  const plan = planScopeChange({ scope: "OCCURRENCE", classDays: [1, 2, 4], date: "2026-10-13", currentRules: [rule("julian"), rule("sal")], currentDayStaff: rows, desired: [{ userId: "julian" }, { userId: "adrian" }] });
  eq("no rule changes", plan.ruleOps, []);
  eq("sal comes off, adrian goes on", plan.dayOps, [{ op: "remove", rowId: "b", userId: "sal" }, { op: "create", userId: "adrian", roleName: null }]);
  eq("same list → nothing to do", planDayEdit(rows, [{ userId: "sal" }, { userId: "julian" }]), []);
  eq("a role change is a role op", planDayEdit(rows, [{ userId: "julian", roleName: " Lead Coach " }, { userId: "sal" }]), [{ op: "role", rowId: "a", userId: "julian", roleName: "Lead Coach" }]);
  eq("role undefined keeps the role; null clears it",
    planDayEdit([row("julian", { id: "a", roleName: "Lead Coach" })], [{ userId: "julian", roleName: null }]), [{ op: "role", rowId: "a", userId: "julian", roleName: null }]);
  eq("a removed coach put back is restored, not duplicated",
    planDayEdit([row("julian", { id: "a", status: "REMOVED" })], [{ userId: "julian" }]), [{ op: "restore", rowId: "a", userId: "julian", roleName: null }]);
  eq("a coach waiting for cover who is not in the list is left waiting",
    planDayEdit([row("julian", { id: "a" }), row("mia", { id: "m", status: "NEEDS_COVERAGE" })], [{ userId: "julian" }]), []);
  const covered = [row("sal", { id: "o", status: "REPLACED" }), row("adrian", { id: "s", kind: "SUBSTITUTE", source: "MANUAL", replacesStaffId: "o" })];
  eq("taking the substitute off re-opens the coach they covered",
    planDayEdit(covered, []), [{ op: "remove", rowId: "s", userId: "adrian" }, { op: "reopen", rowId: "o", userId: "sal" }]);
  eq("keeping the substitute leaves the replaced coach replaced", planDayEdit(covered, [{ userId: "adrian" }]), []);
  eq("putting the replaced coach back restores them and does not re-open",
    planDayEdit(covered, [{ userId: "sal" }]), [{ op: "restore", rowId: "o", userId: "sal", roleName: null }, { op: "remove", rowId: "s", userId: "adrian" }]);
  eq("duplicates and blanks in the wanted list are ignored",
    planDayEdit([], [{ userId: "a" }, { userId: "a" }, { userId: "" }]), [{ op: "create", userId: "a", roleName: null }]);
}

section("Scope: this weekday going forward — the split");
{
  // Class runs Mon/Tue/Thu. Sal coaches every class day. From Tue Oct 20: Adrian instead of Sal on Tuesdays.
  const sal = rule("sal", { id: "sal-all", effectiveFrom: "2026-10-12", roleName: "Lead Coach" });
  const julian = rule("julian", { id: "jul-all", effectiveFrom: "2026-10-12" });
  const rules = [sal, julian];
  const plan = planScopeChange({
    scope: "WEEKDAY_FORWARD", classDays: [1, 2, 4], date: "2026-10-20", currentRules: rules, currentDayStaff: [],
    desired: [{ userId: "julian" }, { userId: "adrian" }],
  });
  eq("exact mutations", plan.ruleOps, [
    { op: "end", ruleId: "sal-all", effectiveTo: "2026-10-19" },
    { op: "create", userId: "sal", roleName: "Lead Coach", dayOfWeek: 1, effectiveFrom: "2026-10-20", effectiveTo: null },
    { op: "create", userId: "sal", roleName: "Lead Coach", dayOfWeek: 4, effectiveFrom: "2026-10-20", effectiveTo: null },
    { op: "create", userId: "adrian", roleName: null, dayOfWeek: 2, effectiveFrom: "2026-10-20", effectiveTo: null },
  ]);
  eq("no day ops for a rule scope", plan.dayOps, []);
  const after = applyRuleOps(rules, plan.ruleOps);
  eq("Mon Oct 19 (before): unchanged", ids(rulesForDay(after, "2026-10-19")), ["sal", "julian"]);
  eq("Tue Oct 13 (before): Sal still on Tuesdays", ids(rulesForDay(after, "2026-10-13")), ["sal", "julian"]);
  eq("Tue Oct 20: Julian + Adrian, no Sal", ids(rulesForDay(after, "2026-10-20")).sort(), ["adrian", "julian"]);
  eq("Thu Oct 22: Sal keeps Thursdays", ids(rulesForDay(after, "2026-10-22")).sort(), ["julian", "sal"]);
  eq("Mon Oct 26: Sal keeps Mondays", ids(rulesForDay(after, "2026-10-26")).sort(), ["julian", "sal"]);
  eq("Tue a year on: still Julian + Adrian", ids(rulesForDay(after, "2027-10-19")).sort(), ["adrian", "julian"]);
  eq("Sal keeps his role on the days he keeps", rulesForDay(after, "2026-10-22").find((r) => r.userId === "sal")?.roleName, "Lead Coach");
  // Asking for what is already true changes nothing.
  eq("idempotent: the same request again plans nothing",
    planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [1, 2, 4], date: "2026-10-20", currentRules: after, currentDayStaff: [], desired: [{ userId: "julian" }, { userId: "adrian" }] }).ruleOps, []);
  eq("…and so does asking for today's Tuesday list before any change",
    planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [1, 2, 4], date: "2026-10-20", currentRules: rules, currentDayStaff: [], desired: [{ userId: "sal" }, { userId: "julian" }] }).ruleOps, []);

  // Every weekday for 10 weeks: only Tuesdays from Oct 20 differ from before.
  let wrong = 0;
  for (let i = 0; i < 70; i++) {
    const day = addDaysYmd("2026-10-12", i);
    const b = ids(rulesForDay(rules, day)).sort().join();
    const a = ids(rulesForDay(after, day)).sort().join();
    const isChangedTue = dowOfYmd(day) === 2 && day >= "2026-10-20";
    const classDay = [1, 2, 4].includes(dowOfYmd(day));
    if (!classDay) continue;
    if (isChangedTue ? a !== "adrian,julian" : a !== b) wrong++;
  }
  check("across 10 weeks only Tuesdays from Oct 20 change", wrong === 0, `${wrong} class day(s) wrong`);

  // A weekday rule that has not started yet is deleted, not ended backwards.
  const future = [rule("mia", { id: "mia-tue", dayOfWeek: 2, effectiveFrom: "2026-11-03" })];
  eq("a rule that starts after the change date is deleted",
    planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [2], date: "2026-10-20", currentRules: future, currentDayStaff: [], desired: [] }).ruleOps, [{ op: "delete", ruleId: "mia-tue" }]);
  // A dated all-days rule keeps its end date on the days it keeps.
  const dated = [rule("noah", { id: "noah-all", effectiveFrom: "2026-10-12", effectiveTo: "2026-12-31" })];
  eq("an all-days rule with an end date keeps that end on its other weekdays",
    planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [2, 4], date: "2026-10-20", currentRules: dated, currentDayStaff: [], desired: [] }).ruleOps, [
      { op: "end", ruleId: "noah-all", effectiveTo: "2026-10-19" },
      { op: "create", userId: "noah", roleName: null, dayOfWeek: 4, effectiveFrom: "2026-10-20", effectiveTo: "2026-12-31" },
    ]);
  // Other weekdays' own rules are not touched.
  const thu = [rule("zoe", { id: "zoe-thu", dayOfWeek: 4 })];
  eq("another weekday's rule is left alone",
    planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [2, 4], date: "2026-10-20", currentRules: thu, currentDayStaff: [], desired: [{ userId: "adrian" }] }).ruleOps,
    [{ op: "create", userId: "adrian", roleName: null, dayOfWeek: 2, effectiveFrom: "2026-10-20", effectiveTo: null }]);
  // A role change on one weekday: the old rule is cut, earlier days keep the old role.
  const roleChange = planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [1, 2], date: "2026-10-20", currentRules: [sal], currentDayStaff: [], desired: [{ userId: "sal", roleName: "Assistant Coach" }] });
  const rc = applyRuleOps([sal], roleChange.ruleOps);
  eq("role change on Tuesdays: new role from the date", rulesForDay(rc, "2026-10-20")[0]?.roleName, "Assistant Coach");
  eq("…old role on earlier Tuesdays", rulesForDay(rc, "2026-10-13")[0]?.roleName, "Lead Coach");
  eq("…and still the old role on Mondays", rulesForDay(rc, "2026-10-26")[0]?.roleName, "Lead Coach");
  // Explicit weekday different from the date's own weekday.
  const explicit = planScopeChange({ scope: "WEEKDAY_FORWARD", classDays: [1, 4], date: "2026-10-20", dayOfWeek: 4, currentRules: [julian], currentDayStaff: [], desired: [] });
  eq("dayOfWeek can be named explicitly", ids(rulesForDay(applyRuleOps([julian], explicit.ruleOps), "2026-10-22")), []);
  eq("…leaving the other weekday on", ids(rulesForDay(applyRuleOps([julian], explicit.ruleOps), "2026-10-26")), ["julian"]);
}

section("Scope: all future occurrences");
{
  const rules = [
    rule("sal", { id: "sal-all", roleName: "Lead Coach" }),
    rule("julian", { id: "jul-all" }),
    rule("adrian", { id: "adr-tue", dayOfWeek: 2, effectiveFrom: "2026-10-20" }),
    rule("mia", { id: "mia-old", effectiveFrom: "2026-10-12", effectiveTo: "2026-10-15" }),
  ];
  const plan = planScopeChange({ scope: "ALL_FUTURE", classDays: [1, 2, 4], date: "2026-10-26", currentRules: rules, currentDayStaff: [], desired: [{ userId: "sal" }, { userId: "zoe", roleName: "Assistant Coach" }] });
  eq("exact mutations", plan.ruleOps, [
    { op: "end", ruleId: "jul-all", effectiveTo: "2026-10-25" },
    { op: "end", ruleId: "adr-tue", effectiveTo: "2026-10-25" },
    { op: "create", userId: "zoe", roleName: "Assistant Coach", dayOfWeek: null, effectiveFrom: "2026-10-26", effectiveTo: null },
  ]);
  const after = applyRuleOps(rules, plan.ruleOps);
  let wrong = 0;
  for (let i = 0; i < 56; i++) {
    const day = addDaysYmd("2026-10-26", i);
    if (ids(rulesForDay(after, day)).sort().join() !== "sal,zoe") wrong++;
  }
  check("every day from the date is exactly the wanted list (weekday rules included)", wrong === 0);
  eq("days before the date are untouched", ids(rulesForDay(after, "2026-10-20")).sort(), ids(rulesForDay(rules, "2026-10-20")).sort());
  eq("an already-ended rule is never touched", plan.ruleOps.some((o) => "ruleId" in o && o.ruleId === "mia-old"), false);
  eq("idempotent", planScopeChange({ scope: "ALL_FUTURE", classDays: [1, 2, 4], date: "2026-10-26", currentRules: after, currentDayStaff: [], desired: [{ userId: "sal" }, { userId: "zoe" }] }).ruleOps, []);
  eq("empty list ends everyone", ids(rulesForDay(applyRuleOps(rules, planScopeChange({ scope: "ALL_FUTURE", classDays: [1], date: "2026-10-26", currentRules: rules, currentDayStaff: [], desired: [] }).ruleOps), "2026-11-03")), []);
  eq("a rule starting on the date is deleted, not ended the day before it began",
    planScopeChange({ scope: "ALL_FUTURE", classDays: [1], date: "2026-10-12", currentRules: [rule("x", { id: "x1" })], currentDayStaff: [], desired: [] }).ruleOps, [{ op: "delete", ruleId: "x1" }]);
}

section("One coach off the recurring list");
{
  const rules = [rule("sal", { id: "a" }), rule("sal", { id: "b", dayOfWeek: 2, effectiveFrom: "2026-11-01" }), rule("julian", { id: "c" }), rule("sal", { id: "d", effectiveTo: "2026-10-13" })];
  eq("only that coach's live rules are cut", planEndUserRules(rules, "sal", "2026-10-20"), [{ op: "end", ruleId: "a", effectiveTo: "2026-10-19" }, { op: "delete", ruleId: "b" }]);
}

// ── Materialization ─────────────────────────────────────────────────────────
section("Materialization — rules → one day's rows");
{
  const rules = [rule("sal", { id: "rs", roleName: "Lead Coach" }), rule("adrian", { id: "ra", dayOfWeek: 2 })];
  const open = { dateYmd: "2026-10-13", staffManual: false, ended: false };
  eq("an empty day gets the rule rows", planDayStaff({ session: open, rules, existingRows: [] }),
    { create: [{ userId: "sal", roleName: "Lead Coach", ruleId: "rs" }, { userId: "adrian", roleName: null, ruleId: "ra" }], update: [], deleteIds: [] });
  eq("already right → nothing", planDayStaff({ session: open, rules, existingRows: [row("sal", { roleName: "Lead Coach", ruleId: "rs" }), row("adrian", { ruleId: "ra" })] }), { create: [], update: [], deleteIds: [] });
  eq("a rule row nobody's rule implies any more is deleted",
    planDayStaff({ session: open, rules, existingRows: [row("sal", { roleName: "Lead Coach", ruleId: "rs" }), row("adrian", { ruleId: "ra" }), row("old", { id: "gone" })] }).deleteIds, ["gone"]);
  eq("a stale role / rule pointer is updated",
    planDayStaff({ session: open, rules, existingRows: [row("sal", { id: "x", roleName: null, ruleId: "old" }), row("adrian", { ruleId: "ra" })] }).update, [{ id: "x", roleName: "Lead Coach", ruleId: "rs" }]);
  const full = [row("old-rule", { id: "p0" })];
  eq("NEVER touches a day edited by hand", planDayStaff({ session: { ...open, staffManual: true }, rules, existingRows: full }), { create: [], update: [], deleteIds: [] });
  eq("NEVER touches a day that has ended", planDayStaff({ session: { ...open, ended: true }, rules, existingRows: full }), { create: [], update: [], deleteIds: [] });
  const guarded = [
    row("mia", { id: "p1", status: "NEEDS_COVERAGE" }),
    row("noah", { id: "p2", status: "REPLACED" }),
    row("zoe", { id: "p3", status: "NO_SHOW" }),
    row("ben", { id: "p4", status: "REMOVED" }),
    row("cal", { id: "p5", kind: "SUBSTITUTE", source: "MANUAL", replacesStaffId: "p2" }),
    row("dee", { id: "p6", source: "MANUAL" }),
  ];
  const g = planDayStaff({ session: open, rules, existingRows: guarded });
  eq("coverage / no-show / removed / substitute / manual rows are never deleted", g.deleteIds, []);
  eq("…or altered", g.update, []);
  // A coach the rules want who already has a protected row is left exactly as they are.
  const salOut = planDayStaff({ session: open, rules, existingRows: [row("sal", { id: "so", status: "NEEDS_COVERAGE" })] });
  eq("a called-out coach is not re-added or reset by the rules", { create: ids(salOut.create), update: salOut.update, del: salOut.deleteIds }, { create: ["adrian"], update: [], del: [] });
  const salRemoved = planDayStaff({ session: open, rules, existingRows: [row("sal", { id: "sr", status: "REMOVED", source: "MANUAL" })] });
  eq("a coach taken off by hand stays off", ids(salRemoved.create), ["adrian"]);
  eq("Wednesday: the Tuesday-only coach's row is removed", planDayStaff({ session: { ...open, dateYmd: "2026-10-14" }, rules, existingRows: [row("sal", { roleName: "Lead Coach", ruleId: "rs" }), row("adrian", { id: "tue", ruleId: "ra" })] }).deleteIds, ["tue"]);
}

// ── Dual-write ──────────────────────────────────────────────────────────────
section("Legacy mirror (dual-write) values");
{
  const rules = [
    rule("sal", { effectiveFrom: "2026-10-12" }),
    rule("adrian", { dayOfWeek: 2, effectiveFrom: "2026-10-12" }),
    rule("mia", { effectiveFrom: "2026-10-12", effectiveTo: "2026-10-18" }),
    rule("noah", { effectiveFrom: "2026-12-01" }),
  ];
  eq("assignedStaffIds = coaches with a rule in force that day, any weekday", legacySeriesStaffIds(rules, "2026-10-14"), ["sal", "adrian", "mia"]);
  eq("…an ended rule drops out, a future one is not in yet", legacySeriesStaffIds(rules, "2026-10-19"), ["sal", "adrian"]);
  eq("…and joins when it starts", legacySeriesStaffIds(rules, "2026-12-01"), ["sal", "adrian", "noah"]);
  eq("a class whose rules all start later is not blank until then", legacySeriesStaffIds([rule("zoe", { effectiveFrom: "2027-01-05" }), rule("ben", { effectiveFrom: "2027-02-01" })], "2026-10-14"), ["zoe"]);
  eq("no rules → []", legacySeriesStaffIds([], "2026-10-14"), []);
  eq("staffOverride = null when the day matches the series (any order)", legacyOverrideFor(["b", "a"], ["a", "b"]), null);
  eq("staffOverride = the SCHEDULED list when it differs", legacyOverrideFor(["a", "c"], ["a", "b"]), ["a", "c"]);
  eq("staffOverride = [] when nobody is on a class that has coaches", legacyOverrideFor([], ["a"]), []);
  eq("both empty → null", legacyOverrideFor([], []), null);
  // The point of the formula: a legacy reader gets the truth.
  for (const [sched, series] of [[["a"], ["a", "b"]], [[], ["a"]], [["a", "b"], ["b", "a"]], [["x"], []]] as [string[], string[]][]) {
    const got = effectiveClassStaff(series, legacyOverrideFor(sched, series)).staffIds.slice().sort();
    eq(`legacy reader sees the SCHEDULED set ${JSON.stringify(sched)} given series ${JSON.stringify(series)}`, got, sched.slice().sort());
  }
}

// ── Late call-out ───────────────────────────────────────────────────────────
section("Late call-out (< 2 hours before the real start)");
{
  // A 6:00 PM class on Tue Oct 13 2026 in New York (EDT, UTC-4) really starts at 22:00Z.
  const start = classStartInstant(new Date("2026-10-13T18:00:00Z"), NY);
  eq("the start instant goes through the club timezone", start.toISOString(), "2026-10-13T22:00:00.000Z");
  check("3 hours before: not late", !isLateCallout(start, new Date("2026-10-13T19:00:00Z")));
  check("EXACTLY 2 hours before: not late", !isLateCallout(start, new Date("2026-10-13T20:00:00.000Z")));
  check("1 ms inside 2 hours: late", isLateCallout(start, new Date("2026-10-13T20:00:00.001Z")));
  check("1 minute before: late", isLateCallout(start, new Date("2026-10-13T21:59:00Z")));
  check("after the start: late", isLateCallout(start, new Date("2026-10-13T22:30:00Z")));
  check("the raw wall-clock stamp is not the start (4pm club time is not late for a 6pm class)", !isLateCallout(start, new Date("2026-10-13T18:00:00Z")));
  eq("the window is 2 hours", LATE_CALLOUT_MS, 7200000);
  // DST: clocks fall back Sun Nov 1 2026. A 9:00 AM class that day is 14:00Z (EST, UTC-5);
  // the day before it was 13:00Z.
  const dst = classStartInstant(new Date("2026-11-01T09:00:00Z"), NY);
  eq("fall-back day: 9 AM is 14:00Z", dst.toISOString(), "2026-11-01T14:00:00.000Z");
  eq("the day before: 9 AM was 13:00Z", classStartInstant(new Date("2026-10-31T09:00:00Z"), NY).toISOString(), "2026-10-31T13:00:00.000Z");
  check("fall-back day: exactly 2 real hours before is not late", !isLateCallout(dst, new Date("2026-11-01T12:00:00Z")));
  check("fall-back day: 1 second inside is late", isLateCallout(dst, new Date("2026-11-01T12:00:01Z")));
  // Spring forward Sun Mar 14 2027: 9:00 AM is 13:00Z (EDT).
  const spring = classStartInstant(new Date("2027-03-14T09:00:00Z"), NY);
  eq("spring-forward day: 9 AM is 13:00Z", spring.toISOString(), "2027-03-14T13:00:00.000Z");
  check("spring-forward day: boundary holds", !isLateCallout(spring, new Date("2027-03-14T11:00:00Z")) && isLateCallout(spring, new Date("2027-03-14T11:00:00.001Z")));
  eq("no club timezone: the stamp is used as-is", classStartInstant(new Date("2026-10-13T18:00:00Z"), null).toISOString(), "2026-10-13T18:00:00.000Z");
  eq("club 'today' follows the club clock (11pm Eastern is still the 13th)", clubTodayYmd(NY, new Date("2026-10-14T03:00:00Z")), "2026-10-13");
}

// ── Conflicts ───────────────────────────────────────────────────────────────
section("Conflict detection");
{
  const p = proposedSlot("2026-10-14", "18:00", "19:00", NY); // Wed 6–7 PM = 22:00–23:00Z
  eq("a proposed slot is real instants", [new Date(p.startMs).toISOString(), new Date(p.endMs).toISOString()], ["2026-10-14T22:00:00.000Z", "2026-10-14T23:00:00.000Z"]);
  const cls = (id: string, startTime: string, endTime: string, date = "2026-10-14"): BusySlot => {
    const s = proposedSlot(date, startTime, endTime, NY);
    return { kind: "CLASS", id, name: "Evening Group", startMs: s.startMs, endMs: s.endMs, date, startTime, endTime };
  };
  eq("overlapping class day", findStaffConflicts([p], [cls("x", "18:30", "19:30")]).map((c) => [c.severity, c.kind, c.id]), [["overlap", "CLASS", "x"]]);
  eq("touching end-to-start is not a conflict", findStaffConflicts([p], [cls("x", "19:00", "20:00"), cls("y", "17:00", "18:00")]), []);
  eq("a class on another day is not a conflict", findStaffConflicts([p], [cls("x", "18:00", "19:00", "2026-10-15")]), []);
  // An event stored as true instants: 6:30–8:00 PM Eastern = 22:30Z–00:00Z.
  const evStart = new Date("2026-10-14T22:30:00Z");
  const evEnd = new Date("2026-10-15T00:00:00Z");
  const wall = instantToWallClock(evStart, NY);
  eq("an event instant is labelled on the club's wall clock", wall, { date: "2026-10-14", time: "18:30" });
  const ev: BusySlot = { kind: "EVENT", id: "e1", name: "Fall Camp", startMs: evStart.getTime(), endMs: evEnd.getTime(), date: wall.date, startTime: wall.time, endTime: instantToWallClock(evEnd, NY).time };
  eq("an event (true instants) overlapping a class (wall clock) is caught in one frame", findStaffConflicts([p], [ev]).map((c) => c.kind), ["EVENT"]);
  // The same wall-clock digits as instants (18:30Z = 2:30 PM Eastern) must NOT collide.
  const naive: BusySlot = { ...ev, id: "e2", startMs: new Date("2026-10-14T18:30:00Z").getTime(), endMs: new Date("2026-10-14T19:30:00Z").getTime() };
  eq("…and is not confused by matching digits in the wrong frame", findStaffConflicts([p], [naive]), []);
  const lesson: BusySlot = { kind: "PRIVATE_LESSON", id: "pb1", name: "Private lesson (1-on-1)", startMs: p.startMs - 30 * 60000, endMs: p.startMs + 30 * 60000, date: "2026-10-14", startTime: "17:30", endTime: "18:30" };
  eq("a confirmed private lesson overlapping is caught", findStaffConflicts([p], [lesson]).map((c) => c.kind), ["PRIVATE_LESSON"]);
  // Availability: softer warning.
  const weekly = [{ dayOfWeek: 3, startTime: "16:00", endTime: "18:30", active: true }];
  const av = findStaffConflicts([p], [], { slots: weekly, exceptions: [] });
  eq("outside saved hours is an availability warning, not an overlap", av.map((c) => [c.severity, c.kind]), [["availability", "AVAILABILITY"]]);
  eq("inside saved hours: no warning", findStaffConflicts([p], [], { slots: [{ dayOfWeek: 3, startTime: "16:00", endTime: "20:00", active: true }], exceptions: [] }), []);
  eq("time off that day: warning", findStaffConflicts([p], [], { slots: [{ dayOfWeek: 3, startTime: "16:00", endTime: "20:00", active: true }], exceptions: [{ date: "2026-10-14", type: "UNAVAILABLE" }] }).length, 1);
  eq("availability not passed: not checked", findStaffConflicts([p], []), []);

  // Rule-level: the next 8 weeks, summarised.
  const series = { daysOfWeek: [1, 3], startTime: "18:00", endTime: "19:00", dayOverrides: [{ dayOfWeek: 1, startTime: "17:00", endTime: "18:00" }], recurrenceStartDate: new Date("2026-01-01T00:00:00Z"), recurrenceEndDate: null };
  const all = ruleOccurrenceSlots(series, null, "2026-10-12", NY);
  eq("8 weeks of a Mon/Wed class = 16 days", all.length, 16);
  eq("each weekday uses its own time", [all[0].date, all[0].startTime, all[1].date, all[1].startTime], ["2026-10-12", "17:00", "2026-10-14", "18:00"]);
  const wed = ruleOccurrenceSlots(series, 3, "2026-10-12", NY);
  eq("one weekday only = 8 days", wed.map((s) => dowOfYmd(s.date)), Array(8).fill(3));
  eq("the recurrence end is respected", ruleOccurrenceSlots({ ...series, recurrenceEndDate: new Date("2026-10-21T00:00:00Z") }, 3, "2026-10-12", NY).length, 2);
  const busy = wed.map((s, i) => cls(`w${i}`, "18:00", "19:00", s.date));
  const found = findStaffConflicts(wed, busy, { slots: [{ dayOfWeek: 3, startTime: "09:00", endTime: "12:00", active: true }], exceptions: [] });
  eq("16 raw warnings (8 overlaps + 8 availability)", found.length, 16);
  eq("summarised by weekday with a count", summarizeConflicts(found), [
    "Overlaps Evening Group on Wednesdays 6:00–7:00 PM (8 times)",
    "Outside available hours on Wednesdays 6:00–7:00 PM (8 times)",
  ]);
  eq("a single clash names the date", summarizeConflicts(findStaffConflicts([p], [ev])), ["Overlaps Fall Camp on Wed, Oct 14, 6:30–8:00 PM"]);
  eq("times are 12-hour", [fmtTimeRange("11:00", "13:00"), fmtTimeRange("00:15", "09:05"), fmtTimeRange("12:00", "12:45")], ["11:00 AM–1:00 PM", "12:15–9:05 AM", "12:00–12:45 PM"]);
  // The DST week: Mon Nov 2 2026 6 PM Eastern is 23:00Z, not 22:00Z.
  eq("a slot after clocks change uses the new offset", new Date(proposedSlot("2026-11-02", "18:00", "19:00", NY).startMs).toISOString(), "2026-11-02T23:00:00.000Z");
}

// ── Coverage recipients ─────────────────────────────────────────────────────
section("Who hears 'needs coverage'");
{
  const staff = [
    { id: "owner", role: "OWNER", canManageSchedule: true },
    { id: "mgr", role: "STAFF", canManageSchedule: true },
    { id: "sal", role: "STAFF", canManageSchedule: false },
    { id: "adrian", role: "STAFF", canManageSchedule: false },
    { id: "head", role: "STAFF", canManageSchedule: false },
    { id: "extra", role: "STAFF", canManageSchedule: false },
  ];
  const dayRows = [row("sal"), row("adrian"), row("gone", { status: "REMOVED" })];
  const classRules = [{ userId: "head", roleName: "Head Coach" }];
  const base = { coverageNotifyOwners: false, coverageNotifyManagers: false, coverageNotifyClassStaff: false, coverageNotifyRoleNames: [] as string[], coverageNotifyUserIds: [] as string[] };
  const pick = (s: Partial<typeof base>, excludingUserId: string | null = "sal") => pickCoverageRecipients({ settings: { ...base, ...s }, staff, dayRows, classRules, excludingUserId });
  eq("defaults: owners + managers + the other coaches that day, never the caller",
    pickCoverageRecipients({ settings: DEFAULT_SCHEDULE_SETTINGS, staff, dayRows, classRules, excludingUserId: "sal" }), ["owner", "mgr", "adrian"]);
  eq("owners only", pick({ coverageNotifyOwners: true }), ["owner"]);
  eq("managers = everyone with schedule:edit, owners included", pick({ coverageNotifyManagers: true }), ["owner", "mgr"]);
  eq("class staff = SCHEDULED rows that day, minus the caller", pick({ coverageNotifyClassStaff: true }), ["adrian"]);
  eq("role names match rules, case-insensitively", pick({ coverageNotifyRoleNames: ["head coach"] }), ["head"]);
  eq("the blank role matches as Coach", pick({ coverageNotifyRoleNames: ["Coach"] }), ["adrian"]);
  eq("named people", pick({ coverageNotifyUserIds: ["extra", "not-staff"] }), ["extra"]);
  eq("nobody configured → nobody", pick({}), []);
  eq("deduped across sources", pick({ coverageNotifyOwners: true, coverageNotifyManagers: true, coverageNotifyUserIds: ["owner", "mgr"] }), ["owner", "mgr"]);
  eq("the caller is excluded even when named", pick({ coverageNotifyUserIds: ["sal"] }), []);
}

// ── Settings ────────────────────────────────────────────────────────────────
section("Schedule settings");
{
  eq("no row → the defaults", normalizeScheduleSettings(null), DEFAULT_SCHEDULE_SETTINGS);
  const s = normalizeScheduleSettings({ coverageNotifyOwners: false, coverageNotifyRoleNames: ["Head Coach", "", 3, "Head Coach"], coverageChannels: [], classCancelNotifyDefault: "EVERYONE", assignmentsStartOn: new Date("2026-10-12T00:00:00Z"), payLedgerStartsOn: null });
  eq("a row is cleaned", [s.coverageNotifyOwners, s.coverageNotifyManagers, s.coverageNotifyRoleNames, s.coverageChannels, s.classCancelNotifyDefault, s.assignmentsStartOn, s.payLedgerStartsOn],
    [false, true, ["Head Coach"], ["IN_APP", "EMAIL"], "BOOKED", "2026-10-12", null]);
}

// ── Cancellation audience ───────────────────────────────────────────────────
section("Cancellation audience");
{
  eq("BOOKED", mergeAudience("BOOKED", ["a", "b"], ["b", "c"]), ["a", "b"]);
  eq("CLASS_MEMBERS", mergeAudience("CLASS_MEMBERS", ["a", "b"], ["b", "c"]), ["b", "c"]);
  eq("BOTH is the union, booked first, no duplicates", mergeAudience("BOTH", ["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  eq("NONE", mergeAudience("NONE", ["a"], ["b"]), []);
  const grouped = groupRecipientsByEmail([
    { recipientEmail: "Parent@Example.test", recipientDisplayName: "Pat Parent", memberId: "kid1", memberFirstName: "Kai", memberLastName: "P" },
    { recipientEmail: "parent@example.test ", recipientDisplayName: null, memberId: "kid2", memberFirstName: "Lee", memberLastName: "P" },
    { recipientEmail: "parent@example.test", memberId: "kid1", memberFirstName: "Kai", memberLastName: "P" },
    { recipientEmail: "adult@example.test", memberId: "adult1", memberFirstName: "Ana", memberLastName: "A" },
    { recipientEmail: "  ", memberId: "none" },
  ]);
  eq("one recipient per address, case-insensitive", grouped.map((g) => g.email.toLowerCase()), ["parent@example.test", "adult@example.test"]);
  eq("a guardian of two athletes gets one notice naming both", [grouped[0].memberIds, grouped[0].memberNames, grouped[0].displayName], [["kid1", "kid2"], ["Kai P", "Lee P"], "Pat Parent"]);
}

// ── Switch-on planner ───────────────────────────────────────────────────────
section("Switch-on planner");
{
  const valid = new Set(["julian", "sal", "adrian"]);
  const classes = [
    { id: "c1", name: "Evening Group", assignedStaffIds: ["julian", "sal", "left-the-club"], existingRules: [] as StaffRule[] },
    { id: "c2", name: "Morning Group", assignedStaffIds: [], existingRules: [] as StaffRule[] },
  ];
  const sess = (id: string, classId: string, dateYmd: string, staffOverride: unknown = null, o: Partial<SwitchOnSession> = {}): SwitchOnSession =>
    ({ id, classId, dateYmd, staffOverride, staffManual: false, existingRowCount: 0, ...o });
  const sessions = [
    sess("before", "c1", "2026-10-11"),
    sess("d1", "c1", "2026-10-12"),
    sess("d2", "c1", "2026-10-13", ["adrian", "nobody-real"]),
    sess("d3", "c1", "2026-10-14", []),
    sess("m1", "c2", "2026-10-12", ["sal"]),
    sess("m2", "c2", "2026-10-13"),
  ];
  const plan = planSwitchOn({ date: "2026-10-12", classes, sessions, validStaffIds: valid });
  eq("(a) one all-days rule per current coach, no role invented",
    plan.rules, [
      { classId: "c1", userId: "julian", roleName: null, dayOfWeek: null, effectiveFrom: "2026-10-12" },
      { classId: "c1", userId: "sal", roleName: null, dayOfWeek: null, effectiveFrom: "2026-10-12" },
    ]);
  check("a session before the date is never included", !plan.rows.some((r) => r.sessionId === "before") && !plan.manualSessionIds.includes("before"));
  eq("(b) a day with no override gets RULE rows", plan.rows.filter((r) => r.sessionId === "d1").map((r) => [r.userId, r.source, r.ruleKey]), [["julian", "RULE", "c1:julian"], ["sal", "RULE", "c1:sal"]]);
  eq("(b) an override list becomes MANUAL rows, exactly", plan.rows.filter((r) => r.sessionId === "d2").map((r) => [r.userId, r.source]), [["adrian", "MANUAL"]]);
  eq("(b) an override of [] gets no rows", plan.rows.filter((r) => r.sessionId === "d3"), []);
  eq("…and both override days are flagged as edited by hand", plan.manualSessionIds.sort(), ["d2", "d3", "m1"]);
  eq("a class with no coaches still honours a day's override", plan.rows.filter((r) => r.classId === "c2").map((r) => [r.sessionId, r.userId, r.source]), [["m1", "sal", "MANUAL"]]);
  eq("ids that are not current staff are dropped and reported", plan.perClass[0].droppedIds.sort(), ["left-the-club", "nobody-real"]);
  eq("per-class counts", [plan.perClass[0].sessions, plan.perClass[0].ruleRows, plan.perClass[0].manualDays, plan.perClass[0].manualRows], [3, 2, 2, 1]);

  // Re-run against the state the first run produced.
  const rowsBySession = new Map<string, number>();
  for (const r of plan.rows) rowsBySession.set(r.sessionId, (rowsBySession.get(r.sessionId) ?? 0) + 1);
  const classes2 = classes.map((c) => ({
    ...c,
    existingRules: plan.rules.filter((r) => r.classId === c.id).map((r, i) => ({ id: `${c.id}-${i}`, classId: c.id, userId: r.userId, roleName: null, dayOfWeek: null, effectiveFrom: r.effectiveFrom, effectiveTo: null })),
  }));
  const sessions2 = sessions.map((s) => ({ ...s, existingRowCount: rowsBySession.get(s.id) ?? 0, staffManual: plan.manualSessionIds.includes(s.id) }));
  const again = planSwitchOn({ date: "2026-10-12", classes: classes2, sessions: sessions2, validStaffIds: valid });
  eq("idempotent: a second run plans no rules", again.rules, []);
  eq("idempotent: …no rows", again.rows, []);
  eq("idempotent: …and flags nothing", again.manualSessionIds, []);
  eq("a class that already has rules is reported as already on", again.perClass[0].state, "already");
  // After switch-on the legacy override column is a MIRROR. A class with rules
  // must never have that mirror read back as a manual day.
  const mirrored = planSwitchOn({
    date: "2026-10-12", classes: [classes2[0]], validStaffIds: valid,
    sessions: [sess("later", "c1", "2026-11-02", ["julian"])],
  });
  eq("a mirrored override on an already-switched class is not re-imported", [mirrored.rows, mirrored.manualSessionIds], [[], []]);
}

// ── Reader seam on occurrences ──────────────────────────────────────────────
section("Staff schedule occurrences");
{
  const r = makeStaffResolver({
    assignmentsStartOn: "2026-10-12",
    rows: [row("adrian", { sessionId: "cs9", kind: "SUBSTITUTE", source: "MANUAL" }), row("sal", { sessionId: "cs9", status: "REPLACED" })],
    rules: [rule("julian", { classId: "c1" }), rule("mia", { classId: "c1", dayOfWeek: 2 })],
  });
  const occ = (date: string, sessionId: string | null) => ({ classId: "c1", sessionId, date, staffIds: ["legacy"], seriesStaffIds: ["legacy"], isSubstitute: false, name: "x" });
  const legacy = occ("2026-10-08", "old");
  check("a legacy day is returned untouched (same object)", r.forOccurrence(legacy) === legacy);
  eq("a day with a session row uses its rows", r.forOccurrence(occ("2026-10-13", "cs9")).staffIds, ["adrian"]);
  eq("a day with no session row yet uses the rules", r.forOccurrence(occ("2026-10-20", null)).staffIds, ["julian", "mia"]);
  eq("…for that weekday", r.forOccurrence(occ("2026-10-21", null)).staffIds, ["julian"]);
  eq("extra fields are preserved", r.forOccurrence(occ("2026-10-20", null)).name, "x");
  const off = makeStaffResolver({ assignmentsStartOn: null });
  const o2 = occ("2030-01-01", null);
  check("a club not switched on: every day untouched", off.forOccurrence(o2) === o2 && off.isSwitched("2030-01-01") === false);
}

console.log(`\n${failures.length ? "✗" : "✓"} ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
