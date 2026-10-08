/**
 * Branch 3 — coach calendar feeds, private lessons on the schedule and in the
 * pay ledger, one-day pay from the class-day editor, the pay-line CSV, and the
 * activity-type mapping. Exercised, not inspected.
 *
 *   npx tsx scripts/schedule-feeds-pay-tests.ts
 *
 * The REAL library code and route handlers run against scripts/fake-prisma.ts
 * with a fabricated session. Clock pinned: Tue Oct 20 2026, noon New York.
 * Coach assignments started Oct 7; the pay ledger starts Tue Oct 13.
 *
 * What it pins:
 *   1. activity types: one mapping, by name; states are words, not colours
 *   2. a calendar link is the coach's own: only they get the URL; an owner /
 *      staff:full can replace or turn it off but never sees it; a replaced or
 *      turned-off link stops working; a removed staff member's link is dead
 *   3. the feed holds ONLY that coach's classes / events / private lessons,
 *      never pay; a called-out or cancelled class day drops out; a substitute
 *      shift appears as "(covering)"
 *   4. private lessons on Staff → Schedule come from the booking rows, show
 *      the athlete only with members:view, and raise a conflict on overlap
 *   5. a finished private lesson becomes ONE pay line from the coach's rate;
 *      no rate = needs review; nothing before the ledger start; a cancelled
 *      lesson's line is voided
 *   6. private lesson rates: finances:full, never your own, never another club
 *   7. "Pay for this day": finances:view to see, nobody edits their own
 *   8. the CSV: finances:view, never before the ledger start, formula-safe
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { buildSessions } from "../lib/classSessions";
import { ACTIVITY_TYPES, ACTIVITY_META, STATE_BADGES, classActivityType, classStates, eventActivityType, findOverlaps, legendFor } from "../lib/activityType";
import { EXPORT_HEADERS, csvCell, ledgerCsv, planPayLines, type LedgerPrivateRow } from "../lib/payLedger";

const RealDate = Date;
let NOW = RealDate.parse("2026-10-20T16:00:00.000Z");
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
      location: { model: "location", kind: "one", fk: "locationId" },
      sessions: { model: "classSession", kind: "many", fk: "classId" },
    },
    eventStaffAssignment: { event: { model: "event", kind: "one", fk: "eventId" } },
    event: {
      location: { model: "location", kind: "one", fk: "locationId" },
      sessions: { model: "eventSession", kind: "many", fk: "eventId" },
      staffAssignments: { model: "eventStaffAssignment", kind: "many", fk: "eventId" },
    },
    privateBooking: {
      lessonType: { model: "privateLessonType", kind: "one", fk: "lessonTypeId" },
      member: { model: "member", kind: "one", fk: "memberId" },
    },
    privateLessonPayRate: { lessonType: { model: "privateLessonType", kind: "one", fk: "lessonTypeId" } },
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
    staffCalendarFeed: [["userId"], ["token"]],
    privateLessonPayRate: [["userId", "lessonTypeId"]],
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
const F = require("../lib/staffCalendarFeed.ts") as typeof import("../lib/staffCalendarFeed");
const guardLib = require("../lib/apiGuard.ts") as typeof import("../lib/apiGuard");
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
const at = (iso: string) => new RealDate(iso);
const ymd = (x: Date) => x.toISOString().slice(0, 10);

// ── Fixtures ────────────────────────────────────────────────────────────────
const CLUB = "club_1";
const NY = "America/New_York";
const COACH = {
  members: "none", attendance: "full", classes: "edit", events: "view", schedule: "view", messages: "send",
  documents: "view", finances: "none", billing: "none", reports: "none", staff: "none",
};
const user = (id: string, role: string, perms: Record<string, unknown> | null, clubId = CLUB) => ({
  id, clubId, role, deletedAt: null, firstName: id, lastName: "Test", email: `${id}@example.test`, resetToken: null,
  staffProfile: perms ? { title: "Coach", permissions: perms } : null,
});
fake.seed("club", [{ id: CLUB, name: "Test Club", timezone: NY }, { id: "club_2", name: "Other Club", timezone: NY }]);
fake.seed("clubScheduleSettings", [{ clubId: CLUB, assignmentsStartOn: d("2026-10-07"), payLedgerStartsOn: d("2026-10-13") }]);
fake.seed("location", [{ id: "loc", clubId: CLUB, name: "Main Mat" }]);
fake.seed("user", [
  user("owner", "OWNER", null),
  user("fin", "STAFF", { ...COACH, finances: "full", staff: "full", members: "view" }),
  user("viewer", "STAFF", { ...COACH, finances: "view" }),
  user("josh", "STAFF", COACH), user("matt", "STAFF", COACH), user("kate", "STAFF", { ...COACH, schedule: "none" }),
  user("stranger", "STAFF", { ...COACH, finances: "full", staff: "full" }, "club_2"),
  { ...user("parent", "MEMBER", null), staffProfile: null },
]);
const CLASSES: [string, string, number[], string, string, string[]][] = [
  ["jr", "Jr Frogs", [1, 3], "18:00", "19:00", ["josh"]],
  ["tad", "Tadpoles", [0, 3], "13:15", "14:00", ["matt"]],
];
for (const [id, name, days, st, en, coaches] of CLASSES) {
  fake.seed("recurringClass", [{
    id, clubId: CLUB, name, daysOfWeek: days, startTime: st, endTime: en, dayOverrides: [], assignedStaffIds: coaches, locationId: "loc",
    recurrenceStartDate: d("2026-09-01"), recurrenceEndDate: null, active: true, deletedAt: null, pricingOptions: [],
  }]);
  const sessions = buildSessions(id, CLUB, days, st, en, [], d("2026-10-05"), d("2026-11-10")).map((s) => ({
    id: `${id}_${ymd(s.date)}`, ...s, staffOverride: null, staffManual: false, cancelPaid: false, cancelReason: null, note: null,
  }));
  fake.seed("classSession", sessions);
  fake.seed("classStaffRule", coaches.map((u) => ({
    id: `rule_${id}_${u}`, clubId: CLUB, classId: id, userId: u, roleName: null, dayOfWeek: null, effectiveFrom: d("2026-10-07"), effectiveTo: null, createdAt: d("2026-10-07"),
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
fake.seed("staffCompensation", [
  { id: "p_josh", clubId: CLUB, userId: "josh", name: "Jr Frogs", baseType: "PER_CLASS", baseAmount: 25, effectiveFrom: d("2026-07-01"), effectiveTo: null, copiedFromId: null, archivedAt: null, createdAt: d("2026-07-01") },
  { id: "p_matt", clubId: CLUB, userId: "matt", name: "Tadpoles", baseType: "PER_CLASS", baseAmount: 25, effectiveFrom: d("2026-09-30"), effectiveTo: null, copiedFromId: null, archivedAt: null, createdAt: d("2026-09-30") },
]);
fake.seed("member", [
  { id: "m_ana", clubId: CLUB, firstName: "Ana", lastName: "Lopez" },
  { id: "m_ben", clubId: CLUB, firstName: "Ben", lastName: "Ruiz" },
]);
fake.seed("privateLessonType", [
  { id: "lt_60", clubId: CLUB, title: "1-on-1 (60 min)", durationMin: 60, basePrice: 70, active: true },
  { id: "lt_30", clubId: CLUB, title: "Quick tune-up", durationMin: 30, basePrice: 40, active: true },
  { id: "lt_other", clubId: "club_2", title: "Other club lesson", durationMin: 60, basePrice: 50, active: true },
]);
const booking = (id: string, coachId: string, memberId: string, lt: string, startIso: string, mins: number, status: string, pricePaid: number | null) => ({
  id, clubId: CLUB, coachId, memberId, lessonTypeId: lt, status, pricePaid,
  confirmedStartAt: at(startIso), confirmedEndAt: new RealDate(RealDate.parse(startIso) + mins * 60_000), createdAt: d("2026-10-01"),
});
fake.seed("privateBooking", [
  booking("b_old", "josh", "m_ana", "lt_60", "2026-10-10T15:00:00.000Z", 60, "COMPLETED", 70),   // before the ledger
  booking("b_done", "josh", "m_ana", "lt_60", "2026-10-15T20:00:00.000Z", 60, "COMPLETED", 70),  // Thu Oct 15, 4pm NY
  booking("b_pct", "matt", "m_ben", "lt_30", "2026-10-16T20:00:00.000Z", 30, "COMPLETED", 40),
  booking("b_norate", "matt", "m_ana", "lt_60", "2026-10-17T15:00:00.000Z", 60, "CONFIRMED", 70),
  booking("b_clash", "josh", "m_ben", "lt_60", "2026-10-21T22:30:00.000Z", 60, "CONFIRMED", 70), // Wed Oct 21 6:30pm NY — overlaps Jr Frogs 6–7
  booking("b_pending", "josh", "m_ana", "lt_30", "2026-10-22T20:00:00.000Z", 30, "PENDING_COACH", null),
  booking("b_cancel", "josh", "m_ana", "lt_60", "2026-10-23T20:00:00.000Z", 60, "CANCELED", null),
]);
fake.seed("privateLessonPayRate", [
  { id: "r1", clubId: CLUB, userId: "josh", lessonTypeId: "lt_60", payType: "FLAT", payValue: 40 },
  { id: "r2", clubId: CLUB, userId: "matt", lessonTypeId: "lt_30", payType: "PERCENT", payValue: 60 },
]);
fake.seed("event", [{ id: "ev1", clubId: CLUB, name: "Fall Tournament", type: "TOURNAMENT", startsAt: at("2026-10-24T13:00:00.000Z"), endsAt: at("2026-10-24T21:00:00.000Z"), deletedAt: null, locationId: null }]);
fake.seed("eventStaffAssignment", [{ id: "esa1", clubId: CLUB, eventId: "ev1", userId: "josh" }]);

function sess(id: string): Sess {
  const u = fake.table("user").find((x) => x.id === id)!;
  return { user: { id, clubId: u.clubId, name: `${u.firstName} ${u.lastName}`, email: u.email, role: u.role, permissions: u.staffProfile?.permissions ?? null } };
}
type Out = { status: number | null; body: any; text: string; threw?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(route: string, verb: "GET" | "POST" | "PUT" | "DELETE", as: string | null, opts: { params?: Record<string, string>; body?: unknown; query?: string } = {}): Promise<Out> {
  CURRENT = as ? sess(as) : null;
  for (const u of fake.table("user")) guardLib.invalidatePermissionCache(u.id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(route) as Record<string, (r: Request, c?: unknown) => Promise<Response>>;
  const init: RequestInit = { method: verb, headers: { "Content-Type": "application/json" } };
  if (verb !== "GET" && opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const realLog = console.log, realError = console.error, realWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    const res = await mod[verb](new Request(`http://localhost/api/test${opts.query ?? ""}`, init), { params: Promise.resolve(opts.params ?? {}) });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text };
  } catch (threw) {
    return { status: null, body: null, text: "", threw };
  } finally {
    console.log = realLog; console.error = realError; console.warn = realWarn;
  }
}
const why = (o: Out) => `got ${o.status ?? "a throw"} ${o.threw ? String((o.threw as Error)?.stack ?? o.threw).slice(0, 600) : o.text.slice(0, 300)}`;
const R = (p: string) => require.resolve(`../app/api/${p}/route.ts`);
const FEED = R("staff/[id]/calendar-feed");
const ICS = R("public/staff-calendar/[token]");
const SCHEDULE = R("staff/schedule");
const RATES = R("staff/[id]/pay-rates");
const DAYPAY = R("classes/sessions/[sessionId]/pay");
const OVERRIDE = R("classes/session-staff/[staffRowId]/pay-override");
const EXPORT = R("payroll/ledger/export");
const tokenOf = (url: string) => url.split("/").pop()!;
const lines = (userId?: string) => fake.table("payLine").filter((l) => !userId || l.userId === userId);
const privLine = (bookingId: string) => fake.table("payLine").find((l) => l.sourceType === "PRIVATE_LESSON" && l.sourceId === bookingId);

async function main() {
  section("1. Activity types — one mapping");
  eq("classes are typed by name", ["Jr Frogs", "Tadpoles", "Girls Class", "MS/HS Preseason", "Adult Open Mat", "Girls MS/HS", "Sunday Funday", "Staff meeting"].map(classActivityType),
    ["JUNIORS", "LITTLE", "GIRLS", "TEENS", "ADULT", "GIRLS", "CLASS", "ADMIN"]);
  eq("events are typed by event type, then name", [eventActivityType("TOURNAMENT", "x"), eventActivityType("CAMP", "x"), eventActivityType("CLINIC", "x"), eventActivityType("OTHER", "Travel to states"), eventActivityType("OTHER", "Staff meeting")],
    ["COMPETITION", "CAMP_CLINIC", "CAMP_CLINIC", "COMPETITION", "ADMIN"]);
  check("every type has a label, a short tag and its own colour", ACTIVITY_TYPES.every((t) => ACTIVITY_META[t].label && ACTIVITY_META[t].short) && new Set(ACTIVITY_TYPES.map((t) => ACTIVITY_META[t].color)).size === ACTIVITY_TYPES.length);
  check("every state badge has words and an icon (never colour alone)", Object.values(STATE_BADGES).every((b) => b.label.length > 3 && !!b.icon));
  eq("the legend lists only what is on screen, in a fixed order", legendFor(["PRIVATE", "JUNIORS", "nope"]).map((x) => x.type), ["JUNIORS", "PRIVATE"]);
  eq("states: cancelled wins; late call-out; substitute; covered; no-show; conflict", [
    classStates({ canceled: true, myStatus: "NEEDS_COVERAGE", conflict: true }),
    classStates({ canceled: false, myStatus: "NEEDS_COVERAGE", myLateCallout: true }),
    classStates({ canceled: false, myStatus: "NEEDS_COVERAGE" }),
    classStates({ canceled: false, myStatus: "SCHEDULED", myKind: "SUBSTITUTE", conflict: true }),
    classStates({ canceled: false, myStatus: "REPLACED", conflict: true }),
    classStates({ canceled: false, myStatus: "NO_SHOW" }),
    classStates({ canceled: false, myStatus: "SCHEDULED" }),
  ], [["CANCELLED"], ["LATE_CALLOUT"], ["NEEDS_COVERAGE"], ["SUBSTITUTE", "CONFLICT"], ["COVERED"], ["NO_SHOW"], []]);
  {
    const o = findOverlaps([{ key: "a", startMs: 0, endMs: 60, label: "A" }, { key: "b", startMs: 30, endMs: 90, label: "B" }, { key: "c", startMs: 90, endMs: 120, label: "C" }]);
    eq("overlap is flagged both ways; back-to-back is not a conflict", [o.get("a"), o.get("b"), o.get("c")], [["B"], ["A"], undefined]);
  }

  section("2. The calendar link belongs to the coach");
  {
    eq("signed out → 401", (await call(FEED, "GET", null, { params: { id: "josh" } })).status, 401);
    eq("a member → 403", (await call(FEED, "GET", "parent", { params: { id: "josh" } })).status, 403);
    eq("another coach → 403", (await call(FEED, "GET", "matt", { params: { id: "josh" } })).status, 403);
    eq("another coach cannot replace or turn it off", [(await call(FEED, "POST", "matt", { params: { id: "josh" }, body: { action: "regenerate" } })).status, (await call(FEED, "DELETE", "matt", { params: { id: "josh" } })).status], [403, 403]);
    eq("another club's admin → 404", (await call(FEED, "GET", "stranger", { params: { id: "josh" } })).status, 404);
    const before = await call(FEED, "GET", "josh", { params: { id: "josh" } });
    eq("the coach starts with no link", [before.status, before.body?.enabled, before.body?.urls], [200, false, null]);
    eq("an admin cannot create a link for someone else", (await call(FEED, "POST", "fin", { params: { id: "josh" }, body: { action: "create" } })).status, 403);
    const made = await call(FEED, "POST", "josh", { params: { id: "josh" }, body: { action: "create" } });
    check("the coach sets up their link", made.status === 200 && typeof made.body?.urls?.ics === "string", why(made));
    const url: string = made.body.urls.ics;
    const token = tokenOf(url);
    check("the link is long and unguessable, and comes as Apple / Google / copy", token.length >= 32 && made.body.urls.webcal.startsWith("webcal://") && made.body.urls.google.includes("calendar.google.com") && url.includes("/api/public/staff-calendar/"), JSON.stringify(made.body.urls));
    eq("setting it up twice keeps the same link", tokenOf((await call(FEED, "POST", "josh", { params: { id: "josh" }, body: { action: "create" } })).body.urls.ics), token);
    const adminView = await call(FEED, "GET", "fin", { params: { id: "josh" } });
    eq("staff:full sees that a link exists — never the link", [adminView.status, adminView.body?.enabled, adminView.body?.urls, JSON.stringify(adminView.body).includes(token)], [200, true, null, false]);
    const ownerView = await call(FEED, "GET", "owner", { params: { id: "josh" } });
    eq("the owner sees the status — never the link", [ownerView.body?.enabled, ownerView.body?.urls], [true, null]);

    const ics = await call(ICS, "GET", null, { params: { token } });
    check("the link answers with a calendar, no sign-in", ics.status === 200 && ics.text.startsWith("BEGIN:VCALENDAR"), why(ics));
    eq("the .ics ending works too", (await call(ICS, "GET", null, { params: { token: `${token}.ics` } })).status, 200);
    eq("a wrong token → 404", (await call(ICS, "GET", null, { params: { token: "x".repeat(32) } })).status, 404);

    section("3. What is in the feed");
    const t = ics.text;
    check("their own classes are in it", t.includes("SUMMARY:Jr Frogs"));
    check("another coach's class is not", !t.includes("Tadpoles"));
    check("their event is in it", t.includes("Fall Tournament"));
    check("their confirmed private lessons are in it, with the athlete", t.includes("Private lesson — Ana Lopez") || t.includes("Private lesson \\— Ana Lopez") || /Private lesson.*Ana Lopez/.test(t));
    check("another coach's private lesson is not", !/Ben Ruiz[\s\S]*Quick tune-up/.test(t) && !t.includes("Quick tune-up"));
    check("a pending or cancelled lesson is not", (t.match(/Private lesson/g) ?? []).length === 3, String((t.match(/Private lesson/g) ?? []).length));
    check("no pay anywhere in the feed", !/\$|pay|rate/i.test(t.replace(/Private lesson/g, "")), t.match(/.*(\$|pay|rate).*/i)?.[0]);
    check("the location comes along", t.includes("Main Mat"));

    // Before anything changes: Josh's 6:30 private on Wed Oct 21 overlaps his 6–7 Jr Frogs.
    {
      const wk = await call(SCHEDULE, "GET", "fin", { query: "?from=2026-10-19&to=2026-10-25" });
      const j = wk.body.staff.find((s: { id: string }) => s.id === "josh");
      const lesson = j.privates.find((p: { id: string }) => p.id === "b_clash");
      const klass = j.classes.find((c: { classId: string; date: string }) => c.classId === "jr" && c.date === "2026-10-21");
      check("a lesson that overlaps a class is a conflict on the lesson", lesson.conflict === true && /Jr Frogs/.test(lesson.conflictWith.join()), JSON.stringify(lesson));
      check("…and on the class", klass.conflict === true && /Private lesson/.test(klass.conflictWith.join()), JSON.stringify(klass.conflictWith));
      check("a pending lesson is not a conflict yet", j.privates.find((p: { id: string }) => p.id === "b_pending").conflict === false);
    }
    // Josh calls out of Wed Oct 21; Matt covers.
    const day = "jr_2026-10-21";
    const jr = fake.table("classSessionStaff").find((r) => r.id === `${day}_josh`)!;
    jr.status = "NEEDS_COVERAGE";
    const afterCallout = (await call(ICS, "GET", null, { params: { token } })).text;
    check("a class day they called out of leaves their feed", !afterCallout.includes(`class-${day}`) && afterCallout.includes("class-jr_2026-10-26"));
    jr.status = "REPLACED";
    fake.seed("classSessionStaff", [{ ...jr, id: `${day}_matt`, userId: "matt", kind: "SUBSTITUTE", status: "SCHEDULED", source: "MANUAL", ruleId: null, replacesStaffId: jr.id }]);
    const mattMade = await call(FEED, "POST", "matt", { params: { id: "matt" }, body: { action: "create" } });
    const mattToken = tokenOf(mattMade.body.urls.ics);
    const mattIcs = (await call(ICS, "GET", null, { params: { token: mattToken } })).text;
    check("the substitute's feed gains it, marked (covering)", mattIcs.includes("Jr Frogs (covering)") && mattIcs.includes(`class-${day}`), mattIcs.match(/SUMMARY:Jr.*/)?.[0]);
    check("…and only that one Jr Frogs day", (mattIcs.match(/SUMMARY:Jr Frogs/g) ?? []).length === 1);
    const canc = fake.table("classSession").find((s) => s.id === "jr_2026-10-26")!;
    canc.canceled = true;
    check("a cancelled class day leaves the feed", !(await call(ICS, "GET", null, { params: { token } })).text.includes("class-jr_2026-10-26"));
    canc.canceled = false;

    section("2b. Replacing and turning off");
    const regen = await call(FEED, "POST", "fin", { params: { id: "josh" }, body: { action: "regenerate" } });
    eq("staff:full replaces the link and is not shown the new one", [regen.status, regen.body?.urls], [200, null]);
    eq("the old link is dead at once", (await call(ICS, "GET", null, { params: { token } })).status, 404);
    const mine = await call(FEED, "GET", "josh", { params: { id: "josh" } });
    const token2 = tokenOf(mine.body.urls.ics);
    check("the coach finds the new link on their own profile", token2 !== token && (await call(ICS, "GET", null, { params: { token: token2 } })).status === 200);
    check("the change is on the staff member's activity", fake.table("staffActivity").some((a) => a.staffUserId === "josh" && /calendar link/.test(a.summary as string)));
    eq("the owner turns it off", (await call(FEED, "DELETE", "owner", { params: { id: "josh" } })).body?.enabled, false);
    eq("…and the link stops working", (await call(ICS, "GET", null, { params: { token: token2 } })).status, 404);
    eq("a coach without the schedule permission still gets their own link", (await call(FEED, "POST", "kate", { params: { id: "kate" }, body: { action: "create" } })).status, 200);
    // A removed staff member's link answers nothing even if the row were left behind.
    const m = fake.table("user").find((u) => u.id === "matt")!;
    m.deletedAt = new RealDate(NOW);
    eq("a removed staff member's link is dead", (await call(ICS, "GET", null, { params: { token: mattToken } })).status, 404);
    m.deletedAt = null;
    check("removing a staff member deletes their link row (route source)", /staffCalendarFeed\.deleteMany/.test(require("fs").readFileSync(R("staff/[id]"), "utf8")));
    eq("the feed's own data never selects pay", /payOverride|payLine|compensation/i.test(require("fs").readFileSync(require.resolve("../lib/staffCalendarFeed.ts"), "utf8")), false);
    void F;
  }

  section("4. Private lessons on Staff → Schedule");
  {
    const q = "?from=2026-10-19&to=2026-10-25";
    const asFin = await call(SCHEDULE, "GET", "fin", { query: q });
    check("the schedule loads", asFin.status === 200, why(asFin));
    const joshRow = asFin.body.staff.find((s: { id: string }) => s.id === "josh");
    const ids = (joshRow.privates as { id: string }[]).map((p) => p.id);
    eq("a coach's row carries their booked lessons this week (not cancelled)", ids, ["b_clash", "b_pending"]);
    const clash = joshRow.privates.find((p: { id: string }) => p.id === "b_clash");
    eq("with members:view the athlete is named", [clash.athlete, clash.activityType, clash.title], ["Ben Ruiz", "PRIVATE", "1-on-1 (60 min)"]);
    eq("once someone covers that class for him, the lesson is no longer a conflict", clash.conflict, false);
    const asJosh = await call(SCHEDULE, "GET", "josh", { query: q });
    const mineRow = asJosh.body.staff.find((s: { id: string }) => s.id === "josh");
    eq("the coach sees their own athlete", mineRow.privates.find((p: { id: string }) => p.id === "b_clash").athlete, "Ben Ruiz");
    const asMatt = await call(SCHEDULE, "GET", "matt", { query: q });
    const seen = asMatt.body.staff.find((s: { id: string }) => s.id === "josh");
    eq("another coach (no members:view) sees the time but not the athlete", seen.privates.map((p: { athlete: string | null }) => p.athlete), [null, null]);
    check("…and no athlete leaks through a conflict label", !JSON.stringify(seen).includes("Ruiz") && !JSON.stringify(seen).includes("Lopez"));
    const asKate = await call(SCHEDULE, "GET", "kate", { query: q });
    eq("a coach without schedule:view sees only their own row", asKate.body.staff.map((s: { id: string }) => s.id), ["kate"]);
    eq("classes carry their activity type", asFin.body.staff.find((s: { id: string }) => s.id === "matt").classes.find((c: { classId: string }) => c.classId === "tad").activityType, "LITTLE");
    check("no pay on the schedule feed", !/payOverride|amountCents|baseAmount/.test(JSON.stringify(asFin.body)));
    eq("the schedule read wrote nothing", fake.table("privateBooking").length, 7);
  }

  section("5. Private lessons in the pay ledger");
  {
    const row = (o: Partial<LedgerPrivateRow>): LedgerPrivateRow => ({ bookingId: "b", userId: "josh", lessonTitle: "1-on-1", athleteName: "Ana", dateYmd: "2026-10-15", ended: true, status: "COMPLETED", pricePaidCents: 7000, rate: { payType: "FLAT", payValue: 40 }, ...o });
    const plan = (rows: LedgerPrivateRow[]) => planPayLines({ fromYmd: "2026-10-13", ledgerStart: "2026-10-13", plans: [], classRows: [], privateRows: rows }).desired;
    eq("flat rate → that amount", plan([row({})]).map((l) => [l.sourceType, l.amountCents, l.status]), [["PRIVATE_LESSON", 4000, "ESTIMATED"]]);
    eq("percent → that share of what the family paid", plan([row({ rate: { payType: "PERCENT", payValue: 60 }, pricePaidCents: 4000 })])[0].amountCents, 2400);
    eq("percent with no price recorded → needs review, no amount", plan([row({ rate: { payType: "PERCENT", payValue: 60 }, pricePaidCents: null })]).map((l) => [l.status, l.amountCents]), [["NEEDS_REVIEW", null]]);
    eq("no rate → needs review, never a guess", plan([row({ rate: null })]).map((l) => [l.status, l.amountCents]), [["NEEDS_REVIEW", null]]);
    eq("not finished, cancelled, or before the ledger start → no line", plan([row({ ended: false }), row({ status: "CANCELED" }), row({ dateYmd: "2026-10-12" })]).length, 0);

    await L.syncPayLines(CLUB);
    eq("nothing before the ledger start", [privLine("b_old"), lines().filter((l) => ymd(l.workDate) < "2026-10-13").length], [undefined, 0]);
    const done = privLine("b_done");
    eq("a finished lesson → one line at the coach's flat rate", [done?.userId, done?.amountCents, done?.status, ymd(done!.workDate)], ["josh", 4000, "ESTIMATED", "2026-10-15"]);
    eq("a percent rate → that share", privLine("b_pct")?.amountCents, 2400);
    eq("no rate for that lesson type → needs review with no amount", [privLine("b_norate")?.status, privLine("b_norate")?.amountCents], ["NEEDS_REVIEW", null]);
    eq("an upcoming, pending or cancelled lesson has no line", [privLine("b_clash"), privLine("b_pending"), privLine("b_cancel")], [undefined, undefined, undefined]);
    const count = lines().length;
    await L.syncPayLines(CLUB);
    eq("syncing again changes nothing", lines().length, count);
    const b = fake.table("privateBooking").find((x) => x.id === "b_done")!;
    b.status = "CANCELED";
    await L.syncPayLines(CLUB);
    eq("a lesson later cancelled → its line is voided", privLine("b_done")?.status, "VOID");
    b.status = "COMPLETED";
    await L.syncPayLines(CLUB);
    eq("…and comes back if it is un-cancelled", [privLine("b_done")?.status, privLine("b_done")?.amountCents], ["ESTIMATED", 4000]);
  }

  section("6. Private lesson pay rates");
  {
    const body = { lessonTypeId: "lt_60", payType: "FLAT", payValue: 45 };
    eq("signed out → 401", (await call(RATES, "POST", null, { params: { id: "matt" }, body })).status, 401);
    eq("a coach cannot set a rate", (await call(RATES, "POST", "josh", { params: { id: "matt" }, body })).status, 403);
    eq("finances:view cannot set a rate", (await call(RATES, "POST", "viewer", { params: { id: "matt" }, body })).status, 403);
    eq("finances:full cannot set their OWN rate", (await call(RATES, "POST", "fin", { params: { id: "fin" }, body })).status, 403);
    eq("…or remove their own", (await call(RATES, "DELETE", "fin", { params: { id: "fin" }, query: "?lessonTypeId=lt_60" })).status, 403);
    eq("another club's admin cannot touch this club's staff", (await call(RATES, "POST", "stranger", { params: { id: "matt" }, body })).status, 404);
    eq("a lesson type from another club is refused", (await call(RATES, "POST", "fin", { params: { id: "matt" }, body: { ...body, lessonTypeId: "lt_other" } })).status, 404);
    eq("over 100% is refused", (await call(RATES, "POST", "fin", { params: { id: "matt" }, body: { ...body, payType: "PERCENT", payValue: 150 } })).status, 400);
    eq("no rate rows were written by any of that", fake.table("privateLessonPayRate").length, 2);
    const ok = await call(RATES, "POST", "fin", { params: { id: "matt" }, body });
    check("finances:full sets another coach's rate", ok.status === 201, why(ok));
    eq("the lesson waiting for review now has its amount", [privLine("b_norate")?.status, privLine("b_norate")?.amountCents], ["ESTIMATED", 4500]);
    check("the change is audited", fake.table("billingAuditLog").some((a) => a.action === "PRIVATE_PAY_RATE_SET") && fake.table("staffActivity").some((a) => a.staffUserId === "matt" && /private lesson pay/i.test(a.summary as string)));
    const own = await call(RATES, "GET", "matt", { params: { id: "matt" } });
    eq("the coach can SEE their own rates, read-only", [own.status, own.body?.viewer?.canEdit, own.body?.rates?.length], [200, false, 2]);
    check("…and only this club's lesson types are listed", own.body.lessonTypes.every((t: { id: string }) => t.id !== "lt_other"));
    eq("another coach cannot see them", (await call(RATES, "GET", "josh", { params: { id: "matt" } })).status, 403);
    eq("removing the rate → back to needs review", [(await call(RATES, "DELETE", "owner", { params: { id: "matt" }, query: "?lessonTypeId=lt_60" })).status, privLine("b_norate")?.status, privLine("b_norate")?.amountCents], [204, "NEEDS_REVIEW", null]);
  }

  section("7. Pay for this day (the class-day editor)");
  {
    const sid = "jr_2026-10-14"; // Wed Oct 14 — ended, on the ledger
    eq("signed out → 401; a coach → 403", [(await call(DAYPAY, "GET", null, { params: { sessionId: sid } })).status, (await call(DAYPAY, "GET", "josh", { params: { sessionId: sid } })).status], [401, 403]);
    const v = await call(DAYPAY, "GET", "viewer", { params: { sessionId: sid } });
    check("finances:view sees the day's pay", v.status === 200 && v.body.rows.length === 1, why(v));
    eq("…the plan amount, and cannot edit", [v.body.rows[0].planCents, v.body.rows[0].canEdit, v.body.onLedger], [2500, false, true]);
    const f = await call(DAYPAY, "GET", "fin", { params: { sessionId: sid } });
    eq("finances:full can edit another coach's day", f.body.rows[0].canEdit, true);
    const rowId = f.body.rows[0].staffRowId;
    const set = await call(OVERRIDE, "PUT", "fin", { params: { staffRowId: rowId }, body: { amount: 40, reason: "Ran it alone" } });
    check("setting the pay for the day", set.status === 200, why(set));
    const after = (await call(DAYPAY, "GET", "fin", { params: { sessionId: sid } })).body.rows[0];
    eq("the override shows the amount, the reason and who", [after.overrideCents, after.overrideReason, after.overrideByName, after.planCents], [4000, "Ran it alone", "fin Test", 2500]);
    check("…and the history has the change", after.history.length >= 1 && after.history[0].action === "set" && after.history[0].cents === 4000, JSON.stringify(after.history));
    eq("the pay plan itself was not touched", fake.table("staffCompensation").find((p) => p.id === "p_josh")!.baseAmount, 25);
    eq("a coach cannot set the pay for their own day", (await call(OVERRIDE, "PUT", "josh", { params: { staffRowId: rowId }, body: { amount: 99, reason: "me" } })).status, 403);
    // The substitute day from section 3: Matt covers Josh on Oct 21 (not yet ended → not payable yet).
    NOW = RealDate.parse("2026-10-22T16:00:00.000Z");
    const sub = await call(DAYPAY, "GET", "owner", { params: { sessionId: "jr_2026-10-21" } });
    const mattRow = sub.body.rows.find((r: { userId: string }) => r.userId === "matt");
    check("a substitute can be matched to the regular coach's rate", mattRow?.matchRegular?.cents === 2500 && /josh/i.test(mattRow.matchRegular.name), JSON.stringify(mattRow));
    eq("a day before the ledger start is not on the ledger", (await call(DAYPAY, "GET", "owner", { params: { sessionId: "jr_2026-10-07" } })).body.onLedger, false);
    eq("another club's class day → 404", (await call(DAYPAY, "GET", "stranger", { params: { sessionId: sid } })).status, 404);
  }

  section("8. The pay-line CSV");
  {
    const q = "?from=2026-10-01&to=2026-10-31";
    eq("signed out → 401; a coach → 403", [(await call(EXPORT, "GET", null, { query: q })).status, (await call(EXPORT, "GET", "josh", { query: q })).status], [401, 403]);
    eq("bad dates → 400", (await call(EXPORT, "GET", "owner", { query: "?from=2026-10-31&to=2026-10-01" })).status, 400);
    const out = await call(EXPORT, "GET", "viewer", { query: q });
    check("finances:view downloads it", out.status === 200 && out.text.startsWith(EXPORT_HEADERS.map((h) => `"${h}"`).join(",")), why(out));
    const rows = out.text.trim().split("\r\n").slice(1);
    check("one row per pay line that is not void", rows.length === lines().filter((l) => l.status !== "VOID").length, `${rows.length} vs ${lines().filter((l) => l.status !== "VOID").length}`);
    check("nothing dated before the ledger start, even when asked", rows.every((r) => r.split(",")[1].replace(/"/g, "") >= "2026-10-13"));
    const override = rows.find((r) => r.includes("Ran it alone"));
    check("an override row shows the calculated amount, the change, the reason and the final amount", !!override && override.includes('"25.00"') && override.includes('"40.00"'), override);
    check("private lessons are in it, labelled", rows.some((r) => /Private lesson/.test(r)));
    eq("one coach only, when asked", (await call(EXPORT, "GET", "owner", { query: `${q}&userId=matt` })).text.trim().split("\r\n").slice(1).every((r) => r.startsWith('"matt Test"')), true);
    eq("a spreadsheet formula is defused", [csvCell("=SUM(A1)"), csvCell("+1"), csvCell("-25.50"), csvCell('say "hi"')], [`"'=SUM(A1)"`, `"'+1"`, `"-25.50"`, `"say ""hi"""`]);
    eq("an empty export is just the header", ledgerCsv([]).trim().split("\r\n").length, 1);
    eq("exporting marked nothing paid", lines().filter((l) => l.status === "PAID").length, 0);
  }

  section("9. One editor, cancelled days stay visible, the old calculation is unchanged");
  {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require("fs") as typeof import("fs");
    const read = (rel: string) => fs.readFileSync(require.resolve(`../${rel}`), "utf8");
    const { toLegacyCompPlan, toCompPlan } = require("../lib/payrollCalc.ts") as typeof import("../lib/payrollCalc");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const sheet = read("components/staff/schedule/ClassDaySheet.tsx");
    check("the class-day editor holds time/note, coaches, pay and cancelling", ["/occurrence", "/pay-override", "/cancel", "Change coaches", "Pay for this day"].every((x) => sheet.includes(x)));
    const tab = read("components/staff/tabs/ScheduleTab.tsx");
    const switched = tab.slice(tab.indexOf("if (switchedOn && it.kind === \"class\")"), tab.indexOf("className=\"flex min-w-0 items-center gap-0.5 rounded-lg py-1 pl-2.5 pr-1\""));
    check("a switched-on class chip has no second (pencil) editor", switched.length > 200 && !switched.includes("Pencil") && !switched.includes("setEditing("));
    const page = read("app/dashboard/staff/schedule/page.tsx");
    const chip = page.slice(page.indexOf("One tap = the one editor"), page.indexOf("Changed for this day</span>}"));
    check("…nor on Staff → Schedule", chip.length > 200 && !chip.includes("setEditingOcc(") && chip.includes("openDay("));
    check("private lessons link to the existing lesson screen (nothing copied)", page.includes("/dashboard/privates?booking=") && tab.includes("/dashboard/privates?booking="));
    const member = read("app/api/member/schedule/route.ts");
    check("a cancelled class day stays on the member schedule, not bookable", !/canceled:\s*false,\s*\n\s*endsAt/.test(member) && member.includes('statusText: isCanceled ? "Canceled"') && member.includes("canBook: !isCanceled"));
    check("…and its reason shows only when families were told", member.includes('cancelNotifyAudience !== "NONE"'));
    const comp = { baseType: "PER_CLASS", baseAmount: 25, assignments: [], bonuses: [
      { id: "b1", bonusType: "ATTENDANCE", amount: 4, minThreshold: null, maxThreshold: null, countPer: "CLASS_DAY", assignments: [] },
      { id: "b2", bonusType: "SIGNUP", amount: 5, minThreshold: 8, maxThreshold: 30, countPer: "PERIOD", assignments: [] },
    ] } as unknown as Parameters<typeof toLegacyCompPlan>[0];
    eq("the old (pre-ledger) calculation ignores per-class-day bonuses made for the ledger", [toLegacyCompPlan(comp).bonuses.length, toCompPlan(comp).bonuses.length], [1, 2]);
    eq("the ledger start date was never moved by any of this", ymd(fake.table("clubScheduleSettings")[0].payLedgerStartsOn), "2026-10-13");
  }

  console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
