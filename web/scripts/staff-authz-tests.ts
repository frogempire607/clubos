/**
 * Staff authorization — exercised, not inspected (2026-10-07).
 *
 *   npx tsx scripts/staff-authz-tests.ts
 *
 * Same method as scripts/permission-behaviour-tests.ts: the REAL exported route
 * handlers are called with a fabricated session, `next-auth` and `@/lib/prisma`
 * are swapped out at the module loader, and the assertion is the HTTP status
 * (and, where it matters, exactly what was written). No database, no network,
 * no email — `@/lib/email` is stubbed too and records what would have gone out.
 *
 * Unlike that file, the prisma stub here is a small in-memory fake rather than
 * a tripwire: these cases have to get PAST the guard and prove what the handler
 * then did (which ids were stored, whether a notice was sent, that the caller's
 * own pay row was not touched).
 *
 * What it pins — the owner's rules from the staff scheduling/payroll audit:
 *   1. class edits need classes:edit; changing coaches needs schedule:edit
 *   2. only this club's OWNER/STAFF ids are ever stored as coaches
 *   3. a coach may take THEMSELF off (others are told) and can never add themself
 *   4. only an owner makes an owner; no granting above your own level; pay
 *      fields need finances:full
 *   5. an owner's setup link is owner-only; a removed account is not restored
 *      as a side effect
 *   6. a removed or demoted login is refused at once, whatever its token says
 *   7. schedule / staff / calendar reads respect schedule:view and finances:view
 *   8. nobody but an owner sets, changes or pays out their own event pay
 *   9. the permission-boundary guard judges each handler on its own
 */
import Module from "node:module";

// ── Fixtures ───────────────────────────────────────────────────────────────
const COACH = {
  members: "view", attendance: "full", classes: "edit", events: "view",
  schedule: "view", messages: "send", documents: "view",
  finances: "none", billing: "none", reports: "none", staff: "none",
};
type U = {
  id: string; clubId: string; role: "OWNER" | "STAFF" | "MEMBER"; deletedAt: Date | null;
  firstName: string; lastName: string; email: string;
  emailVerified: null; lastLoginAt: Date | null; createdAt: Date; updatedAt: Date; resetToken: string | null;
  staffProfile: Record<string, unknown> | null;
};
const mk = (id: string, role: U["role"], perms: Record<string, unknown> | null, extra: Partial<U> = {}): U => ({
  id, clubId: "club_1", role, deletedAt: null,
  firstName: id, lastName: "Test", email: `${id}@example.test`,
  emailVerified: null, lastLoginAt: new Date("2026-10-01"), createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  resetToken: null,
  staffProfile: perms
    ? { id: `sp_${id}`, userId: id, title: "Coach", permissions: perms, phone: "555-0100", hourlyRate: "25.00", salary: null, perSessionRate: "40.00", appointmentPrice: null, bio: null, publicEmail: null, publicPhone: null, photoUrl: null, showOnPortal: false }
    : null,
  ...extra,
});

let USERS: Record<string, U> = {};
let CLS: Record<string, unknown> = {};
let EVENT_ROSTER: string[] = [];
let COMP_ROWS: Record<string, unknown>[] = [];
let DAY_ROW: Record<string, unknown> | null = null;
let PAYOUT: Record<string, unknown> | null = null;
let DB_DOWN = false;

function resetDb() {
  USERS = {
    owner1: mk("owner1", "OWNER", null),
    owner2: mk("owner2", "OWNER", null),
    // Production's one manager: staff:full, finances:view, schedule:edit, classes:full.
    mgr: mk("mgr", "STAFF", { ...COACH, staff: "full", finances: "view", schedule: "edit", classes: "full" }),
    coachA: mk("coachA", "STAFF", COACH),
    coachB: mk("coachB", "STAFF", COACH),
    // classes:view + schedule:view — production's sixth staff member.
    viewer: mk("viewer", "STAFF", { ...COACH, classes: "view" }),
    noSched: mk("noSched", "STAFF", { ...COACH, classes: "none", schedule: "none" }),
    // Money without schedule: can set event pay, cannot assign.
    finMgr: mk("finMgr", "STAFF", { ...COACH, finances: "full" }),
    member1: mk("member1", "MEMBER", null),
    gone: mk("gone", "STAFF", COACH, { deletedAt: new Date("2026-10-06") }),
    otherClub: mk("otherClub", "STAFF", COACH, { clubId: "club_2" }),
  };
  CLS = {
    id: "cls1", clubId: "club_1", name: "Tuesday Advanced", deletedAt: null, active: true,
    assignedStaffIds: ["coachA", "coachB"], daysOfWeek: [2], startTime: "17:00", endTime: "18:00",
    dayOverrides: [], recurrenceStartDate: new Date("2026-01-01T00:00:00.000Z"), recurrenceEndDate: null,
  };
  EVENT_ROSTER = ["coachA", "coachB", "finMgr"];
  COMP_ROWS = [
    { id: "comp_fin", payeeType: "STAFF", userId: "finMgr", contractorId: null, payeeName: "finMgr Test", compMethod: "FLAT", flatAmount: 100, percent: null, basis: "GROSS_COLLECTED", notes: null, payoutId: null },
    { id: "comp_a", payeeType: "STAFF", userId: "coachA", contractorId: null, payeeName: "coachA Test", compMethod: "FLAT", flatAmount: 80, percent: null, basis: "GROSS_COLLECTED", notes: null, payoutId: null },
  ];
  DAY_ROW = null;
  PAYOUT = null;
  DB_DOWN = false;
}

// ── The in-memory prisma ───────────────────────────────────────────────────
type Call = { model: string; method: string; args: any };
let CALLS: Call[] = [];
const wrote = (model: string, method: string) => CALLS.filter((c) => c.model === model && c.method === method);

const inList = (v: unknown, cond: unknown): boolean => {
  if (cond === undefined) return true;
  if (cond && typeof cond === "object" && "in" in (cond as object)) return ((cond as { in: unknown[] }).in ?? []).includes(v);
  return v === cond;
};
function userMatches(u: U, where: any): boolean {
  if (!where) return true;
  if (!inList(u.id, where.id)) return false;
  if (where.clubId !== undefined && u.clubId !== where.clubId) return false;
  if (!inList(u.role, where.role)) return false;
  if (where.deletedAt === null && u.deletedAt) return false;
  return true;
}

const HANDLERS: Record<string, (args: any) => unknown> = {
  "user.findUnique": (a) => {
    if (DB_DOWN) throw new Error("db down");
    if (a?.where?.id) return USERS[a.where.id] ?? null;
    if (a?.where?.clubId_email) {
      const { clubId, email } = a.where.clubId_email;
      return Object.values(USERS).find((u) => u.clubId === clubId && u.email === email) ?? null;
    }
    return null;
  },
  "user.findFirst": (a) => {
    const u = Object.values(USERS).find((x) => userMatches(x, a?.where));
    return u ? { ...u, club: { name: "Test Club", slug: "test-club" } } : null;
  },
  "user.findMany": (a) => Object.values(USERS).filter((u) => userMatches(u, a?.where)),
  "user.update": (a) => {
    const u = USERS[a.where.id];
    if (u) Object.assign(u, Object.fromEntries(Object.entries(a.data).filter(([k]) => k !== "staffProfile")));
    return { ...(u ?? {}), staffProfile: u?.staffProfile ?? null };
  },
  "user.create": (a) => ({ id: "new_user", ...a.data, staffProfile: { permissions: a.data?.staffProfile?.create?.permissions } }),
  "club.findUnique": () => ({ name: "Test Club", slug: "test-club", builtInEventColors: null }),
  "recurringClass.findFirst": (a) => (a?.where?.id === CLS.id && a?.where?.clubId === CLS.clubId ? { ...CLS } : null),
  "recurringClass.findMany": () => [{ ...CLS }],
  "recurringClass.update": (a) => { Object.assign(CLS, a.data); return { ...CLS }; },
  "recurringClass.create": (a) => ({ id: "cls_new", ...a.data }),
  "classSession.findFirst": () => (DAY_ROW ? { ...DAY_ROW } : null),
  "classSession.findMany": () => (DAY_ROW ? [{ ...DAY_ROW }] : []),
  "classSession.update": (a) => { if (DAY_ROW) Object.assign(DAY_ROW, a.data); return { ...(DAY_ROW ?? {}) }; },
  "classSession.create": (a) => ({ id: "cs_new", ...a.data }),
  "event.findFirst": (a) => (a?.where?.id === "ev1" ? { id: "ev1", clubId: "club_1", name: "Fall Camp", startsAt: new Date("2026-11-01"), endsAt: new Date("2026-11-02"), compNoRefunds: false, sessions: [] } : null),
  "eventStaffAssignment.findMany": () => EVENT_ROSTER.map((userId) => ({ userId, event: { name: "Fall Camp" } })),
  "eventStaffAssignment.findFirst": (a) => (EVENT_ROSTER.includes(a?.where?.userId) ? { userId: a.where.userId } : null),
  "eventStaffAssignment.upsert": (a) => ({ id: "esa", ...a.create, user: { id: a.create.userId, firstName: "x", lastName: "y" } }),
  "eventCompAssignment.findMany": () => COMP_ROWS.map((r) => ({ ...r })),
  "payout.findFirst": () => (PAYOUT ? { ...PAYOUT } : null),
  "payout.create": (a) => ({ id: `po_${CALLS.length}`, ...a.data }),
  "payout.update": (a) => ({ ...(PAYOUT ?? {}), ...a.data }),
  "staffAvailability.findMany": (a) =>
    ["coachA", "coachB", "mgr"].filter((id) => !a?.where?.userId || a.where.userId === id)
      .map((userId) => ({ userId, dayOfWeek: 2, startTime: "16:00", endTime: "20:00" })),
  "staffAvailabilityException.findMany": (a) =>
    ["coachA", "coachB"].filter((id) => !a?.where?.userId || a.where.userId === id)
      .map((userId) => ({ id: `ex_${userId}`, userId, date: new Date("2026-10-07T00:00:00.000Z"), type: "UNAVAILABLE", startTime: null, endTime: null, note: `${userId} private note` })),
  "privateBooking.findMany": (a) =>
    [{ id: "pb1", coachId: "coachB", confirmedStartAt: new Date("2026-10-06T20:00:00Z"), confirmedEndAt: new Date("2026-10-06T21:00:00Z"), lessonType: { title: "1-on-1" }, coach: { firstName: "coachB", lastName: "Test" }, member: { firstName: "Private", lastName: "Athlete" } }]
      .filter((b) => !a?.where?.coachId || a.where.coachId === b.coachId),
};
const DEFAULTS: Record<string, unknown> = { findMany: [], findFirst: null, findUnique: null, count: 0, createMany: { count: 0 }, deleteMany: { count: 0 }, updateMany: { count: 0 } };

