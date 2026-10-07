/**
 * Pay plans + the pay ledger — the database side and the API, exercised not
 * inspected (Branch 2).
 *
 *   npx tsx scripts/pay-ledger-server-tests.ts
 *
 * The REAL library code and the REAL exported route handlers run against the
 * in-memory fake in scripts/fake-prisma.ts with a fabricated session (the same
 * method as scripts/class-staffing-api-tests.ts). No database, no network.
 * The clock is pinned: Tuesday Oct 20 2026, noon in New York. The club's
 * coach assignments started Oct 7; its pay ledger starts Tue Oct 13.
 *
 * What it pins — the owner's rules:
 *   1. nothing before the ledger start date ever gets a pay line; a future
 *      class never pays; an ended class day pays each coach still scheduled
 *   2. salary = one full-amount line per pay period; a salaried coach's class
 *      days are $0 lines; no plan = "needs review" with no amount
 *   3. the sync is idempotent, and cancel / cancel-paid / replace / no-show
 *      move lines the right way
 *   4. a substitute is paid from their own plan; the pay for one day can be
 *      set (override) with a reason and a name; the plan is never changed
 *   5. only finances:full writes anything, and NEVER to your own pay
 *   6. several plans per coach; edit in place; copy = an independent plan
 *   7. bonuses / adjustments by hand, dated inside the ledger, audited
 *   8. a payout pays exact lines; paid lines are locked; history is never
 *      rewritten; voiding releases the lines
 *   9. reports: old calculation before the date + pay lines after, no overlap
 *  10. removing a staff member ends their recurring assignments, opens their
 *      future class days as "needs coverage", and leaves the past alone
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { buildSessions } from "../lib/classSessions";

// ── A pinned clock ──────────────────────────────────────────────────────────
const RealDate = Date;
let NOW = RealDate.parse("2026-10-20T16:00:00.000Z"); // Tue Oct 20 2026, noon New York
class PinnedDate extends RealDate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...a: any[]) {
    if (a.length === 0) super(NOW);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else super(...(a as [any]));
  }
  static now() { return NOW; }
}
(globalThis as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;
const setNow = (iso: string) => { NOW = RealDate.parse(iso); };

const fake = makeFakeDb({
  relations: {
    classSession: {
      recurringClass: { model: "recurringClass", kind: "one", fk: "classId" },
      club: { model: "club", kind: "one", fk: "clubId" },
      staff: { model: "classSessionStaff", kind: "many", fk: "sessionId" },
    },
    classSessionStaff: { session: { model: "classSession", kind: "one", fk: "sessionId" } },
    recurringClass: {
      club: { model: "club", kind: "one", fk: "clubId" },
      sessions: { model: "classSession", kind: "many", fk: "classId" },
    },
    attendanceRecord: { classSession: { model: "classSession", kind: "one", fk: "classSessionId" } },
    memberSubscription: { member: { model: "member", kind: "one", fk: "memberId" } },
    eventStaffAssignment: { event: { model: "event", kind: "one", fk: "eventId" } },
    staffCompensation: {
      bonuses: { model: "compensationBonus", kind: "many", fk: "compensationId" },
      assignments: { model: "compensationAssignment", kind: "many", fk: "compensationId" },
    },
    user: { compensations: { model: "staffCompensation", kind: "many", fk: "userId" } },
  },
  uniques: {
    classSession: [["classId", "date"]],
    classSessionStaff: [["sessionId", "userId"]],
    clubScheduleSettings: [["clubId"]],
    payLine: [["userId", "sourceType", "sourceId", "component"]],
  },
});

type Sess = { user: { id: string; role: string; clubId: string; name: string; email: string; permissions: Record<string, unknown> | null } } | null;
let CURRENT: Sess = null;

installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => CURRENT, default: {} },
  "@/lib/auth": { authOptions: {} },
  "@/lib/email": { sendEmail: async () => {}, isEmailConfigured: () => true },
  "@/lib/sendClubEmail": { sendClubEmail: async () => ({ emailSendId: "es", status: "SENT" }) },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const L = require("../lib/payLedgerServer.ts") as typeof import("../lib/payLedgerServer");
const guardLib = require("../lib/apiGuard.ts") as typeof import("../lib/apiGuard");
const { computePayrollTotalForRange } = require("../lib/payroll.ts") as typeof import("../lib/payroll");
const { loadClubReminders } = require("../lib/payReminders.ts") as typeof import("../lib/payReminders");
const AC = require("../lib/actionCenter.ts") as typeof import("../lib/actionCenter");
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
const d = (ymd: string) => new RealDate(`${ymd}T00:00:00.000Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);

// ── Fixtures ────────────────────────────────────────────────────────────────
const CLUB = "club_1";
const NY = "America/New_York";
const COACH = {
  members: "view", attendance: "full", classes: "edit", events: "view", schedule: "view", messages: "send",
  documents: "view", finances: "none", billing: "none", reports: "none", staff: "none",
};
const user = (id: string, role: string, perms: Record<string, unknown> | null) => ({
  id, clubId: CLUB, role, deletedAt: null, firstName: id, lastName: "Test", email: `${id}@example.test`, resetToken: null,
  staffProfile: perms ? { title: "Coach", permissions: perms } : null,
});
fake.seed("club", [{ id: CLUB, name: "Test Club", timezone: NY }]);
fake.seed("clubScheduleSettings", [{ clubId: CLUB, assignmentsStartOn: d("2026-10-07"), payLedgerStartsOn: d("2026-10-13") }]);
fake.seed("user", [
  user("owner", "OWNER", null),
  user("fin", "STAFF", { ...COACH, finances: "full", staff: "full" }),
  user("viewer", "STAFF", { ...COACH, finances: "view" }),
  user("sal", "STAFF", COACH), user("josh", "STAFF", COACH), user("matt", "STAFF", COACH), user("kate", "STAFF", COACH),
]);
const CLASSES: [string, string, number[], string, string, string[]][] = [
  ["jr", "Jr Frogs", [1, 3], "18:00", "19:00", ["sal", "josh"]],
  ["tad", "Tadpoles", [0, 3], "13:15", "14:00", ["matt"]],
  ["girls", "Girls Class", [5], "17:00", "18:30", ["kate"]],
  ["fun", "Sunday Funday", [0], "11:00", "13:00", ["fin"]],
];
for (const [id, name, days, st, en, coaches] of CLASSES) {
  fake.seed("recurringClass", [{
    id, clubId: CLUB, name, daysOfWeek: days, startTime: st, endTime: en, dayOverrides: [], assignedStaffIds: coaches, locationId: null,
    recurrenceStartDate: d("2026-09-01"), recurrenceEndDate: null, active: true, deletedAt: null, pricingOptions: [],
  }]);
  const sessions = buildSessions(id, CLUB, days, st, en, [], d("2026-10-05"), d("2026-11-30")).map((s) => ({
    id: `${id}_${ymd(s.date)}`, ...s, staffOverride: null, staffManual: false, cancelPaid: false, cancelReason: null,
  }));
  fake.seed("classSession", sessions);
  fake.seed("classStaffRule", coaches.map((u) => ({
    id: `rule_${id}_${u}`, clubId: CLUB, classId: id, userId: u, roleName: null, dayOfWeek: null, effectiveFrom: d("2026-10-07"), effectiveTo: null,
    createdAt: d("2026-10-07"),
  })));
  for (const s of sessions) {
    if (ymd(s.date) < "2026-10-07") continue;
    fake.seed("classSessionStaff", coaches.map((u) => ({
      id: `${s.id}_${u}`, clubId: CLUB, sessionId: s.id, userId: u, roleName: null, kind: "REGULAR", status: "SCHEDULED", source: "RULE",
      ruleId: `rule_${id}_${u}`, replacesStaffId: null, lateCallout: false, calledOutAt: null, calledOutByUserId: null, calloutReason: null,
      coverageFilledAt: null, coverageFilledByUserId: null, note: null, payOverrideCents: null, payOverrideReason: null,
      payOverrideByUserId: null, payOverrideAt: null, createdAt: d("2026-10-07"),
    })));
  }
}
const comp = (id: string, userId: string, baseType: string, baseAmount: number, from: string, o: Record<string, unknown> = {}) => ({
  id, clubId: CLUB, userId, name: "Pay plan", baseType, baseAmount, effectiveFrom: d(from), effectiveTo: null, copiedFromId: null,
  archivedAt: null, createdAt: d(from), ...o,
});
fake.seed("staffCompensation", [
  comp("p_sal", "sal", "SALARY", 1700, "2026-06-01"),
  comp("p_josh", "josh", "PER_CLASS", 25, "2026-07-01"),
  comp("p_matt", "matt", "PER_CLASS", 25, "2026-09-30"),
  comp("p_fin", "fin", "PER_CLASS", 40, "2026-09-01"),
]);
fake.seed("compensationAssignment", [
  { id: "a1", compensationId: "p_josh", bonusId: null, scopeType: "CLASS", scopeId: "jr" },
  { id: "a2", compensationId: "p_matt", bonusId: null, scopeType: "CLASS", scopeId: "tad" },
]);
const sched = (userId: string) => ({ id: `sch_${userId}`, clubId: CLUB, userId, frequency: "BIWEEKLY", anchorDate: d("2026-10-12"), active: true, lastEmailedFor: null });
fake.seed("staffPaySchedule", [sched("sal"), sched("josh")]);

const lines = (userId?: string) => fake.table("payLine").filter((l) => !userId || l.userId === userId);
const live = (userId?: string) => lines(userId).filter((l) => l.status !== "VOID");
const lineFor = (sessionId: string, userId: string, component = "BASE") =>
  fake.table("payLine").find((l) => l.sourceType === "CLASS_SESSION" && l.sourceId === `${sessionId}_${userId}` && l.component === component);
const rowOf = (sessionId: string, userId: string) => fake.table("classSessionStaff").find((r) => r.sessionId === sessionId && r.userId === userId)!;
const sessRow = (id: string) => fake.table("classSession").find((r) => r.id === id)!;
const audits = (action: string) => fake.table("billingAuditLog").filter((a) => a.action === action);
const activity = (userId: string) => fake.table("staffActivity").filter((a) => a.staffUserId === userId).map((a) => a.summary as string);

function sess(id: string): Sess {
  const u = fake.table("user").find((x) => x.id === id)!;
  return { user: { id, clubId: u.clubId, name: `${u.firstName} ${u.lastName}`, email: u.email, role: u.role, permissions: u.staffProfile?.permissions ?? null } };
}
type Out = { status: number | null; body: any; threw?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(route: string, verb: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", as: string | null, opts: { params?: Record<string, string>; body?: unknown; query?: string } = {}): Promise<Out> {
  CURRENT = as ? sess(as) : null;
  fake.resetCalls();
  for (const u of fake.table("user")) guardLib.invalidatePermissionCache(u.id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(route) as Record<string, (r: Request, c?: unknown) => Promise<Response>>;
  const handler = mod[verb];
  if (!handler) throw new Error(`${route} has no ${verb}`);
  const init: RequestInit = { method: verb, headers: { "Content-Type": "application/json" } };
  if (verb !== "GET" && opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const realLog = console.log, realError = console.error, realWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    const res = await handler(new Request(`http://localhost/api/test${opts.query ?? ""}`, init), { params: Promise.resolve(opts.params ?? {}) });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body };
  } catch (threw) {
    return { status: null, body: null, threw };
  } finally {
    console.log = realLog; console.error = realError; console.warn = realWarn;
  }
}
const is = (o: Out, code: number, errCode?: string) => o.status === code && (errCode === undefined || o.body?.code === errCode);
const why = (o: Out) => `got ${o.status ?? "a throw"} ${o.threw ? String((o.threw as Error)?.stack ?? o.threw).slice(0, 500) : JSON.stringify(o.body)?.slice(0, 300)}`;
const wrote = (model: string) => fake.writes().filter((c) => c.model === model);

const R = (p: string) => require.resolve(`../app/api/${p}/route.ts`);
const LEDGER = R("payroll/ledger");
const PLANS_ALL = R("payroll/plans");
const PLANS = R("staff/[id]/pay-plans");
const PLAN = R("staff/[id]/pay-plans/[planId]");
const COPY = R("staff/[id]/pay-plans/[planId]/copy");
const LINES = R("payroll/lines");
const LINE = R("payroll/lines/[lineId]");
const PAYOUTS = R("payroll/ledger/payouts");
const PAYOUT = R("payouts/[id]");
const PAYOUT_LIST = R("payouts");
const MARK_PAID = R("payroll/reminders/mark-paid");
const OVERRIDE = R("classes/session-staff/[staffRowId]/pay-override");
const LEDGER_START = R("settings/schedule/pay-ledger");
const STAFF = R("staff/[id]");
const COMP = R("staff/[id]/compensation");
const LEGACY = R("staff/payroll");

const planBody = (o: Record<string, unknown> = {}) => ({ name: "Jr Frogs Lead", baseType: "PER_CLASS", baseAmount: 45, effectiveFrom: "2026-10-13", effectiveTo: null, baseScopes: [], bonuses: [], ...o });

async function main() {
  console.log("\nPAY LEDGER — real code, in-memory database, pinned clock (Tue Oct 20 2026, noon New York)\n");

  section("1. Nothing before the ledger start date");
  {
    setNow("2026-10-12T23:30:00.000Z"); // Mon Oct 12, 7:30 PM New York — the day before the ledger starts; Jr Frogs just ended
    const r = await L.syncPayLines(CLUB);
    eq("the day before the start date: the sync writes nothing, though a class just ended", [r.on, r.created, lines().length], [true, 0, 0]);
    setNow("2026-10-20T16:00:00.000Z");
    const r2 = await L.syncPayLines(CLUB);
    check("on Oct 20 the lines exist", r2.created === 9, `created ${r2.created}`);
    eq("no line is dated before Oct 13 — the Oct 7–12 class days stay with the old system", lines().filter((l) => ymd(l.workDate) < "2026-10-13" ).length, 0);
    eq("…including Jr Frogs on Mon Oct 12, which has coach rows", lineFor("jr_2026-10-12", "josh"), undefined);
    eq("a class later today / tomorrow has no line (future classes never pay)", [lineFor("jr_2026-10-21", "josh"), lineFor("tad_2026-10-21", "matt")], [undefined, undefined]);
  }

  section("2. What the lines say");
  {
    eq("Josh: $25 for each Jr Frogs class that ended (Oct 14, Oct 19), in the Oct 13–26 pay period", live("josh").map((l) => [ymd(l.workDate), l.amountCents, l.planName, ymd(l.periodStart), ymd(l.periodEnd), l.status]).sort(),
      [["2026-10-14", 2500, "Pay plan", "2026-10-13", "2026-10-26", "ESTIMATED"], ["2026-10-19", 2500, "Pay plan", "2026-10-13", "2026-10-26", "ESTIMATED"]]);
    const salary = live("sal").filter((l) => l.sourceType === "SALARY");
    eq("Sal: ONE salary line for the pay period, the full $1,700, dated on the payday", salary.map((l) => [l.amountCents, ymd(l.workDate), ymd(l.periodStart), l.sourceId]), [[170000, "2026-10-26", "2026-10-13", "p_sal|2026-10-26"]]);
    eq("…and his class days are $0 lines covered by the salary", live("sal").filter((l) => l.sourceType === "CLASS_SESSION").map((l) => [l.amountCents, /covered by salary/.test(l.description)]), [[0, true], [0, true]]);
    eq("Matt has no pay schedule: his lines are still made, with no pay period", live("matt").map((l) => [ymd(l.workDate), l.amountCents, l.periodEnd]).sort(), [["2026-10-14", 2500, null], ["2026-10-18", 2500, null]]);
    const kate = lineFor("girls_2026-10-16", "kate")!;
    eq("Kate has no pay plan: her class day needs review and has NO amount", [kate.status, kate.amountCents, kate.planId], ["NEEDS_REVIEW", null, null]);
    const again = await L.syncPayLines(CLUB);
    eq("running the sync again changes nothing", [again.created, again.updated, again.voided], [0, 0, 0]);

    // The owner coaches a class day and has no pay plan.
    fake.seed("classSessionStaff", [{ ...rowOf("jr_2026-10-14", "josh"), id: "jr_2026-10-14_owner", userId: "owner", ruleId: null, source: "MANUAL" }]);
    await L.syncPayLines(CLUB);
    eq("an OWNER with no pay plan is not put on the ledger (no 'needs review' for every class the owner coaches)", lines("owner").length, 0);
    fake.seed("staffCompensation", [comp("p_owner", "owner", "PER_CLASS", 30, "2026-10-01")]);
    await L.syncPayLines(CLUB);
    eq("…an owner who gives themself a plan is paid from it like anyone else", lines("owner").map((l) => l.amountCents), [3000]);
    fake.table("staffCompensation").splice(fake.table("staffCompensation").findIndex((p) => p.id === "p_owner"), 1);
    fake.table("classSessionStaff").splice(fake.table("classSessionStaff").findIndex((r) => r.id === "jr_2026-10-14_owner"), 1);
    fake.table("payLine").splice(fake.table("payLine").findIndex((l) => l.userId === "owner"), 1);
  }

  section("3. Cancelled, cancelled-paid, substitute, no-show");
  {
    const s = sessRow("tad_2026-10-18");
    s.canceled = true;
    await L.syncPayLines(CLUB);
    const l = lineFor("tad_2026-10-18", "matt")!;
    check("a cancelled class day: the line is withdrawn (kept on record), with the reason", l.status === "VOID" && /cancelled/.test(l.voidReason), JSON.stringify([l.status, l.voidReason]));
    s.cancelPaid = true;
    await L.syncPayLines(CLUB);
    eq("marked 'cancelled — paid': the line pays again", [lineFor("tad_2026-10-18", "matt")!.status, lineFor("tad_2026-10-18", "matt")!.amountCents, lineFor("tad_2026-10-18", "matt")!.voidReason], ["ESTIMATED", 2500, null]);
    s.canceled = false; s.cancelPaid = false;

    // Josh covers Tadpoles on Oct 14 for Matt.
    rowOf("tad_2026-10-14", "matt").status = "REPLACED";
    fake.seed("classSessionStaff", [{ ...rowOf("tad_2026-10-14", "matt"), id: "tad_2026-10-14_josh", userId: "josh", kind: "SUBSTITUTE", status: "SCHEDULED", source: "MANUAL", roleName: "Substitute", replacesStaffId: "tad_2026-10-14_matt", ruleId: null }]);
    await L.syncPayLines(CLUB);
    check("the replaced coach is not paid for that day", lineFor("tad_2026-10-14", "matt")!.status === "VOID" && /substitute/i.test(lineFor("tad_2026-10-14", "matt")!.voidReason));
    const subLine = lineFor("tad_2026-10-14", "josh")!;
    eq("the substitute's own plan only covers Jr Frogs → needs review, no guessed amount", [subLine.status, subLine.amountCents], ["NEEDS_REVIEW", null]);
    check("…and the plan they do have is untouched", fake.table("staffCompensation").find((p) => p.id === "p_josh")!.baseAmount === 25);

    rowOf("jr_2026-10-19", "josh").status = "NO_SHOW";
    await L.syncPayLines(CLUB);
    check("a no-show is not paid", lineFor("jr_2026-10-19", "josh")!.status === "VOID" && /no-show/.test(lineFor("jr_2026-10-19", "josh")!.voidReason));
    rowOf("jr_2026-10-19", "josh").status = "SCHEDULED";
    await L.syncPayLines(CLUB);
    eq("…cleared: paid again", lineFor("jr_2026-10-19", "josh")!.status, "ESTIMATED");
  }

  section("4. Setting the pay for one class day (the override)");
  {
    const sub = lineFor("tad_2026-10-14", "josh")!;
    let o = await call(LEDGER, "GET", "owner");
    const view = o.body?.coaches?.find((c: { userId: string }) => c.userId === "josh")?.lines.find((l: { id: string }) => l.id === sub.id);
    eq("the screen is told what the regular coach's plan would have paid ('Match Matt's rate')", view?.matchRegular, { name: "matt", cents: 2500 });
    o = await call(LINE, "PATCH", "owner", { params: { lineId: sub.id }, body: { action: "override", amount: 25 } });
    check("an override with no reason → 400", is(o, 400), why(o));
    o = await call(LINE, "PATCH", "owner", { params: { lineId: sub.id }, body: { action: "override", amount: 25, reason: "Paid Matt's rate for covering" } });
    check("the owner sets the pay for that one day", is(o, 200), why(o));
    const after = lineFor("tad_2026-10-14", "josh")!;
    eq("the line pays the set amount, says who and why, and is no longer 'needs review'", [after.amountCents, after.rateSource, after.status, after.overrideReason, after.overrideByUserId], [2500, "OVERRIDE", "ESTIMATED", "Paid Matt's rate for covering", "owner"]);
    eq("it lives on that one assignment", [rowOf("tad_2026-10-14", "josh").payOverrideCents, rowOf("tad_2026-10-14", "josh").payOverrideByUserId], [2500, "owner"]);
    eq("no pay plan was changed or created", fake.table("staffCompensation").map((p) => [p.id, p.baseAmount]), [["p_sal", 1700], ["p_josh", 25], ["p_matt", 25], ["p_fin", 40]]);
    check("audited: who, before, after, reason", audits("PAY_LINE_OVERRIDE_SET").length === 1 && audits("PAY_LINE_OVERRIDE_SET")[0].actorUserId === "owner" && activity("josh").some((s) => /Set the pay/.test(s)));
    await L.syncPayLines(CLUB);
    eq("the override survives the next sync", lineFor("tad_2026-10-14", "josh")!.amountCents, 2500);

    // Before the class happens: Wed Oct 21 Jr Frogs, Josh as lead for the day.
    o = await call(OVERRIDE, "PUT", "owner", { params: { staffRowId: "jr_2026-10-21_josh" }, body: { amount: 60, reason: "Running the class alone" } });
    check("an override can be set BEFORE the class happens", is(o, 200) && rowOf("jr_2026-10-21", "josh").payOverrideCents === 6000 && lineFor("jr_2026-10-21", "josh") === undefined, why(o));
    o = await call(OVERRIDE, "PUT", "owner", { params: { staffRowId: "jr_2026-10-12_josh" }, body: { amount: 60, reason: "x" } });
    check("…but not on a class day before the ledger started (it would change nothing) → 409", is(o, 409, "BEFORE_LEDGER") && rowOf("jr_2026-10-12", "josh").payOverrideCents === null, why(o));
    setNow("2026-10-22T16:00:00.000Z");
    await L.syncPayLines(CLUB);
    const wed = lineFor("jr_2026-10-21", "josh")!;
    eq("…and once the class has ended the line pays it, with the plan amount kept beside it", [wed.amountCents, wed.rateSource, wed.planAmountCents], [6000, "OVERRIDE", 2500]);
    o = await call(LINE, "PATCH", "owner", { params: { lineId: wed.id }, body: { action: "clearOverride" } });
    eq("clearing it goes back to the plan", [o.status, lineFor("jr_2026-10-21", "josh")!.amountCents, lineFor("jr_2026-10-21", "josh")!.rateSource, rowOf("jr_2026-10-21", "josh").payOverrideCents], [200, 2500, "PLAN", null]);
    setNow("2026-10-20T16:00:00.000Z");
  }

  section("5. Who may do what");
  {
    const kateLine = lineFor("girls_2026-10-16", "kate")!;
    const finLine = lineFor("fun_2026-10-18", "fin")!;
    let o = await call(LEDGER, "GET", null);
    check("no session → 401", is(o, 401), why(o));
    o = await call(LEDGER, "GET", "josh");
    check("a coach cannot read the ledger → 403", is(o, 403), why(o));
    o = await call(LEDGER, "GET", "josh", { query: "?userId=josh" });
    check("…but may read their OWN lines", is(o, 200) && o.body.coaches.length === 1 && o.body.coaches[0].userId === "josh" && o.body.viewer.canEdit === false, why(o));
    o = await call(LEDGER, "GET", "josh", { query: "?userId=matt" });
    check("…never someone else's → 403", is(o, 403), why(o));
    o = await call(LEDGER, "GET", "viewer");
    check("finances:view reads everything, read-only", is(o, 200) && o.body.viewer.canEdit === false && o.body.coaches.length >= 4, why(o));
    eq("the ledger never returns a line before its start date", o.body.coaches.flatMap((c: { lines: { workDate: string }[] }) => c.lines).filter((l: { workDate: string }) => l.workDate < "2026-10-13").length, 0);
    check("it flags pay setup problems (none yet: salary has a schedule)", Array.isArray(o.body.notes) && o.body.notes.length === 0, JSON.stringify(o.body.notes));

    const writes: [string, string, "POST" | "PATCH" | "PUT" | "DELETE", Record<string, unknown>][] = [
      ["add a pay plan", PLANS, "POST", { params: { id: "kate" }, body: planBody() }],
      ["edit a pay plan", PLAN, "PATCH", { params: { id: "josh", planId: "p_josh" }, body: planBody() }],
      ["remove a pay plan", PLAN, "DELETE", { params: { id: "josh", planId: "p_josh" } }],
      ["copy a pay plan", COPY, "POST", { params: { id: "josh", planId: "p_josh" }, body: { toUserIds: ["kate"], effectiveFrom: "2026-10-13" } }],
      ["set the pay for a line", LINE, "PATCH", { params: { lineId: kateLine.id }, body: { action: "override", amount: 50, reason: "x" } }],
      ["set the pay for a class day", OVERRIDE, "PUT", { params: { staffRowId: "girls_2026-10-16_kate" }, body: { amount: 50, reason: "x" } }],
      ["add a bonus", LINES, "POST", { body: { userId: "kate", kind: "BONUS", amount: 20, description: "x", workDate: "2026-10-15" } }],
      ["record a payout", PAYOUTS, "POST", { body: { userId: "matt", lineIds: [lineFor("tad_2026-10-18", "matt")!.id], status: "PAID", method: "CASH" } }],
      ["old one-plan save", COMP, "PUT", { params: { id: "kate" }, body: { baseType: "PER_CLASS", baseAmount: 50, baseScopes: [], bonuses: [] } }],
    ];
    const before = JSON.stringify([fake.table("staffCompensation"), fake.table("payLine"), fake.table("payout"), fake.table("classSessionStaff")]);
    for (const who of ["josh", "viewer"]) {
      const res = [];
      for (const [, route, verb, opts] of writes) res.push((await call(route, verb, who, opts)).status);
      eq(`${who === "josh" ? "a coach" : "finances:view"}: every pay write → 403`, res, writes.map(() => 403));
    }
    eq("…and nothing was written", JSON.stringify([fake.table("staffCompensation"), fake.table("payLine"), fake.table("payout"), fake.table("classSessionStaff")]) === before, true);

    // fin holds finances:full — and coaches Sunday Funday. Never their own pay.
    const self: [string, string, "POST" | "PATCH" | "PUT" | "DELETE", Record<string, unknown>][] = [
      ["add a plan for themself", PLANS, "POST", { params: { id: "fin" }, body: planBody() }],
      ["edit their own plan", PLAN, "PATCH", { params: { id: "fin", planId: "p_fin" }, body: planBody({ baseAmount: 400 }) }],
      ["remove their own plan", PLAN, "DELETE", { params: { id: "fin", planId: "p_fin" } }],
      ["copy a plan TO themself", COPY, "POST", { params: { id: "josh", planId: "p_josh" }, body: { toUserIds: ["kate", "fin"], effectiveFrom: "2026-10-13" } }],
      ["set the pay on their own line", LINE, "PATCH", { params: { lineId: finLine.id }, body: { action: "override", amount: 500, reason: "x" } }],
      ["set the pay on their own class day", OVERRIDE, "PUT", { params: { staffRowId: "fun_2026-10-18_fin" }, body: { amount: 500, reason: "x" } }],
      ["give themself a bonus", LINES, "POST", { body: { userId: "fin", kind: "BONUS", amount: 500, description: "x", workDate: "2026-10-15" } }],
      ["pay themself", PAYOUTS, "POST", { body: { userId: "fin", lineIds: [finLine.id], status: "PAID", method: "CASH" } }],
      ["the old one-plan save on themself", COMP, "PUT", { params: { id: "fin" }, body: { baseType: "PER_CLASS", baseAmount: 500, baseScopes: [], bonuses: [] } }],
    ];
    const res = [];
    for (const [, route, verb, opts] of self) res.push((await call(route, verb, "fin", opts)).status);
    eq("a finances:full manager can NEVER touch their own pay — plans, lines, bonuses, payouts → 403", res, self.map(() => 403));
    eq("…and nothing was written (the copy to kate+fin was refused whole)", JSON.stringify([fake.table("staffCompensation"), fake.table("payLine"), fake.table("payout"), fake.table("classSessionStaff")]) === before, true);
    o = await call(PLAN, "PATCH", "fin", { params: { id: "kate", planId: "p_fin" }, body: planBody({ baseAmount: 400 }) });
    check("naming someone else in the URL does not reach your own plan → 404", is(o, 404) && fake.table("staffCompensation").find((p) => p.id === "p_fin")!.baseAmount === 40, why(o));
    o = await call(LEDGER, "GET", "fin");
    check("the manager sees their own lines but the screen is told the caller", is(o, 200) && o.body.viewer.userId === "fin" && o.body.viewer.isOwner === false, why(o));
  }

  section("6. Several plans per coach; edit in place; copy is independent");
  {
    let o = await call(PLANS, "POST", "fin", { params: { id: "kate" }, body: planBody({ name: "Girls Class Lead", baseAmount: 50, baseScopes: [{ scopeType: "CLASS", scopeId: "girls" }], bonuses: [{ bonusType: "ATTENDANCE", amount: 9, minThreshold: 8, maxThreshold: 30, countPer: "CLASS_DAY", scopes: [{ scopeType: "CLASS", scopeId: "girls" }] }] }) });
    check("finances:full adds a plan for someone else", is(o, 201) && o.body.plan.name === "Girls Class Lead", why(o));
    const katePlan = o.body.plan.id as string;
    const bonusId = o.body.plan.bonuses[0].id as string;
    eq("Kate's 'needs review' class day now has an amount", [lineFor("girls_2026-10-16", "kate")!.status, lineFor("girls_2026-10-16", "kate")!.amountCents, lineFor("girls_2026-10-16", "kate")!.planName], ["ESTIMATED", 5000, "Girls Class Lead"]);
    fake.seed("attendanceRecord", Array.from({ length: 12 }, (_, i) => ({ id: `att_${i}`, clubId: CLUB, classSessionId: "girls_2026-10-16", memberId: `m${i}`, status: "PRESENT", eventId: null, createdAt: d("2026-10-16") })));
    await L.syncPayLines(CLUB);
    const bonus = lineFor("girls_2026-10-16", "kate", `BONUS:${bonusId}`)!;
    eq("her attendance bonus, counted that class day: 12 attending, after 8 → 4 × $9", [bonus.units, bonus.amountCents], [4, 3600]);

    o = await call(PLANS, "POST", "owner", { params: { id: "josh" }, body: planBody({ name: "Jr Frogs Lead", baseAmount: 45, baseScopes: [{ scopeType: "CLASS", scopeId: "jr" }, { scopeType: "ROLE", scopeId: "Lead Coach" }] }) });
    check("a second plan for Josh: Jr Frogs as Lead Coach, $45", is(o, 201), why(o));
    eq("Josh now holds two plans", fake.table("staffCompensation").filter((p) => p.userId === "josh").length, 2);
    eq("his ordinary days still pay the class plan ($25)", lineFor("jr_2026-10-14", "josh")!.amountCents, 2500);
    rowOf("jr_2026-10-19", "josh").roleName = "Lead Coach";
    await L.syncPayLines(CLUB);
    eq("the day he was Lead Coach pays the more specific plan ($45), by name", [lineFor("jr_2026-10-19", "josh")!.amountCents, lineFor("jr_2026-10-19", "josh")!.planName], [4500, "Jr Frogs Lead"]);

    o = await call(PLANS, "POST", "owner", { params: { id: "josh" }, body: planBody({ name: "Jr Frogs other", baseAmount: 99, baseScopes: [{ scopeType: "CLASS", scopeId: "jr" }] }) });
    const dup = o.body.plan.id as string;
    eq("two plans that fit equally → needs review, no amount picked", [lineFor("jr_2026-10-14", "josh")!.status, lineFor("jr_2026-10-14", "josh")!.amountCents], ["NEEDS_REVIEW", null]);
    o = await call(PLAN, "DELETE", "owner", { params: { id: "josh", planId: dup } });
    const gone = fake.table("staffCompensation").find((p) => p.id === dup)!;
    check("removing a plan archives it (the row stays) and the day is priced again", is(o, 200) && gone.archivedAt !== null && lineFor("jr_2026-10-14", "josh")!.amountCents === 2500, why(o));

    o = await call(PLAN, "PATCH", "owner", { params: { id: "kate", planId: katePlan }, body: planBody({ name: "Girls Class Lead", baseAmount: 55, baseScopes: [{ scopeType: "CLASS", scopeId: "girls" }], bonuses: [{ id: bonusId, bonusType: "ATTENDANCE", amount: 10, minThreshold: 8, maxThreshold: 30, countPer: "CLASS_DAY", scopes: [{ scopeType: "CLASS", scopeId: "girls" }] }] }) });
    check("editing keeps the SAME plan and the SAME bonus (never delete-and-recreate)", is(o, 200) && o.body.plan.id === katePlan && o.body.plan.bonuses[0].id === bonusId && fake.table("compensationBonus").filter((b) => b.compensationId === katePlan).length === 1, why(o));
    eq("…and re-prices her unpaid lines", [lineFor("girls_2026-10-16", "kate")!.amountCents, lineFor("girls_2026-10-16", "kate", `BONUS:${bonusId}`)!.amountCents], [5500, 4000]);
    check("plan changes are audited with before and after", audits("PAY_PLAN_UPDATED").some((a) => a.before?.baseAmount === 50 && a.after?.baseAmount === 55) && audits("PAY_PLAN_CREATED").length >= 3);

    o = await call(COPY, "POST", "owner", { params: { id: "kate", planId: katePlan }, body: { toUserIds: ["matt"], name: "Girls Class Lead (Matt)", effectiveFrom: "2026-10-20" } });
    const copyId = o.body?.copies?.[0]?.id as string;
    const copy = fake.table("staffCompensation").find((p) => p.id === copyId);
    check("copy ONE specific plan to another coach: a new plan of their own, by name", is(o, 201) && copy?.userId === "matt" && copy?.name === "Girls Class Lead (Matt)" && copy?.copiedFromId === katePlan && copyId !== katePlan, why(o));
    const copyBonus = fake.table("compensationBonus").find((b) => b.compensationId === copyId)!;
    check("the copy has its own bonus and scopes (new ids)", copyBonus.id !== bonusId && fake.table("compensationAssignment").filter((a) => a.compensationId === copyId).length === 2);
    await call(PLAN, "PATCH", "owner", { params: { id: "matt", planId: copyId }, body: planBody({ name: "Girls Class Lead (Matt)", baseAmount: 70, effectiveFrom: "2026-10-20", baseScopes: [{ scopeType: "CLASS", scopeId: "girls" }] }) });
    eq("changing the copy does not change the original", [fake.table("staffCompensation").find((p) => p.id === katePlan)!.baseAmount, fake.table("staffCompensation").find((p) => p.id === copyId)!.baseAmount], [55, 70]);
    o = await call(COPY, "POST", "fin", { params: { id: "kate", planId: katePlan }, body: { toUserIds: ["sal"], effectiveFrom: "2026-10-20" } });
    check("a manager may copy a plan to someone else", is(o, 201), why(o));
    await call(PLAN, "DELETE", "owner", { params: { id: "sal", planId: o.body.copies[0].id } });
    const plansBefore = fake.table("staffCompensation").length;
    o = await call(COPY, "POST", "owner", { params: { id: "kate", planId: katePlan }, body: { toUserIds: ["sal", "nobody"], effectiveFrom: "2026-10-20" } });
    check("a copy naming someone who is not staff is refused whole — nobody gets a plan", is(o, 404) && fake.table("staffCompensation").length === plansBefore, why(o));
    o = await call(COPY, "POST", "owner", { params: { id: "matt", planId: katePlan }, body: { toUserIds: ["josh"], effectiveFrom: "2026-10-20" } });
    check("a plan id under the wrong person → 404", is(o, 404), why(o));

    o = await call(PLANS_ALL, "GET", "viewer");
    const j = o.body?.staff?.find((s: { id: string }) => s.id === "josh");
    check("Pay plans lists every coach with all their plans, read-only for finances:view", is(o, 200) && j?.plans.length === 3 && o.body.viewer.canEdit === false && o.body.options.roles.includes("Lead Coach"), why(o));
    o = await call(PLANS, "GET", "josh", { params: { id: "josh" } });
    check("a coach may see their own plans (read-only)", is(o, 200) && o.body.viewer.canEdit === false && o.body.staff[0].plans.length === 3, why(o));
    o = await call(PLANS, "GET", "josh", { params: { id: "matt" } });
    check("…not someone else's → 403", is(o, 403), why(o));

    o = await call(COMP, "PUT", "owner", { params: { id: "josh" }, body: { baseType: "PER_CLASS", baseAmount: 1, baseScopes: [], bonuses: [] } });
    check("the old one-plan save refuses a coach with several plans (it used to delete them all)", is(o, 409, "MULTIPLE_PLANS") && fake.table("staffCompensation").filter((p) => p.userId === "josh").length === 3, why(o));
    o = await call(COMP, "PUT", "owner", { params: { id: "sal" }, body: { baseType: "SALARY", baseAmount: 1700, baseScopes: [], bonuses: [] } });
    check("…and edits a single plan in place (same id)", is(o, 200) && fake.table("staffCompensation").filter((p) => p.userId === "sal" && !p.archivedAt).map((p) => p.id).join() === "p_sal", why(o));
  }

  section("7. Bonuses and adjustments added by hand");
  {
    let o = await call(LINES, "POST", "owner", { body: { userId: "matt", kind: "BONUS", amount: 100, description: "Tournament weekend", workDate: "2026-10-12" } });
    check("dated before the ledger start → refused", is(o, 400, "BEFORE_LEDGER"), why(o));
    o = await call(LINES, "POST", "owner", { body: { userId: "matt", kind: "BONUS", amount: 100, description: "Tournament weekend", workDate: "2026-10-25" } });
    check("dated in the future → refused", is(o, 400), why(o));
    o = await call(LINES, "POST", "owner", { body: { userId: "matt", kind: "BONUS", amount: -5, description: "x", workDate: "2026-10-15" } });
    check("a negative bonus → refused (use an adjustment)", is(o, 400), why(o));
    o = await call(LINES, "POST", "owner", { body: { userId: "matt", kind: "BONUS", amount: 100, description: "Tournament weekend", workDate: "2026-10-17" } });
    const bonusId = o.body?.id as string;
    const b = fake.table("payLine").find((l) => l.id === bonusId)!;
    check("the owner adds a bonus", is(o, 201) && b.amountCents === 10000 && b.rateSource === "MANUAL" && b.sourceType === "BONUS" && b.createdByUserId === "owner", why(o));
    o = await call(LINES, "POST", "fin", { body: { userId: "matt", kind: "ADJUSTMENT", amount: -15, description: "Uniform", workDate: "2026-10-17" } });
    const adjId = o.body?.id as string;
    check("a manager adds an adjustment that takes pay off", is(o, 201) && fake.table("payLine").find((l) => l.id === adjId)!.amountCents === -1500, why(o));
    check("both are audited with who added them", audits("PAY_BONUS_ADDED")[0]?.actorUserId === "owner" && audits("PAY_ADJUSTMENT_ADDED")[0]?.actorUserId === "fin" && activity("matt").some((s) => /Tournament weekend/.test(s)));
    await L.syncPayLines(CLUB);
    eq("the sync never touches a hand-made line", [fake.table("payLine").find((l) => l.id === bonusId)!.status, fake.table("payLine").find((l) => l.id === adjId)!.status], ["ESTIMATED", "ESTIMATED"]);
    o = await call(LINE, "PATCH", "owner", { params: { lineId: adjId }, body: { action: "edit", amount: -20, description: "Uniform + bag", workDate: "2026-10-17" } });
    check("editing it is audited with before and after", is(o, 200) && fake.table("payLine").find((l) => l.id === adjId)!.amountCents === -2000 && audits("PAY_MANUAL_LINE_EDITED")[0]?.before?.cents === -1500, why(o));
    o = await call(LINE, "PATCH", "owner", { params: { lineId: adjId }, body: { action: "void", reason: "Entered twice" } });
    const v = fake.table("payLine").find((l) => l.id === adjId)!;
    check("removing it keeps the row, with why and who", is(o, 200) && v.status === "VOID" && v.voidReason === "Entered twice" && v.voidedByUserId === "owner", why(o));
    o = await call(LINE, "PATCH", "owner", { params: { lineId: lineFor("tad_2026-10-18", "matt")!.id }, body: { action: "void", reason: "x" } });
    check("a generated class line cannot be 'removed' — set its pay instead", is(o, 409, "BAD_STATE"), why(o));
    o = await call(LINE, "PATCH", "owner", { params: { lineId: bonusId }, body: { action: "override", amount: 5, reason: "x" } });
    check("a hand-made line is edited, not overridden", is(o, 409, "BAD_STATE"), why(o));
  }

  section("8. Payouts: exact lines, locked once paid, history never rewritten");
  {
    const mattIds = () => live("matt").filter((l) => !l.payoutId && l.status === "ESTIMATED").map((l) => l.id);
    const ids = mattIds();
    const total = live("matt").filter((l) => ids.includes(l.id)).reduce((a, l) => a + l.amountCents, 0);
    eq("Matt is owed: Tadpoles Oct 18 $25 + the $100 bonus (Oct 14 was covered by a substitute)", [ids.length, total], [2, 12500]);
    let o = await call(PAYOUTS, "POST", "owner", { body: { userId: "matt", lineIds: [...ids, lineFor("jr_2026-10-14", "josh")!.id], status: "PAID", method: "CASH" } });
    check("someone else's line in the list → refused, nothing written", is(o, 409, "STALE") && fake.table("payout").length === 0, why(o));
    o = await call(PAYOUTS, "POST", "owner", { body: { userId: "matt", lineIds: ids, status: "PAID" } });
    check("paid with no method → 400", is(o, 400), why(o));
    o = await call(PAYOUTS, "POST", "owner", { body: { userId: "matt", lineIds: ids, status: "PAID", method: "CASH", notes: "Oct" } });
    const po = fake.table("payout")[0];
    check("one payout for exactly those lines", is(o, 201) && fake.table("payout").length === 1 && Number(po.amount) === 125 && po.kind === "PAYROLL" && po.payeeUserId === "matt" && po.status === "PAID", why(o));
    check("the payout is locked and its lines are PAID and linked to it", po.lockedAt !== null && ids.every((id) => { const l = fake.table("payLine").find((x) => x.id === id)!; return l.status === "PAID" && l.payoutId === po.id; }));
    check("audited with the line ids", audits("PAYROLL_PAYOUT_CREATED")[0]?.after?.lineIds?.length === 2);
    o = await call(PAYOUTS, "POST", "owner", { body: { userId: "matt", lineIds: ids, status: "PAID", method: "CASH" } });
    check("the same lines cannot be paid twice", is(o, 409, "STALE") && fake.table("payout").length === 1, why(o));

    // History is never rewritten: change the plan, cancel the class — the paid line stays.
    const paidLine = lineFor("tad_2026-10-18", "matt")!;
    await call(PLAN, "PATCH", "owner", { params: { id: "matt", planId: "p_matt" }, body: planBody({ name: "Pay plan", baseAmount: 99, effectiveFrom: "2026-09-30", baseScopes: [{ scopeType: "CLASS", scopeId: "tad" }] }) });
    sessRow("tad_2026-10-18").canceled = true;
    await L.syncPayLines(CLUB);
    eq("the plan's rate changed and the class was later cancelled: the PAID line is exactly as it was paid", [paidLine.amountCents, paidLine.rateCents, paidLine.status, paidLine.planName], [2500, 2500, "PAID", "Pay plan"]);
    sessRow("tad_2026-10-18").canceled = false;
    o = await call(LINE, "PATCH", "owner", { params: { lineId: paidLine.id }, body: { action: "override", amount: 1, reason: "x" } });
    check("a paid line cannot be overridden → 409 LOCKED", is(o, 409, "LOCKED") && paidLine.amountCents === 2500, why(o));
    o = await call(OVERRIDE, "PUT", "owner", { params: { staffRowId: "tad_2026-10-18_matt" }, body: { amount: 1, reason: "x" } });
    check("…nor through the class day → 409 LOCKED", is(o, 409, "LOCKED") && rowOf("tad_2026-10-18", "matt").payOverrideCents === null, why(o));
    o = await call(LINE, "PATCH", "owner", { params: { lineId: ids.find((id) => id !== paidLine.id)! }, body: { action: "void", reason: "x" } });
    check("a paid bonus cannot be removed → 409 LOCKED", is(o, 409, "LOCKED"), why(o));
    o = await call(PAYOUT, "PATCH", "owner", { params: { id: po.id }, body: { amount: 5 } });
    check("the payout's amount cannot be edited → 409", is(o, 409, "LEDGER_LOCKED") && Number(po.amount) === 125, why(o));
    o = await call(PAYOUT, "PATCH", "owner", { params: { id: po.id }, body: { status: "PENDING" } });
    check("a paid payroll payout cannot go back to pending → 409", is(o, 409, "LEDGER_LOCKED"), why(o));
    o = await call(PAYOUT, "DELETE", "owner", { params: { id: po.id } });
    check("…or be deleted → 409", is(o, 409, "LEDGER_LOCKED") && fake.table("payout").length === 1, why(o));
    o = await call(PAYOUT_LIST, "GET", "viewer");
    check("the Payouts page is told how many lines it pays", is(o, 200) && o.body.payouts[0].lineCount === 2, why(o));

    o = await call(PAYOUT, "PATCH", "owner", { params: { id: po.id }, body: { status: "VOID" } });
    check("voiding it releases the lines back to unpaid, and says so in the audit log", is(o, 200) && ids.every((id) => { const l = fake.table("payLine").find((x) => x.id === id)!; return l.status === "ESTIMATED" && l.payoutId === null; }) && audits("PAYROLL_PAYOUT_VOIDED")[0]?.before?.lines?.length === 2, why(o));
    await L.syncPayLines(CLUB);
    eq("…and only now is the unpaid class line re-priced by the changed plan", lineFor("tad_2026-10-18", "matt")!.amountCents, 9900);

    o = await call(PAYOUTS, "POST", "fin", { body: { userId: "matt", lineIds: mattIds(), status: "PENDING" } });
    const pend = fake.table("payout").find((p) => p.id === o.body?.payoutId)!;
    check("a pending payout holds its lines without paying them", is(o, 201) && pend.status === "PENDING" && pend.lockedAt === null && mattIds().length === 0, why(o));
    await call(PLAN, "PATCH", "owner", { params: { id: "matt", planId: "p_matt" }, body: planBody({ name: "Pay plan", baseAmount: 25, effectiveFrom: "2026-09-30", baseScopes: [{ scopeType: "CLASS", scopeId: "tad" }] }) });
    eq("a line on a pending payout is not re-priced under it", lineFor("tad_2026-10-18", "matt")!.amountCents, 9900);
    o = await call(PAYOUT, "PATCH", "fin", { params: { id: pend.id }, body: { status: "PAID", method: "CHECK" } });
    check("marking the pending payout paid pays and locks its lines", is(o, 200) && lineFor("tad_2026-10-18", "matt")!.status === "PAID" && fake.table("payout").find((p) => p.id === pend.id)!.lockedAt !== null, why(o));

    o = await call(PAYOUTS, "POST", "owner", { body: { userId: "sal", lineIds: live("sal").filter((l) => l.sourceType === "CLASS_SESSION").map((l) => l.id), status: "PAID", method: "CASH" } });
    check("lines that add up to $0 → nothing to pay", is(o, 409, "NOTHING_TO_PAY"), why(o));
  }

  section("Paydays: 'Mark paid' on a ledger pay period");
  {
    setNow("2026-10-26T16:00:00.000Z"); // the Oct 26 payday; Jr Frogs Oct 21 has ended, Oct 26 has not
    const rem = await loadClubReminders(CLUB);
    const josh = rem.reminders.find((r) => r.userId === "josh" && r.payday === "2026-10-26")!;
    const sal = rem.reminders.find((r) => r.userId === "sal" && r.payday === "2026-10-26")!;
    const old = rem.reminders.find((r) => r.userId === "josh" && r.payday === "2026-10-12")!;
    eq("the Oct 12 payday (the period in progress at cut-over) keeps the OLD estimate and is not on the ledger", [old.fromLedger ?? false, old.periodStart, old.estimate], [false, "2026-09-29", 75]);
    // Josh: Oct 14 $25, Oct 19 $45 (lead), Oct 21 $25, Tadpoles Oct 14 override $25 = $120
    eq("the reminder shows the total of the period's saved lines (not an estimate)", [josh.fromLedger, josh.estimate, josh.periodStart, josh.periodEnd, sal.estimate], [true, 120, "2026-10-13", "2026-10-26", 1700]);
    let o = await call(MARK_PAID, "POST", "owner", { body: { userId: "josh", payday: "2026-10-26", amount: 100, method: "CASH" } });
    check("a different amount is refused — add a bonus or adjustment first", is(o, 409, "AMOUNT_MISMATCH") && o.body.expected === 120, why(o));
    o = await call(MARK_PAID, "POST", "josh", { body: { userId: "josh", payday: "2026-10-26", amount: 120, method: "CASH" } });
    check("never your own payday → 403", is(o, 403), why(o));
    o = await call(MARK_PAID, "POST", "owner", { body: { userId: "josh", payday: "2026-10-26", amount: 120, method: "CASH" } });
    const po = fake.table("payout").find((p) => p.id === o.body?.payoutId);
    check("the exact amount pays the period's lines and settles the payday", is(o, 200) && po && Number(po.amount) === 120 && ymd(po.payPeriodEnd) === "2026-10-26" && live("josh").filter((l) => ymd(l.periodEnd ?? d("2000-01-01")) === "2026-10-26").every((l) => l.status === "PAID"), why(o));
    const after = await loadClubReminders(CLUB);
    check("…the reminder is gone", !after.reminders.some((r) => r.userId === "josh" && r.payday === "2026-10-26"));
    o = await call(MARK_PAID, "POST", "owner", { body: { userId: "sal", payday: "2026-10-26", amount: 1700, method: "TRANSFER" } });
    check("Sal's salary period is paid: $1,700 for the two weeks", is(o, 200) && live("sal").filter((l) => l.sourceType === "SALARY")[0].status === "PAID", why(o));
    setNow("2026-10-27T16:00:00.000Z");
    await L.syncPayLines(CLUB);
    eq("the next pay period gets its own salary line; the paid one is untouched", lines("sal").filter((l) => l.sourceType === "SALARY").map((l) => [ymd(l.workDate), l.amountCents, l.status]).sort(), [["2026-10-26", 170000, "PAID"], ["2026-11-09", 170000, "ESTIMATED"]]);
    setNow("2026-10-20T16:00:00.000Z");
  }

  section("9. Reports: old calculation before the date + pay lines after");
  {
    // The old calculator, Oct 7–12 (legacy lists before Oct 7, coach rows from Oct 7): Josh 2 Jr Frogs classes (Oct 7, 12) × $25,
    // Matt Tadpoles Oct 7 + 11 × $25, fin Sunday Funday Oct 11 × $40, Sal's salary 1,700 "for the period".
    const beforeOnly = await computePayrollTotalForRange(CLUB, new RealDate("2026-10-07T00:00:00Z"), new RealDate("2026-10-12T23:59:59.999Z"));
    eq("a range wholly before the ledger: the old calculation, using only the plans that existed then", beforeOnly, 1700 + 50 + 50 + 40);
    const ledgerOnly = await computePayrollTotalForRange(CLUB, new RealDate("2026-10-13T00:00:00Z"), new RealDate("2026-10-20T23:59:59.999Z"));
    const sumLines = fake.table("payLine").filter((l) => ["ESTIMATED", "PAID"].includes(l.status) && ymd(l.workDate) >= "2026-10-13" && ymd(l.workDate) <= "2026-10-20").reduce((a, l) => a + (l.amountCents ?? 0), 0) / 100;
    eq("a range wholly on/after it: the pay lines dated in the range", ledgerOnly, sumLines);
    const both = await computePayrollTotalForRange(CLUB, new RealDate("2026-10-07T00:00:00Z"), new RealDate("2026-10-20T23:59:59.999Z"));
    eq("a range across the date is exactly the two added together — nothing twice", both, +(beforeOnly + ledgerOnly).toFixed(2));
    const o = await call(LEGACY, "GET", "viewer", { query: "?from=2026-10-07&to=2026-10-31" });
    check("the old Payroll calculation stops the day before the ledger starts, whatever dates are asked", is(o, 200) && o.body.to.slice(0, 10) === "2026-10-12" && o.body.totals.total === beforeOnly, why(o));
    const joshOld = o.body.staff.find((s: { id: string }) => s.id === "josh");
    eq("…and Josh's new 'Lead' plan (dated Oct 13) does not change what the old period worked out to", joshOld.payout.total, 50);
    // Even a second plan back-dated before the ledger does not: the old world had one plan per coach.
    fake.seed("staffCompensation", [comp("p_josh_early", "josh", "PER_CLASS", 500, "2026-10-08", { createdAt: d("2026-10-08") })]);
    const again = await call(LEGACY, "GET", "viewer", { query: "?from=2026-10-07&to=2026-10-12" });
    eq("…nor does a second plan added while setting up (dated before the ledger): the old calculation uses the coach's original plan only", again.body.staff.find((s: { id: string }) => s.id === "josh").payout.total, 50);
    fake.table("staffCompensation").splice(fake.table("staffCompensation").findIndex((p) => p.id === "p_josh_early"), 1);
  }

  section("10. Removing a staff member");
  {
    setNow("2026-10-20T16:00:00.000Z");
    const pastRow = rowOf("tad_2026-10-18", "matt");
    const pastLine = { ...lineFor("tad_2026-10-18", "matt")! };
    let o = await call(STAFF, "DELETE", "viewer", { params: { id: "matt" } });
    check("needs staff:full → 403", is(o, 403), why(o));
    o = await call(STAFF, "DELETE", "fin", { params: { id: "matt" } });
    const future = fake.table("classSessionStaff").filter((r) => r.userId === "matt" && r.sessionId.startsWith("tad_") && r.sessionId.slice(4) > "2026-10-20");
    check("removed", is(o, 200) && fake.table("user").find((u) => u.id === "matt")!.deletedAt !== null && o.body.schedule.daysOpened === future.length && future.length > 5, why(o));
    check("every future class day they were on now needs coverage, marked 'No longer on staff'", future.every((r) => r.status === "NEEDS_COVERAGE" && r.calloutReason === "No longer on staff" && r.calledOutByUserId === "fin"));
    check("their recurring assignment ended today (no new class days will be generated for them)", fake.table("classStaffRule").filter((r) => r.userId === "matt").every((r) => r.effectiveTo !== null && ymd(r.effectiveTo) < "2026-10-20"));
    eq("class days that already happened are untouched", [pastRow.status, pastRow.calloutReason, rowOf("tad_2026-10-11", "matt").status], ["SCHEDULED", null, "SCHEDULED"]);
    await L.syncPayLines(CLUB);
    eq("…and so is what they were paid for them", [lineFor("tad_2026-10-18", "matt")!.status, lineFor("tad_2026-10-18", "matt")!.amountCents, lineFor("tad_2026-10-18", "matt")!.payoutId], [pastLine.status, pastLine.amountCents, pastLine.payoutId]);
    const items = await AC.loadCoverageActionItems(CLUB);
    check("Action Items shows ONE item for the class, not one per class day", items.length === 1 && /Needs a coach: Tadpoles/.test(items[0].label) && /no longer on staff/.test(items[0].label) && items[0].count === future.length, JSON.stringify(items.map((i) => i.label)));
    o = await call(LEDGER, "GET", "owner");
    check("their pay lines are still on the ledger, marked as no longer on staff", o.body.coaches.find((c: { userId: string }) => c.userId === "matt")?.removed === true, why(o));

    // A new recurring coach settles the openings.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const S = require("../lib/classStaffServer.ts") as typeof import("../lib/classStaffServer");
    await S.addUserRule(fake.client, { clubId: CLUB, classId: "tad", userId: "josh", date: "2026-10-21", byUserId: "owner" });
    const still = fake.table("classSessionStaff").filter((r) => r.userId === "matt" && r.status === "NEEDS_COVERAGE");
    check("putting a new recurring coach on the class closes those openings", still.length === 0 && rowOf("tad_2026-10-25", "josh").status === "SCHEDULED", `${still.length} still open`);
    eq("…and Action Items is clear", (await AC.loadCoverageActionItems(CLUB)).length, 0);
  }

  section("Starting the ledger (other clubs)");
  {
    let o = await call(LEDGER_START, "POST", "fin", { body: { date: "2026-11-01" } });
    check("owner only → 403", is(o, 403), why(o));
    o = await call(LEDGER_START, "POST", "owner", { body: { date: "2026-11-01" } });
    check("once set, the start date cannot be moved → 409", is(o, 409, "ALREADY_SET") && ymd(fake.table("clubScheduleSettings")[0].payLedgerStartsOn) === "2026-10-13", why(o));
    const s = fake.table("clubScheduleSettings")[0];
    const keepLines = fake.table("payLine").splice(0);
    s.payLedgerStartsOn = null;
    o = await call(LEDGER_START, "POST", "owner", { body: { date: "2026-10-19" } });
    check("it cannot start in the past (nothing that already happened becomes pay lines)", is(o, 400), why(o));
    o = await call(LEDGER, "GET", "owner");
    check("with no ledger the ledger endpoint returns nothing and writes nothing", is(o, 200) && o.body.ledgerStart === null && fake.table("payLine").length === 0, why(o));
    o = await call(LEDGER_START, "POST", "owner", { body: { date: "2026-10-26" } });
    check("the owner starts it on a future date", is(o, 200) && ymd(s.payLedgerStartsOn) === "2026-10-26" && audits("PAY_LEDGER_STARTED").length === 1, why(o));
    await L.syncPayLines(CLUB);
    eq("…and nothing is written until that date arrives", fake.table("payLine").length, 0);
    s.payLedgerStartsOn = d("2026-10-13");
    fake.table("payLine").push(...keepLines);
  }

  console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
