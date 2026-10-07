/**
 * Class coach assignments — the database half, run end to end against the
 * in-memory fake in scripts/fake-prisma.ts (no database, no network).
 *
 *   npx tsx scripts/class-staff-server-tests.ts
 *
 * One story, in order, on one small club:
 *   1. NOT switched on  — every reader is exactly the legacy answer and the
 *                         new code writes nothing
 *   2. switch-on        — dry run writes nothing, apply writes rules + rows,
 *                         a second apply writes nothing, days before the date
 *                         are never touched, the legacy columns are unchanged
 *   3. payroll          — days before the date: byte-for-byte what they were;
 *                         days after: rows, ended only, cancelled-but-paid
 *   4. day operations   — call-out (late flag), cover, undo, close, no-show,
 *                         hand edits; the legacy mirror after each
 *   5. the three scopes — occurrence, weekday going forward, all future
 *   6. cancellation, audience, coverage recipients, conflicts
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { buildSessions } from "../lib/classSessions";
import { effectiveClassStaff, asIdList } from "../lib/staffAssignments";

const fake = makeFakeDb({
  relations: {
    classSession: {
      recurringClass: { model: "recurringClass", kind: "one", fk: "classId" },
      club: { model: "club", kind: "one", fk: "clubId" },
      staff: { model: "classSessionStaff", kind: "many", fk: "sessionId" },
      attendance: { model: "attendanceRecord", kind: "many", fk: "classSessionId" },
    },
    classSessionStaff: { session: { model: "classSession", kind: "one", fk: "sessionId" } },
    recurringClass: { club: { model: "club", kind: "one", fk: "clubId" } },
    attendanceRecord: {
      classSession: { model: "classSession", kind: "one", fk: "classSessionId" },
      member: { model: "member", kind: "one", fk: "memberId" },
    },
    memberSubscription: {
      member: { model: "member", kind: "one", fk: "memberId" },
      membership: { model: "membership", kind: "one", fk: "membershipId" },
    },
    eventStaffAssignment: { event: { model: "event", kind: "one", fk: "eventId" } },
    event: { sessions: { model: "eventSession", kind: "many", fk: "eventId" } },
    privateBooking: { lessonType: { model: "privateLessonType", kind: "one", fk: "lessonTypeId" } },
  },
  uniques: { classSession: [["classId", "date"]], classSessionStaff: [["sessionId", "userId"]], clubScheduleSettings: [["clubId"]] },
});
installFakePrisma(fake.client, {
  "@/lib/email": { sendEmail: async () => {}, isEmailConfigured: () => false },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const S = require("../lib/classStaffServer.ts") as typeof import("../lib/classStaffServer");
const { computePayroll } = require("../lib/payrollCalc.ts") as typeof import("../lib/payrollCalc");
const { computePayrollTotalForRange } = require("../lib/payroll.ts") as typeof import("../lib/payroll");
const { syncFutureSessions } = require("../lib/classSessionSync.ts") as typeof import("../lib/classSessionSync");
const { computeCoachAudienceMemberIds } = require("../lib/coachAudience.ts") as typeof import("../lib/coachAudience");
/* eslint-enable @typescript-eslint/no-var-requires */
const db = fake.client;

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
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "ok"; } catch (e) { return (e as { code?: string }).code ?? `threw: ${(e as Error).message}`; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const CLUB = "club_1";
const NY = "America/New_York";
const SWITCH = "2026-10-12"; // a Monday
// Tuesday Oct 13 2026, 12:00 noon in New York. Monday's class has ended; today's (6 PM) has not.
const NOON_TUE = new Date("2026-10-13T16:00:00.000Z");
const perms = (schedule: string) => ({ permissions: { schedule } });
const user = (id: string, role: string, o: Record<string, unknown> = {}) => ({
  id, clubId: CLUB, role, deletedAt: null, firstName: id, lastName: "Test", email: `${id}@example.test`,
  staffProfile: role === "STAFF" ? { title: "Coach", ...perms("view") } : null,
  compensation: role === "MEMBER" ? null : { baseType: "PER_CLASS", baseAmount: 10, bonuses: [], assignments: [] },
  ...o,
});
fake.seed("club", [{ id: CLUB, name: "Test Club", timezone: NY }]);
fake.seed("user", [
  user("owner", "OWNER"),
  user("mgr", "STAFF", { staffProfile: { title: "Manager", ...perms("edit") } }),
  user("julian", "STAFF"), user("sal", "STAFF"), user("adrian", "STAFF"), user("mia", "STAFF"),
  user("gone", "STAFF", { deletedAt: d("2026-09-01") }),
  user("member1", "MEMBER"),
]);
const series = (id: string, name: string, daysOfWeek: number[], startTime: string, endTime: string, assignedStaffIds: string[]) => ({
  id, clubId: CLUB, name, daysOfWeek, startTime, endTime, dayOverrides: [], assignedStaffIds,
  recurrenceStartDate: d("2026-09-01"), recurrenceEndDate: null, active: true, deletedAt: null,
  pricingOptions: [{ type: "membership", membershipId: "plan_a" }, { type: "dropin", price: 20 }],
});
fake.seed("recurringClass", [
  series("c1", "Evening Group", [1, 2, 4], "18:00", "19:00", ["julian", "sal", "gone"]),
  series("c2", "Morning Group", [3], "09:00", "10:00", ["mia"]),
]);
for (const [id, days, st, en] of [["c1", [1, 2, 4], "18:00", "19:00"], ["c2", [3], "09:00", "10:00"]] as [string, number[], string, string][]) {
  fake.seed("classSession", buildSessions(id, CLUB, days, st, en, [], d("2026-10-05"), d("2026-11-30")).map((s) => ({
    id: `${id}_${ymd(s.date)}`, ...s, staffOverride: null, note: null, overridden: false, staffManual: false,
    canceledAt: null, canceledByUserId: null, cancelReason: null, cancelNotifyAudience: null, cancelNotifiedCount: null,
    cancelPaid: false, cancelPaidByUserId: null, cancelPaidAt: null,
  })));
}
const sess = (id: string) => fake.table("classSession").find((r) => r.id === id)!;
// Legacy one-day changes that exist before switch-on:
sess("c1_2026-10-06").staffOverride = ["adrian"];   // before the date: a substitute
sess("c1_2026-10-08").canceled = true;              // before the date: canceled
sess("c1_2026-10-15").staffOverride = ["adrian", "gone"]; // after: a one-day list
sess("c1_2026-10-19").staffOverride = [];           // after: explicitly nobody

const rowsOf = (sessionId: string) => fake.table("classSessionStaff").filter((r) => r.sessionId === sessionId);
const on = (sessionId: string) => rowsOf(sessionId).filter((r) => r.status === "SCHEDULED").map((r) => r.userId).sort();
const statusOf = (sessionId: string, userId: string) => rowsOf(sessionId).find((r) => r.userId === userId)?.status ?? null;
const cls = (id: string) => fake.table("recurringClass").find((r) => r.id === id)!;
const legacyOn = (sessionId: string) => {
  const s = sess(sessionId);
  return effectiveClassStaff(cls(s.classId).assignedStaffIds, s.staffOverride).staffIds.slice().sort();
};

/** What payroll says each coach taught, as "date" lists — from the real calculator. */
async function taught(from: string, to: string, now: Date) {
  const a = new Date(`${from}T00:00:00.000Z`);
  const b = new Date(`${to}T23:59:59.999Z`);
  const res = await computePayroll(CLUB, a, b, { now });
  const total = await computePayrollTotalForRange(CLUB, a, b, now);
  const by: Record<string, number> = {};
  for (const s of res.staff) if (s.payout && s.payout.classesCoached > 0) by[s.id] = s.payout.classesCoached;
  return { by, json: JSON.stringify(res), total, pageTotal: res.totals.total };
}

async function main() {
  // ── 1. Not switched on ────────────────────────────────────────────────────
  section("1. A club that is not switched on");
  const legacyPay = await taught("2026-10-05", "2026-10-31", NOON_TUE);
  const legacyPayBeforeDate = await taught("2026-10-05", "2026-10-11", NOON_TUE);
  {
    // Reference, computed the old way straight from the fixtures.
    const ref: Record<string, number> = {};
    for (const s of fake.table("classSession")) {
      if (s.canceled || ymd(s.date) > "2026-10-31") continue;
      for (const id of effectiveClassStaff(cls(s.classId).assignedStaffIds, s.staffOverride).staffIds) {
        if (["julian", "sal", "adrian", "mia", "mgr", "owner"].includes(id)) ref[id] = (ref[id] ?? 0) + 1;
      }
    }
    eq("payroll = the legacy lists (future days included, as today)", legacyPay.by, Object.fromEntries(Object.entries(ref).sort()) && Object.fromEntries(Object.keys(legacyPay.by).map((k) => [k, ref[k]])));
    eq("…same coaches as the reference", Object.keys(legacyPay.by).sort(), Object.keys(ref).sort());
    eq("the reports total agrees with the Payroll page", legacyPay.total, legacyPay.pageTotal);

    fake.resetCalls();
    const r = await S.loadSessionStaffResolver(CLUB, fake.table("classSession"));
    eq("the resolver costs ONE query (the settings row)", fake.calls.map((c) => `${c.model}.${c.method}`), ["clubScheduleSettings.findUnique"]);
    eq("…and answers with the legacy lists", [r.forSession(sess("c1_2026-10-06"), cls("c1").assignedStaffIds).staffIds, r.forSession(sess("c1_2026-10-20"), cls("c1").assignedStaffIds).staffIds], [["adrian"], ["julian", "sal", "gone"]]);

    fake.resetCalls();
    const sync = await S.syncSessionStaff(db, "c1", null, { now: NOON_TUE });
    eq("syncSessionStaff is a no-op", [sync.switchedOn, fake.writes().length], [false, 0]);
    const init = await S.initClassStaffFromLegacy(db, "c1", { now: NOON_TUE });
    eq("initClassStaffFromLegacy is a no-op", [init.switchedOn, fake.writes().length], [false, 0]);
    eq("a day operation refuses", await codeOf(() => S.setDayStaff(db, { clubId: CLUB, sessionId: "c1_2026-10-20", staff: [{ userId: "mia" }], byUserId: "mgr" })), "NOT_SWITCHED_ON");
    eq("a rule change refuses", await codeOf(() => S.applyScopeChange(db, { clubId: CLUB, classId: "c1", scope: "ALL_FUTURE", date: "2026-10-20", desired: [], byUserId: "mgr" })), "NOT_SWITCHED_ON");
    eq("a range call-out refuses", await codeOf(() => S.callOutRange(db, { clubId: CLUB, userId: "sal", fromDate: "2026-10-20", toDate: "2026-10-27", byUserId: "sal" })), "NOT_SWITCHED_ON");
    eq("nothing was written by any of that", [fake.writes().length, fake.table("classSessionStaff").length, fake.table("classStaffRule").length], [0, 0, 0]);
    const settings = await S.getScheduleSettings(CLUB);
    eq("settings default when there is no row", [settings.assignmentsStartOn, settings.classCancelNotifyDefault, settings.coverageChannels], [null, "BOOKED", ["IN_APP", "EMAIL"]]);
  }

  // ── 2. Switch-on ──────────────────────────────────────────────────────────
  section("2. Switch-on");
  const legacySnapshot = JSON.stringify({ classes: fake.table("recurringClass").map((c) => c.assignedStaffIds), overrides: fake.table("classSession").map((s) => [s.id, s.staffOverride, s.staffManual]) });
  {
    fake.resetCalls();
    const dry = await S.runSwitchOn({ clubId: CLUB, date: SWITCH, apply: false });
    eq("dry run writes nothing", [dry.applied, fake.writes().length], [false, 0]);
    eq("…and reports the plan", [dry.plan.rules.length, dry.plan.perClass.map((c) => [c.name, c.coaches, c.droppedIds])], [3, [["Evening Group", ["julian", "sal"], ["gone"]], ["Morning Group", ["mia"], []]]]);

    const applied = await S.runSwitchOn({ clubId: CLUB, date: SWITCH, apply: true, byUserId: "owner" });
    eq("apply writes the rules and the settings date", [applied.applied, applied.written.rules, applied.written.settings], [true, 3, true]);
    eq("rules: one per current coach, all days, no role, from the date",
      fake.table("classStaffRule").map((r) => [r.classId, r.userId, r.roleName, r.dayOfWeek, ymd(r.effectiveFrom), r.effectiveTo ?? null]),
      [["c1", "julian", null, null, SWITCH, null], ["c1", "sal", null, null, SWITCH, null], ["c2", "mia", null, null, SWITCH, null]]);
    eq("the club's start date is set", (await S.getScheduleSettings(CLUB)).assignmentsStartOn, SWITCH);
    check("NO row was written for any day before the date", fake.table("classSessionStaff").every((r) => ymd(sess(r.sessionId).date) >= SWITCH));
    check("no day before the date was flagged", fake.table("classSession").filter((s) => ymd(s.date) < SWITCH).every((s) => s.staffManual === false));
    eq("a normal day gets the rule coaches (source RULE, pointing at their rule)", rowsOf("c1_2026-10-13").map((r) => [r.userId, r.source, !!r.ruleId, r.kind, r.status]), [["julian", "RULE", true, "REGULAR", "SCHEDULED"], ["sal", "RULE", true, "REGULAR", "SCHEDULED"]]);
    eq("a one-day list is kept exactly (source MANUAL; the departed coach is dropped)", rowsOf("c1_2026-10-15").map((r) => [r.userId, r.source]), [["adrian", "MANUAL"]]);
    eq("…and the day is flagged as edited by hand", [sess("c1_2026-10-15").staffManual, sess("c1_2026-10-19").staffManual], [true, true]);
    eq("a day set to nobody gets no rows", rowsOf("c1_2026-10-19").length, 0);
    eq("the legacy columns are untouched by switch-on (only staffManual flags changed)",
      JSON.stringify({ classes: fake.table("recurringClass").map((c) => c.assignedStaffIds), overrides: fake.table("classSession").map((s) => [s.id, s.staffOverride, ["c1_2026-10-15", "c1_2026-10-19"].includes(s.id) ? false : s.staffManual]) }), legacySnapshot);

    const rowCount = fake.table("classSessionStaff").length;
    fake.resetCalls();
    const again = await S.runSwitchOn({ clubId: CLUB, date: SWITCH, apply: true });
    eq("re-run: no writes, nothing planned", [fake.writes().length, again.plan.rules.length, again.plan.rows.length, fake.table("classSessionStaff").length], [0, 0, 0, rowCount]);
    const other = await S.runSwitchOn({ clubId: CLUB, date: "2026-11-01", apply: true });
    eq("a different date is refused, nothing written", [other.refused, fake.writes().length], [`already switched on from ${SWITCH}`, 0]);
  }

  // ── 3. Readers + payroll ──────────────────────────────────────────────────
  section("3. Readers and payroll after switch-on");
  {
    const after = await taught("2026-10-05", "2026-10-11", NOON_TUE);
    check("payroll for days BEFORE the date is byte-for-byte unchanged", after.json === legacyPayBeforeDate.json, `${after.json.slice(0, 200)} vs ${legacyPayBeforeDate.json.slice(0, 200)}`);
    eq("…including the reports total", after.total, legacyPayBeforeDate.total);

    const noon = await taught(SWITCH, "2026-10-31", NOON_TUE);
    eq("after the date, at noon Tuesday: only Monday's class has ended", noon.by, { julian: 1, sal: 1 });
    const tueNight = await taught(SWITCH, "2026-10-31", new Date("2026-10-13T23:00:00.000Z"));
    eq("at 7:00 PM Tuesday (club time) Tuesday's class counts too", tueNight.by, { julian: 2, sal: 2 });
    const fri = await taught(SWITCH, "2026-10-31", new Date("2026-10-16T16:00:00.000Z"));
    eq("by Friday: Mon+Tue (julian, sal), Wed (mia), Thu (the one-day coach)", fri.by, { adrian: 1, julian: 2, mia: 1, sal: 2 });
    eq("future days never pay — unlike the legacy calculation", legacyPay.by.julian > fri.by.julian, true);
    eq("the reports total follows the same rule", fri.total, fri.pageTotal);

    fake.resetCalls();
    const many = fake.table("classSession");
    const r = await S.loadSessionStaffResolver(CLUB, many);
    eq(`the resolver costs 3 queries for ${many.length} sessions (no N+1)`, fake.calls.length, 3);
    eq("a day before the date still reads the legacy override", r.forSession(sess("c1_2026-10-06"), cls("c1").assignedStaffIds).staffIds, ["adrian"]);
    eq("…and the legacy series list", r.forSession(sess("c1_2026-10-05"), cls("c1").assignedStaffIds).staffIds, ["julian", "sal", "gone"]);
    eq("a day after the date reads its rows", r.forSession(sess("c1_2026-10-13"), ["ignored"]).staffIds, ["julian", "sal"]);
    eq("a hand-edited day is a one-day change", r.forSession(sess("c1_2026-10-15"), []).isSubstitute, true);
    fake.resetCalls();
    await S.loadSessionStaffResolver(CLUB, many.filter((s) => ymd(s.date) < SWITCH));
    eq("only legacy days asked about → still one query", fake.calls.length, 1);
  }

  // ── 4. Day operations ─────────────────────────────────────────────────────
  section("4. Call-out, cover, close, no-show, hand edits");
  const TUE = "c1_2026-10-13"; // starts 6 PM New York = 22:00Z
  {
    eq("a day before the date is refused", await codeOf(() => S.callOut(db, { clubId: CLUB, sessionId: "c1_2026-10-06", userId: "adrian", byUserId: "adrian", now: NOON_TUE })), "NOT_SWITCHED_ON");
    eq("another club's id finds nothing", await codeOf(() => S.callOut(db, { clubId: "club_2", sessionId: TUE, userId: "sal", byUserId: "sal", now: NOON_TUE })), "NOT_FOUND");
    eq("someone not on the day cannot call out", await codeOf(() => S.callOut(db, { clubId: CLUB, sessionId: TUE, userId: "mia", byUserId: "mia", now: NOON_TUE })), "NOT_ON_DAY");

    const out = await S.callOut(db, { clubId: CLUB, sessionId: TUE, userId: "sal", reason: " flat tyre ", byUserId: "sal", now: NOON_TUE });
    const salRow = rowsOf(TUE).find((r) => r.userId === "sal")!;
    eq("call-out 6 hours ahead: NEEDS_COVERAGE, not late, who/when/why stored",
      [salRow.status, out.late, salRow.lateCallout, salRow.calledOutByUserId, salRow.calloutReason, salRow.calledOutAt.toISOString(), out.startInstant.toISOString()],
      ["NEEDS_COVERAGE", false, false, "sal", "flat tyre", NOON_TUE.toISOString(), "2026-10-13T22:00:00.000Z"]);
    eq("the class stays scheduled and the other coach stays on", [sess(TUE).canceled, on(TUE)], [false, ["julian"]]);
    eq("before/after are returned for the audit", [out.coachingBefore, out.coachingAfter, out.changed], [["julian", "sal"], ["julian"], true]);
    eq("a call-out does not make the day 'edited by hand'", sess(TUE).staffManual, false);
    eq("legacy mirror: that day's override is now the one coach left", [sess(TUE).staffOverride, legacyOn(TUE)], [["julian"], ["julian"]]);
    eq("calling out twice is refused", await codeOf(() => S.callOut(db, { clubId: CLUB, sessionId: TUE, userId: "sal", byUserId: "sal", now: NOON_TUE })), "BAD_STATE");

    // Rules do not undo an open call-out.
    await S.syncSessionStaff(db, "c1", null, { now: NOON_TUE });
    eq("the nightly sync leaves the open call-out alone", statusOf(TUE, "sal"), "NEEDS_COVERAGE");

    const undo = await S.cancelCoverageRequest(db, { clubId: CLUB, staffRowId: salRow.id, byUserId: "sal" });
    eq("undo while unfilled: back to SCHEDULED, call-out fields cleared", [statusOf(TUE, "sal"), salRow.calledOutAt, salRow.calloutReason, salRow.lateCallout, undo.coachingAfter], ["SCHEDULED", null, null, false, ["julian", "sal"]]);
    // The series list is FROZEN at switch-on (it still names the removed coach
    // "gone"), so the day's mirror is the exact SCHEDULED list, not "inherit".
    eq("legacy mirror: a legacy reader sees both coaches again", [sess(TUE).staffOverride, legacyOn(TUE)], [["julian", "sal"], ["julian", "sal"]]);
    eq("undoing again is refused", await codeOf(() => S.cancelCoverageRequest(db, { clubId: CLUB, staffRowId: salRow.id, byUserId: "sal" })), "BAD_STATE");

    const exact = await S.callOut(db, { clubId: CLUB, sessionId: TUE, userId: "sal", byUserId: "sal", now: new Date("2026-10-13T20:00:00.000Z") });
    eq("exactly 2 hours before the real start is NOT late", exact.late, false);
    await S.cancelCoverageRequest(db, { clubId: CLUB, staffRowId: salRow.id, byUserId: "sal" });
    const late = await S.callOut(db, { clubId: CLUB, sessionId: TUE, userId: "sal", byUserId: "mgr", now: new Date("2026-10-13T20:30:00.000Z") });
    eq("90 minutes before: accepted, flagged late; a manager may act for the coach", [late.late, salRow.lateCallout, salRow.status, salRow.calledOutByUserId], [true, true, "NEEDS_COVERAGE", "mgr"]);

    eq("a member cannot be the substitute", await codeOf(() => S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "member1", byUserId: "mgr" })), "INVALID_STAFF");
    eq("a removed staff member cannot be the substitute", await codeOf(() => S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "gone", byUserId: "mgr" })), "INVALID_STAFF");
    eq("a coach cannot cover for themself", await codeOf(() => S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "sal", byUserId: "mgr" })), "BAD_INPUT");
    eq("someone already coaching it cannot be the substitute", await codeOf(() => S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "julian", byUserId: "mgr" })), "ALREADY_ON_DAY");

    const filledAt = new Date("2026-10-13T20:45:00.000Z");
    const fill = await S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "adrian", byUserId: "mgr", now: filledAt });
    const subRow = rowsOf(TUE).find((r) => r.userId === "adrian")!;
    eq("filled: the original is REPLACED with who/when", [salRow.status, salRow.coverageFilledByUserId, salRow.coverageFilledAt.toISOString()], ["REPLACED", "mgr", filledAt.toISOString()]);
    eq("…and the substitute is a SCHEDULED SUBSTITUTE row pointing at it, role Substitute", [subRow.kind, subRow.status, subRow.replacesStaffId, subRow.roleName, subRow.source, fill.substituteRowId], ["SUBSTITUTE", "SCHEDULED", salRow.id, "Substitute", "MANUAL", subRow.id]);
    eq("who is coaching now", on(TUE), ["adrian", "julian"]);
    eq("legacy mirror agrees", legacyOn(TUE), ["adrian", "julian"]);
    eq("a filled request cannot be undone by the coach", await codeOf(() => S.cancelCoverageRequest(db, { clubId: CLUB, staffRowId: salRow.id, byUserId: "sal" })), "BAD_STATE");
    eq("…or filled twice", await codeOf(() => S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "mia", byUserId: "mgr" })), "BAD_STATE");
    await S.syncSessionStaff(db, "c1", null, { now: NOON_TUE });
    eq("the sync never touches the replaced coach or the substitute", [statusOf(TUE, "sal"), statusOf(TUE, "adrian"), on(TUE)], ["REPLACED", "SCHEDULED", ["adrian", "julian"]]);

    const paid = await taught(SWITCH, "2026-10-13", new Date("2026-10-14T03:00:00.000Z"));
    eq("pay: the substitute is paid as themself; the replaced coach is not", paid.by, { adrian: 1, julian: 2, sal: 1 });

    // Take the substitute off → the request re-opens.
    const off = await S.removeDayStaff(db, { clubId: CLUB, sessionId: TUE, userId: "adrian", byUserId: "mgr" });
    eq("removing the substitute re-opens the request", [statusOf(TUE, "adrian"), statusOf(TUE, "sal"), salRow.coverageFilledAt, off.dayOps.map((o) => o.op)], ["REMOVED", "NEEDS_COVERAGE", null, ["remove", "reopen"]]);
    eq("a hand edit flags the day", sess(TUE).staffManual, true);
    eq("removing someone who is not coaching is refused", await codeOf(() => S.removeDayStaff(db, { clubId: CLUB, sessionId: TUE, userId: "adrian", byUserId: "mgr" })), "NOT_ON_DAY");
    // Fill again with the SAME person: their REMOVED row is reused (one row per coach per day).
    await S.fillCoverage(db, { clubId: CLUB, staffRowId: salRow.id, substituteUserId: "adrian", roleName: "Lead Coach", byUserId: "mgr" });
    eq("re-filling with the same person reuses their row", [rowsOf(TUE).filter((r) => r.userId === "adrian").length, subRow.status, subRow.kind, subRow.roleName, salRow.status], [1, "SCHEDULED", "SUBSTITUTE", "Lead Coach", "REPLACED"]);
    await S.removeDayStaff(db, { clubId: CLUB, sessionId: TUE, userId: "adrian", byUserId: "mgr" });
    const closed = await S.closeCoverage(db, { clubId: CLUB, staffRowId: salRow.id, byUserId: "mgr", note: "one coach is enough" });
    eq("a manager closes the request with nobody: REMOVED", [salRow.status, salRow.note, closed.coachingAfter], ["REMOVED", "one coach is enough", ["julian"]]);
    eq("closing again is refused", await codeOf(() => S.closeCoverage(db, { clubId: CLUB, staffRowId: salRow.id, byUserId: "mgr" })), "BAD_STATE");

    // No-show.
    const MON = "c1_2026-10-12";
    const julianMon = rowsOf(MON).find((r) => r.userId === "julian")!;
    eq("no-show before the class starts is refused", await codeOf(() => S.markNoShow(db, { clubId: CLUB, staffRowId: rowsOf("c1_2026-10-20").find((r) => r.userId === "julian")!.id, byUserId: "mgr", now: NOON_TUE })), "BAD_STATE");
    await S.markNoShow(db, { clubId: CLUB, staffRowId: julianMon.id, byUserId: "mgr", note: "did not arrive", now: NOON_TUE });
    eq("no-show after the class: NO_SHOW", [julianMon.status, on(MON)], ["NO_SHOW", ["sal"]]);
    eq("pay: a no-show is not paid for that day", (await taught(SWITCH, SWITCH, NOON_TUE)).by, { sal: 1 });
    eq("the sync does not resurrect a no-show (and never touches an ended day)", [(await S.syncSessionStaff(db, "c1", null, { now: NOON_TUE })).created, julianMon.status], [0, "NO_SHOW"]);
    await S.clearNoShow(db, { clubId: CLUB, staffRowId: julianMon.id, byUserId: "mgr" });
    eq("cleared: scheduled and paid again", [julianMon.status, (await taught(SWITCH, SWITCH, NOON_TUE)).by], ["SCHEDULED", { julian: 1, sal: 1 }]);

    // Hand edits on a future day.
    const THU22 = "c1_2026-10-22";
    eq("adding a member as a coach is refused", await codeOf(() => S.addDayStaff(db, { clubId: CLUB, sessionId: THU22, userId: "member1", byUserId: "mgr" })), "INVALID_STAFF");
    eq("…and nothing was written for them", rowsOf(THU22).some((r) => r.userId === "member1"), false);
    const add = await S.addDayStaff(db, { clubId: CLUB, sessionId: THU22, userId: "mia", roleName: "Volunteer", byUserId: "mgr" });
    eq("add one person: the others stay", [on(THU22), rowsOf(THU22).find((r) => r.userId === "mia")!.roleName, add.dayOps.length, sess(THU22).staffManual], [["julian", "mia", "sal"], "Volunteer", 1, true]);
    eq("adding again changes nothing", (await S.addDayStaff(db, { clubId: CLUB, sessionId: THU22, userId: "mia", byUserId: "mgr" })).changed, false);
    const set = await S.setDayStaff(db, { clubId: CLUB, sessionId: THU22, staff: [{ userId: "mia" }, { userId: "adrian", roleName: "Assistant Coach" }], byUserId: "mgr" });
    eq("set the exact list", [on(THU22), statusOf(THU22, "julian"), statusOf(THU22, "sal"), set.coachingBefore, set.coachingAfter], [["adrian", "mia"], "REMOVED", "REMOVED", ["julian", "sal", "mia"], ["mia", "adrian"]]);
    eq("legacy mirror agrees", legacyOn(THU22), ["adrian", "mia"]);
    await S.setDayStaff(db, { clubId: CLUB, sessionId: THU22, staff: [{ userId: "julian" }], byUserId: "mgr" });
    eq("putting a removed coach back restores their one row", [on(THU22), rowsOf(THU22).filter((r) => r.userId === "julian").length], [["julian"], 1]);
    await S.syncSessionStaff(db, "c1", null, { now: NOON_TUE });
    eq("the sync never refills a day edited by hand", on(THU22), ["julian"]);
  }

  // ── 5. Scopes ─────────────────────────────────────────────────────────────
  section("5. This occurrence / this weekday going forward / all future");
  {
    eq("a member in a recurring change is refused", await codeOf(() => S.applyScopeChange(db, { clubId: CLUB, classId: "c1", scope: "WEEKDAY_FORWARD", date: "2026-10-20", desired: [{ userId: "julian" }, { userId: "member1" }], byUserId: "mgr", now: NOON_TUE })), "INVALID_STAFF");
    eq("…and no rule was written for them", fake.table("classStaffRule").some((r) => r.userId === "member1"), false);
    eq("a date before the switch-on date is refused", await codeOf(() => S.applyScopeChange(db, { clubId: CLUB, classId: "c1", scope: "ALL_FUTURE", date: "2026-10-06", desired: [], byUserId: "mgr" })), "NOT_SWITCHED_ON");

    // "Replace Sal with Adrian on Tuesdays from Oct 20."
    const res = await S.applyScopeChange(db, { clubId: CLUB, classId: "c1", scope: "WEEKDAY_FORWARD", date: "2026-10-20", desired: [{ userId: "julian" }, { userId: "adrian" }], byUserId: "mgr", now: NOON_TUE });
    eq("rule mutations", res.ruleOps.map((o) => o.op === "create" ? `create ${o.userId} dow=${o.dayOfWeek} from ${o.effectiveFrom}` : o.op === "end" ? `end to ${o.effectiveTo}` : "delete"),
      ["end to 2026-10-19", "create sal dow=1 from 2026-10-20", "create sal dow=4 from 2026-10-20", "create adrian dow=2 from 2026-10-20"]);
    eq("recurring Tuesday coaches before → after", [res.recurringBefore.map((r) => r.userId), res.recurringAfter.map((r) => r.userId).sort()], [["julian", "sal"], ["adrian", "julian"]]);
    eq("Tue Oct 20 and 27: Julian + Adrian", [on("c1_2026-10-20"), on("c1_2026-10-27")], [["adrian", "julian"], ["adrian", "julian"]]);
    eq("Mon Oct 26 and Thu Oct 29: Sal keeps them", [on("c1_2026-10-26"), on("c1_2026-10-29")], [["julian", "sal"], ["julian", "sal"]]);
    eq("days before the change date are untouched", [on("c1_2026-10-12"), on("c1_2026-10-13")], [["julian", "sal"], ["julian"]]);
    eq("days edited by hand are untouched", [on("c1_2026-10-15"), on("c1_2026-10-19"), on("c1_2026-10-22")], [["adrian"], [], ["julian"]]);
    eq("the other class is untouched", on("c2_2026-10-21"), ["mia"]);
    check("every day on/after the switch-on date: a legacy reader sees exactly the SCHEDULED coaches",
      fake.table("classSession").filter((s) => ymd(s.date) >= SWITCH).every((s) => JSON.stringify(legacyOn(s.id)) === JSON.stringify(on(s.id))),
      fake.table("classSession").filter((s) => ymd(s.date) >= SWITCH && JSON.stringify(legacyOn(s.id)) !== JSON.stringify(on(s.id))).map((s) => s.id).join(","));
    eq("assignedStaffIds is FROZEN: a rule change does not rewrite the legacy list", asIdList(cls("c1").assignedStaffIds), ["julian", "sal", "gone"]);
    eq("…so days before the switch-on date still read who was on them then", [legacyOn("c1_2026-10-05"), legacyOn("c1_2026-10-06")], [["gone", "julian", "sal"], ["adrian"]]);
    const later = await S.syncSessionStaff(db, "c1", null, { now: new Date("2026-10-21T16:00:00.000Z") });
    eq("…and the nightly sync, once the change has started, still does not touch it", [later.seriesStaffIds, later.seriesChanged, asIdList(cls("c1").assignedStaffIds)], [["julian", "sal", "gone"], false, ["julian", "sal", "gone"]]);
    check("no write to RecurringClass.assignedStaffIds anywhere since switch-on",
      !fake.calls.some((c) => c.model === "recurringClass" && /^(update|upsert)/.test(c.method) && c.args?.data && "assignedStaffIds" in c.args.data));
    check("…with every day's override still giving a legacy reader the truth",
      fake.table("classSession").filter((s) => ymd(s.date) >= SWITCH).every((s) => JSON.stringify(legacyOn(s.id)) === JSON.stringify(on(s.id))));
    eq("the same request again: nothing to do", (await S.applyScopeChange(db, { clubId: CLUB, classId: "c1", scope: "WEEKDAY_FORWARD", date: "2026-10-20", desired: [{ userId: "julian" }, { userId: "adrian" }], byUserId: "mgr", now: NOON_TUE })).ruleOps, []);
    check("days before the switch-on date still have no rows", fake.table("classSessionStaff").every((r) => ymd(sess(r.sessionId).date) >= SWITCH));
    eq("…and their legacy override columns are as they were", [sess("c1_2026-10-06").staffOverride, sess("c1_2026-10-05").staffOverride], [["adrian"], null]);

    // This occurrence only, on a day with no session row yet.
    const occ = await S.applyScopeChange(db, { clubId: CLUB, classId: "c2", scope: "OCCURRENCE", date: "2027-03-10", desired: [{ userId: "adrian" }], byUserId: "mgr", now: NOON_TUE });
    const made = fake.table("classSession").find((s) => s.classId === "c2" && ymd(s.date) === "2027-03-10")!;
    eq("occurrence scope creates the day if needed, then sets it", [!!made, made?.startsAt.toISOString(), on(made.id), statusOf(made.id, "mia"), made.staffManual, occ.ruleOps], [true, "2027-03-10T09:00:00.000Z", ["adrian"], "REMOVED", true, []]);
    eq("…without changing the rules", fake.table("classStaffRule").filter((r) => r.classId === "c2").length, 1);

    // All future.
    const all = await S.applyScopeChange(db, { clubId: CLUB, classId: "c1", scope: "ALL_FUTURE", date: "2026-11-02", desired: [{ userId: "mia", roleName: "Lead Coach" }], byUserId: "mgr", now: NOON_TUE });
    eq("all future: every later day is exactly the list", [on("c1_2026-11-02"), on("c1_2026-11-03"), on("c1_2026-11-05"), rowsOf("c1_2026-11-03").find((r) => r.userId === "mia")!.roleName], [["mia"], ["mia"], ["mia"], "Lead Coach"]);
    eq("…days before it keep the weekday arrangement", [on("c1_2026-10-27"), on("c1_2026-10-29")], [["adrian", "julian"], ["julian", "sal"]]);
    check("rules were ended, not deleted (history kept)", all.ruleOps.filter((o) => o.op === "end").length >= 4);

    // One coach off the recurring list.
    const end = await S.endUserRules(db, { clubId: CLUB, classId: "c2", userId: "mia", date: "2026-10-28", byUserId: "mia", now: NOON_TUE });
    eq("take one coach off every week from a date", [end.ruleOps.length, on("c2_2026-10-21"), on("c2_2026-10-28"), on("c2_2026-11-04")], [1, ["mia"], [], []]);

    // Range call-out: per-day rows only.
    const rulesBefore = JSON.stringify(fake.table("classStaffRule"));
    const range = await S.callOutRange(db, { clubId: CLUB, userId: "julian", fromDate: "2026-10-20", toDate: "2026-10-27", reason: "away", byUserId: "julian", now: NOON_TUE });
    eq("range call-out: one result per class day they were scheduled on", range.results.map((r) => r.date), ["2026-10-20", "2026-10-22", "2026-10-26", "2026-10-27"]);
    eq("…each now needs coverage", ["c1_2026-10-20", "c1_2026-10-22", "c1_2026-10-26", "c1_2026-10-27"].map((id) => statusOf(id, "julian")), Array(4).fill("NEEDS_COVERAGE"));
    eq("…none is late", range.results.some((r) => r.late), false);
    eq("…and the recurring rules are unchanged", JSON.stringify(fake.table("classStaffRule")), rulesBefore);
    eq("the day after the range is unaffected", statusOf("c1_2026-10-29", "julian"), "SCHEDULED");
    eq("a range that is backwards is refused", await codeOf(() => S.callOutRange(db, { clubId: CLUB, userId: "julian", fromDate: "2026-10-27", toDate: "2026-10-20", byUserId: "julian" })), "BAD_INPUT");

    // A class created after switch-on.
    fake.seed("recurringClass", [series("c3", "Weekend Group", [6], "10:00", "11:00", ["sal", "member1"])]);
    fake.seed("classSession", buildSessions("c3", CLUB, [6], "10:00", "11:00", [], d("2026-10-10"), d("2026-10-31")).map((s) => ({ id: `c3_${ymd(s.date)}`, ...s, staffOverride: null, staffManual: false, cancelPaid: false })));
    const init = await S.initClassStaffFromLegacy(db, "c3", { byUserId: "mgr", now: NOON_TUE });
    eq("a new class's coaches become rules from today (members dropped) and its coming days get rows",
      [fake.table("classStaffRule").filter((r) => r.classId === "c3").map((r) => [r.userId, ymd(r.effectiveFrom)]), on("c3_2026-10-17"), init.created], [[["sal", "2026-10-13"]], ["sal"], 3]);
    eq("…its day before today is left without rows", rowsOf("c3_2026-10-10").length, 0);
    eq("calling it again adds nothing", [(await S.initClassStaffFromLegacy(db, "c3", { now: NOON_TUE })).created, fake.table("classStaffRule").filter((r) => r.classId === "c3").length], [0, 1]);

    // The existing series reconciler hands new days to the same sync.
    const sync = await syncFutureSessions({ ...cls("c3"), recurrenceEndDate: d("2026-11-14") } as never);
    eq("syncFutureSessions gives the days it creates their coaches", [sync.created > 0, sync.staffSync.switchedOn, on("c3_2026-10-17")], [true, true, ["sal"]]);
    const newDay = fake.table("classSession").find((s) => s.classId === "c3" && ymd(s.date) === "2026-11-07");
    check("…including a day that did not exist before", !!newDay && on(newDay.id).join() === "sal");
  }

  // ── 6. Cancellation ───────────────────────────────────────────────────────
  section("6. Cancelling a class day");
  {
    const DAY = "c1_2026-10-29"; // Thursday: julian + sal
    const at = new Date("2026-10-28T15:00:00.000Z");
    const c = await S.cancelOccurrence(db, { clubId: CLUB, sessionId: DAY, reason: " gym closed ", notifyAudience: "BOTH", paid: false, byUserId: "mgr", now: at });
    eq("cancel stores who / when / why / audience / unpaid", [sess(DAY).canceled, sess(DAY).canceledByUserId, sess(DAY).canceledAt.toISOString(), sess(DAY).cancelReason, sess(DAY).cancelNotifyAudience, sess(DAY).cancelPaid, c.changed, c.before.canceled],
      [true, "mgr", at.toISOString(), "gym closed", "BOTH", false, true, false]);
    eq("the coaches' rows are left as they are", on(DAY), ["julian", "sal"]);
    await S.recordCancelNotified(db, { clubId: CLUB, sessionId: DAY, count: 7 });
    eq("the number of people told is stored", sess(DAY).cancelNotifiedCount, 7);
    eq("cancelling again writes nothing", (await S.cancelOccurrence(db, { clubId: CLUB, sessionId: DAY, notifyAudience: "NONE", paid: true, byUserId: "owner" })).changed, false);
    const afterEnd = new Date("2026-10-30T16:00:00.000Z");
    eq("pay: a canceled day pays nobody", (await taught("2026-10-29", "2026-10-29", afterEnd)).by, {});
    const p = await S.setCancelPaid(db, { clubId: CLUB, sessionId: DAY, paid: true, byUserId: "owner", now: at });
    eq("cancelled — paid: who and when", [sess(DAY).cancelPaid, sess(DAY).cancelPaidByUserId, p.before.cancelPaid, p.after.cancelPaid], [true, "owner", false, true]);
    eq("pay: cancelled-but-paid pays the scheduled coaches", (await taught("2026-10-29", "2026-10-29", afterEnd)).by, { julian: 1, sal: 1 });
    eq("…but not before the class time has passed", (await taught("2026-10-29", "2026-10-29", at)).by, {});
    const u = await S.uncancelOccurrence(db, { clubId: CLUB, sessionId: DAY, byUserId: "mgr" });
    eq("un-cancel clears the cancel and pay fields; the old values come back in `before`", [sess(DAY).canceled, sess(DAY).cancelReason, sess(DAY).cancelPaid, u.before.cancelReason, u.before.cancelPaid], [false, null, false, "gym closed", true]);
    eq("marking a day that is not canceled as paid is refused", await codeOf(() => S.setCancelPaid(db, { clubId: CLUB, sessionId: DAY, paid: true, byUserId: "owner" })), "BAD_STATE");
    const paidNow = await S.cancelOccurrence(db, { clubId: CLUB, sessionId: DAY, notifyAudience: "NONE", paid: true, byUserId: "owner", now: at });
    eq("cancel + paid in one step", [paidNow.after.canceled, paidNow.after.cancelPaid, paidNow.after.cancelPaidByUserId, paidNow.after.cancelNotifyAudience], [true, true, "owner", "NONE"]);
    await S.uncancelOccurrence(db, { clubId: CLUB, sessionId: DAY, byUserId: "mgr" });

    // A day before the switch-on date can be cancelled too, and "paid" there changes no pay.
    const before = await taught("2026-10-05", "2026-10-11", NOON_TUE);
    await S.cancelOccurrence(db, { clubId: CLUB, sessionId: "c1_2026-10-05", notifyAudience: "NONE", paid: true, byUserId: "owner" });
    const after = await taught("2026-10-05", "2026-10-11", NOON_TUE);
    eq("a canceled-but-paid day BEFORE the date is simply not paid (legacy rule)", [(before.by.julian ?? 0) - (after.by.julian ?? 0), (before.by.sal ?? 0) - (after.by.sal ?? 0)], [1, 1]);
    await S.uncancelOccurrence(db, { clubId: CLUB, sessionId: "c1_2026-10-05", byUserId: "owner" });
    check("…and un-cancelling it restores the old numbers exactly", (await taught("2026-10-05", "2026-10-11", NOON_TUE)).json === before.json);
    eq("another club cannot cancel it", await codeOf(() => S.cancelOccurrence(db, { clubId: "club_2", sessionId: DAY, notifyAudience: "NONE", paid: false, byUserId: "x" })), "NOT_FOUND");
  }

  section("Who is told a class day is cancelled");
  {
    const DAY = "c1_2026-10-29";
    const member = (id: string, o: Record<string, unknown> = {}) => ({
      id, clubId: CLUB, deletedAt: null, firstName: id, lastName: "M", email: `${id}@example.test`, isMinor: false, userId: null,
      guardianName: null, guardianEmail: null, responsiblePayerUserId: null, guardian: null, user: null, guardianLinks: [], ...o,
    });
    const parent = { id: "u_parent", email: "Parent@Example.test", firstName: "Pat", lastName: "Parent", deletedAt: null };
    const link = [{ userId: "u_parent", createdAt: d("2026-01-01"), isPrimary: true, canPay: true, user: parent }];
    fake.seed("member", [
      member("kid1", { isMinor: true, email: null, guardianLinks: link }),
      member("kid2", { isMinor: true, email: null, guardianLinks: link }),
      member("adult1"),
      member("planB"),
      member("lapsed"),
      member("archived", { deletedAt: d("2026-09-01") }),
      member("walkin"),
      member("noemail", { email: null }),
    ]);
    fake.seed("membership", [{ id: "plan_a", name: "Unlimited", options: [] }, { id: "plan_b", name: "Other", options: [] }]);
    const sub = (memberId: string, membershipId: string, status = "active") => ({
      id: `sub_${memberId}`, memberId, membershipId, status, optionId: null, optionLabel: null, billingPeriod: "MONTHLY", price: 100, endDate: null,
    });
    fake.seed("memberSubscription", [sub("kid1", "plan_a"), sub("kid2", "plan_a"), sub("adult1", "plan_a"), sub("planB", "plan_b"), sub("lapsed", "plan_a", "canceled"), sub("archived", "plan_a"), sub("noemail", "plan_a")]);
    const att = (memberId: string, status = "PRESENT", classSessionId = DAY) => ({ id: `att_${memberId}_${classSessionId}`, clubId: CLUB, classSessionId, memberId, status, checkedInAt: null, eventId: null });
    fake.seed("attendanceRecord", [att("kid1"), att("walkin", "DROP_IN"), att("planB", "ABSENT"), att("archived"), att("adult1", "PRESENT", "c1_2026-10-12"), att("lapsed", "PRESENT", "c1_2026-10-27")]);

    const none = await S.cancelAudienceMembers(CLUB, DAY, "NONE");
    eq("NONE → nobody", [none.memberIds, none.recipients], [[], []]);
    const booked = await S.cancelAudienceMembers(CLUB, DAY, "BOOKED");
    eq("BOOKED = booked into THAT day (not absent, not archived, not another day's booking)", booked.memberIds, ["kid1", "walkin"]);
    eq("…a booked non-member is included", booked.recipients.map((r) => r.email.toLowerCase()).sort(), ["parent@example.test", "walkin@example.test"]);
    const members = await S.cancelAudienceMembers(CLUB, DAY, "CLASS_MEMBERS");
    eq("CLASS_MEMBERS = an ACTIVE membership that covers this class (not another plan, not lapsed, not archived)", members.memberIds.slice().sort(), ["adult1", "kid1", "kid2", "noemail"]);
    check("…past attendance alone never qualifies", !members.memberIds.includes("walkin"));
    const both = await S.cancelAudienceMembers(CLUB, DAY, "BOTH");
    eq("BOTH = the union, booked first", both.memberIds, ["kid1", "walkin", "kid2", "adult1", "noemail"]);
    const parentRow = both.recipients.find((r) => r.email.toLowerCase() === "parent@example.test")!;
    eq("a guardian of two athletes gets ONE notice naming both", [both.recipients.filter((r) => r.email.toLowerCase() === "parent@example.test").length, parentRow.memberIds.slice().sort()], [1, ["kid1", "kid2"]]);
    eq("one recipient per address", both.recipients.length, 3);
    eq("a member with no address is reported, not dropped silently", both.skipped.map((s) => s.memberId), ["noemail"]);

    // Coach audience (who a coach may message): the new rows count.
    // Adrian is on Tuesday Oct 27 by a weekday rule row, and is NOT in the class-wide legacy list.
    eq("(setup) the Tuesday-only coach is not in the class-wide list", [asIdList(cls("c1").assignedStaffIds).includes("adrian"), on("c1_2026-10-27").includes("adrian")], [false, true]);
    const aud = await computeCoachAudienceMemberIds({ role: "STAFF", userId: "adrian", clubId: CLUB, permissions: {} });
    eq("a coach on a day by the new rows can message that day's athletes — and only those", [aud?.has("lapsed"), aud?.has("kid1")], [true, false]);
    const audMia = await computeCoachAudienceMemberIds({ role: "STAFF", userId: "mia", clubId: CLUB, permissions: {} });
    eq("a coach with no day on that class cannot", [audMia?.has("lapsed"), audMia?.has("kid1")], [false, false]);
  }

  section("Who hears that a day needs coverage");
  {
    const DAY = "c1_2026-10-29"; // julian + sal scheduled
    const def = await S.coverageRecipients(CLUB, DAY, "sal");
    eq("defaults: owners, schedule managers, the other coach that day — not the caller", [def.userIds.slice().sort(), def.channels], [["julian", "mgr", "owner"], ["IN_APP", "EMAIL"]]);
    eq("emails come back for the notice", def.users.map((u) => u.email).sort(), ["julian@example.test", "mgr@example.test", "owner@example.test"]);
    await db.clubScheduleSettings.update({ where: { clubId: CLUB }, data: { coverageNotifyOwners: false, coverageNotifyManagers: false, coverageNotifyClassStaff: false, coverageNotifyRoleNames: ["lead coach"], coverageNotifyUserIds: ["adrian", "gone", "member1"] } });
    eq("configured: named people only — removed staff and members never; a role nobody holds that day matches nobody", (await S.coverageRecipients(CLUB, DAY, "sal")).userIds.slice().sort(), ["adrian"]);
    // From Nov 2 Mia is the class's Lead Coach (the all-future change above).
    eq("a configured role name finds whoever holds that role on the day", (await S.coverageRecipients(CLUB, "c1_2026-11-05", "sal")).userIds.slice().sort(), ["adrian", "mia"]);
    eq("…but never the coach who is calling out", (await S.coverageRecipients(CLUB, "c1_2026-11-05", "mia")).userIds.slice().sort(), ["adrian"]);
    await db.clubScheduleSettings.update({ where: { clubId: CLUB }, data: { coverageNotifyOwners: true, coverageNotifyManagers: true, coverageNotifyClassStaff: true, coverageNotifyRoleNames: [], coverageNotifyUserIds: [] } });
    eq("an unknown day is refused", await codeOf(() => S.coverageRecipients(CLUB, "nope", null)), "NOT_FOUND");
  }

  section("Conflicts (warnings)");
  {
    // Adrian is on Tuesday Oct 27, 6–7 PM (rule row).
    const overlap = await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [{ date: "2026-10-27", startTime: "18:30", endTime: "19:30" }] });
    eq("overlap with their other class day", overlap.conflicts.filter((c) => c.severity === "overlap").map((c) => [c.kind, c.name, c.date, c.startTime, c.endTime]), [["CLASS", "Evening Group", "2026-10-27", "18:00", "19:00"]]);
    check("…reported as a warning with a summary line", overlap.hasOverlap && overlap.summary[0] === "Overlaps Evening Group on Tue, Oct 27, 6:00–7:00 PM", overlap.summary.join(" | "));
    const self = await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [{ date: "2026-10-27", startTime: "18:00", endTime: "19:00" }], excludeSessionIds: ["c1_2026-10-27"] });
    eq("the day being edited can be excluded", self.conflicts.filter((c) => c.severity === "overlap"), []);
    const back = await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [{ date: "2026-10-27", startTime: "19:00", endTime: "20:00" }] });
    eq("back-to-back is not an overlap", back.hasOverlap, false);
    const coachOut = await S.loadStaffConflicts({ clubId: CLUB, userId: "julian", slots: [{ date: "2026-10-27", startTime: "18:00", endTime: "19:00" }] });
    eq("a coach who called out of a day is not 'on' it", coachOut.hasOverlap, false);

    // An event (true instants): Thu Oct 29, 6:30–8:00 PM Eastern.
    fake.seed("event", [{ id: "ev1", clubId: CLUB, name: "Fall Camp", deletedAt: null, startsAt: new Date("2026-10-29T22:30:00.000Z"), endsAt: new Date("2026-10-30T00:00:00.000Z") }]);
    fake.seed("eventStaffAssignment", [{ id: "esa1", clubId: CLUB, eventId: "ev1", userId: "adrian", role: "COACH" }]);
    const ev = await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [{ date: "2026-10-29", startTime: "18:00", endTime: "19:00" }] });
    eq("overlap with an event they staff, compared in one time frame", ev.summary.filter((s) => s.startsWith("Overlaps")), ["Overlaps Fall Camp on Thu, Oct 29, 6:30–8:00 PM"]);
    const morning = await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [{ date: "2026-10-29", startTime: "09:00", endTime: "10:00" }] });
    eq("…and not with a class that morning", morning.hasOverlap, false);

    // A confirmed private lesson: Wed Oct 28, 9:30–10:30 AM Eastern (13:30–14:30Z).
    fake.seed("privateLessonType", [{ id: "lt1", title: "1-on-1" }]);
    fake.seed("privateBooking", [
      { id: "pb1", clubId: CLUB, coachId: "adrian", lessonTypeId: "lt1", status: "CONFIRMED", confirmedStartAt: new Date("2026-10-28T13:30:00.000Z"), confirmedEndAt: new Date("2026-10-28T14:30:00.000Z") },
      { id: "pb2", clubId: CLUB, coachId: "adrian", lessonTypeId: "lt1", status: "REQUESTED", confirmedStartAt: new Date("2026-11-04T13:30:00.000Z"), confirmedEndAt: new Date("2026-11-04T14:30:00.000Z") },
    ]);
    const pl = await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [{ date: "2026-10-28", startTime: "09:00", endTime: "10:00" }, { date: "2026-11-04", startTime: "09:00", endTime: "10:00" }] });
    eq("overlap with a CONFIRMED private lesson only", pl.conflicts.filter((c) => c.severity === "overlap").map((c) => [c.kind, c.id, c.startTime]), [["PRIVATE_LESSON", "pb1", "09:30"]]);

    // Availability: Adrian's saved hours are Wednesdays 4–8 PM.
    fake.seed("staffAvailability", [{ id: "av1", clubId: CLUB, userId: "adrian", dayOfWeek: 3, startTime: "16:00", endTime: "20:00", active: true }]);
    const rule = await S.conflictsForRuleChange({ clubId: CLUB, classId: "c2", userId: "adrian", dayOfWeek: null, fromDate: "2026-10-14" });
    eq("a recurring assignment is checked across the next 8 weeks and summarised",
      rule.summary, ["Overlaps Private lesson (1-on-1) on Wed, Oct 28, 9:30–10:30 AM", "Outside available hours on Wednesdays 9:00–10:00 AM (8 times)"]);
    eq("availability alone is the softer kind", [rule.conflicts.filter((c) => c.severity === "availability").length, rule.conflicts.filter((c) => c.severity === "overlap").length], [8, 1]);
    const own = await S.conflictsForRuleChange({ clubId: CLUB, classId: "c1", userId: "adrian", dayOfWeek: 2, fromDate: "2026-10-20", weeks: 2 });
    eq("a coach already on the class does not clash with their own days", own.hasOverlap, false);
    eq("no slots → no queries, no warnings", (await S.loadStaffConflicts({ clubId: CLUB, userId: "adrian", slots: [] })).conflicts, []);
    eq("an unknown class is refused", await codeOf(() => S.conflictsForRuleChange({ clubId: CLUB, classId: "nope", userId: "adrian", dayOfWeek: null, fromDate: "2026-10-14" })), "NOT_FOUND");
  }

  console.log(`\n${failures.length ? "✗" : "✓"} ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