const prismaStub: any = new Proxy({}, {
  get(_t, model: string) {
    if (model === "then") return undefined;
    if (model === "$transaction") return async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prismaStub));
    return new Proxy({}, {
      get(_t2, method: string) {
        return async (args: any) => {
          CALLS.push({ model, method, args });
          const h = HANDLERS[`${model}.${method}`];
          if (h) return h(args);
          return method in DEFAULTS ? DEFAULTS[method] : { id: `${model}_x`, ...(args?.data ?? {}) };
        };
      },
    });
  },
});

type Sess = { user: { id: string; role: string; clubId: string; name: string; email: string; permissions: Record<string, unknown> | null } } | null;
let CURRENT: Sess = null;
let EMAILS: { to: string; subject: string }[] = [];

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: unknown })._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) {
  if (request === "next-auth") return { getServerSession: async () => CURRENT, default: {} };
  if (request === "@/lib/prisma" || request.endsWith("/lib/prisma") || (request === "./prisma" && /[\\/]lib[\\/]/.test(parent?.filename ?? ""))) {
    return { prisma: prismaStub, default: prismaStub };
  }
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) return { authOptions: {} };
  if (request === "@/lib/email" || request.endsWith("/lib/email")) {
    return {
      sendEmail: async (m: { to: string; subject: string }) => { EMAILS.push({ to: m.to, subject: m.subject }); },
      sendStaffInviteEmail: async () => {},
    };
  }
  return (origLoad as (...a: unknown[]) => unknown).call(this, request, parent, ...rest);
} as never;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guardLib = require("../lib/apiGuard.ts") as typeof import("../lib/apiGuard");

// ── Harness ────────────────────────────────────────────────────────────────
let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A session as the JWT would describe this user. `tokenAs` fakes a stale token. */
function sess(id: string, tokenAs?: { role?: string; permissions?: Record<string, unknown> | null }): Sess {
  const u = USERS[id];
  return {
    user: {
      id, clubId: u.clubId, name: `${u.firstName} ${u.lastName}`, email: u.email,
      role: tokenAs?.role ?? u.role,
      permissions: tokenAs?.permissions !== undefined ? tokenAs.permissions : ((u.staffProfile?.permissions as Record<string, unknown>) ?? null),
    },
  };
}

type Out = { status: number | null; body: any; threw?: unknown };
async function call(
  route: string,
  verb: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  session: Sess,
  opts: { params?: Record<string, string>; body?: unknown; query?: string; keepCache?: boolean } = {},
): Promise<Out> {
  CURRENT = session;
  CALLS = [];
  EMAILS = [];
  // lib/apiGuard caches the live user row for 20s; these cases change rows
  // between calls, so start each one cold unless the case is about the cache.
  if (!opts.keepCache) for (const id of Object.keys(USERS)) guardLib.invalidatePermissionCache(id);
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
    try { body = await res.json(); } catch { /* 204 */ }
    return { status: res.status, body };
  } catch (threw) {
    return { status: null, body: null, threw };
  } finally {
    console.log = realLog; console.error = realError; console.warn = realWarn;
  }
}
const is = (o: Out, code: number) => o.status === code;
const why = (o: Out) => `got ${o.status ?? "a throw"} ${o.threw ? String(o.threw) : JSON.stringify(o.body)?.slice(0, 160)}`;

const R = (p: string) => require.resolve(`../app/api/${p}/route.ts`);
const CLASSES = R("classes");
const CLASS = R("classes/[id]");
const CLASS_STAFF = R("classes/[id]/staff");
const CLASS_OCC = R("classes/[id]/occurrence");
const CLASS_SESSION = R("classes/[id]/sessions/[sessionId]");
const CLASS_SESSIONS = R("classes/[id]/sessions");
const EVENT_STAFF = R("events/[id]/staff");
const EVENT_COMP = R("events/[id]/comp");
const EVENT_PAYOUTS = R("events/[id]/comp/generate-payouts");
const PAYOUTS = R("payouts");
const PAYOUT_ID = R("payouts/[id]");
const STAFF = R("staff");
const STAFF_ID = R("staff/[id]");
const SETUP_LINK = R("staff/[id]/setup-link");
const STAFF_SCHEDULE = R("staff/schedule");
const AVAILABILITY = R("staff/[id]/availability");
const EXCEPTIONS = R("staff/[id]/availability/exceptions");
const CALENDAR = R("calendar");
const EXPENSES = R("expenses");
const MEMBER_ID = R("members/[id]");
const MEMBERSHIP_ID = R("memberships/[id]");
const PRODUCT_ID = R("products/[id]");
const GROUP_ID = R("messages/groups/[id]");
const LESSON_BOOKING = R("private-lessons/bookings/[id]");

