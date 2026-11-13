/**
 * A recurring-rule change that takes a coach OFF future class days tells that
 * coach — once, with the days summarised.
 *
 *   npx tsx scripts/coach-removed-notice-tests.ts
 *
 * Pure half: lib/classStaff.ts ruleRemovals / ruleRemovalWhen.
 * Notice half: lib/classStaffNotify.ts notifyRuleRemovals, run end to end
 * against the in-memory fake in scripts/fake-prisma.ts.
 * No database, no network. Every date is an offset from today.
 */
import fs from "node:fs";
import path from "node:path";
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import {
  addDaysYmd,
  applyRuleOps,
  clubTodayYmd,
  dowOfYmd,
  fmtMonthDay,
  planEndUserRules,
  planScopeChange,
  ruleRemovalWhen,
  ruleRemovals,
  type StaffRule,
} from "../lib/classStaff";

const fake = makeFakeDb({ relations: {} });
const EMAILS: { to: string; subject: string }[] = [];
installFakePrisma(fake.client, {
  "@/lib/email": { sendEmail: async (m: { to: string; subject: string }) => { EMAILS.push(m); }, isEmailConfigured: () => true },
  "@/lib/sendClubEmail": { sendClubEmail: async () => ({ emailSendId: "x", status: "SENT" }) },
});
/* eslint-disable @typescript-eslint/no-var-requires */
const N = require("../lib/classStaffNotify.ts") as typeof import("../lib/classStaffNotify");
/* eslint-enable @typescript-eslint/no-var-requires */

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
const section = (t: string) => console.log(`\n${t}`);

const PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const today = clubTodayYmd(null, new Date(Date.now()));
const longAgo = addDaysYmd(today, -90);
/** The first day on/after `from` that falls on weekday `d`. */
const firstOn = (from: string, d: number) => addDaysYmd(from, (d - dowOfYmd(from) + 7) % 7);

// A class on three weekdays, counted from today so nothing is pinned to a date:
// A = today's weekday, B = two days later, C = four days later.
const A = dowOfYmd(today);
const B = (A + 2) % 7;
const C = (A + 4) % 7;
const classDays = [A, B, C].sort((x, y) => x - y);
const CLASS = "c1";
const rule = (id: string, userId: string, o: Partial<StaffRule> = {}): StaffRule =>
  ({ id, classId: CLASS, userId, roleName: null, dayOfWeek: null, effectiveFrom: longAgo, effectiveTo: null, ...o });
const byUser = (list: ReturnType<typeof ruleRemovals>) => Object.fromEntries(list.map((r) => [r.userId, r]));

