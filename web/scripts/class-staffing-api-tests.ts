/**
 * Class coach assignments — the API (stage 2), exercised not inspected.
 *
 *   npx tsx scripts/class-staffing-api-tests.ts
 *
 * The REAL exported route handlers are called with a fabricated session
 * against the in-memory fake in scripts/fake-prisma.ts (the same method as
 * scripts/staff-authz-tests.ts): `next-auth`, `@/lib/auth`, `@/lib/email` and
 * `@/lib/sendClubEmail` are swapped at the module loader and record what would
 * have gone out. No database, no network, no email. The clock is pinned
 * (handlers call `new Date()`): Tuesday Oct 13 2026, 12:00 noon in New York.
 *
 * What it pins — the owner's rules:
 *   0. a club that is NOT switched on: new write endpoints refuse, legacy
 *      routes write exactly what they always wrote, cancel still works
 *   1. only schedule:edit assigns / fills / closes / marks a no-show; a coach
 *      can never assign themself
 *   2. the plan in words writes nothing; conflicts are warnings (409 until
 *      acknowledged)
 *   3. a coach calls out of THEIR OWN day, the class stays on, the right
 *      people are told; inside 2 hours it is a LATE call-out and says so
 *   4. undo while unfilled only; fill = REPLACED + SUBSTITUTE, everyone told
 *   5. cancel: classes:edit; "paid" needs finances:full and is never your own
 *      class day; audience counts; the notified count is stored
 *   6. settings are owner-only; the switch-on date is not settable
 *   7. legacy routes on a switched-on club go to the rules/rows and never
 *      write the frozen assignedStaffIds
 *   8. readers: own-only views, a coach who called out still sees the class
 *   9. Action Items: late call-outs first, then the soonest class
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { buildSessions } from "../lib/classSessions";

// ── A pinned clock ──────────────────────────────────────────────────────────
const RealDate = Date;
let NOW = RealDate.parse("2026-10-13T16:00:00.000Z"); // Tue Oct 13 2026, noon New York
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
      attendance: { model: "attendanceRecord", kind: "many", fk: "classSessionId" },
    },
    classSessionStaff: { session: { model: "classSession", kind: "one", fk: "sessionId" } },
    recurringClass: {
      club: { model: "club", kind: "one", fk: "clubId" },
      sessions: { model: "classSession", kind: "many", fk: "classId" },
      location: { model: "location", kind: "one", fk: "locationId" },
    },
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

type Sess = { user: { id: string; role: string; clubId: string; name: string; email: string; permissions: Record<string, unknown> | null } } | null;
let CURRENT: Sess = null;
let EMAILS: { to: string; subject: string; html: string }[] = [];
let MEMBER_EMAILS: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => CURRENT, default: {} },
  "@/lib/auth": { authOptions: {} },
  "@/lib/email": {
    sendEmail: async (m: { to: string; subject: string; html: string }) => { EMAILS.push({ to: m.to, subject: m.subject, html: m.html }); },
    isEmailConfigured: () => true,
  },
  "@/lib/sendClubEmail": {
    sendClubEmail: async (m: Record<string, unknown>) => { MEMBER_EMAILS.push(m); return { emailSendId: `es_${MEMBER_EMAILS.length}`, status: "SENT" }; },
  },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const S = require("../lib/classStaffServer.ts") as typeof import("../lib/classStaffServer");
const guardLib = require("../lib/apiGuard.ts") as typeof import("../lib/apiGuard");
const AC = require("../lib/actionCenter.ts") as typeof import("../lib/actionCenter");
const pure = require("../lib/classStaff.ts") as typeof import("../lib/classStaff");
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
const SWITCH = "2026-10-12"; // a Monday
const COACH = {
  members: "view", attendance: "full", classes: "edit", events: "view",
  schedule: "view", messages: "send", documents: "view",
  finances: "none", billing: "none", reports: "none", staff: "none",
};
const user = (id: string, role: string, perms: Record<string, unknown> | null) => ({
  id, clubId: CLUB, role, deletedAt: null, firstName: id, lastName: "Test", email: `${id}@example.test`,
  staffProfile: perms ? { title: "Coach", permissions: perms } : null,
});
fake.seed("club", [{ id: CLUB, name: "Test Club", timezone: NY, contactEmail: "office@example.test" }]);
fake.seed("user", [
  user("owner", "OWNER", null),
  // The schedule manager: assigns, cancels — but no money.
  user("mgr", "STAFF", { ...COACH, schedule: "edit", classes: "full", finances: "view" }),
  user("julian", "STAFF", COACH),
  // Sal cannot even see the club schedule: own-only views.
  user("sal", "STAFF", { ...COACH, schedule: "none" }),
  user("adrian", "STAFF", COACH),
  user("mia", "STAFF", COACH),
  // Money, and coaches the Morning Group.
  user("fin", "STAFF", { ...COACH, finances: "full" }),
  // Sees classes, cannot edit them.
  user("viewer", "STAFF", { ...COACH, classes: "view" }),
  { ...user("gone", "STAFF", COACH), deletedAt: d("2026-09-01") },
  user("member1", "MEMBER", null),
]);
const series = (id: string, name: string, daysOfWeek: number[], startTime: string, endTime: string, assignedStaffIds: string[]) => ({
  id, clubId: CLUB, name, daysOfWeek, startTime, endTime, dayOverrides: [], assignedStaffIds, locationId: null,
  recurrenceStartDate: d("2026-09-01"), recurrenceEndDate: null, active: true, deletedAt: null, capacity: null,
  pricingOptions: [{ type: "membership", membershipId: "plan_a" }, { type: "dropin", price: 20 }],
});
const CLASSES: [string, string, number[], string, string, string[]][] = [
  ["c1", "Evening Group", [1, 2, 4], "18:00", "19:00", ["julian", "sal"]],
  ["c2", "Morning Group", [3], "09:00", "10:00", ["mia", "fin"]],
  ["c3", "Clash Group", [3], "09:30", "10:30", ["julian", "owner"]],
];
fake.seed("recurringClass", CLASSES.map((c) => series(...c)));
for (const [id, days, st, en] of CLASSES.map((c) => [c[0], c[2], c[3], c[4]] as [string, number[], string, string])) {
  fake.seed("classSession", buildSessions(id, CLUB, days, st, en, [], d("2026-10-05"), d("2026-11-30")).map((s) => ({
    id: `${id}_${ymd(s.date)}`, ...s, staffOverride: null, note: null, overridden: false, staffManual: false,
    canceledAt: null, canceledByUserId: null, cancelReason: null, cancelNotifyAudience: null, cancelNotifiedCount: null,
    cancelPaid: false, cancelPaidByUserId: null, cancelPaidAt: null,
  })));
}
// Members, for the cancellation audience (same shape as class-staff-server-tests).
const member = (id: string, o: Record<string, unknown> = {}) => ({
  id, clubId: CLUB, deletedAt: null, firstName: id, lastName: "M", email: `${id}@example.test`, isMinor: false, userId: null,
  guardianName: null, guardianEmail: null, responsiblePayerUserId: null, guardian: null, user: null, guardianLinks: [], ...o,
});
const parent = { id: "u_parent", email: "Parent@Example.test", firstName: "Pat", lastName: "Parent", deletedAt: null };
const link = [{ userId: "u_parent", createdAt: d("2026-01-01"), isPrimary: true, canPay: true, user: parent }];
fake.seed("member", [
  member("kid1", { isMinor: true, email: null, guardianLinks: link }),
  member("kid2", { isMinor: true, email: null, guardianLinks: link }),
  member("adult1"), member("walkin"), member("noemail", { email: null }),
]);
fake.seed("membership", [{ id: "plan_a", name: "Unlimited", options: [] }]);
const sub = (memberId: string) => ({ id: `sub_${memberId}`, memberId, membershipId: "plan_a", status: "active", optionId: null, optionLabel: null, billingPeriod: "MONTHLY", price: 100, endDate: null });
fake.seed("memberSubscription", [sub("kid1"), sub("kid2"), sub("adult1"), sub("noemail")]);
const THU29 = "c1_2026-10-29";
const att = (memberId: string, status: string, classSessionId: string) => ({ id: `att_${memberId}_${classSessionId}`, clubId: CLUB, classSessionId, memberId, status, checkedInAt: null, eventId: null });
fake.seed("attendanceRecord", [att("kid1", "PRESENT", THU29), att("walkin", "DROP_IN", THU29)]);

const sessRow = (id: string) => fake.table("classSession").find((r) => r.id === id)!;
const cls = (id: string) => fake.table("recurringClass").find((r) => r.id === id)!;
const rowsOf = (sessionId: string) => fake.table("classSessionStaff").filter((r) => r.sessionId === sessionId);
const rowOf = (sessionId: string, userId: string) => rowsOf(sessionId).find((r) => r.userId === userId);
const on = (sessionId: string) => rowsOf(sessionId).filter((r) => r.status === "SCHEDULED").map((r) => r.userId).sort();
const msgsTo = (userId: string) => fake.table("message").filter((m) => m.recipientId === userId).map((m) => m.body as string);
const rulesOf = (classId: string, userId: string) => fake.table("classStaffRule").filter((r) => r.classId === classId && r.userId === userId);

function sess(id: string): Sess {
  const u = fake.table("user").find((x) => x.id === id)!;
  return { user: { id, clubId: u.clubId, name: `${u.firstName} ${u.lastName}`, email: u.email, role: u.role, permissions: u.staffProfile?.permissions ?? null } };
}
type Out = { status: number | null; body: any; threw?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  route: string,
  verb: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  as: string | null,
  opts: { params?: Record<string, string>; body?: unknown; query?: string } = {},
): Promise<Out> {
  CURRENT = as ? sess(as) : null;
  EMAILS = [];
  MEMBER_EMAILS = [];
  fake.table("message").length = 0;
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
const why = (o: Out) => `got ${o.status ?? "a throw"} ${o.threw ? String((o.threw as Error)?.stack ?? o.threw).slice(0, 400) : JSON.stringify(o.body)?.slice(0, 260)}`;
const wrote = (model: string) => fake.writes().filter((c) => c.model === model);

const R = (p: string) => require.resolve(`../app/api/${p}/route.ts`);
const STAFFING = R("classes/[id]/staffing");
const PREVIEW = R("classes/[id]/staffing/preview");
const CALL_OUT = R("classes/sessions/[sessionId]/call-out");
const CALL_OUT_RANGE = R("staff/me/call-out-range");
const UNDO = R("classes/session-staff/[staffRowId]/undo-call-out");
const FILL = R("classes/session-staff/[staffRowId]/fill");
const CLOSE = R("classes/session-staff/[staffRowId]/close");
const NO_SHOW = R("classes/session-staff/[staffRowId]/no-show");
const CLEAR_NO_SHOW = R("classes/session-staff/[staffRowId]/clear-no-show");
const CANCEL = R("classes/sessions/[sessionId]/cancel");
const UNCANCEL = R("classes/sessions/[sessionId]/uncancel");
const CANCEL_PAY = R("classes/sessions/[sessionId]/cancel-pay");
const CANCEL_PREVIEW = R("classes/sessions/[sessionId]/cancel-preview");
const SETTINGS = R("settings/schedule");
const SWITCH_ON = R("settings/schedule/switch-on");
const CONFLICTS = R("staff/conflicts");
const CLASSES_LIST = R("classes");
const CLASS = R("classes/[id]");
const CLASS_STAFF = R("classes/[id]/staff");
const CLASS_OCC = R("classes/[id]/occurrence");
const CLASS_SESSION = R("classes/[id]/sessions/[sessionId]");
const STAFF_SCHEDULE = R("staff/schedule");
const CALENDAR = R("calendar");

const TUE = "c1_2026-10-13"; // today, 6 PM New York = 22:00Z
const THU22 = "c1_2026-10-22";

async function main() {
  console.log("\nCLASS STAFFING API — real handlers, fabricated sessions, pinned clock\n");
  let o: Out;

  // ── 0. Not switched on ───────────────────────────────────────────────────
  section("0. A club that is NOT switched on");
  {
    const body = { scope: "OCCURRENCE", date: "2026-10-20", staff: [{ userId: "julian" }, { userId: "adrian" }] };
    o = await call(STAFFING, "POST", "mgr", { params: { id: "c1" }, body });
    check("POST staffing → 409 NOT_SWITCHED_ON", is(o, 409, "NOT_SWITCHED_ON"), why(o));
    check("…and nothing was written", fake.writes().length === 0, JSON.stringify(fake.writes().map((w) => `${w.model}.${w.method}`)));
    o = await call(PREVIEW, "POST", "mgr", { params: { id: "c1" }, body });
    check("POST staffing/preview → 409 NOT_SWITCHED_ON", is(o, 409, "NOT_SWITCHED_ON"), why(o));
    o = await call(CALL_OUT, "POST", "sal", { params: { sessionId: TUE }, body: {} });
    check("POST call-out → 409 NOT_SWITCHED_ON", is(o, 409, "NOT_SWITCHED_ON") && fake.writes().length === 0, why(o));
    o = await call(CALL_OUT_RANGE, "POST", "sal", { body: { fromDate: "2026-10-13", toDate: "2026-10-20" } });
    check("POST call-out-range → 409 NOT_SWITCHED_ON", is(o, 409, "NOT_SWITCHED_ON") && fake.writes().length === 0, why(o));
    for (const [name, route] of [["fill", FILL], ["close", CLOSE], ["no-show", NO_SHOW], ["clear-no-show", CLEAR_NO_SHOW], ["undo-call-out", UNDO]] as const) {
      o = await call(route, "POST", "mgr", { params: { staffRowId: "nope" }, body: { substituteUserId: "adrian" } });
      check(`POST ${name} → 404 (there are no coach rows to act on)`, is(o, 404, "NOT_FOUND") && fake.writes().length === 0, why(o));
    }
    o = await call(STAFFING, "GET", "mgr", { params: { id: "c1" }, query: "?date=2026-10-20" });
    check("GET staffing answers from the legacy list, switchedOn false", is(o, 200) && o.body.switchedOn === false && o.body.day.switched === false &&
      JSON.stringify(o.body.day.rows.map((r: { userId: string; source: string; id: null }) => [r.userId, r.source, r.id])) === JSON.stringify([["julian", "LEGACY", null], ["sal", "LEGACY", null]]), why(o));
    eq("…with no new actions offered", [o.body.viewer.canCallOut, o.body.rules], [false, []]);

    // Legacy routes: exactly what they always wrote.
    o = await call(CLASS_STAFF, "POST", "mgr", { params: { id: "c1" }, body: { userId: "mia" } });
    check("legacy POST /staff writes assignedStaffIds", is(o, 200) && JSON.stringify(cls("c1").assignedStaffIds) === JSON.stringify(["julian", "sal", "mia"]), why(o));
    eq("…through one recurringClass.update and nothing else", fake.writes().map((w) => `${w.model}.${w.method}`), ["recurringClass.update"]);
    o = await call(CLASS_STAFF, "DELETE", "mgr", { params: { id: "c1" }, query: "?userId=mia" });
    check("legacy DELETE /staff writes assignedStaffIds", is(o, 200) && JSON.stringify(cls("c1").assignedStaffIds) === JSON.stringify(["julian", "sal"]), why(o));
    o = await call(CLASS_SESSION, "PATCH", "mgr", { params: { id: "c1", sessionId: "c1_2026-10-20" }, body: { staffOverride: ["adrian"] } });
    check("legacy PATCH session writes staffOverride", is(o, 200) && JSON.stringify(sessRow("c1_2026-10-20").staffOverride) === JSON.stringify(["adrian"]), why(o));
    eq("…through one classSession.update", fake.writes().map((w) => `${w.model}.${w.method}`), ["classSession.update"]);
    o = await call(CLASS_SESSION, "PATCH", "mgr", { params: { id: "c1", sessionId: "c1_2026-10-20" }, body: { staffOverride: null } });
    check("…and clears it again", is(o, 200) && sessRow("c1_2026-10-20").staffOverride === null, why(o));
    o = await call(CLASS, "PATCH", "mgr", { params: { id: "c1" }, body: { assignedStaffIds: ["julian", "sal", "mia"] } });
    check("legacy PATCH class writes assignedStaffIds", is(o, 200) && JSON.stringify(cls("c1").assignedStaffIds) === JSON.stringify(["julian", "sal", "mia"]), why(o));
    o = await call(CLASS, "PATCH", "mgr", { params: { id: "c1" }, body: { assignedStaffIds: ["julian", "sal"] } });
    check("no coach rule or row exists yet", fake.table("classStaffRule").length === 0 && fake.table("classSessionStaff").length === 0);
    o = await call(CLASSES_LIST, "GET", "mgr");
    const c1 = (o.body as { id: string; switchedOn: boolean; currentStaff: { userId: string; name: string }[]; assignedStaffIds: string[]; staffRules: unknown[] }[]).find((c) => c.id === "c1")!;
    eq("GET classes: currentStaff is the legacy list, staffRules empty", [c1.switchedOn, c1.currentStaff.map((x) => x.name), c1.assignedStaffIds, c1.staffRules], [false, ["julian Test", "sal Test"], ["julian", "sal"], []]);

    // Cancel is not an assignment: it works without the switch.
    o = await call(CANCEL, "POST", "mgr", { params: { sessionId: "c1_2026-10-26" }, body: { reason: "floor being cleaned", notifyAudience: "NONE" } });
    check("cancel works for a club that is not switched on", is(o, 200) && sessRow("c1_2026-10-26").canceled === true && sessRow("c1_2026-10-26").canceledByUserId === "mgr", why(o));
    eq("…and that day's coaches (legacy list) are told in-app", [msgsTo("julian").length, msgsTo("sal").length], [1, 1]);
    o = await call(UNCANCEL, "POST", "mgr", { params: { sessionId: "c1_2026-10-26" } });
    check("…and un-cancel", is(o, 200) && sessRow("c1_2026-10-26").canceled === false, why(o));
    eq("no Action Items for coverage", await AC.loadCoverageActionItems(CLUB), []);
  }

  // ── Switch on ────────────────────────────────────────────────────────────
  // Through the owner's own button (Settings → Scheduling): POST /api/settings/schedule/switch-on.
  section("0b. Turning it on from Settings: owner only; the preview writes nothing");
  {
    for (const who of ["mgr", "fin", "julian", "member1"]) {
      o = await call(SWITCH_ON, "POST", who, { body: { apply: true, date: SWITCH } });
      check(`switch-on as ${who} → 403, nothing written`, is(o, 403) && fake.writes().length === 0 && fake.table("clubScheduleSettings").length === 0, why(o));
    }
    o = await call(SWITCH_ON, "POST", null, { body: { apply: true } });
    check("switch-on signed out → 401", is(o, 401) && fake.writes().length === 0, why(o));
    o = await call(SWITCH_ON, "POST", "owner", { body: { date: "next week" } });
    check("a date that is not YYYY-MM-DD → 400", is(o, 400, "BAD_INPUT") && fake.writes().length === 0, why(o));
    o = await call(SWITCH_ON, "POST", "owner", { body: {} });
    check("preview (apply omitted) → 200, applied false, date = today in the club's timezone", is(o, 200) && o.body.applied === false && o.body.date === "2026-10-13" && o.body.switchedOn === false && o.body.assignmentsStartOn === null, why(o));
    check("…and the preview WROTE NOTHING", fake.writes().length === 0 && fake.table("classStaffRule").length === 0 && fake.table("classSessionStaff").length === 0 && fake.table("clubScheduleSettings").length === 0, JSON.stringify(fake.writes().map((w) => `${w.model}.${w.method}`)));
    const line = (o.body.classes as { classId: string; name: string; state: string; coaches: string[]; upcomingDays: number }[]).find((c) => c.classId === "c1");
    eq("…it lists each class with its coaches by NAME and its upcoming class days", [line?.name, line?.state, line?.coaches, (line?.upcomingDays ?? 0) > 0, o.body.totals.classes], ["Evening Group", "new", ["julian Test", "sal Test"], true, 3]);
    o = await call(SWITCH_ON, "POST", "owner", { body: { apply: false, date: SWITCH } });
    check("preview with a chosen date still writes nothing", is(o, 200) && o.body.date === SWITCH && fake.writes().length === 0, why(o));
    o = await call(SWITCH_ON, "POST", "owner", { body: { apply: true, date: SWITCH } });
    check("apply as the owner → 200, on from that date, rules and rows written", is(o, 200) && o.body.applied === true && o.body.switchedOn === true && o.body.assignmentsStartOn === SWITCH && fake.table("classStaffRule").length > 0 && fake.table("classSessionStaff").length > 0, why(o));
    check("…class days before the date got no coach rows", rowsOf("c1_2026-10-05").length === 0 && rowsOf("c1_2026-10-12").length === 2);
    const rulesBefore = fake.table("classStaffRule").length, rowsBefore = fake.table("classSessionStaff").length;
    o = await call(SWITCH_ON, "POST", "owner", { body: { apply: true, date: "2026-11-02" } });
    check("asking for a DIFFERENT date once on → 409 ALREADY_ON, nothing changes", is(o, 409, "ALREADY_ON") && fake.writes().length === 0 && ymd(fake.table("clubScheduleSettings")[0].assignmentsStartOn) === SWITCH, why(o));
    o = await call(SWITCH_ON, "POST", "owner", { body: { apply: true } });
    check("pressing it again (no date) keeps the date and adds nothing", is(o, 200) && o.body.assignmentsStartOn === SWITCH && fake.table("classStaffRule").length === rulesBefore && fake.table("classSessionStaff").length === rowsBefore, why(o));
  }
  const frozen = JSON.stringify(fake.table("recurringClass").map((c) => [c.id, c.assignedStaffIds]));

  // ── 1. Who may assign ────────────────────────────────────────────────────
  section("1. Only schedule:edit assigns — and never yourself");
  {
    const tuesdays = { scope: "WEEKDAY_FORWARD", date: "2026-10-20", staff: [{ userId: "julian" }, { userId: "adrian" }] };
    o = await call(STAFFING, "POST", "julian", { params: { id: "c1" }, body: tuesdays });
    check("a coach without schedule:edit → 403 on POST staffing", is(o, 403) && fake.writes().length === 0, why(o));
    o = await call(STAFFING, "POST", "adrian", { params: { id: "c1" }, body: { scope: "OCCURRENCE", date: "2026-10-20", staff: [{ userId: "julian" }, { userId: "sal" }, { userId: "adrian" }] } });
    check("a coach adding THEMSELF to one class day → 403, nothing written", is(o, 403) && fake.writes().length === 0 && !on("c1_2026-10-20").includes("adrian"), why(o));
    o = await call(STAFFING, "POST", "adrian", { params: { id: "c1" }, body: { scope: "ALL_FUTURE", date: "2026-10-20", staff: [{ userId: "julian" }, { userId: "sal" }, { userId: "adrian" }] } });
    check("a coach adding themself to the recurring schedule → 403", is(o, 403) && rulesOf("c1", "adrian").length === 0, why(o));
    o = await call(PREVIEW, "POST", "julian", { params: { id: "c1" }, body: tuesdays });
    check("…and on the preview", is(o, 403), why(o));
    o = await call(STAFFING, "POST", "member1", { params: { id: "c1" }, body: tuesdays });
    check("a MEMBER → 403", is(o, 403), why(o));
    o = await call(STAFFING, "POST", null, { params: { id: "c1" }, body: tuesdays });
    check("signed out → 401", is(o, 401), why(o));
    o = await call(CONFLICTS, "POST", "julian", { body: { userId: "mia", classId: "c1", fromDate: "2026-10-20" } });
    check("a coach cannot look up someone else's conflicts → 403", is(o, 403), why(o));
    o = await call(STAFFING, "POST", "mgr", { params: { id: "c1" }, body: { ...tuesdays, date: "2026-10-06" } });
    check("a date before the switch-on date → 409 NOT_SWITCHED_ON", is(o, 409, "NOT_SWITCHED_ON") && fake.writes().length === 0, why(o));
    o = await call(STAFFING, "POST", "mgr", { params: { id: "c1" }, body: { ...tuesdays, staff: [{ userId: "julian" }, { userId: "member1" }], acknowledgeConflicts: true } });
    check("a member as a coach → 400 INVALID_STAFF", is(o, 400, "INVALID_STAFF") && rulesOf("c1", "member1").length === 0, why(o));

    // ── 2. Preview, then the real thing ────────────────────────────────────
    section("2. The plan in words, conflicts as warnings");
    o = await call(PREVIEW, "POST", "mgr", { params: { id: "c1" }, body: tuesdays });
    check("preview → 200", is(o, 200), why(o));
    eq("…in words", o.body?.plan?.text, "Tuesdays from Oct 20: adrian Test replaces sal Test. sal Test stays on Mondays and Thursdays. Class days already edited by hand keep their own coaches.");
    eq("…who comes on / goes off", [o.body?.added?.map((x: { userId: string }) => x.userId), o.body?.removed?.map((x: { userId: string }) => x.userId), o.body?.needsAcknowledge], [["adrian"], ["sal"], false]);
    check("…and it wrote NOTHING", fake.writes().length === 0, JSON.stringify(fake.writes().map((w) => `${w.model}.${w.method}`)));
    // The preview refuses what the save refuses: someone who is not current staff of this club.
    for (const who of ["member1", "gone", "someone-from-another-club"]) {
      o = await call(PREVIEW, "POST", "mgr", { params: { id: "c1" }, body: { scope: "OCCURRENCE", date: "2026-10-20", staff: [{ userId: "julian" }, { userId: "sal" }, { userId: who }] } });
      check(`preview adding ${who} → 400 INVALID_STAFF (same as the save)`, is(o, 400, "INVALID_STAFF") && fake.writes().length === 0, why(o));
    }

    o = await call(STAFFING, "POST", "mgr", { params: { id: "c1" }, body: tuesdays });
    check("POST staffing (this weekday going forward) → 200", is(o, 200) && o.body.changed === true, why(o));
    eq("Tue Oct 20 + 27 are Julian and Adrian; Mon/Thu keep Sal", [on("c1_2026-10-20"), on("c1_2026-10-27"), on("c1_2026-10-26"), on(THU22)], [["adrian", "julian"], ["adrian", "julian"], ["julian", "sal"], ["julian", "sal"]]);
    eq("today's class (before the change date) is untouched", on(TUE), ["julian", "sal"]);
    eq("the coach put on and the coach taken off are told in-app", [msgsTo("adrian"), msgsTo("sal")], [["mgr Test put you on Evening Group on Tuesdays from Oct 20."], ["mgr Test took you off Evening Group on Tuesdays from Oct 20."]]);
    check("…and nobody else", fake.table("message").length === 2);
    eq("…with a Recent-activity line each", fake.table("staffActivity").filter((a) => a.kind === "ASSIGNMENT").map((a) => [a.staffUserId, a.summary, a.actorUserId]),
      [["adrian", "Put on Evening Group on Tuesdays from Oct 20", "mgr"], ["sal", "Taken off Evening Group on Tuesdays from Oct 20", "mgr"]]);
    check("the answer carries the refreshed sheet", o.body.staffing?.day?.date === "2026-10-20" && o.body.staffing.day.rows.length === 2, JSON.stringify(o.body.staffing?.day));
    eq("RecurringClass.assignedStaffIds is FROZEN", JSON.stringify(fake.table("recurringClass").map((c) => [c.id, c.assignedStaffIds])), frozen);

    // Conflict: Mia coaches Morning Group Wed 9–10; Clash Group is Wed 9:30–10:30.
    const clash = { scope: "OCCURRENCE", date: "2026-10-21", staff: [{ userId: "julian" }, { userId: "owner" }, { userId: "mia", roleName: "Assistant Coach" }] };
    o = await call(STAFFING, "POST", "mgr", { params: { id: "c3" }, body: clash });
    check("double-booking a coach → 409 STAFF_CONFLICT", is(o, 409, "STAFF_CONFLICT"), why(o));
    eq("…naming the clash", [o.body?.summary, o.body?.conflicts?.[0]?.userId, o.body?.hasOverlap], [["mia Test: Overlaps Morning Group on Wed, Oct 21, 9:00–10:00 AM"], "mia", true]);
    check("…and nothing was written", fake.writes().length === 0 && !on("c3_2026-10-21").includes("mia"));
    o = await call(PREVIEW, "POST", "mgr", { params: { id: "c3" }, body: clash });
    check("the preview shows the same warning", is(o, 200) && o.body.needsAcknowledge === true && o.body.summary.length === 1 && o.body.plan.text === "Wed Oct 21 only: mia Test is added. The recurring schedule is not changed.", why(o));
    o = await call(STAFFING, "POST", "mgr", { params: { id: "c3" }, body: { ...clash, acknowledgeConflicts: true } });
    check("…acknowledged → 200, with the role", is(o, 200) && JSON.stringify(on("c3_2026-10-21")) === JSON.stringify(["julian", "mia", "owner"]) && rowOf("c3_2026-10-21", "mia")?.roleName === "Assistant Coach", why(o));
    o = await call(CONFLICTS, "POST", "mgr", { body: { userId: "mia", classId: "c3", fromDate: "2026-10-14" } });
    check("conflicts on demand: the next 8 weeks, folded", is(o, 200) && o.body.summary[0] === "Overlaps Morning Group on Wednesdays 9:00–10:00 AM (7 times)", why(o));
    o = await call(CONFLICTS, "POST", "mgr", { body: { userId: "member1", slots: [{ date: "2026-10-21", startTime: "09:00", endTime: "10:00" }] } });
    check("…not for someone who is not staff", is(o, 400, "INVALID_STAFF"), why(o));
  }

  // ── 3. Call-out ──────────────────────────────────────────────────────────
  section("3. Call-out: own day only, the class stays on, the right people hear");
  {
    o = await call(CALL_OUT, "POST", "sal", { params: { sessionId: TUE }, body: { userId: "julian" } });
    check("a coach calling out SOMEONE ELSE → 403", is(o, 403) && rowOf(TUE, "julian")?.status === "SCHEDULED", why(o));
    o = await call(CALL_OUT, "POST", "mia", { params: { sessionId: TUE }, body: {} });
    check("a coach who is not on that class day → 409 NOT_ON_DAY", is(o, 409, "NOT_ON_DAY"), why(o));
    o = await call(CALL_OUT, "POST", "member1", { params: { sessionId: TUE }, body: {} });
    check("a MEMBER → 403", is(o, 403), why(o));

    o = await call(CALL_OUT, "POST", "sal", { params: { sessionId: TUE }, body: { reason: "flat tyre" } });
    check("a coach calls out of their own class day → 200, not late (6 hours ahead)", is(o, 200) && o.body.late === false, why(o));
    eq("their row needs coverage; the class is still on; the other coach stays", [rowOf(TUE, "sal")?.status, rowOf(TUE, "sal")?.calloutReason, sessRow(TUE).canceled, on(TUE)], ["NEEDS_COVERAGE", "flat tyre", false, ["julian"]]);
    eq("the notice", [o.body.notice.subject, o.body.notice.body],
      ["Needs coverage: Evening Group today 6:00 PM — sal Test can't make it", "sal Test can't make Evening Group on Tuesday, October 13 at 6:00 PM. Reason: flat tyre. The class is still on — it needs someone to cover."]);
    eq("goes in-app to owners, schedule managers and the other coach that day — not the caller", fake.table("message").map((m) => m.recipientId).sort(), ["julian", "mgr", "owner"]);
    eq("…and by email, with a link to that day on the staff schedule", [EMAILS.map((e) => e.to).sort(), EMAILS.every((e) => e.html.includes("/dashboard/staff/schedule?date=2026-10-13"))], [["julian@example.test", "mgr@example.test", "owner@example.test"], true]);
    check("the answer tells the caller's screen what they may do next", o.body.day?.rows?.length === 1 && o.body.day.rows[0].userId === "sal" && o.body.day.rows[0].status === "NEEDS_COVERAGE", JSON.stringify(o.body.day?.rows));

    // Readers: Sal has no schedule:view.
    o = await call(STAFFING, "GET", "sal", { params: { id: "c1" }, query: "?date=2026-10-13" });
    check("GET staffing (own day, no schedule:view) → only their own row, undo offered", is(o, 200) && o.body.day.rows.length === 1 && o.body.day.rows[0].userId === "sal" &&
      o.body.viewer.myStatus === "NEEDS_COVERAGE" && o.body.viewer.canUndoCallOut === true && o.body.viewer.canCallOut === false && o.body.viewer.canManage === false, why(o));
    check("…and no other person's name anywhere in it", !JSON.stringify(o.body).includes("julian"), JSON.stringify(o.body).slice(0, 300));
    o = await call(STAFFING, "GET", "sal", { params: { id: "c2" }, query: "?date=2026-10-14" });
    check("GET staffing for a day they are not on → 403", is(o, 403), why(o));
    o = await call(STAFF_SCHEDULE, "GET", "sal", { query: "?from=2026-10-12&to=2026-10-18" });
    const mine = (o.body?.staff?.[0]?.classes ?? []) as { date: string; myStatus: string; needsCoverage: boolean; staffIds: string[]; staffRows: { userId: string }[] }[];
    check("staff schedule: the coach who called out STILL sees that class, as Needs coverage",
      is(o, 200) && o.body.staff.length === 1 && mine.some((c) => c.date === "2026-10-13" && c.myStatus === "NEEDS_COVERAGE" && c.needsCoverage === true), why(o));
    check("…with nobody else's row or id on it", mine.every((c) => c.staffRows.every((r) => r.userId === "sal") && c.staffIds.every((x) => x === "sal")) && !JSON.stringify(o.body).includes("julian"));
    o = await call(CALENDAR, "GET", "sal", { query: "?from=2026-10-12&to=2026-10-19" });
    const calTue = (o.body?.items ?? []).find((i: { id: string }) => i.id === TUE);
    check("calendar: same — the class day is there with their status", is(o, 200) && calTue?.myStatus === "NEEDS_COVERAGE" && calTue.needsCoverage === true && calTue.staffRows.length === 1, why(o));
    o = await call(STAFF_SCHEDULE, "GET", "mgr", { query: "?from=2026-10-12&to=2026-10-18" });
    eq("staff schedule carries the CLUB's today (the viewer's device may be on another day)", o.body?.today, pure.clubTodayYmd(NY));
    const mgrSal = (o.body?.staff ?? []).find((s: { id: string }) => s.id === "sal");
    const mgrTue = (mgrSal?.classes ?? []).find((c: { date: string }) => c.date === "2026-10-13");
    check("staff schedule (manager): rich rows, the late flag, needsCoverage", mgrTue?.needsCoverage === true && mgrTue.staffRows.length === 2 &&
      mgrTue.staffRows.find((r: { userId: string }) => r.userId === "sal").status === "NEEDS_COVERAGE" && mgrTue.switched === true && o.body.assignmentsStartOn === SWITCH, JSON.stringify(mgrTue)?.slice(0, 300));

    // Undo.
    const salRow = rowOf(TUE, "sal")!;
    o = await call(UNDO, "POST", "julian", { params: { staffRowId: salRow.id } });
    check("another coach cannot undo it → 403", is(o, 403) && salRow.status === "NEEDS_COVERAGE", why(o));
    o = await call(UNDO, "POST", "sal", { params: { staffRowId: salRow.id } });
    check("the coach undoes their own unfilled call-out → 200, scheduled again", is(o, 200) && salRow.status === "SCHEDULED" && salRow.calledOutAt === null, why(o));
    eq("…and the people who were asked to cover are stood down", fake.table("message").map((m) => m.recipientId).sort(), ["julian", "mgr", "owner"]);

    // LATE: 4:40 PM New York — 1h 20m before the 6:00 PM class.
    setNow("2026-10-13T20:40:00.000Z");
    o = await call(CALL_OUT, "POST", "sal", { params: { sessionId: TUE }, body: { reason: "stuck at work" } });
    check("80 minutes before the class: still accepted, flagged LATE", is(o, 200) && o.body.late === true && salRow.lateCallout === true && salRow.status === "NEEDS_COVERAGE", why(o));
    eq("the notice says so — subject and first words", [o.body.notice.subject, String(o.body.notice.body).slice(0, 45)],
      ["Late call-out: Evening Group today 6:00 PM — sal Test can't make it", "LATE CALL-OUT — class starts in 1h 20m. sal T"]);
    check("…in the in-app message and the email too", msgsTo("owner")[0]?.startsWith("LATE CALL-OUT — class starts in 1h 20m.") && EMAILS.every((e) => e.subject.startsWith("Late call-out:") && e.html.includes("LATE CALL-OUT — class starts in 1h 20m")), JSON.stringify([msgsTo("owner"), EMAILS.map((e) => e.subject)]));
    setNow("2026-10-13T16:00:00.000Z");

    // A manager on a coach's behalf, a later day.
    o = await call(CALL_OUT, "POST", "mgr", { params: { sessionId: THU22 }, body: { userId: "julian", reason: "phoned in sick" } });
    check("a schedule manager calls out on a coach's behalf → 200", is(o, 200) && rowOf(THU22, "julian")?.status === "NEEDS_COVERAGE" && rowOf(THU22, "julian")?.calledOutByUserId === "mgr", why(o));
    check("…the manager is not sent their own notice; the notice says who recorded it", !fake.table("message").some((m) => m.recipientId === "mgr") && String(o.body.notice.body).includes("Recorded by mgr Test."), JSON.stringify(o.body.notice));
    eq("…and the coach is told it was recorded for them", msgsTo("julian"), ["mgr Test recorded that you can't make Evening Group on Thursday, October 22 at 6:00 PM. It is marked as needing coverage."]);
  }

  // ── 9a. Action Items (while two requests are open) ───────────────────────
  section("Action Items: late first, then the soonest class");
  {
    // A third, EARLIER-in-time-than-Oct-22 but not late: Mia, tomorrow morning.
    o = await call(CALL_OUT, "POST", "mia", { params: { sessionId: "c2_2026-10-14" }, body: {} });
    check("(setup) Mia calls out of tomorrow's class", is(o, 200) && o.body.late === false, why(o));
    const items = await AC.loadCoverageActionItems(CLUB);
    eq("one item per open request — the LATE one first, then by class time", items.map((i) => i.label), [
      "Late call-out: Evening Group today 6:00 PM — sal can't make it",
      "Needs coverage: Morning Group tomorrow 9:00 AM — mia can't make it",
      "Needs coverage: Evening Group Thu Oct 22 6:00 PM — julian can't make it",
    ]);
    eq("each links to the staff schedule on that day", items.map((i) => i.href.split("&")[0]), ["/dashboard/staff/schedule?date=2026-10-13", "/dashboard/staff/schedule?date=2026-10-14", "/dashboard/staff/schedule?date=2026-10-22"]);
    const forMgr = await AC.getActionCenter(sess("mgr"));
    check("a schedule manager sees them at the very top of the Action Center, counted in the badge",
      forMgr.items[0]?.label.startsWith("Late call-out: Evening Group") && forMgr.items[1]?.kind.startsWith("NEEDS_COVERAGE:") && forMgr.items[2]?.kind.startsWith("NEEDS_COVERAGE:") && forMgr.badge >= 3,
      JSON.stringify(forMgr.items.slice(0, 4).map((i) => i.label)));
    const forOwner = await AC.getActionCenter(sess("owner"));
    check("an owner sees them", forOwner.items.filter((i) => i.kind.startsWith("NEEDS_COVERAGE:")).length === 3);
    const forCoach = await AC.getActionCenter(sess("julian"));
    check("a coach without schedule:edit does not", forCoach.items.every((i) => !i.kind.startsWith("NEEDS_COVERAGE:")), JSON.stringify(forCoach.items.map((i) => i.kind)));
    const sorted = pure.coverageActionItems([
      { staffRowId: "a", sessionId: "s1", classId: "c", className: "A", coachName: "x", dateYmd: "2026-10-13", startsAt: "2026-10-13T18:00:00.000Z", lateCallout: false },
      { staffRowId: "b", sessionId: "s2", classId: "c", className: "B", coachName: "y", dateYmd: "2026-10-14", startsAt: "2026-10-14T09:00:00.000Z", lateCallout: true },
      { staffRowId: "c", sessionId: "s3", classId: "c", className: "C", coachName: "z", dateYmd: "2026-10-13", startsAt: "2026-10-13T08:00:00.000Z", lateCallout: true },
    ], "2026-10-13");
    eq("pure ordering: late before not-late whatever the time, then soonest", sorted.map((i) => i.kind), ["NEEDS_COVERAGE:c", "NEEDS_COVERAGE:b", "NEEDS_COVERAGE:a"]);
    const miaRow = rowOf("c2_2026-10-14", "mia")!;
    await call(UNDO, "POST", "mia", { params: { staffRowId: miaRow.id } });
    eq("an undone request leaves the list by itself", (await AC.loadCoverageActionItems(CLUB)).length, 2);
  }

  // ── 4. Fill, close, no-show ──────────────────────────────────────────────
  section("4. Fill / close / no-show: schedule managers only");
  {
    const salRow = rowOf(TUE, "sal")!;
    const julianRow = rowOf(THU22, "julian")!;
    o = await call(FILL, "POST", "julian", { params: { staffRowId: salRow.id }, body: { substituteUserId: "julian" } });
    check("a coach cannot fill a request (not even with themself) → 403", is(o, 403) && salRow.status === "NEEDS_COVERAGE", why(o));
    o = await call(CLOSE, "POST", "adrian", { params: { staffRowId: salRow.id }, body: {} });
    check("a coach cannot close one → 403", is(o, 403) && salRow.status === "NEEDS_COVERAGE", why(o));
    o = await call(NO_SHOW, "POST", "adrian", { params: { staffRowId: rowOf("c1_2026-10-12", "julian")!.id }, body: {} });
    check("a coach cannot mark a no-show → 403", is(o, 403), why(o));
    o = await call(CLEAR_NO_SHOW, "POST", "adrian", { params: { staffRowId: rowOf("c1_2026-10-12", "julian")!.id } });
    check("…or clear one → 403", is(o, 403), why(o));

    o = await call(FILL, "POST", "mgr", { params: { staffRowId: salRow.id }, body: { substituteUserId: "member1" } });
    check("a member cannot be the substitute → 400 INVALID_STAFF", is(o, 400, "INVALID_STAFF"), why(o));
    o = await call(FILL, "POST", "mgr", { params: { staffRowId: salRow.id }, body: { substituteUserId: "julian" } });
    check("someone already coaching it → 409 (conflict warning first, then ALREADY_ON_DAY when acknowledged)", is(o, 409), why(o));
    o = await call(FILL, "POST", "mgr", { params: { staffRowId: salRow.id }, body: { substituteUserId: "adrian" } });
    check("a schedule manager fills it → 200", is(o, 200), why(o));
    const subRow = rowOf(TUE, "adrian")!;
    eq("REPLACED + a SCHEDULED SUBSTITUTE pointing at it", [salRow.status, salRow.coverageFilledByUserId, subRow.kind, subRow.status, subRow.replacesStaffId === salRow.id, subRow.roleName, on(TUE)], ["REPLACED", "mgr", "SUBSTITUTE", "SCHEDULED", true, "Substitute", ["adrian", "julian"]]);
    eq("the substitute, the coach who called out and the coverage group are told", [msgsTo("adrian")[0]?.slice(0, 61), msgsTo("sal"), msgsTo("owner"), msgsTo("julian").length],
      ["You're covering Evening Group on Tuesday, October 13 at 6:00 ", ["adrian Test is covering Evening Group on Tuesday, October 13 at 6:00 PM for you."], ["Covered by adrian Test: adrian Test is covering Evening Group on Tuesday, October 13 at 6:00 PM for sal Test."], 1]);
    check("…by email too", EMAILS.some((e) => e.to === "adrian@example.test" && e.subject === "You're covering Evening Group Tue Oct 13 6:00 PM") && EMAILS.some((e) => e.to === "owner@example.test" && e.subject === "Covered by adrian Test: Evening Group Tue Oct 13 6:00 PM"), JSON.stringify(EMAILS.map((e) => [e.to, e.subject])));
    check("the sheet shows who covers whom", o.body.day.rows.find((r: { userId: string }) => r.userId === "sal").coveredByName === "adrian Test", JSON.stringify(o.body.day.rows));
    o = await call(UNDO, "POST", "sal", { params: { staffRowId: salRow.id } });
    check("once filled, the coach can no longer undo it → 409 BAD_STATE", is(o, 409, "BAD_STATE") && salRow.status === "REPLACED", why(o));
    o = await call(FILL, "POST", "mgr", { params: { staffRowId: salRow.id }, body: { substituteUserId: "mia" } });
    check("…and it cannot be filled twice → 409 BAD_STATE", is(o, 409, "BAD_STATE"), why(o));

    // A substitute who is double-booked is a warning.
    o = await call(CALL_OUT, "POST", "owner", { params: { sessionId: "c3_2026-10-21" }, body: {} });
    const ownerRow = rowOf("c3_2026-10-21", "owner")!;
    o = await call(FILL, "POST", "mgr", { params: { staffRowId: ownerRow.id }, body: { substituteUserId: "fin" } });
    check("a double-booked substitute → 409 STAFF_CONFLICT", is(o, 409, "STAFF_CONFLICT") && o.body.summary[0] === "fin Test: Overlaps Morning Group on Wed, Oct 21, 9:00–10:00 AM" && ownerRow.status === "NEEDS_COVERAGE", why(o));
    o = await call(FILL, "POST", "mgr", { params: { staffRowId: ownerRow.id }, body: { substituteUserId: "fin", acknowledgeConflicts: true, roleName: "Lead Coach" } });
    check("…acknowledged → 200", is(o, 200) && rowOf("c3_2026-10-21", "fin")?.roleName === "Lead Coach" && ownerRow.status === "REPLACED", why(o));

    o = await call(CLOSE, "POST", "mgr", { params: { staffRowId: julianRow.id }, body: { note: "one coach is enough" } });
    check("a manager closes a request with nobody → 200, REMOVED", is(o, 200) && julianRow.status === "REMOVED" && julianRow.note === "one coach is enough", why(o));
    check("…the coach is told", msgsTo("julian")[0]?.startsWith("Your call-out for Evening Group on Thursday, October 22"), JSON.stringify(msgsTo("julian")));
    eq("no open requests left in the Action Center", (await AC.loadCoverageActionItems(CLUB)).length, 0);

    // No-show: Monday Oct 12's class is over; Oct 20's has not started.
    const monJulian = rowOf("c1_2026-10-12", "julian")!;
    o = await call(NO_SHOW, "POST", "mgr", { params: { staffRowId: rowOf("c1_2026-10-20", "julian")!.id }, body: {} });
    check("no-show before the class starts → 409 BAD_STATE", is(o, 409, "BAD_STATE"), why(o));
    o = await call(NO_SHOW, "POST", "mgr", { params: { staffRowId: monJulian.id }, body: { note: "did not arrive" } });
    check("no-show after the class → 200", is(o, 200) && monJulian.status === "NO_SHOW" && msgsTo("julian").length === 1, why(o));
    o = await call(CLEAR_NO_SHOW, "POST", "mgr", { params: { staffRowId: monJulian.id } });
    check("clear-no-show → 200", is(o, 200) && monJulian.status === "SCHEDULED", why(o));
  }

  // ── 3b. A range ──────────────────────────────────────────────────────────
  section("Call-out for a range of days");
  {
    o = await call(CALL_OUT_RANGE, "POST", "mia", { body: { fromDate: "2026-10-14", toDate: "2026-10-28", reason: "away" } });
    check("every class day the caller is scheduled on in the range → 200", is(o, 200) && o.body.count === 4, why(o));
    eq("…those days", o.body.days.map((x: { className: string; date: string }) => `${x.className} ${x.date}`), ["Morning Group 2026-10-14", "Morning Group 2026-10-21", "Clash Group 2026-10-21", "Morning Group 2026-10-28"]);
    eq("ONE notice per person, listing all of them", [msgsTo("owner").length, msgsTo("owner")[0]?.split("\n")[0], o.body.notice.subject], [1, "mia Test can't make 4 classes. They are still on and need someone to cover:", "Needs coverage: mia Test can't make 4 classes"]);
    check("their recurring assignment is untouched", rulesOf("c2", "mia").length === 1 && rulesOf("c2", "mia")[0].effectiveTo == null);
    o = await call(CALL_OUT_RANGE, "POST", "mia", { body: { fromDate: "2026-10-28", toDate: "2026-10-14" } });
    check("dates out of order → 400", is(o, 400), why(o));
    for (const r of fake.table("classSessionStaff").filter((x) => x.userId === "mia" && x.status === "NEEDS_COVERAGE")) await call(UNDO, "POST", "mia", { params: { staffRowId: r.id } });
  }

  // ── 5. Cancel ────────────────────────────────────────────────────────────
  section("5. Cancel a class day: who, the audience, the pay choice");
  {
    o = await call(CANCEL, "POST", "viewer", { params: { sessionId: THU29 }, body: { reason: "x" } });
    check("without classes:edit → 403", is(o, 403) && sessRow(THU29).canceled === false, why(o));
    o = await call(CANCEL_PREVIEW, "GET", "viewer", { params: { sessionId: THU29 } });
    check("…and no preview either", is(o, 403), why(o));
    o = await call(CANCEL, "POST", "julian", { params: { sessionId: THU29 }, body: { reason: "x", paid: true } });
    check("\"paid\" without finances:full → 403 FINANCES_REQUIRED, nothing canceled", is(o, 403, "FINANCES_REQUIRED") && sessRow(THU29).canceled === false, why(o));
    o = await call(CANCEL, "POST", "fin", { params: { sessionId: "c2_2026-10-28" }, body: { reason: "x", paid: true, notifyAudience: "NONE" } });
    check("finances:full but COACHING that day → 403 SELF_PAY_FORBIDDEN", is(o, 403, "SELF_PAY_FORBIDDEN") && sessRow("c2_2026-10-28").canceled === false, why(o));

    o = await call(CANCEL_PREVIEW, "GET", "mgr", { params: { sessionId: THU29 } });
    check("cancel-preview → 200", is(o, 200), why(o));
    eq("audience counts: booked / class members / both", [o.body.counts.BOOKED, o.body.counts.CLASS_MEMBERS, o.body.counts.BOTH, o.body.counts.NONE],
      [{ members: 2, recipients: 2, noAddress: 0 }, { members: 4, recipients: 2, noAddress: 1 }, { members: 5, recipients: 3, noAddress: 1 }, { members: 0, recipients: 0, noAddress: 0 }]);
    eq("the club default is offered and selected; a manager without finances cannot choose paid", [o.body.defaultAudience, o.body.audience, o.body.selected.recipients, o.body.canSetPaid], ["BOOKED", "BOOKED", 2, false]);
    o = await call(CANCEL_PREVIEW, "GET", "fin", { params: { sessionId: "c2_2026-10-28" } });
    eq("…nor may someone with finances who is coaching that day; they may on another day", [o.body.canSetPaid, (await call(CANCEL_PREVIEW, "GET", "fin", { params: { sessionId: THU29 } })).body.canSetPaid], [false, true]);

    // The reason is part of the record and of the email: the handler requires it, not only the screen.
    for (const body of [{ notifyAudience: "NONE" }, { reason: "", notifyAudience: "NONE" }, { reason: "   ", notifyAudience: "NONE" }, { reason: null, notifyAudience: "NONE" }]) {
      o = await call(CANCEL, "POST", "mgr", { params: { sessionId: THU29 }, body });
      check(`cancel with reason ${JSON.stringify((body as { reason?: unknown }).reason)} → 400 BAD_INPUT, nothing canceled, nobody told`, is(o, 400, "BAD_INPUT") && sessRow(THU29).canceled === false && fake.writes().length === 0 && MEMBER_EMAILS.length === 0, why(o));
    }
    o = await call(CANCEL, "POST", "mgr", { params: { sessionId: THU29 }, body: { reason: "Building closed for repairs", notifyAudience: "BOTH" } });
    check("cancel with audience BOTH → 200", is(o, 200) && o.body.changed === true, why(o));
    const s29 = sessRow(THU29);
    eq("who / why / audience / pay stored on the class day", [s29.canceled, s29.canceledByUserId, s29.cancelReason, s29.cancelNotifyAudience, s29.cancelPaid], [true, "mgr", "Building closed for repairs", "BOTH", false]);
    eq("the notified count is stored (one per address — a guardian of two gets one)", [s29.cancelNotifiedCount, o.body.notifiedCount, MEMBER_EMAILS.length], [3, 3, 3]);
    eq("emails: transactional, one dedupe key per address", MEMBER_EMAILS.map((m) => [m.kind, m.dedupeKey]).sort(), [
      ["TRANSACTIONAL", `class-cancel:${THU29}:adult1@example.test`], ["TRANSACTIONAL", `class-cancel:${THU29}:parent@example.test`], ["TRANSACTIONAL", `class-cancel:${THU29}:walkin@example.test`],
    ]);
    const pm = MEMBER_EMAILS.find((m) => String(m.recipientEmail).toLowerCase() === "parent@example.test")!;
    check("the copy: class, day, time, reason, both athletes, the club's name", pm.subject === "Canceled: Evening Group on Thursday, October 29" && String(pm.bodyText).includes("Evening Group on Thursday, October 29 at 6:00 PM – 7:00 PM has been canceled.") &&
      String(pm.bodyText).includes("Reason: Building closed for repairs") && String(pm.bodyText).includes("kid1 M, kid2 M") && String(pm.bodyHtml).includes("Test Club") && pm.fromName === "Test Club" && String(pm.sendBatchId).startsWith(`class-cancel:${THU29}:`), JSON.stringify([pm.subject, pm.bodyText]));
    eq("that day's coaches are told in-app", [msgsTo("julian"), msgsTo("sal").length], [["Evening Group on Thursday, October 29 at 6:00 PM was canceled by mgr Test. Reason: Building closed for repairs."], 1]);
    eq("no pay decision → no billing audit row", fake.table("billingAuditLog").length, 0);
    o = await call(CANCEL, "POST", "mgr", { params: { sessionId: THU29 }, body: { reason: "again", notifyAudience: "BOTH" } });
    check("cancelling an already-canceled day changes nothing and emails nobody", is(o, 200) && o.body.changed === false && MEMBER_EMAILS.length === 0 && sessRow(THU29).cancelReason === "Building closed for repairs", why(o));

    o = await call(CANCEL_PAY, "PATCH", "mgr", { params: { sessionId: THU29 }, body: { paid: true } });
    check("changing the pay choice without finances:full → 403", is(o, 403) && sessRow(THU29).cancelPaid === false, why(o));
    o = await call(CANCEL_PAY, "PATCH", "fin", { params: { sessionId: THU29 }, body: { paid: true } });
    check("finances:full, not coaching that day → 200, canceled-paid", is(o, 200) && sessRow(THU29).cancelPaid === true && sessRow(THU29).cancelPaidByUserId === "fin", why(o));
    eq("…written to the billing audit log", fake.table("billingAuditLog").map((a) => [a.action, a.actorUserId, a.before?.cancelPaid, a.after?.cancelPaid]), [["CLASS_CANCEL_PAY", "fin", false, true]]);
    o = await call(UNCANCEL, "POST", "mgr", { params: { sessionId: THU29 } });
    check("un-cancel → 200, the record cleared, what it was is returned", is(o, 200) && sessRow(THU29).canceled === false && sessRow(THU29).cancelPaid === false && o.body.was.notifiedCount === 3 && o.body.was.paid === true, why(o));
    eq("…and the dropped pay decision is audited", fake.table("billingAuditLog").length, 2);

    o = await call(CANCEL, "POST", "mgr", { params: { sessionId: THU29 }, body: { reason: "storm" } });
    check("no audience given → the club default (BOOKED): 2 told", is(o, 200) && o.body.notifyAudience === "BOOKED" && sessRow(THU29).cancelNotifiedCount === 2, why(o));
    await call(UNCANCEL, "POST", "mgr", { params: { sessionId: THU29 } });

    // "Paid" at cancel time.
    o = await call(CANCEL, "POST", "fin", { params: { sessionId: THU29 }, body: { reason: "storm", paid: true, notifyAudience: "NONE" } });
    check("finances:full on a class they do not coach: cancel + paid in one step", is(o, 200) && sessRow(THU29).cancelPaid === true && sessRow(THU29).cancelNotifiedCount === 0 && MEMBER_EMAILS.length === 0, why(o));
    o = await call(CANCEL, "POST", "fin", { params: { sessionId: "c2_2026-10-28" }, body: { reason: "x", notifyAudience: "NONE" } });
    check("they can still cancel their OWN class day unpaid", is(o, 200) && sessRow("c2_2026-10-28").canceled === true && sessRow("c2_2026-10-28").cancelPaid === false, why(o));
    o = await call(CANCEL_PAY, "PATCH", "fin", { params: { sessionId: "c2_2026-10-28" }, body: { paid: true } });
    check("…but never switch it to paid afterwards → 403 SELF_PAY_FORBIDDEN", is(o, 403, "SELF_PAY_FORBIDDEN") && sessRow("c2_2026-10-28").cancelPaid === false, why(o));
    o = await call(CANCEL_PAY, "PATCH", "owner", { params: { sessionId: "c3_2026-10-28" }, body: { paid: true } });
    check("cancel-pay on a day that is not canceled → 409 BAD_STATE", is(o, 409, "BAD_STATE"), why(o));
    o = await call(CANCEL, "POST", "owner", { params: { sessionId: "c3_2026-10-28" }, body: { reason: "x", paid: true, notifyAudience: "NONE" } });
    check("an OWNER may keep pay on a class day they coach themself", is(o, 200) && sessRow("c3_2026-10-28").cancelPaid === true, why(o));
    o = await call(CANCEL, "POST", "mgr", { params: { sessionId: "c1_2026-10-08" }, body: { reason: "old day", notifyAudience: "NONE" } });
    check("a class day BEFORE the switch-on date can be canceled too", is(o, 200) && sessRow("c1_2026-10-08").canceled === true, why(o));
    o = await call(CANCEL, "POST", "mgr", { params: { sessionId: "nope" }, body: {} });
    check("unknown class day → 404", is(o, 404), why(o));
    o = await call(CALENDAR, "GET", "mgr", { query: "?from=2026-10-26&to=2026-11-01" });
    check("calendar leaves canceled days out unless asked", is(o, 200) && !o.body.items.some((i: { id: string }) => i.id === THU29), why(o));
    o = await call(CALENDAR, "GET", "mgr", { query: "?from=2026-10-26&to=2026-11-01&includeCanceled=1" });
    const canc = (o.body?.items ?? []).find((i: { id: string }) => i.id === THU29);
    check("…and with includeCanceled carries the cancel record", canc?.canceled === true && canc.cancel?.reason === "storm" && canc.cancel.paid === true && canc.cancel.canceledByName === "fin Test", JSON.stringify(canc)?.slice(0, 300));
  }

  // ── 6. Settings ──────────────────────────────────────────────────────────
  section("6. Settings: owner-only, and who hears about coverage");
  {
    o = await call(SETTINGS, "GET", "mgr");
    check("GET settings (schedule:view) → 200 with the read-only switch-on date", is(o, 200) && o.body.assignmentsStartOn === SWITCH && o.body.coverageNotifyOwners === true && o.body.classCancelNotifyDefault === "BOOKED", why(o));
    o = await call(SETTINGS, "GET", "sal");
    check("GET settings without schedule:view → 403", is(o, 403), why(o));
    o = await call(SETTINGS, "PUT", "mgr", { body: { coverageNotifyOwners: false } });
    check("PUT settings as a schedule manager → 403 (owner only)", is(o, 403) && wrote("clubScheduleSettings").length === 0, why(o));
    o = await call(SETTINGS, "PUT", "fin", { body: { classCancelNotifyDefault: "NONE" } });
    check("…as staff with full finances → 403", is(o, 403), why(o));
    o = await call(SETTINGS, "PUT", "owner", { body: { coverageNotifyUserIds: ["adrian", "member1", "gone"] } });
    check("naming someone who is not current staff → 400 INVALID_STAFF", is(o, 400, "INVALID_STAFF") && JSON.stringify(o.body.invalidUserIds) === JSON.stringify(["member1", "gone"]), why(o));
    o = await call(SETTINGS, "PUT", "owner", { body: { assignmentsStartOn: "2026-01-01" } });
    check("the switch-on date cannot be set here → 400", is(o, 400) && ymd(fake.table("clubScheduleSettings")[0].assignmentsStartOn) === SWITCH, why(o));
    o = await call(SETTINGS, "PUT", "owner", { body: { coverageNotifyOwners: false, coverageNotifyManagers: false, coverageNotifyClassStaff: false, coverageNotifyUserIds: ["adrian"], coverageChannels: ["IN_APP", "PUSH"], classCancelNotifyDefault: "BOTH" } });
    check("PUT settings as the owner → 200, stored", is(o, 200) && o.body.coverageNotifyUserIds[0] === "adrian" && o.body.classCancelNotifyDefault === "BOTH" && o.body.assignmentsStartOn === SWITCH, why(o));
    o = await call(CALL_OUT, "POST", "julian", { params: { sessionId: "c1_2026-10-26" }, body: {} });
    eq("a call-out now reaches only the configured person, in-app only (PUSH is ignored until it exists)", [is(o, 200), fake.table("message").map((m) => m.recipientId), EMAILS.length], [true, ["adrian"], 0]);
    await call(UNDO, "POST", "julian", { params: { staffRowId: rowOf("c1_2026-10-26", "julian")!.id } });
    await call(SETTINGS, "PUT", "owner", { body: { coverageNotifyOwners: true, coverageNotifyManagers: true, coverageNotifyClassStaff: true, coverageNotifyUserIds: [], coverageChannels: ["IN_APP", "EMAIL"], classCancelNotifyDefault: "BOOKED" } });
  }

  // ── 7. Legacy routes, switched on ────────────────────────────────────────
  section("7. The old routes on a switched-on club go to rules and rows");
  {
    o = await call(CLASSES_LIST, "GET", "mgr");
    const c1 = (o.body as { id: string; switchedOn: boolean; currentStaff: { userId: string; dayOfWeek: number | null }[]; assignedStaffIds: string[]; legacyAssignedStaffIds: string[]; staffRules: unknown[] }[]).find((c) => c.id === "c1")!;
    eq("GET classes: currentStaff comes from the RULES (weekday-aware, an assignment that starts next week included); assignedStaffIds is those coaches; the frozen list is kept apart",
      [c1.switchedOn, c1.currentStaff.map((x) => `${x.userId}:${x.dayOfWeek ?? "*"}`), c1.assignedStaffIds, c1.legacyAssignedStaffIds],
      [true, ["julian:*", "sal:*", "sal:1", "sal:4", "adrian:2"], ["julian", "sal", "adrian"], ["julian", "sal"]]);
    o = await call(CLASS, "GET", "mgr", { params: { id: "c2" } });
    check("GET class detail carries staffRules + currentStaff with names", is(o, 200) && o.body.staffRules.length === 2 && o.body.currentStaff[0].name === "mia Test" && o.body.currentStaff[0].roleLabel === "Coach", why(o));

    o = await call(CLASS_STAFF, "POST", "julian", { params: { id: "c2" }, body: { userId: "julian" } });
    check("legacy POST /staff: a coach still cannot add themself → 403", is(o, 403) && rulesOf("c2", "julian").length === 0, why(o));
    o = await call(CLASS_STAFF, "POST", "mgr", { params: { id: "c2" }, body: { userId: "adrian" } });
    check("legacy POST /staff (manager) → an every-day rule from today, and rows", is(o, 200) && rulesOf("c2", "adrian").length === 1 && rulesOf("c2", "adrian")[0].dayOfWeek == null && ymd(rulesOf("c2", "adrian")[0].effectiveFrom) === "2026-10-13" && on("c2_2026-11-04").includes("adrian"), why(o));
    check("…without touching anyone else's rule", rulesOf("c2", "mia").length === 1 && rulesOf("c2", "mia")[0].effectiveTo == null && rulesOf("c2", "fin")[0].effectiveTo == null);
    o = await call(CLASS_STAFF, "DELETE", "adrian", { params: { id: "c2" }, query: "?userId=mia" });
    check("legacy DELETE /staff: a coach cannot remove someone else → 403", is(o, 403) && rulesOf("c2", "mia")[0].effectiveTo == null, why(o));
    o = await call(CLASS_STAFF, "DELETE", "adrian", { params: { id: "c2" }, query: "?userId=adrian" });
    check("…but may take THEMSELF off; the others are told", is(o, 200) && o.body.selfRemoved === true && rulesOf("c2", "adrian").length === 0 && !on("c2_2026-11-04").includes("adrian") && EMAILS.some((e) => e.subject === "adrian Test is off Morning Group every week"), why(o));

    o = await call(CLASS, "PATCH", "mgr", { params: { id: "c2" }, body: { name: "Morning Group", assignedStaffIds: ["mia", "fin"] } });
    check("legacy PATCH class with the SAME coach list writes no rule", is(o, 200) && wrote("classStaffRule").length === 0 && wrote("classSessionStaff").length === 0, why(o));
    o = await call(CLASS, "PATCH", "mgr", { params: { id: "c2" }, body: { assignedStaffIds: ["mia", "fin", "adrian"] } });
    check("legacy PATCH class adding a coach → a rule, in the same transaction as the class", is(o, 200) && rulesOf("c2", "adrian").length === 1 && on("c2_2026-11-04").includes("adrian"), why(o));
    o = await call(CLASS, "PATCH", "julian", { params: { id: "c2" }, body: { assignedStaffIds: ["mia", "fin", "adrian", "julian"] } });
    check("legacy PATCH class: a coach adding themself → 403", is(o, 403) && rulesOf("c2", "julian").length === 0, why(o));

    const D = "c1_2026-11-05"; // Thursday: julian + sal
    o = await call(CLASS_SESSION, "PATCH", "julian", { params: { id: "c1", sessionId: D }, body: { staffOverride: ["julian", "sal", "mia"] } });
    check("legacy PATCH session: classes:edit naming a coach → 403", is(o, 403) && !on(D).includes("mia"), why(o));
    o = await call(CLASS_SESSION, "PATCH", "mgr", { params: { id: "c1", sessionId: D }, body: { staffOverride: ["julian", "mia", "member1"] } });
    check("legacy PATCH session (manager) → that day's ROWS, real staff only", is(o, 200) && JSON.stringify(on(D)) === JSON.stringify(["julian", "mia"]) && rowOf(D, "sal")?.status === "REMOVED" && !rowOf(D, "member1") && sessRow(D).staffManual === true, why(o));
    eq("…and the per-day legacy mirror follows", sessRow(D).staffOverride, ["julian", "mia"]);
    o = await call(CLASS_SESSION, "PATCH", "julian", { params: { id: "c1", sessionId: D }, body: { staffOverride: ["mia"] } });
    check("legacy PATCH session: a coach taking THEMSELF off that day → 200, others told", is(o, 200) && JSON.stringify(on(D)) === JSON.stringify(["mia"]) && rowOf(D, "julian")?.status === "REMOVED" && EMAILS.length > 0, why(o));
    o = await call(CLASS_SESSION, "PATCH", "mgr", { params: { id: "c1", sessionId: D }, body: { canceled: true } });
    check("legacy PATCH session canceled:true → recorded with who/when, told nobody", is(o, 200) && sessRow(D).canceled === true && sessRow(D).canceledByUserId === "mgr" && sessRow(D).cancelNotifyAudience === "NONE" && MEMBER_EMAILS.length === 0, why(o));
    o = await call(CLASS_SESSION, "PATCH", "mgr", { params: { id: "c1", sessionId: D }, body: { canceled: false, staffOverride: null } });
    check("…canceled:false + \"inherit\" → back on, the day follows the rules again", is(o, 200) && sessRow(D).canceled === false && sessRow(D).canceledAt === null && JSON.stringify(on(D)) === JSON.stringify(["julian", "sal"]), why(o));

    // Occurrence route: a day with no row yet (Tue Dec 1 — sessions were built to Nov 30).
    fake.table("recurringClass").find((c) => c.id === "c1")!.dayOverrides = [{ dayOfWeek: 2, startTime: "17:00", endTime: "18:00" }];
    o = await call(CLASS_OCC, "POST", "adrian", { params: { id: "c1" }, body: { date: "2026-12-01", scope: "occurrence", removeSelf: true } });
    const dec1 = fake.table("classSession").find((s) => s.classId === "c1" && ymd(s.date) === "2026-12-01");
    check("legacy occurrence: \"take me off\" a day that has no row yet → the day is created and they come off", is(o, 200) && o.body.selfRemoved === true && !!dec1 && rowsOf(dec1.id).find((r) => r.userId === "adrian")?.status === "REMOVED" && JSON.stringify(on(dec1.id)) === JSON.stringify(["julian"]), why(o));
    eq("…created with THAT weekday's time, not the class default", [dec1?.startsAt.toISOString(), dec1?.endsAt.toISOString()], ["2026-12-01T17:00:00.000Z", "2026-12-01T18:00:00.000Z"]);
    o = await call(CLASS_OCC, "POST", "adrian", { params: { id: "c1" }, body: { date: "2026-12-08", scope: "occurrence", staffIds: ["julian", "adrian", "mia"] } });
    check("legacy occurrence: a coach adding someone → 403", is(o, 403), why(o));
    o = await call(CLASS_OCC, "POST", "mgr", { params: { id: "c1" }, body: { date: "2026-10-06", scope: "following", staffIds: ["julian"] } });
    check("legacy \"this and following\" from before the switch-on date → 409 SPANS_SWITCH_ON", is(o, 409, "SPANS_SWITCH_ON") && fake.writes().length === 0, why(o));
    o = await call(CLASS_OCC, "POST", "mgr", { params: { id: "c1" }, body: { date: "2026-11-09", scope: "following", staffIds: ["julian", "sal", "mia"] } });
    check("legacy \"this and following\" → rules from that date", is(o, 200) && ymd(rulesOf("c1", "mia")[0]?.effectiveFrom ?? d("2000-01-01")) === "2026-11-09" && on("c1_2026-11-12").includes("mia") && !on("c1_2026-11-05").includes("mia"), why(o));
    o = await call(CLASS_OCC, "POST", "mgr", { params: { id: "c1" }, body: { date: "2026-10-13", scope: "series", staffIds: ["julian", "sal", "adrian"] } });
    check("legacy \"series\" → rules from today: the coach left out comes off; a weekday-only coach still listed is NOT flattened to every day",
      is(o, 200) && rulesOf("c1", "mia").length === 0 && rulesOf("c1", "adrian").length === 1 && rulesOf("c1", "adrian")[0].dayOfWeek === 2 && rulesOf("c1", "adrian")[0].effectiveTo == null && !on("c1_2026-11-12").includes("mia") && !on("c1_2026-11-12").includes("adrian"), why(o));
    o = await call(CLASS_OCC, "POST", "mgr", { params: { id: "c1" }, body: { date: "2026-10-05", scope: "occurrence", staffIds: ["adrian"] } });
    check("a day BEFORE the switch-on date still takes the legacy path (staffOverride, no rows)", is(o, 200) && JSON.stringify(sessRow("c1_2026-10-05").staffOverride) === JSON.stringify(["adrian"]) && rowsOf("c1_2026-10-05").length === 0, why(o));

    eq("after all of it, RecurringClass.assignedStaffIds was never written", JSON.stringify(fake.table("recurringClass").map((c) => [c.id, c.assignedStaffIds])), frozen);
    const { effectiveClassStaff } = require("../lib/staffAssignments.ts") as typeof import("../lib/staffAssignments"); // eslint-disable-line @typescript-eslint/no-var-requires
    const wrong = fake.table("classSession").filter((s) => ymd(s.date) >= SWITCH)
      .filter((s) => JSON.stringify(effectiveClassStaff(cls(s.classId).assignedStaffIds, s.staffOverride).staffIds.slice().sort()) !== JSON.stringify(on(s.id)));
    check("…and on every post-switch day a legacy reader still sees exactly the SCHEDULED coaches", wrong.length === 0, wrong.map((s) => s.id).join(","));
  }

  // ── 8. The pure text ─────────────────────────────────────────────────────
  section("8. Words");
  {
    const start = new RealDate("2026-10-13T22:00:00.000Z");
    eq("late banner counts down", [pure.lateCalloutBanner(start, new RealDate("2026-10-13T20:40:00.000Z")), pure.lateCalloutBanner(start, new RealDate("2026-10-13T21:15:00.000Z")), pure.lateCalloutBanner(start, new RealDate("2026-10-13T22:10:00.000Z"))],
      ["LATE CALL-OUT — class starts in 1h 20m", "LATE CALL-OUT — class starts in 45m", "LATE CALL-OUT — class started 10m ago"]);
    const rule = (id: string, userId: string, o: Partial<import("../lib/classStaff").StaffRule> = {}) => ({ id, classId: "c", userId, roleName: null, dayOfWeek: null, effectiveFrom: "2026-10-12", effectiveTo: null, ...o });
    const nameOf = (id: string) => id[0].toUpperCase() + id.slice(1);
    const words = (scope: "OCCURRENCE" | "WEEKDAY_FORWARD" | "ALL_FUTURE", desired: { userId: string; roleName?: string | null }[]) =>
      pure.describeScopeChange({ scope, classDays: [1, 2, 4], date: "2026-10-20", currentRules: [rule("r1", "sal"), rule("r2", "julian")], currentDayStaff: [], desired, nameOf }).text;
    eq("weekday: replace", words("WEEKDAY_FORWARD", [{ userId: "julian" }, { userId: "adrian" }]), "Tuesdays from Oct 20: Adrian replaces Sal. Sal stays on Mondays and Thursdays. Class days already edited by hand keep their own coaches.");
    eq("all future: add with a role", words("ALL_FUTURE", [{ userId: "sal" }, { userId: "julian" }, { userId: "mia", roleName: "Volunteer" }]), "Every class day from Oct 20: Mia is added. Class days already edited by hand keep their own coaches.");
    eq("all future: a role change", words("ALL_FUTURE", [{ userId: "sal", roleName: "Lead Coach" }, { userId: "julian" }]), "Every class day from Oct 20: Sal becomes Lead Coach. Class days already edited by hand keep their own coaches.");
    eq("nothing to do", words("WEEKDAY_FORWARD", [{ userId: "sal" }, { userId: "julian" }]), "Tuesdays from Oct 20: no change.");
    // A change already planned for LATER is cut by an edit dated EARLIER ("from that day on, exactly these
    // coaches"). The words must say so — never "the coaches on each day stay the same".
    const planned = [
      rule("p1", "sal", { effectiveTo: "2026-10-19" }), rule("p2", "sal", { dayOfWeek: 1, effectiveFrom: "2026-10-20" }), rule("p3", "sal", { dayOfWeek: 4, effectiveFrom: "2026-10-20" }),
      rule("p4", "adrian", { dayOfWeek: 2, effectiveFrom: "2026-10-20" }), rule("p5", "julian"),
    ];
    const early = (scope: "WEEKDAY_FORWARD" | "ALL_FUTURE", desired: { userId: string }[]) =>
      pure.describeScopeChange({ scope, classDays: [1, 2, 4], date: "2026-10-13", currentRules: planned, currentDayStaff: [], desired, nameOf });
    const untouched = early("WEEKDAY_FORWARD", [{ userId: "sal" }, { userId: "julian" }]);
    eq("saving an earlier Tuesday as shown drops the Tuesday change planned for Oct 20 — and says so, by name", untouched.text,
      "Tuesdays from Oct 13: Adrian, who was due to start Oct 20, will not be added. Sal, who was due to come off Oct 20, stays on. Class days already edited by hand keep their own coaches.");
    check("…it is reported as a change, with the planned rule in the ops", untouched.changed === true && untouched.ruleOps.some((op) => op.op === "delete" && op.ruleId === "p4"));
    eq("…and when someone is added as well, both are said", early("WEEKDAY_FORWARD", [{ userId: "sal" }, { userId: "julian" }, { userId: "mia" }]).text,
      "Tuesdays from Oct 13: Mia is added. Adrian, who was due to start Oct 20, will not be added. Sal, who was due to come off Oct 20, stays on. Class days already edited by hand keep their own coaches.");
    eq("a true tidy-up (same coaches every day, fewer rules) still reads as one",
      pure.describeScopeChange({ scope: "ALL_FUTURE", classDays: [1, 2, 4], date: "2026-10-20", currentRules: [rule("t1", "sal", { dayOfWeek: 1 }), rule("t2", "sal", { dayOfWeek: 2 }), rule("t3", "sal", { dayOfWeek: 4 })], currentDayStaff: [], desired: [{ userId: "sal" }], nameOf }).text,
      "Every class day from Oct 20: The recurring schedule is tidied; the coaches on each day stay the same. Class days already edited by hand keep their own coaches.");
    eq("series-level coaches from rules: weekday-aware, ended rules gone, a future-only class not blank",
      [pure.currentRuleStaff([rule("a", "sal", { effectiveTo: "2026-10-19" }), rule("b", "sal", { dayOfWeek: 1, effectiveFrom: "2026-10-20" }), rule("c", "adrian", { dayOfWeek: 2, effectiveFrom: "2026-10-20", roleName: "Lead Coach" })], "2026-10-21").map((e) => `${e.userId}:${e.dayOfWeek}:${e.roleName}`),
        pure.currentRuleStaffIds([rule("z", "zoe", { effectiveFrom: "2027-01-05" })], "2026-10-21")],
      [["sal:1:null", "adrian:2:Lead Coach"], ["zoe"]]);
  }

  console.log(`\n${failures.length ? "✗" : "✓"} ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