async function main() {
  console.log("\nSTAFF AUTHORIZATION — real handlers, fabricated sessions\n");

  // ── 0. The pure rules ────────────────────────────────────────────────────
  console.log("the assignment rule (lib/staffSelf.ts)");
  {
    const { assignmentVerdict } = require("../lib/staffSelf.ts") as typeof import("../lib/staffSelf");
    const v = (canManage: boolean, before: string[], after: string[]) => assignmentVerdict({ canManage, actorId: "me", before, after });
    check("no change is 'none' for anyone", v(false, ["a", "me"], ["me", "a"]) === "none");
    check("a manager may add themself", v(true, ["a"], ["a", "me"]) === "manage");
    check("a non-manager taking only themself off is 'self_remove'", v(false, ["a", "me"], ["a"]) === "self_remove");
    check("a non-manager adding themself is denied", v(false, ["a"], ["a", "me"]) === "deny");
    check("a non-manager removing someone else is denied", v(false, ["a", "me"], ["me"]) === "deny");
    check("a non-manager swapping themself for someone is denied", v(false, ["a", "me"], ["a", "b"]) === "deny");
    check("a non-manager clearing the whole list is denied", v(false, ["a", "me"], []) === "deny");
  }
  console.log("\nno granting above your own level (lib/staffAccess.ts)");
  {
    const { accessAboveOwn } = require("../lib/staffAccess.ts") as typeof import("../lib/staffAccess");
    const mgr = { ...COACH, staff: "full", finances: "view" };
    check("raising finances to full with only finances:view is refused",
      accessAboveOwn(mgr, COACH, { ...COACH, finances: "full" }).length === 1);
    check("granting what you hold is fine", accessAboveOwn(mgr, COACH, { ...COACH, finances: "view" }).length === 0);
    check("lowering someone who has MORE than you is fine — even to a level still above yours",
      accessAboveOwn(mgr, { ...COACH, billing: "full" }, { ...COACH, billing: "view" }).length === 0 &&
      accessAboveOwn(mgr, { ...COACH, billing: "full" }, { ...COACH, billing: "none" }).length === 0);
    check("a brand-new account has no 'before': every level is a grant",
      accessAboveOwn({ ...COACH, attendance: "none" }, null, COACH, { newAccount: true }).some((x) => x.startsWith("Attendance")));
    check("leaving a higher level untouched is fine",
      accessAboveOwn(mgr, { ...COACH, billing: "full" }, { ...COACH, billing: "full", members: "view" }).length === 0);
    check("turning on a sub-scope you don't have is refused",
      accessAboveOwn(mgr, COACH, { ...COACH, messages_subScopes: { bulk: true } }).some((x) => x.startsWith("Messaging")));
    check("the billing transfer switch cannot be handed out by someone without it",
      accessAboveOwn(mgr, COACH, { ...COACH, billing_subScopes: { transfer_subscription: true } }).some((x) => x.startsWith("Billing")));
  }

  // ── 1. Class edits ───────────────────────────────────────────────────────
  console.log("\nPATCH /api/classes/[id] — classes:edit for details, schedule:edit for coaches");
  resetDb();
  let o = await call(CLASS, "PATCH", sess("viewer"), { params: { id: "cls1" }, body: { name: "Renamed" } });
  check("staff WITHOUT classes:edit → 403 (was open to every staff login)", is(o, 403), why(o));
  check("…and nothing was written", wrote("recurringClass", "update").length === 0);
  o = await call(CLASS, "PATCH", sess("member1"), { params: { id: "cls1" }, body: { name: "x" } });
  check("a MEMBER → 403", is(o, 403), why(o));
  o = await call(CLASS, "PATCH", null, { params: { id: "cls1" }, body: { name: "x" } });
  check("no session → 401", is(o, 401), why(o));
  o = await call(CLASS, "PATCH", sess("coachA"), { params: { id: "cls1" }, body: { name: "Renamed" } });
  check("classes:edit may change class details", is(o, 200), why(o));
  o = await call(CLASS, "PATCH", sess("coachA"), { params: { id: "cls1" }, body: { name: "Renamed", assignedStaffIds: ["coachB", "coachA"] } });
  check("classes:edit sending the SAME coaches (the editor always does) is not a coach change", is(o, 200), why(o));
  check("…and the coach list is not rewritten", !("assignedStaffIds" in (wrote("recurringClass", "update")[0]?.args.data ?? {})));
  resetDb();
  o = await call(CLASS, "PATCH", sess("coachA"), { params: { id: "cls1" }, body: { assignedStaffIds: ["coachA", "coachB", "viewer"] } });
  check("classes:edit WITHOUT schedule:edit adding a coach → 403", is(o, 403) && o.body?.code === "ASSIGNMENT_FORBIDDEN", why(o));
  check("…and nothing was written", wrote("recurringClass", "update").length === 0);
  o = await call(CLASS, "PATCH", sess("coachA"), { params: { id: "cls1" }, body: { assignedStaffIds: ["coachA"] } });
  check("…removing ANOTHER coach → 403", is(o, 403), why(o));
  o = await call(CLASS, "PATCH", sess("mgr"), { params: { id: "cls1" }, body: { assignedStaffIds: ["coachA", "viewer"] } });
  check("schedule:edit may change the coaches", is(o, 200), why(o));
  check("…and they are stored", JSON.stringify(CLS.assignedStaffIds) === JSON.stringify(["coachA", "viewer"]));
  o = await call(CLASS, "PATCH", sess("mgr", { permissions: { ...COACH, classes: "none", schedule: "none" } }), { params: { id: "cls1" }, body: { name: "y" } });
  check("the guard reads the DATABASE: a stale token saying classes:none does not block a granted manager", is(o, 200), why(o));
  USERS.mgr.staffProfile!.permissions = { ...COACH, classes: "view" };
  o = await call(CLASS, "PATCH", sess("mgr", { permissions: { ...COACH, classes: "full", schedule: "edit" } }), { params: { id: "cls1" }, body: { name: "y" } });
  check("…and a token still saying classes:full does not help once it is taken away", is(o, 403), why(o));

  // ── 2. Only real staff ids are stored ────────────────────────────────────
  console.log("\nstaff ids are validated everywhere they are written");
  resetDb();
  o = await call(CLASS, "PATCH", sess("mgr"), { params: { id: "cls1" }, body: { assignedStaffIds: ["coachA", "member1", "ghost", "otherClub", "gone"] } });
  check("a member id, a made-up id, another club's id and a removed coach are all dropped",
    is(o, 200) && JSON.stringify(CLS.assignedStaffIds) === JSON.stringify(["coachA"]), `${why(o)} stored ${JSON.stringify(CLS.assignedStaffIds)}`);
  resetDb();
  o = await call(CLASSES, "POST", sess("mgr"), { body: { name: "New", daysOfWeek: [1], startTime: "10:00", endTime: "11:00", recurrenceStartDate: "2026-10-12", assignedStaffIds: ["coachB", "member1", "ghost"] } });
  check("POST /api/classes stores only real staff", is(o, 201) && JSON.stringify(wrote("recurringClass", "create")[0]?.args.data.assignedStaffIds) === JSON.stringify(["coachB"]), why(o));
  o = await call(CLASSES, "POST", sess("coachA"), { body: { name: "New", daysOfWeek: [1], startTime: "10:00", endTime: "11:00", recurrenceStartDate: "2026-10-12", assignedStaffIds: ["coachA"] } });
  check("POST /api/classes: classes:edit cannot name coaches (themself included) → 403", is(o, 403) && wrote("recurringClass", "create").length === 0, why(o));
  o = await call(CLASSES, "POST", sess("coachA"), { body: { name: "New", daysOfWeek: [1], startTime: "10:00", endTime: "11:00", recurrenceStartDate: "2026-10-12" } });
  check("POST /api/classes: classes:edit can still create a class with no coaches", is(o, 201), why(o));
  o = await call(CLASS_STAFF, "POST", sess("mgr"), { params: { id: "cls1" }, body: { userId: "member1" } });
  check("POST /classes/[id]/staff with a member's id → 404", is(o, 404), why(o));
  DAY_ROW = { id: "cs1", classId: "cls1", clubId: "club_1", date: new Date("2026-10-06T00:00:00.000Z"), startsAt: new Date("2026-10-06T17:00:00.000Z"), endsAt: new Date("2026-10-06T18:00:00.000Z"), staffOverride: null };
  o = await call(CLASS_SESSION, "PATCH", sess("mgr"), { params: { id: "cls1", sessionId: "cs1" }, body: { staffOverride: ["viewer", "member1", "ghost"] } });
  check("PATCH sessions/[sessionId] stores only real staff as the substitute",
    is(o, 200) && JSON.stringify(wrote("classSession", "update")[0]?.args.data.staffOverride) === JSON.stringify(["viewer"]), why(o));
  o = await call(CLASS_OCC, "POST", sess("mgr"), { params: { id: "cls1" }, body: { date: "2026-10-06", scope: "occurrence", staffIds: ["viewer", "member1"] } });
  check("POST occurrence stores only real staff", is(o, 200) && JSON.stringify(wrote("classSession", "update")[0]?.args.data.staffOverride) === JSON.stringify(["viewer"]), why(o));
  o = await call(AVAILABILITY, "POST", sess("mgr"), { params: { id: "member1" }, body: { slots: [] } });
  check("availability cannot be written for a member's id → 404", is(o, 404) && wrote("staffAvailability", "createMany").length === 0, why(o));
  o = await call(EXCEPTIONS, "POST", sess("mgr"), { params: { id: "ghost" }, body: { date: "2026-10-10", type: "UNAVAILABLE" } });
  check("time off cannot be written for a made-up id → 404", is(o, 404), why(o));
  HANDLERS["privateBooking.findFirst"] = () => ({ id: "pb1", clubId: "club_1", coachId: null, memberId: "m1", status: "REQUESTED", requestedSlots: [], member: { firstName: "A", lastName: "B" }, lessonType: { title: "1-on-1" } });
  o = await call(LESSON_BOOKING, "PATCH", sess("owner1"), { params: { id: "pb1" }, body: { action: "ASSIGN_COACH", coachId: "member1" } });
  check("a private lesson cannot be assigned to a member's id → 400", is(o, 400) && wrote("privateBooking", "update").length === 0, why(o));
  o = await call(LESSON_BOOKING, "PATCH", sess("owner1"), { params: { id: "pb1" }, body: { action: "ASSIGN_COACH", coachId: "coachB" } });
  check("…a real coach is accepted", is(o, 200) && wrote("privateBooking", "update")[0]?.args.data.coachId === "coachB", why(o));
  o = await call(LESSON_BOOKING, "PATCH", sess("member1"), { params: { id: "pb1" }, body: { action: "COMPLETE" } });
  check("…and a MEMBER cannot reach the staff-side lesson route → 403", is(o, 403), why(o));
  delete HANDLERS["privateBooking.findFirst"];

  // ── 3. Self-removal, and never self-assignment ───────────────────────────
  console.log("\na coach may take THEMSELF off — and is the only assignment change they can make");
  resetDb();
  o = await call(CLASS_STAFF, "POST", sess("coachA"), { params: { id: "cls1" }, body: { userId: "coachA" } });
  check("adding yourself to a class → 403", is(o, 403), why(o));
  USERS.viewer.staffProfile!.permissions = { ...COACH, classes: "full" };
  o = await call(CLASS_STAFF, "POST", sess("viewer"), { params: { id: "cls1" }, body: { userId: "viewer" } });
  check("…even with classes:full (assignments are schedule:edit now) → 403", is(o, 403) && wrote("recurringClass", "update").length === 0, why(o));
  o = await call(CLASS_STAFF, "POST", sess("mgr"), { params: { id: "cls1" }, body: { userId: "mgr" } });
  check("a schedule manager may assign anyone, themself included", is(o, 200), why(o));
  resetDb();
  o = await call(CLASS_STAFF, "DELETE", sess("coachA"), { params: { id: "cls1" }, query: "?userId=coachB" });
  check("removing ANOTHER coach without schedule:edit → 403", is(o, 403) && wrote("recurringClass", "update").length === 0, why(o));
  o = await call(CLASS_STAFF, "DELETE", sess("coachA"), { params: { id: "cls1" }, query: "?userId=coachA" });
  check("removing YOURSELF is allowed", is(o, 200) && o.body?.selfRemoved === true, why(o));
  check("…you come off the class, nobody else does", JSON.stringify(CLS.assignedStaffIds) === JSON.stringify(["coachB"]));
  {
    const msgs = wrote("message", "createMany")[0]?.args.data as { recipientId: string; body: string }[] | undefined;
    const to = (msgs ?? []).map((m) => m.recipientId).sort();
    check("…the other coach, the schedule manager and both owners are messaged", JSON.stringify(to) === JSON.stringify(["coachB", "mgr", "owner1", "owner2"]), JSON.stringify(to));
    check("…the leaver is not messaged, nor is anyone outside the club or removed", !to.includes("coachA") && !to.includes("otherClub") && !to.includes("gone") && !to.includes("member1"));
    check("…an email is attempted for each of them", EMAILS.length === 4, String(EMAILS.length));
    check("…and it is recorded on the coach's activity", wrote("staffActivity", "create").some((c) => c.args.data.kind === "ASSIGNMENT"));
  }
  o = await call(CLASS_STAFF, "DELETE", sess("member1"), { params: { id: "cls1" }, query: "?userId=member1" });
  check("a MEMBER cannot use the self-removal path → 403", is(o, 403) && wrote("recurringClass", "update").length === 0, why(o));
  resetDb();
  o = await call(CLASS, "PATCH", sess("coachA"), { params: { id: "cls1" }, body: { assignedStaffIds: ["coachB"] } });
  check("the class editor path allows the same self-removal", is(o, 200) && JSON.stringify(CLS.assignedStaffIds) === JSON.stringify(["coachB"]), why(o));
  check("…and notifies", wrote("message", "createMany").length === 1);

  console.log("\none occurrence");
  resetDb();
  o = await call(CLASS_OCC, "POST", sess("coachA"), { params: { id: "cls1" }, body: { date: "2026-10-06", scope: "occurrence", removeSelf: true } });
  check("a coach takes themself off ONE day", is(o, 200) && o.body?.selfRemoved === true, why(o));
  check("…stored as that day's list without them", JSON.stringify(wrote("classSession", "create")[0]?.args.data.staffOverride) === JSON.stringify(["coachB"]));
  check("…the series is untouched", JSON.stringify(CLS.assignedStaffIds) === JSON.stringify(["coachA", "coachB"]));
  check("…and the others are told", wrote("message", "createMany").length === 1);
  o = await call(CLASS_OCC, "POST", sess("viewer"), { params: { id: "cls1" }, body: { date: "2026-10-06", scope: "occurrence", staffIds: ["coachA", "coachB", "viewer"] } });
  check("adding yourself to one occurrence → 403", is(o, 403) && wrote("classSession", "create").length === 0, why(o));
  o = await call(CLASS_OCC, "POST", sess("coachA"), { params: { id: "cls1" }, body: { date: "2026-10-06", scope: "occurrence", removeSelf: true, canceled: true } });
  check("a self-removal cannot smuggle a cancellation → 403", is(o, 403) && wrote("classSession", "create").length === 0, why(o));
  o = await call(CLASS_OCC, "POST", sess("coachA"), { params: { id: "cls1" }, body: { date: "2026-10-06", scope: "occurrence", startTime: "18:00" } });
  check("changing a time without schedule:edit → 403", is(o, 403), why(o));
  o = await call(CLASS_OCC, "POST", sess("coachA"), { params: { id: "cls1" }, body: { date: "2026-10-06", scope: "following", removeSelf: true } });
  check("'this day and after' is not a self-service scope → 403", is(o, 403), why(o));
  DAY_ROW = { id: "cs1", classId: "cls1", clubId: "club_1", date: new Date("2026-10-06T00:00:00.000Z"), startsAt: new Date("2026-10-06T17:00:00.000Z"), endsAt: new Date("2026-10-06T18:00:00.000Z"), staffOverride: null };
  o = await call(CLASS_SESSION, "PATCH", sess("coachA"), { params: { id: "cls1", sessionId: "cs1" }, body: { staffOverride: ["coachA", "coachB", "viewer"] } });
  check("PATCH session: classes:edit naming a substitute → 403", is(o, 403) && wrote("classSession", "update").length === 0, why(o));
  o = await call(CLASS_SESSION, "PATCH", sess("coachA"), { params: { id: "cls1", sessionId: "cs1" }, body: { staffOverride: ["coachB"] } });
  check("PATCH session: taking yourself off is allowed and notifies", is(o, 200) && wrote("message", "createMany").length === 1, why(o));
  o = await call(CLASS_SESSION, "PATCH", sess("viewer"), { params: { id: "cls1", sessionId: "cs1" }, body: { canceled: true } });
  check("PATCH session: canceling without classes:edit → 403", is(o, 403), why(o));

  console.log("\nevents");
  resetDb();
  USERS.viewer.staffProfile!.permissions = { ...COACH, events: "full" };
  o = await call(EVENT_STAFF, "POST", sess("viewer"), { params: { id: "ev1" }, body: { userId: "viewer" } });
  check("adding yourself to an event roster → 403, even with events:full", is(o, 403) && wrote("eventStaffAssignment", "upsert").length === 0, why(o));
  o = await call(EVENT_STAFF, "POST", sess("mgr"), { params: { id: "ev1" }, body: { userId: "viewer" } });
  check("a schedule manager adds staff to an event", is(o, 201), why(o));
  o = await call(EVENT_STAFF, "DELETE", sess("coachA"), { params: { id: "ev1" }, query: "?userId=coachB" });
  check("removing someone else from an event without schedule:edit → 403", is(o, 403) && wrote("eventStaffAssignment", "deleteMany").length === 0, why(o));
  o = await call(EVENT_STAFF, "DELETE", sess("coachA"), { params: { id: "ev1" }, query: "?userId=coachA" });
  check("taking yourself off an event is allowed", is(o, 204), why(o));
  check("…and the rest of the roster + managers are told", wrote("message", "createMany").length === 1);

  // ── 4. Owners, grants, pay fields ────────────────────────────────────────
  console.log("\nPOST /api/staff — only an owner makes an owner");
  resetDb();
  const invite = (extra: Record<string, unknown>) => ({ firstName: "New", lastName: "Person", email: "new@example.test", sendSetupLink: true, ...extra });
  o = await call(STAFF, "POST", sess("mgr"), { body: invite({ accountRole: "OWNER" }) });
  check("staff:full creating an OWNER → 403", is(o, 403) && o.body?.code === "OWNER_REQUIRED", why(o));
  check("…and no account was created", wrote("user", "create").length === 0);
  o = await call(STAFF, "POST", sess("mgr", { role: "OWNER" }), { body: invite({ accountRole: "OWNER" }) });
  check("…a token that CLAIMS owner is not enough — the database is asked", is(o, 403) && wrote("user", "create").length === 0, why(o));
  o = await call(STAFF, "POST", sess("owner1"), { body: invite({ accountRole: "OWNER" }) });
  check("a real owner can add a second owner", is(o, 201) && wrote("user", "create")[0]?.args.data.role === "OWNER", why(o));
  o = await call(STAFF, "POST", sess("mgr"), { body: invite({ permissions: { ...COACH } }) });
  check("staff:full can still invite STAFF at or below their own access", is(o, 201) && wrote("user", "create")[0]?.args.data.role === "STAFF", why(o));
  o = await call(STAFF, "POST", sess("mgr"), { body: invite({ permissions: { ...COACH, finances: "full" } }) });
  check("…but not with finances:full when they only hold finances:view → 403", is(o, 403) && o.body?.code === "ACCESS_ABOVE_OWN" && wrote("user", "create").length === 0, why(o));
  o = await call(STAFF, "POST", sess("mgr"), { body: invite({ permissions: { ...COACH, billing: "full" } }) });
  check("…nor billing:full", is(o, 403), why(o));
  o = await call(STAFF, "POST", sess("coachA"), { body: invite({}) });
  check("no staff:full → 403", is(o, 403), why(o));

  console.log("\nPATCH /api/staff/[id] — no privilege escalation, no pay without finances:full");
  resetDb();
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "coachA" }, body: { permissions: { ...COACH, finances: "full" } } });
  check("raising someone above your own level → 403", is(o, 403) && o.body?.code === "ACCESS_ABOVE_OWN", why(o));
  check("…nothing written", wrote("staffProfile", "update").length === 0);
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "coachA" }, body: { permissions: { ...COACH, staff: "full", schedule: "edit" } } });
  check("granting levels you hold yourself is allowed", is(o, 200), why(o));
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "coachA" }, body: { permissions: { ...COACH, messages_subScopes: { bulk: true } } } });
  check("switching on a messaging sub-scope you don't have → 403", is(o, 403), why(o));
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "coachA" }, body: { hourlyRate: 99 } });
  check("writing hourlyRate without finances:full → 403", is(o, 403) && o.body?.code === "FINANCES_FULL_REQUIRED" && wrote("staffProfile", "update").length === 0, why(o));
  for (const f of ["salary", "perSessionRate", "appointmentPrice"]) {
    o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "coachA" }, body: { [f]: 10 } });
    check(`writing ${f} without finances:full → 403`, is(o, 403), why(o));
  }
  USERS.mgr.staffProfile!.permissions = { ...COACH, staff: "full", finances: "full" };
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "coachA" }, body: { hourlyRate: 30 } });
  check("with finances:full the pay field saves", is(o, 200), why(o));
  o = await call(STAFF_ID, "PATCH", sess("owner1"), { params: { id: "coachA" }, body: { permissions: { ...COACH, finances: "full", billing: "full" }, hourlyRate: 30 } });
  check("an owner can grant anything", is(o, 200), why(o));
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "mgr" }, body: { permissions: { ...COACH, finances: "full" } } });
  check("nobody edits their own access here → 403", is(o, 403), why(o));
  o = await call(STAFF_ID, "PATCH", sess("mgr"), { params: { id: "owner1" }, body: { title: "x" } });
  check("an OWNER's record cannot be edited through this route → 404", is(o, 404), why(o));

  // ── 5. Setup links ───────────────────────────────────────────────────────
  console.log("\nPOST /api/staff/[id]/setup-link");
  resetDb();
  o = await call(SETUP_LINK, "POST", sess("mgr"), { params: { id: "owner1" } });
  check("a non-owner asking for an OWNER's setup link → 403", is(o, 403) && o.body?.code === "OWNER_REQUIRED", why(o));
  check("…no token is minted and no link comes back", wrote("user", "update").length === 0 && !JSON.stringify(o.body).includes("setup?token"));
  o = await call(SETUP_LINK, "POST", sess("mgr", { role: "OWNER" }), { params: { id: "owner1" } });
  check("…a token that claims owner does not change that", is(o, 403) && wrote("user", "update").length === 0, why(o));
  o = await call(SETUP_LINK, "POST", sess("owner2"), { params: { id: "owner1" } });
  check("an owner can", is(o, 200) && typeof o.body?.setupUrl === "string", why(o));
  resetDb();
  o = await call(SETUP_LINK, "POST", sess("mgr"), { params: { id: "gone" } });
  check("a non-owner cannot restore a REMOVED account by asking for its link → 403", is(o, 403) && USERS.gone.deletedAt !== null && wrote("user", "update").length === 0, why(o));
  o = await call(SETUP_LINK, "POST", sess("owner1"), { params: { id: "gone" } });
  check("an owner can restore one", is(o, 200) && USERS.gone.deletedAt === null, why(o));
  resetDb();
  o = await call(SETUP_LINK, "POST", sess("mgr"), { params: { id: "finMgr" } });
  check("a non-owner cannot take a link for someone with MORE access than they have → 403", is(o, 403) && wrote("user", "update").length === 0, why(o));
  o = await call(SETUP_LINK, "POST", sess("mgr"), { params: { id: "coachA" } });
  check("staff:full can still send a coach their setup link", is(o, 200), why(o));
  o = await call(SETUP_LINK, "POST", sess("coachA"), { params: { id: "coachB" } });
  check("no staff:full → 403", is(o, 403), why(o));

  // ── 6. Revocation ────────────────────────────────────────────────────────
  console.log("\na removed or demoted login is refused whatever its token says");
  resetDb();
  o = await call(EXPENSES, "POST", sess("gone", { permissions: { ...COACH, finances: "full" } }), { body: {} });
  check("removed user, valid-looking token, live-guarded route → 401", is(o, 401) && o.body?.code === "SESSION_REVOKED", why(o));
  o = await call(CLASS, "PATCH", sess("gone"), { params: { id: "cls1" }, body: { name: "x" } });
  check("removed user on the class PATCH → 401, nothing written", is(o, 401) && wrote("recurringClass", "update").length === 0, why(o));
  o = await call(STAFF_SCHEDULE, "GET", sess("gone"), { query: "?from=2026-10-05&to=2026-10-11" });
  check("removed user cannot read the schedule → 401", is(o, 401), why(o));
  o = await call(STAFF_ID, "GET", sess("gone"), { params: { id: "gone" } });
  check("…not even their own profile → 401", is(o, 401), why(o));
  {
    // The synchronous guard sees the same record once it is cached — which
    // getServerSession() always does first in production (lib/auth.ts jwt).
    for (const id of Object.keys(USERS)) guardLib.invalidatePermissionCache(id);
    await guardLib.liveUser("gone");
    const r = guardLib.requirePermission(sess("gone"), "classes", "view");
    check("the synchronous guard refuses a removed user too (401)", r?.status === 401);
    const r2 = guardLib.requireOwner({ user: { id: "gone", role: "OWNER", clubId: "club_1" } });
    check("requireOwner refuses a removed user even if the token says OWNER (401)", r2?.status === 401);
  }
  resetDb();
  USERS.owner2.role = "STAFF";
  USERS.owner2.staffProfile = { permissions: { ...COACH } };
  o = await call(STAFF, "POST", sess("owner2", { role: "OWNER" }), { body: invite({ accountRole: "OWNER" }) });
  check("an owner demoted to staff cannot mint an owner with their old token → 403", is(o, 403) && wrote("user", "create").length === 0, why(o));
  o = await call(EXPENSES, "POST", sess("owner2", { role: "OWNER" }), { body: {} });
  check("…and loses the owner bypass on money routes → 403", is(o, 403), why(o));
  resetDb();
  USERS.coachA.role = "MEMBER";
  o = await call(CLASS, "PATCH", sess("coachA", { role: "STAFF" }), { params: { id: "cls1" }, body: { name: "x" } });
  check("staff turned back into a member → 403 with a STAFF token", is(o, 403) && wrote("recurringClass", "update").length === 0, why(o));
  resetDb();
  USERS.coachA.clubId = "club_2";
  o = await call(CLASS, "PATCH", { user: { id: "coachA", role: "STAFF", clubId: "club_1", name: "x", email: "x", permissions: COACH } }, { params: { id: "cls1" }, body: { name: "x" } });
  check("a token for a club the user is no longer in → 401", is(o, 401), why(o));
  resetDb();
  DB_DOWN = true;
  o = await call(EXPENSES, "POST", sess("finMgr"), { body: {} });
  check("if the live check itself fails, staff are refused (503) rather than trusted", is(o, 503) && o.body?.code === "ACCESS_CHECK_UNAVAILABLE", why(o));
  o = await call(STAFF, "POST", sess("owner1"), { body: invite({ accountRole: "OWNER" }) });
  check("…and owner-making fails closed for everyone (503)", is(o, 503) && wrote("user", "create").length === 0, why(o));
  DB_DOWN = false;

  console.log("\nDELETE /api/staff/[id] ends access, not just the listing");
  resetDb();
  USERS.coachB.resetToken = "pending-invite-token";
  o = await call(EXPENSES, "POST", sess("coachB"), { body: {} }); // warms coachB's cache entry as a live coach
  o = await call(STAFF_ID, "DELETE", sess("mgr"), { params: { id: "coachB" }, keepCache: true });
  check("staff:full removes a coach", is(o, 200), why(o));
  {
    const data = wrote("user", "update")[0]?.args.data ?? {};
    check("…deletedAt is set and the pending setup/reset token is cleared", data.deletedAt instanceof Date && data.resetToken === null && data.resetExpires === null);
  }
  o = await call(CLASS, "PATCH", sess("coachB"), { params: { id: "cls1" }, body: { name: "x" }, keepCache: true });
  check("…their very next request is refused — the cached 'still staff' record was dropped (401)", is(o, 401), why(o));
  o = await call(STAFF_ID, "DELETE", sess("mgr"), { params: { id: "mgr" } });
  check("nobody removes themself → 403", is(o, 403), why(o));
  o = await call(STAFF_ID, "DELETE", sess("mgr"), { params: { id: "owner1" } });
  check("an owner cannot be removed through this route → 404", is(o, 404), why(o));

  console.log("\nthe session itself (lib/auth.ts callbacks)");
  {
    resetDb();
    for (const id of Object.keys(USERS)) guardLib.invalidatePermissionCache(id);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { authOptions, sessionPermissions } = require("../lib/auth.ts") as typeof import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt as unknown as (p: { token: Record<string, unknown>; user?: unknown }) => Promise<Record<string, unknown>>;
    const session = authOptions.callbacks!.session as unknown as (p: { session: unknown; token: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    const blank = () => ({ user: { name: "n", email: "e" }, expires: "x" });

    let t = await jwt({ token: { id: "gone", role: "STAFF", clubId: "club_1", permissions: COACH } });
    check("a removed user's token is marked revoked on the next read", t.revoked === true);
    check("…and yields NO session (empty body → getServerSession() returns null → 401 everywhere)", Object.keys(await session({ session: blank(), token: t })).length === 0);
    USERS.gone.deletedAt = null;
    guardLib.invalidatePermissionCache("gone");
    t = await jwt({ token: t });
    check("…revocation is sticky: restoring the account does not revive an old session", t.revoked === true);

    USERS.coachA.staffProfile!.permissions = { ...COACH, finances: "full", messages_subScopes: { bulk: true }, billing_subScopes: { transfer_subscription: true } };
    t = await jwt({ token: { id: "coachA", role: "STAFF", clubId: "club_1", permissions: COACH } });
    const p = t.permissions as Record<string, any>;
    check("a permission change reaches the session without a re-login", p.finances === "full");
    check("sub-scope grants now reach the session (they used to be dropped)", p.messages_subScopes?.bulk === true && p.billing_subScopes?.transfer_subscription === true);
    const s = await session({ session: blank(), token: t });
    check("…and are on session.user.permissions", (s.user as any).permissions.messages_subScopes.bulk === true && (s.user as any).id === "coachA");

    USERS.owner2.role = "STAFF"; USERS.owner2.staffProfile = { permissions: { ...COACH } };
    t = await jwt({ token: { id: "owner2", role: "OWNER", clubId: "club_1", permissions: null } });
    check("a demotion reaches the session: role STAFF with their permissions", t.role === "STAFF" && (t.permissions as any).classes === "edit");

    t = await jwt({ token: { id: "nobody", role: "STAFF", clubId: "club_1", permissions: COACH } });
    check("a token for a user that no longer exists is revoked", t.revoked === true);
    t = await jwt({ token: { id: "otherClub", role: "STAFF", clubId: "club_1", permissions: COACH } });
    check("a token whose club no longer matches is revoked", t.revoked === true);

    DB_DOWN = true;
    for (const id of Object.keys(USERS)) guardLib.invalidatePermissionCache(id);
    t = await jwt({ token: { id: "coachB", role: "STAFF", clubId: "club_1", permissions: COACH } });
    check("a failed lookup does not sign anyone out (the *Live guards fail closed instead)", t.revoked === undefined && t.role === "STAFF");
    DB_DOWN = false;

    t = await jwt({ token: { revoked: true }, user: { id: "coachA", role: "STAFF", clubId: "club_1", permissions: COACH } });
    check("signing in again clears the mark", t.revoked === undefined && t.id === "coachA");
    check("sessionPermissions keeps levels + sub-scope maps and nothing else",
      JSON.stringify(Object.keys(sessionPermissions({ classes: "edit", junk: 1, messages_subScopes: { bulk: true } })).sort()) ===
      JSON.stringify(["attendance", "billing", "classes", "documents", "events", "finances", "members", "messages", "messages_subScopes", "reports", "schedule", "staff"].sort()));
  }

  // ── 7. Reads ─────────────────────────────────────────────────────────────
  console.log("\nGET /api/staff/schedule — schedule:view for everyone's, otherwise only your own");
  resetDb();
  o = await call(STAFF_SCHEDULE, "GET", sess("noSched"), { query: "?from=2026-10-05&to=2026-10-11" });
  check("without schedule:view the response has exactly one row: the caller", is(o, 200) && o.body.staff.length === 1 && o.body.staff[0].id === "noSched", why(o));
  check("…and no club-wide class/event lists", o.body?.allClasses?.length === 0 && o.body?.allEvents?.length === 0);
  check("…and nobody else's email or time-off note anywhere in it", !JSON.stringify(o.body).includes("coachA") && !JSON.stringify(o.body).includes("private note"));
  USERS.coachA.staffProfile!.permissions = { ...COACH, schedule: "none" };
  o = await call(STAFF_SCHEDULE, "GET", sess("coachA", { permissions: COACH }), { query: "?from=2026-10-05&to=2026-10-11" });
  check("a coach without schedule:view still sees their OWN classes and time off", is(o, 200) && o.body.staff.length === 1 && o.body.staff[0].classes.length === 1 && o.body.staff[0].exceptions.length === 1, why(o));
  check("…with the co-coach's id removed from the occurrence", JSON.stringify(o.body.staff[0].classes[0].staffIds) === JSON.stringify(["coachA"]) && !JSON.stringify(o.body).includes("coachB"));
  check("…read live: the stale token still said schedule:view", o.body?.viewer?.seesAll === false);
  resetDb();
  o = await call(STAFF_SCHEDULE, "GET", sess("coachB"), { query: "?from=2026-10-05&to=2026-10-11" });
  check("with schedule:view everyone is listed", is(o, 200) && o.body.staff.length === 8 && o.body.viewer.canAssign === false, `${why(o).slice(0, 60)} rows=${o.body?.staff?.length}`);
  o = await call(STAFF_SCHEDULE, "GET", sess("mgr"), { query: "?from=2026-10-05&to=2026-10-11" });
  check("schedule:edit is reported as canAssign", o.body?.viewer?.canAssign === true);
  o = await call(STAFF_SCHEDULE, "GET", sess("member1"), { query: "?from=2026-10-05&to=2026-10-11" });
  check("a MEMBER → 403", is(o, 403), why(o));

  console.log("\nGET availability — self, or schedule:view");
  o = await call(AVAILABILITY, "GET", sess("noSched"), { params: { id: "coachA" } });
  check("someone else's weekly hours without schedule:view → 403", is(o, 403), why(o));
  o = await call(EXCEPTIONS, "GET", sess("noSched"), { params: { id: "coachA" } });
  check("someone else's time off without schedule:view → 403", is(o, 403), why(o));
  o = await call(AVAILABILITY, "GET", sess("noSched"), { params: { id: "noSched" } });
  check("your own → 200", is(o, 200), why(o));
  o = await call(AVAILABILITY, "GET", sess("coachB"), { params: { id: "coachA" } });
  check("schedule:view → 200", is(o, 200), why(o));
  o = await call(AVAILABILITY, "POST", sess("coachB"), { params: { id: "coachA" }, body: { slots: [] } });
  check("changing someone else's hours needs schedule:edit → 403", is(o, 403), why(o));
  o = await call(AVAILABILITY, "POST", sess("noSched"), { params: { id: "noSched" }, body: { slots: [] } });
  check("your own hours → allowed", is(o, 200), why(o));
  o = await call(AVAILABILITY, "GET", sess("member1"), { params: { id: "member1" } });
  check("a MEMBER cannot use the 'self' path → 403", is(o, 403), why(o));

  console.log("\nGET /api/staff and /api/staff/[id] — directory vs pay vs access");
  resetDb();
  USERS.viewer.staffProfile!.permissions = { ...COACH, staff: "view" };
  o = await call(STAFF, "GET", sess("viewer"), { query: "?includeOwners=true" });
  {
    const rows = (o.body ?? []) as any[];
    const other = rows.find((r) => r.id === "coachA")?.staffProfile ?? {};
    const mine = rows.find((r) => r.id === "viewer")?.staffProfile ?? {};
    check("staff:view lists the directory", is(o, 200) && rows.length === 8 && other.title === "Coach", why(o));
    check("…with NO pay fields (finances:none)", !["hourlyRate", "salary", "perSessionRate", "appointmentPrice"].some((f) => rows.some((r) => r.staffProfile && f in r.staffProfile)));
    check("…and no one else's permissions or private phone", !("permissions" in other) && !("phone" in other));
    check("…but their own", "permissions" in mine && mine.phone === "555-0100");
    check("…and never a reset token or password hash", !JSON.stringify(rows).includes("resetToken") && !JSON.stringify(rows).includes("passwordHash"));
  }
  USERS.viewer.staffProfile!.permissions = { ...COACH, staff: "view", finances: "view" };
  o = await call(STAFF, "GET", sess("viewer"), { query: "?includeOwners=true" });
  check("finances:view adds the pay fields", (o.body as any[]).find((r) => r.id === "coachA")?.staffProfile?.hourlyRate === "25.00" && !("permissions" in (o.body as any[]).find((r) => r.id === "coachA").staffProfile));
  o = await call(STAFF, "GET", sess("mgr"), { query: "?includeOwners=true" });
  check("staff:full sees permissions + private phone", (o.body as any[]).find((r) => r.id === "coachA")?.staffProfile?.phone === "555-0100" && "permissions" in (o.body as any[]).find((r) => r.id === "coachA").staffProfile);
  o = await call(STAFF, "GET", sess("coachA"));
  check("no staff:view → 403", is(o, 403), why(o));
  USERS.viewer.staffProfile!.permissions = { ...COACH, staff: "view" };
  o = await call(STAFF_ID, "GET", sess("viewer"), { params: { id: "coachA" } });
  check("profile with staff:view: no private phone, no access grid, no activity",
    is(o, 200) && o.body.staff.phone === null && Object.keys(o.body.staff.permissions).length === 0 && o.body.activity.length === 0 && o.body.viewer.canSeeAccess === false && wrote("staffActivity", "findMany").length === 0, why(o));
  o = await call(STAFF_ID, "GET", sess("coachA"), { params: { id: "coachA" } });
  check("your own profile: phone + access visible", is(o, 200) && o.body.staff.phone === "555-0100" && o.body.staff.permissions.classes === "edit" && o.body.viewer.canAssign === false, why(o));
  o = await call(STAFF_ID, "GET", sess("mgr"), { params: { id: "coachA" } });
  check("staff:full: phone + access visible, canAssign follows schedule:edit", is(o, 200) && o.body.staff.phone === "555-0100" && o.body.viewer.canAssign === true && wrote("staffActivity", "findMany").length === 1, why(o));
  o = await call(STAFF_ID, "GET", sess("coachA"), { params: { id: "coachB" } });
  check("someone else's profile without staff:view → 403", is(o, 403), why(o));

  console.log("\nGET /api/calendar and the class reads");
  resetDb();
  HANDLERS["classSession.findMany"] = () => [{ id: "cs1", classId: "cls1", date: new Date("2026-10-06T00:00:00.000Z"), startsAt: new Date("2026-10-06T17:00:00.000Z"), endsAt: new Date("2026-10-06T18:00:00.000Z"), staffOverride: null, recurringClass: { name: "Tuesday Advanced", assignedStaffIds: ["coachA", "coachB"], description: null, capacity: null, color: null, textColor: null, location: null }, _count: { attendance: 0 } }];
  HANDLERS["event.findMany"] = () => [{ id: "ev1", name: "Fall Camp", type: "CAMP", startsAt: new Date("2026-10-08T14:00:00Z"), endsAt: new Date("2026-10-08T16:00:00Z"), capacity: null, description: null, memberPrice: null, nonMemberPrice: null, location: null, customEventTypeId: null, customEventType: null, staffAssignments: [{ userId: "coachB" }], sessions: [], _count: { bookings: 0 } }];
  USERS.coachA.staffProfile!.permissions = { ...COACH, schedule: "none" };
  o = await call(CALENDAR, "GET", sess("coachA"), { query: "?from=2026-10-01&to=2026-10-31" });
  {
    const items = (o.body?.items ?? []) as any[];
    check("calendar without schedule:view: only the caller's own items", is(o, 200) && items.length === 1 && items[0].kind === "class", `${why(o).slice(0, 80)} items=${items.length}`);
    check("…no other coach's name, no private-lesson athlete, no staff picker", !JSON.stringify(o.body).includes("coachB") && !JSON.stringify(o.body).includes("Private Athlete") && o.body.staffOptions.length === 0);
  }
  resetDb();
  HANDLERS["classSession.findMany"] = () => [{ id: "cs1", classId: "cls1", date: new Date("2026-10-06T00:00:00.000Z"), startsAt: new Date("2026-10-06T17:00:00.000Z"), endsAt: new Date("2026-10-06T18:00:00.000Z"), staffOverride: null, recurringClass: { name: "Tuesday Advanced", assignedStaffIds: ["coachA", "coachB"], description: null, capacity: null, color: null, textColor: null, location: null }, _count: { attendance: 0 } }];
  o = await call(CALENDAR, "GET", sess("coachA"), { query: "?from=2026-10-01&to=2026-10-31" });
  check("calendar with schedule:view: everything, and no assign rights without schedule:edit",
    is(o, 200) && o.body.items.length === 3 && o.body.can.editClassSeriesStaff === false && o.body.can.editEventStaff === false, `${why(o).slice(0, 60)} items=${o.body?.items?.length}`);
  o = await call(CALENDAR, "GET", sess("mgr"), { query: "?from=2026-10-01&to=2026-10-31" });
  check("…schedule:edit turns the assign flags on", o.body?.can?.editClassSeriesStaff === true && o.body?.can?.editClassDayStaff === true);
  o = await call(CALENDAR, "GET", sess("member1"));
  check("calendar: a MEMBER → 403", is(o, 403), why(o));
  HANDLERS["classSession.findMany"] = () => (DAY_ROW ? [{ ...DAY_ROW }] : []);
  HANDLERS["event.findMany"] = () => [];
  for (const [name, route, params] of [["/api/classes", CLASSES, {}], ["/api/classes/[id]", CLASS, { id: "cls1" }], ["/api/classes/[id]/sessions", CLASS_SESSIONS, { id: "cls1" }]] as const) {
    o = await call(route, "GET", sess("member1"), { params });
    check(`GET ${name}: a MEMBER → 403 (was any signed-in user)`, is(o, 403), why(o));
    o = await call(route, "GET", sess("viewer"), { params });
    check(`GET ${name}: classes:view → 200`, is(o, 200), why(o));
  }
  delete HANDLERS["event.findMany"];

  // ── 8. Event pay ─────────────────────────────────────────────────────────
  console.log("\nPUT /api/events/[id]/comp — nobody but an owner sets their own event pay");
  const row = (r: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({ id: r.id, payeeType: r.payeeType, userId: r.userId, compMethod: r.compMethod, flatAmount: r.flatAmount, basis: r.basis, notes: r.notes, ...patch });
  resetDb();
  o = await call(EVENT_COMP, "PUT", sess("mgr"), { params: { id: "ev1" }, body: { assignments: [] } });
  check("finances:view is not enough → 403", is(o, 403), why(o));
  o = await call(EVENT_COMP, "PUT", sess("finMgr", { permissions: COACH }), { params: { id: "ev1" }, body: { assignments: COMP_ROWS.map((r) => row(r)) } });
  check("finances:full is read live (stale token said none) — an unchanged save is allowed", is(o, 200), why(o));
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [row(COMP_ROWS[0], { flatAmount: 500 }), row(COMP_ROWS[1])] } });
  check("raising your OWN row → 403", is(o, 403) && o.body?.code === "SELF_PAY_FORBIDDEN", why(o));
  check("…the whole save is refused: nothing written", wrote("eventCompAssignment", "update").length === 0 && wrote("eventCompAssignment", "create").length === 0 && wrote("eventCompAssignment", "deleteMany").length === 0);
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [row(COMP_ROWS[1])] } });
  check("removing your own row → 403", is(o, 403), why(o));
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [row(COMP_ROWS[0]), row(COMP_ROWS[1]), { payeeType: "STAFF", userId: "finMgr", compMethod: "PERCENT", percent: 50, basis: "GROSS_COLLECTED" }] } });
  check("adding a second row for yourself → 403", is(o, 403), why(o));
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [row(COMP_ROWS[0]), row(COMP_ROWS[1], { userId: "finMgr" })] } });
  check("re-pointing someone else's row at yourself → 403", is(o, 403), why(o));
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [row(COMP_ROWS[0], { notes: "" }), row(COMP_ROWS[1], { flatAmount: 120 })] } });
  check("changing ANOTHER coach's row (own row untouched) is allowed", is(o, 200), why(o));
  check("…and that row is updated", wrote("eventCompAssignment", "update").some((c) => c.args.where.id === "comp_a" && c.args.data.flatAmount === 120));
  o = await call(EVENT_COMP, "PUT", sess("owner1"), { params: { id: "ev1" }, body: { assignments: [row(COMP_ROWS[0], { flatAmount: 500 }), row(COMP_ROWS[1])] } });
  check("an owner changes anyone's row, a manager's included", is(o, 200), why(o));
  COMP_ROWS.push({ id: "comp_o", payeeType: "STAFF", userId: "owner1", contractorId: null, payeeName: "owner1 Test", compMethod: "FLAT", flatAmount: 50, percent: null, basis: "GROSS_COLLECTED", notes: null, payoutId: null });
  EVENT_ROSTER.push("owner1");
  o = await call(EVENT_COMP, "PUT", sess("owner1"), { params: { id: "ev1" }, body: { assignments: COMP_ROWS.map((r) => row(r, r.id === "comp_o" ? { flatAmount: 75 } : {})) } });
  check("an owner may set their own (no manager above them)", is(o, 200), why(o));
  resetDb();
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [...COMP_ROWS.map((r) => row(r)), { payeeType: "STAFF", userId: "member1", compMethod: "FLAT", flatAmount: 10, basis: "GROSS_COLLECTED" }] } });
  check("a member's login cannot be a STAFF payee → 400", is(o, 400), why(o));
  o = await call(EVENT_COMP, "PUT", sess("finMgr"), { params: { id: "ev1" }, body: { assignments: [...COMP_ROWS.map((r) => row(r)), { payeeType: "STAFF", userId: "viewer", compMethod: "FLAT", flatAmount: 10, basis: "GROSS_COLLECTED" }] } });
  check("paying someone NOT on the roster would assign them — needs schedule:edit → 403", is(o, 403) && o.body?.code === "ASSIGNMENT_FORBIDDEN" && wrote("eventStaffAssignment", "createMany").length === 0, why(o));

  console.log("\nPOST generate-payouts never pays the caller");
  resetDb();
  o = await call(EVENT_PAYOUTS, "POST", sess("finMgr"), { params: { id: "ev1" } });
  {
    const made = wrote("payout", "create").map((c) => c.args.data.payeeUserId);
    check("a finances:full manager generates the others' payouts", is(o, 200) && o.body.created === 1 && JSON.stringify(made) === JSON.stringify(["coachA"]), `${why(o)} made=${JSON.stringify(made)}`);
    check("…their own row is skipped and reported", o.body?.skippedSelf === 1 && !made.includes("finMgr"));
    check("…and stays unclaimed for an owner to generate", !wrote("eventCompAssignment", "update").some((c) => c.args.where.id === "comp_fin"));
  }
  o = await call(EVENT_PAYOUTS, "POST", sess("owner1"), { params: { id: "ev1" } });
  check("an owner generates every row", is(o, 200) && o.body.created === 2 && o.body.skippedSelf === 0, why(o));
  o = await call(EVENT_PAYOUTS, "POST", sess("mgr"), { params: { id: "ev1" } });
  check("finances:view → 403", is(o, 403) && wrote("payout", "create").length === 0, why(o));

  console.log("\n/api/payouts");
  resetDb();
  const payout = (extra: Record<string, unknown>) => ({ payeeType: "STAFF", kind: "OTHER", amount: 50, ...extra });
  o = await call(PAYOUTS, "POST", sess("finMgr"), { body: payout({ payeeName: "Fin Mgr" }) });
  check("a typed-in payee from a non-owner → 403", is(o, 403) && o.body?.code === "OWNER_REQUIRED" && wrote("payout", "create").length === 0, why(o));
  o = await call(PAYOUTS, "POST", sess("finMgr"), { body: payout({ payeeType: "GUEST", payeeName: "Some Guest" }) });
  check("…for a guest name too → 403", is(o, 403) && wrote("payout", "create").length === 0, why(o));
  o = await call(PAYOUTS, "POST", sess("owner1"), { body: payout({ payeeType: "GUEST", payeeName: "Some Guest" }) });
  check("an owner can record a typed-in payee", is(o, 201), why(o));
  o = await call(PAYOUTS, "POST", sess("finMgr"), { body: payout({ payeeUserId: "finMgr" }) });
  check("a payout to yourself → 403", is(o, 403) && wrote("payout", "create").length === 0, why(o));
  o = await call(PAYOUTS, "POST", sess("finMgr"), { body: payout({ payeeUserId: "coachA" }) });
  check("a payout to another staff member is allowed", is(o, 201), why(o));
  o = await call(PAYOUTS, "POST", sess("finMgr"), { body: payout({ payeeUserId: "member1" }) });
  check("a member's login cannot be a payee → 400", is(o, 400), why(o));
  PAYOUT = { id: "po1", clubId: "club_1", payeeUserId: "coachA", contractorId: null, payeeName: "coachA Test", payeeType: "STAFF", amount: 80, status: "PAID", method: "CASH", paidAt: new Date("2026-10-01"), kind: "EVENT", eventId: "ev1" };
  o = await call(PAYOUT_ID, "PATCH", sess("finMgr"), { params: { id: "po1" }, body: { amount: 800 } });
  check("editing a PAID payout writes an audit entry", is(o, 200) && wrote("billingAuditLog", "create")[0]?.args.data.action === "PAYOUT_PAID_EDITED", why(o));
  o = await call(PAYOUT_ID, "DELETE", sess("finMgr"), { params: { id: "po1" } });
  check("deleting a PAID payout writes an audit entry", is(o, 200) && wrote("billingAuditLog", "create")[0]?.args.data.action === "PAYOUT_PAID_DELETED", why(o));
  PAYOUT = { ...PAYOUT, status: "PENDING" };
  o = await call(PAYOUT_ID, "PATCH", sess("finMgr"), { params: { id: "po1" }, body: { notes: "x" } });
  check("a PENDING row is edited without an audit entry (unchanged behaviour)", is(o, 200) && wrote("billingAuditLog", "create").length === 0, why(o));
  PAYOUT = { ...PAYOUT, payeeUserId: null, payeeName: "Typed Name" };
  o = await call(PAYOUT_ID, "PATCH", sess("finMgr"), { params: { id: "po1" }, body: { amount: 9 } });
  check("a typed-in-payee row cannot be edited by a non-owner → 403", is(o, 403) && wrote("payout", "update").length === 0, why(o));
  o = await call(PAYOUT_ID, "DELETE", sess("finMgr"), { params: { id: "po1" } });
  check("…or deleted → 403", is(o, 403) && wrote("payout", "delete").length === 0, why(o));
  PAYOUT = { ...PAYOUT, payeeUserId: "finMgr" };
  o = await call(PAYOUT_ID, "PATCH", sess("finMgr"), { params: { id: "po1" }, body: { amount: 9 } });
  check("your own payout row cannot be edited → 403", is(o, 403), why(o));

  // ── 9. The other role-only handlers the new guard found ──────────────────
  console.log("\nthe handlers that were role-only behind a guarded sibling");
  resetDb();
  o = await call(MEMBER_ID, "PATCH", sess("viewer"), { params: { id: "m1" }, body: {} });
  check("members/[id] PATCH: members:view → 403 (needs members:edit)", is(o, 403), why(o));
  o = await call(MEMBERSHIP_ID, "PATCH", sess("coachA"), { params: { id: "ms1" }, body: {} });
  check("memberships/[id] PATCH: finances:none → 403 (needs finances:edit)", is(o, 403), why(o));
  o = await call(PRODUCT_ID, "PATCH", sess("coachA"), { params: { id: "p1" }, body: {} });
  check("products/[id] PATCH: finances:none → 403 (needs finances:edit)", is(o, 403), why(o));
  o = await call(EXPENSES, "POST", sess("mgr"), { body: {} });
  check("expenses POST: finances:view → 403 (needs finances:full, live)", is(o, 403), why(o));
  USERS.noSched.staffProfile!.permissions = { ...COACH, messages: "none" };
  o = await call(GROUP_ID, "POST", sess("noSched"), { params: { id: "g1" }, body: { body: "hi" } });
  check("messages/groups/[id] POST: messages:none → 403 (needs messages:send)", is(o, 403), why(o));
  o = await call(GROUP_ID, "POST", sess("coachA"), { params: { id: "g1" }, body: { body: "hi" } });
  check("…messages:send gets past the guard (404: no such group here)", is(o, 404), why(o));
  o = await call(MEMBER_ID, "PATCH", sess("member1"), { params: { id: "m1" }, body: {} });
  check("members/[id] PATCH: a MEMBER → 403", is(o, 403), why(o));

  // ── 10. The boundary guard, on fixtures ──────────────────────────────────
  console.log("\npermission-boundary-guard judges each handler on its own");
  {
    const { analyzeRouteSource, scanTree, APPROVED_INLINE } = require("./permission-boundary-guard.ts") as typeof import("./permission-boundary-guard");
    const kinds = (src: string) => Object.fromEntries(analyzeRouteSource(src).map((h) => [h.verb, h.kind]));
    const head = `import { requirePermission } from "@/lib/apiGuard";\n`;
    const guardedGet = `export async function GET() {\n  const session = await getServerSession(authOptions);\n  const denied = requirePermission(session, "classes", "view");\n  if (denied) return denied;\n  return x;\n}\n`;
    const roleOnlyPatch = `export async function PATCH(req: Request) {\n  const session = await getServerSession(authOptions);\n  if (!["OWNER", "STAFF"].includes(session.user.role)) return forbidden;\n  return prisma.thing.update({});\n}\n`;
    let k = kinds(head + guardedGet + roleOnlyPatch);
    check("a file where only GET is guarded and PATCH is role-only FAILS (this is the classes/[id] hole)", k.PATCH === "anyStaff");
    k = kinds(head + roleOnlyPatch + `export async function DELETE() {\n  const denied = requirePermission(session, "classes", "full");\n  if (denied) return denied;\n}\n`);
    check("a guarded DELETE does not cover the PATCH above it", k.PATCH === "anyStaff" && k.DELETE === "guarded");
    k = kinds(`export async function POST(req: Request) {\n  const session = await getServerSession(authOptions);\n  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) return no;\n  return ok;\n}\n`);
    check("the `role !== OWNER && role !== STAFF` form is caught", k.POST === "anyStaff");
    k = kinds(`export async function POST() {\n  const session = await getServerSession(authOptions);\n  if (!session) return no;\n  return prisma.x.create({});\n}\n`);
    check("a session-only mutating handler is caught", k.POST === "noRoleCheck");
    k = kinds(`export async function POST() {\n  if (!session || session.user.role !== "OWNER") return no;\n  return ok;\n}\n`);
    check("owner-only is recognised (stronger than a permission)", k.POST === "ownerOnly");
    k = kinds(`export async function PATCH() {\n  const denied = await requirePermissionLive(session, "finances", "full");\n  if (denied) return denied;\n}\n`);
    check("requirePermissionLive counts", k.PATCH === "guarded");
    k = kinds(`export async function PUT() {\n  const denied = await requireOwnerLive(session);\n  if (denied) return denied;\n}\n`);
    check("requireOwnerLive counts", k.PUT === "guarded");
    k = kinds(`async function authorize(session: S, id: string) {\n  return requirePermissionLive(session, "schedule", "edit");\n}\n\nexport async function POST() {\n  const denied = await authorize(session, id);\n  if (denied) return denied;\n}\n\nexport async function DELETE() {\n  if (session.user.role === "STAFF") return go();\n}\n`);
    check("a guard inside a same-file helper counts for the handler that CALLS it — and only that one", k.POST === "guarded" && k.DELETE === "anyStaff");
    k = kinds(`export async function PATCH() {\n  // requirePermission(session, "classes", "edit") — TODO\n  if (["OWNER", "STAFF"].includes(role)) return go();\n}\n`);
    check("a guard that only appears in a comment does not count", k.PATCH === "anyStaff");
    k = kinds(guardedGet);
    check("GET handlers are not judged by this guard", Object.keys(k).length === 0);

    const tree = scanTree();
    check("the real tree: zero handlers admit any staff", tree.anyStaff.length === 0, JSON.stringify(tree.anyStaff));
    check("the real tree: zero session-only mutating handlers outside the approved list", tree.noRoleCheck.length === 0, JSON.stringify(tree.noRoleCheck));
    check("the approved-inline list is exactly the one documented exception", JSON.stringify(Object.keys(APPROVED_INLINE)) === JSON.stringify(["app/api/messages/dm/[userId]/route.ts#POST"]));
    check("the guard looked at a real number of handlers", tree.handlers > 200, String(tree.handlers));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