async function main() {
  section("\"exactly this list\" — every class day");
  {
    // head: every day · tue: weekday B only · soon: every day, but not starting for three weeks.
    const startsLater = addDaysYmd(today, 21);
    const before = [rule("r1", "head"), rule("r2", "tue", { dayOfWeek: B }), rule("r3", "soon", { effectiveFrom: startsLater })];
    // Saved from TODAY (weekday A): the list is exactly [head].
    const plan = planScopeChange({ scope: "ALL_FUTURE", classDays, date: today, currentRules: before, currentDayStaff: [], desired: [{ userId: "head" }] });
    const after = applyRuleOps(before, plan.ruleOps, CLASS);
    const out = byUser(ruleRemovals(before, after, today, classDays));
    eq("the coach kept on the list is not reported", out.head, undefined);
    eq("a coach who only coached another weekday is found (the first class day alone would miss them)",
      out.tue && [out.tue.weekdays, out.tue.staysOn, out.tue.firstDay, out.tue.everyDay], [[B], [], firstOn(today, B), false]);
    eq("a coach whose assignment had not started yet is found, from the day they would have started",
      out.soon && [out.soon.weekdays, out.soon.everyDay, out.soon.firstDay >= startsLater], [classDays, true, true]);
    eq("…in words", [ruleRemovalWhen(out.tue), ruleRemovalWhen(out.soon)],
      [`on ${PLURAL[B]} from ${fmtMonthDay(firstOn(today, B))}`, `every class day from ${fmtMonthDay(out.soon.firstDay)}`]);
    eq("one entry per coach, however many class days they lose", ruleRemovals(before, after, today, classDays).map((r) => r.userId).sort(), ["soon", "tue"]);

    const gone = applyRuleOps(before, planScopeChange({ scope: "ALL_FUTURE", classDays, date: today, currentRules: before, currentDayStaff: [], desired: [{ userId: "tue" }] }).ruleOps, CLASS);
    const head = byUser(ruleRemovals(before, gone, today, classDays)).head;
    eq("a coach who was on every class day and is left off loses every day, from today", head && [head.weekdays, head.everyDay, head.firstDay, ruleRemovalWhen(head)], [classDays, true, today, `every class day from ${fmtMonthDay(today)}`]);
  }

  section("one weekday going forward");
  {
    const before = [rule("r1", "head"), rule("r2", "asst")];
    const from = addDaysYmd(today, 7);
    const plan = planScopeChange({ scope: "WEEKDAY_FORWARD", classDays, date: from, dayOfWeek: B, currentRules: before, currentDayStaff: [], desired: [{ userId: "head" }] });
    const after = applyRuleOps(before, plan.ruleOps, CLASS);
    const list = ruleRemovals(before, after, today, classDays);
    const stays = [A, C].sort((x, y) => x - y);
    eq("only the coach taken off, only that weekday, and the days they keep", list.map((r) => [r.userId, r.weekdays, r.staysOn, r.everyDay]), [["asst", [B], stays, false]]);
    eq("the first day is the first such weekday on/after the change date", list[0].firstDay, firstOn(from, B));
    eq("…in words", ruleRemovalWhen(list[0]), `on ${PLURAL[B]} from ${fmtMonthDay(firstOn(from, B))} (still on ${PLURAL[stays[0]]} and ${PLURAL[stays[1]]})`);
  }

  section("a rule ended for one coach");
  {
    const before = [rule("r1", "head"), rule("r2", "asst")];
    const after = applyRuleOps(before, planEndUserRules(before, "asst", today), CLASS);
    eq("that coach, every class day; nobody else", ruleRemovals(before, after, today, classDays).map((r) => [r.userId, r.everyDay]), [["asst", true]]);
  }

  section("nobody is told about nothing");
  {
    const before = [rule("r1", "head"), rule("r2", "asst")];
    eq("no change → nobody", ruleRemovals(before, before, today, classDays), []);
    const reRoled = applyRuleOps(before, planScopeChange({ scope: "ALL_FUTURE", classDays, date: today, currentRules: before, currentDayStaff: [], desired: [{ userId: "head" }, { userId: "asst", roleName: "Assistant coach" }] }).ruleOps, CLASS);
    eq("a role change keeps the coach on → nobody", ruleRemovals(before, reRoled, today, classDays), []);
    const added = applyRuleOps(before, planScopeChange({ scope: "ALL_FUTURE", classDays, date: today, currentRules: before, currentDayStaff: [], desired: [{ userId: "head" }, { userId: "asst" }, { userId: "new" }] }).ruleOps, CLASS);
    eq("adding a coach removes nobody", ruleRemovals(before, added, today, classDays), []);
    const ending = [rule("r1", "head"), rule("r2", "asst", { effectiveTo: addDaysYmd(today, 10) })];
    eq("a coach already set to come off, left as they were → nobody", ruleRemovals(ending, ending, today, classDays), []);
  }

  section("never for past days");
  {
    // The coach had already finished ten days ago; the change only shortens their history.
    const before = [rule("r1", "head"), rule("r2", "old", { effectiveTo: addDaysYmd(today, -10) })];
    const after = [rule("r1", "head"), rule("r2", "old", { effectiveTo: addDaysYmd(today, -30) })];
    eq("a change that only touches days already gone tells nobody", ruleRemovals(before, after, today, classDays), []);
    // A change dated in the past: the days before today are not counted.
    const past = addDaysYmd(today, -14);
    const b2 = [rule("r1", "head"), rule("r2", "asst")];
    const a2 = applyRuleOps(b2, planEndUserRules(b2, "asst", past), CLASS);
    const r = ruleRemovals(b2, a2, today, classDays)[0];
    check("a change dated two weeks back is reported from today, never earlier", !!r && r.firstDay >= today && r.firstDay === today, JSON.stringify(r));
    // …and one whose effect was over before today reports nobody at all.
    const b3 = [rule("r1", "head"), rule("r2", "temp", { effectiveFrom: addDaysYmd(today, -20), effectiveTo: addDaysYmd(today, -5) })];
    const a3 = applyRuleOps(b3, planEndUserRules(b3, "temp", addDaysYmd(today, -15)), CLASS);
    eq("a cover that started and finished in the past → nobody", ruleRemovals(b3, a3, today, classDays), []);
  }

  section("the notice — one per coach, in the app, like every other assignment change");
  const CLUB = "club_1";
  fake.seed("club", [{ id: CLUB, name: "Northside", timezone: null, contactEmail: null }]);
  fake.seed("recurringClass", [{ id: CLASS, clubId: CLUB, name: "Evening Group", daysOfWeek: classDays, deletedAt: null }]);
  const user = (id: string, o: Record<string, unknown> = {}) => ({ id, clubId: CLUB, firstName: id, lastName: "Test", email: `${id}@example.test`, role: "STAFF", deletedAt: null, ...o });
  fake.seed("user", [user("mgr"), user("head"), user("asst"), user("tue"), user("left", { deletedAt: new Date(Date.now()) })]);
  const msgs = () => fake.table("message").map((m) => [m.recipientId, m.senderId, m.body] as [string, string, string]);
  const acts = () => fake.table("staffActivity").map((a) => [a.staffUserId, a.kind, a.summary] as [string, string, string]);
  const reset = () => { fake.table("message").length = 0; fake.table("staffActivity").length = 0; EMAILS.length = 0; };
  {
    const before = [rule("r1", "head"), rule("r2", "asst"), rule("r3", "tue", { dayOfWeek: B })];
    const after = applyRuleOps(before, planScopeChange({ scope: "ALL_FUTURE", classDays, date: today, currentRules: before, currentDayStaff: [], desired: [{ userId: "head" }] }).ruleOps, CLASS);
    const res = await N.notifyRuleRemovals({ clubId: CLUB, classId: CLASS, actorId: "mgr", actorName: "Morgan Lee", date: today, rulesBefore: before, rulesAfter: after });
    eq("both coaches left off the list are told — one message each, from the person who saved it", msgs().sort(), [
      ["asst", "mgr", `Morgan Lee took you off Evening Group every class day from ${fmtMonthDay(today)}.`],
      ["tue", "mgr", `Morgan Lee took you off Evening Group on ${PLURAL[B]} from ${fmtMonthDay(firstOn(today, B))}.`],
    ] as [string, string, string][]);
    eq("the count and who", [res.notified, res.removedIds.slice().sort(), res.removedNotified.slice().sort()], [2, ["asst", "tue"], ["asst", "tue"]]);
    eq("a Recent-activity line each", acts().sort(), [
      ["asst", "ASSIGNMENT", `Taken off Evening Group every class day from ${fmtMonthDay(today)}`],
      ["tue", "ASSIGNMENT", `Taken off Evening Group on ${PLURAL[B]} from ${fmtMonthDay(firstOn(today, B))}`],
    ] as [string, string, string][]);
    eq("in the app only — no email (assignment changes never email)", EMAILS.length, 0);
    check("the coach kept on hears nothing", !msgs().some((m) => m[0] === "head"));
  }
  {
    reset();
    // The same save, many class days ahead: still one message, not one per day.
    const before = [rule("r1", "head"), rule("r2", "asst")];
    const after = applyRuleOps(before, planEndUserRules(before, "asst", today), CLASS);
    await N.notifyRuleRemovals({ clubId: CLUB, classId: CLASS, actorId: "mgr", actorName: "Morgan Lee", date: today, rulesBefore: before, rulesAfter: after });
    eq("one notice for the whole run of class days", msgs().length, 1);
  }
  {
    reset();
    const before = [rule("r1", "head"), rule("r2", "asst")];
    const after = applyRuleOps(before, planEndUserRules(before, "asst", today), CLASS);
    const res = await N.notifyRuleRemovals({ clubId: CLUB, classId: CLASS, actorId: "asst", actorName: "asst Test", date: today, rulesBefore: before, rulesAfter: after });
    eq("a coach who took THEMSELF off is not sent a notice about their own action", [msgs().length, res.notified, res.removedIds], [0, 0, ["asst"]]);
  }
  {
    reset();
    const before = [rule("r1", "head"), rule("r2", "left")];
    const after = applyRuleOps(before, planEndUserRules(before, "left", today), CLASS);
    const res = await N.notifyRuleRemovals({ clubId: CLUB, classId: CLASS, actorId: "mgr", date: today, rulesBefore: before, rulesAfter: after });
    eq("someone no longer on the staff is not messaged", [msgs().length, res.notified], [0, 0]);
  }
  {
    reset();
    const past = addDaysYmd(today, -14);
    const before = [rule("r1", "head"), rule("r2", "asst")];
    const after = applyRuleOps(before, planEndUserRules(before, "asst", past), CLASS);
    await N.notifyRuleRemovals({ clubId: CLUB, classId: CLASS, actorId: "mgr", actorName: "Morgan Lee", date: past, rulesBefore: before, rulesAfter: after });
    eq("a change dated in the past is worded from today, never from a day already gone", msgs().map((m) => m[2]), [`Morgan Lee took you off Evening Group every class day from ${fmtMonthDay(today)}.`]);
  }
  {
    reset();
    const before = [rule("r1", "head"), rule("r2", "old", { effectiveTo: addDaysYmd(today, -10) })];
    const after = [rule("r1", "head"), rule("r2", "old", { effectiveTo: addDaysYmd(today, -30) })];
    const res = await N.notifyRuleRemovals({ clubId: CLUB, classId: CLASS, actorId: "mgr", date: addDaysYmd(today, -30), rulesBefore: before, rulesAfter: after });
    eq("a change that only touched past days: no message, no activity line", [msgs().length, acts().length, res.notified], [0, 0, 0]);
  }
  {
    reset();
    const res = await N.notifyRuleRemovals({ clubId: CLUB, classId: "nope", actorId: "mgr", date: today, rulesBefore: [rule("r1", "asst")], rulesAfter: [] });
    eq("an unknown class tells nobody (and does not throw)", [msgs().length, res.notified], [0, 0]);
  }

  section("wiring — every recurring-rule writer hands its before/after to the notice");
  {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const server = read("lib/classStaffServer.ts");
    check("the three rule writers return the rules before and after", (server.match(/rulesBefore: rules, rulesAfter: (after|afterRules)/g) ?? []).length === 3);
    const notify = read("lib/classStaffNotify.ts");
    const body = notify.slice(notify.indexOf("export async function notifyRuleRemovals"), notify.indexOf("// ── Cancellation"));
    check("it reuses the assignment notice — no second notification path", body.includes("await notifyAssignmentChange(") && !/sendEmail\(|prisma\.message\./.test(body));
    check("days before today are cut off on the club's calendar", body.includes("maxYmd(input.date, clubTodayYmd(club.timezone"));
    const staffing = read("app/api/classes/[id]/staffing/route.ts");
    check("the three-scope save: rule scopes go through it, a one-day change keeps the day notice",
      staffing.includes("removedIds: result.day ? removedIds : []") && staffing.includes("rulesBefore: result.rulesBefore, rulesAfter: result.rulesAfter"));
    for (const rel of ["app/api/classes/[id]/route.ts", "app/api/classes/[id]/occurrence/route.ts", "app/api/classes/[id]/staff/route.ts"]) {
      const s = read(rel);
      check(`${rel} tells coaches left off a saved list`, s.includes("notifyRuleRemovals({") && /rulesBefore: \w+(\.\w+)*\.rulesBefore/.test(s));
      check(`…after the transaction, not inside it`, s.indexOf("notifyRuleRemovals({") > s.lastIndexOf("applySeriesListChange(tx"));
    }
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
