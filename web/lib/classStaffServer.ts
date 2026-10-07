// Class coach assignments, coverage and cancellation — the DATABASE half.
// Pure rules live in lib/classStaff.ts (read its header first). Stage 1 of
// "Assignments, Coverage, Cancellation": the API routes, notifications and
// Action Items are built ON these functions and must not re-implement them.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────
// Conventions
//   • `db` is a Prisma client OR a transaction client. Every function that
//     writes takes it FIRST and never opens its own transaction (runSwitchOn is
//     the one exception) — wrap a call in prisma.$transaction when the route
//     needs it atomic with its own writes. Nothing here catches a database
//     error: inside a transaction there is no error you can ignore.
//   • Nothing here checks PERMISSIONS or sends NOTIFICATIONS. The route decides
//     who may call (schedule:edit, the coach themself, finances:full for pay)
//     and what to send, using the before/after each function returns.
//   • Failures a caller should turn into a 4xx throw ClassStaffError(code).
//   • Day operations only work on class days on/after the club's switch-on
//     date (else ClassStaffError NOT_SWITCHED_ON — use the legacy path).
//   • RecurringClass.assignedStaffIds is FROZEN once a club is switched on
//     (stage 2 decision, 2026-10-08): nothing here writes it. It stays the
//     legacy record of who coached the class BEFORE the switch-on date, so a
//     post-switch rule change can never rewrite who appears on a pre-switch
//     day. The series-level "this class's coaches" for a switched-on club is
//     the RULES (lib/classStaff.currentRuleStaff).
//   • Every day operation and every rule change still keeps the PER-DAY legacy
//     mirror in step: ClassSession.staffOverride = legacyOverrideFor(SCHEDULED
//     coaches, the frozen list), for class days on/after the switch-on date
//     only — so a legacy reader's effectiveClassStaff(assignedStaffIds,
//     staffOverride) is still exactly the SCHEDULED set on every such day.
//
// Settings
//   getScheduleSettings(clubId, db?)                 defaults when no row
//   coverageRecipients(clubId, sessionId, excludingUserId, db?)
// Readers (switch-aware seam — every existing reader goes through this)
//   loadSessionStaffResolver(clubId, sessions, opts?, db?) → StaffResolver
// Rules + materialization
//   loadClassRules(db, classIds)
//   syncSessionStaff(db, classId, fromDate?, opts?)   rules → rows, + legacy mirror
//   applyScopeChange(db, {...})                       the 3-scope coach edit, end to end
//   endUserRules(db, {...})                           one coach off the recurring list
//   addUserRule(db, {...})                            one coach ON the recurring list (every class day)
//   applySeriesListChange(db, {...})                  a legacy "series coach list" save → the two above
//   initClassStaffFromLegacy(db, classId, opts?)      a class created after switch-on
//   ensureSession(classId, dateYmd, db?)              get-or-create one class day
// Day operations (each returns DayOpResult with before/after rows)
//   setDayStaff / addDayStaff / removeDayStaff
//   callOut / callOutRange / cancelCoverageRequest / fillCoverage / closeCoverage
//   markNoShow / clearNoShow
// Cancellation
//   cancelOccurrence / uncancelOccurrence / setCancelPaid / recordCancelNotified
//   cancelAudienceMembers(clubId, sessionId, audience, db?)
// Conflicts (warnings)
//   loadStaffConflicts({...}, db?) / conflictsForRuleChange({...}, db?)
// Switch-on
//   runSwitchOn({clubId, date, apply})                scripts/switch-on-class-assignments.ts
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asIdList, classTimesForDay, hhmmUTC } from "@/lib/staffAssignments";
import { classHasStarted, wallClockUTCToInstant } from "@/lib/datetime";
import { hasPermission } from "@/lib/permissions";
import { validScheduleStaffIds } from "@/lib/staffAssignmentsServer";
import { coverageForMembers, loadSessionCoverageContext } from "@/lib/coverageQuery";
import { resolveRecipients } from "@/lib/emailRecipients";
import {
  REMOVED_STAFF_REASON,
  SUBSTITUTE_ROLE_NAME,
  addDaysYmd,
  classHasEnded,
  classStartInstant,
  clubTodayYmd,
  coachingUserIds,
  dowOfYmd,
  findStaffConflicts,
  groupRecipientsByEmail,
  instantToWallClock,
  isLateCallout,
  isSwitchedOn,
  isYmd,
  legacyOverrideFor,
  makeStaffResolver,
  maxYmd,
  mergeAudience,
  normalizeRoleName,
  normalizeScheduleSettings,
  pickCoverageRecipients,
  planDayEdit,
  planDayStaff,
  planEndUserRules,
  planScopeChange,
  planSwitchOn,
  proposedSlot,
  ruleInForce,
  ruleOccurrenceSlots,
  rulesForDay,
  summarizeConflicts,
  toYmd,
  ymdToDate,
  type AudienceRecipient,
  type BusySlot,
  type CancelAudience,
  type ChangeScope,
  type DayOp,
  type DayStaffRow,
  type DesiredStaff,
  type ProposedSlot,
  type RuleOp,
  type RuleStaff,
  type ScheduleSettings,
  type StaffConflict,
  type StaffKind,
  type StaffResolver,
  type StaffRule,
  type StaffSource,
  type StaffStatus,
  type SwitchOnPlan,
} from "@/lib/classStaff";

/** A Prisma client or a transaction client. */
export type Db = Prisma.TransactionClient;

export type ClassStaffErrorCode =
  | "NOT_FOUND"          // no such class / class day / staff row in this club
  | "NOT_SWITCHED_ON"    // the class day is before the club's switch-on date (or the club is not switched on)
  | "INVALID_STAFF"      // an id that is not a current OWNER/STAFF of this club
  | "NOT_ON_DAY"         // that person has no row on the class day
  | "BAD_STATE"          // the row / day is not in a state this action applies to
  | "ALREADY_ON_DAY"     // the proposed substitute is already coaching that day
  | "DAY_ENDED"          // the class day is over
  | "BAD_INPUT";

export class ClassStaffError extends Error {
  code: ClassStaffErrorCode;
  constructor(code: ClassStaffErrorCode, message: string) {
    super(message);
    this.name = "ClassStaffError";
    this.code = code;
  }
}

// ── Row shapes ──────────────────────────────────────────────────────────────

const ROW_SELECT = {
  id: true, sessionId: true, userId: true, roleName: true, kind: true, status: true, source: true,
  ruleId: true, replacesStaffId: true, lateCallout: true, calledOutAt: true, calledOutByUserId: true,
  calloutReason: true, coverageFilledAt: true, coverageFilledByUserId: true, note: true,
} satisfies Prisma.ClassSessionStaffSelect;
const ROW_ORDER: Prisma.ClassSessionStaffOrderByWithRelationInput[] = [{ createdAt: "asc" }, { id: "asc" }];
type DbRow = Prisma.ClassSessionStaffGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(r: DbRow): DayStaffRow {
  return { ...r, kind: r.kind as StaffKind, status: r.status as StaffStatus, source: r.source as StaffSource };
}

const RULE_SELECT = {
  id: true, classId: true, userId: true, roleName: true, dayOfWeek: true, effectiveFrom: true, effectiveTo: true,
} satisfies Prisma.ClassStaffRuleSelect;
const RULE_ORDER: Prisma.ClassStaffRuleOrderByWithRelationInput[] = [{ createdAt: "asc" }, { id: "asc" }];
type DbRule = Prisma.ClassStaffRuleGetPayload<{ select: typeof RULE_SELECT }>;

function toRule(r: DbRule): StaffRule {
  return { ...r, effectiveFrom: toYmd(r.effectiveFrom), effectiveTo: r.effectiveTo ? toYmd(r.effectiveTo) : null };
}

/** A class's (or several classes') recurring rules, oldest first. */
export async function loadClassRules(db: Db, classIds: string | string[]): Promise<StaffRule[]> {
  const ids = Array.isArray(classIds) ? classIds : [classIds];
  if (ids.length === 0) return [];
  const rows = await db.classStaffRule.findMany({ where: { classId: { in: ids } }, select: RULE_SELECT, orderBy: RULE_ORDER });
  return rows.map(toRule);
}

// ── Settings ────────────────────────────────────────────────────────────────

/** The club's schedule settings; the defaults when it has no row yet. */
export async function getScheduleSettings(clubId: string, db: Db = prisma): Promise<ScheduleSettings> {
  const row = await db.clubScheduleSettings.findUnique({ where: { clubId } });
  return normalizeScheduleSettings(row as Record<string, unknown> | null);
}

// ── The reader seam ─────────────────────────────────────────────────────────

/**
 * One switch-aware resolver for a batch of class sessions — what every reader
 * of "who coaches this class day" uses (staff schedule, calendar, member
 * schedule + portal, payroll).
 *
 * Queries: the settings row, always. Only when the club is switched on AND
 * some session is on/after the switch-on date: the club timezone and those
 * sessions' rows (one query, no N+1). `classIds` additionally loads those
 * classes' rules, for callers that also show days with no session row yet
 * (resolver.forOccurrence).
 */
export async function loadSessionStaffResolver(
  clubId: string,
  sessions: readonly { id: string; date: Date | string }[],
  opts: { classIds?: readonly string[] } = {},
  db: Db = prisma,
): Promise<StaffResolver> {
  const settings = await getScheduleSettings(clubId, db);
  const startOn = settings.assignmentsStartOn;
  if (!startOn) return makeStaffResolver({ assignmentsStartOn: null });
  const ids = sessions.filter((s) => isSwitchedOn(startOn, toYmd(s.date))).map((s) => s.id);
  const classIds = Array.from(new Set(opts.classIds ?? []));
  if (ids.length === 0 && classIds.length === 0) return makeStaffResolver({ assignmentsStartOn: startOn });
  const [club, rows, rules] = await Promise.all([
    db.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
    ids.length
      ? db.classSessionStaff.findMany({ where: { clubId, sessionId: { in: ids } }, select: ROW_SELECT, orderBy: ROW_ORDER })
      : Promise.resolve([] as DbRow[]),
    classIds.length ? loadClassRules(db, classIds) : Promise.resolve([] as StaffRule[]),
  ]);
  return makeStaffResolver({ assignmentsStartOn: startOn, timezone: club?.timezone ?? null, rows: rows.map(toRow), rules });
}

// ── Materialization: rules → rows, and the legacy mirror ────────────────────

export type StaffSyncResult = {
  /** false = the club is not switched on (or the class is gone): nothing was read further or written. */
  switchedOn: boolean;
  /** First class day considered for regeneration. */
  from: string | null;
  sessionsChecked: number;
  created: number;
  updated: number;
  deleted: number;
  /** RecurringClass.assignedStaffIds — the FROZEN legacy list (never written here). */
  seriesStaffIds: string[];
  /** Always false since the list was frozen (kept so callers' shapes do not change). */
  seriesChanged: boolean;
  /** How many class days had ClassSession.staffOverride rewritten. */
  overridesWritten: number;
};

const NO_SYNC: StaffSyncResult = {
  switchedOn: false, from: null, sessionsChecked: 0, created: 0, updated: 0, deleted: 0,
  seriesStaffIds: [], seriesChanged: false, overridesWritten: 0,
};

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Bring one class's staff rows in line with its rules, then refresh the legacy
 * mirror. Idempotent — safe to call after any rule change, any session
 * creation or move, and nightly.
 *
 *   Rows: for class days with date >= max(fromDate, today, switch-on date)
 *   that are not staffManual and have not ended — insert missing RULE rows,
 *   re-point/re-role rule-managed rows, delete rule-managed rows the rules no
 *   longer imply. NEEDS_COVERAGE / REPLACED / NO_SHOW / REMOVED rows,
 *   SUBSTITUTEs and MANUAL rows are never touched (lib/classStaff.planDayStaff).
 *
 *   Legacy mirror: ClassSession.staffOverride = legacyOverrideFor(SCHEDULED
 *   coaches, the FROZEN RecurringClass.assignedStaffIds) for EVERY class day
 *   on/after the switch-on date (ended days included — only that mirror column
 *   is rewritten on them, never their rows). assignedStaffIds itself is never
 *   written: it is the legacy record for the days before the switch-on date.
 *
 * No-op (one class read + the settings read) when the club is not switched on.
 */
export async function syncSessionStaff(
  db: Db,
  classId: string,
  fromDate?: string | null,
  opts: { now?: Date } = {},
): Promise<StaffSyncResult> {
  const now = opts.now ?? new Date();
  const cls = await db.recurringClass.findUnique({
    where: { id: classId },
    select: { id: true, clubId: true, assignedStaffIds: true, club: { select: { timezone: true } } },
  });
  if (!cls) return { ...NO_SYNC };
  const settings = await getScheduleSettings(cls.clubId, db);
  const startOn = settings.assignmentsStartOn;
  if (!startOn) return { ...NO_SYNC };
  const tz = cls.club?.timezone ?? null;
  const today = clubTodayYmd(tz, now);
  const from = maxYmd(fromDate ?? null, today, startOn);

  const [rules, sessions] = await Promise.all([
    loadClassRules(db, classId),
    db.classSession.findMany({
      where: { classId, date: { gte: ymdToDate(startOn) } },
      select: {
        id: true, date: true, endsAt: true, staffManual: true, staffOverride: true,
        staff: { select: ROW_SELECT, orderBy: ROW_ORDER },
      },
      orderBy: { date: "asc" },
    }),
  ]);

  const creates: Prisma.ClassSessionStaffCreateManyInput[] = [];
  const deleteIds: string[] = [];
  const closeLeftIds: string[] = [];
  const updateGroups = new Map<string, { ruleId: string; roleName: string | null; ids: string[] }>();
  const scheduledBySession = new Map<string, string[]>();
  let checked = 0;
  let updated = 0;

  for (const s of sessions) {
    const dateYmd = toYmd(s.date);
    const rows = s.staff.map(toRow);
    let scheduled = coachingUserIds(rows);
    if (dateYmd >= from) {
      checked++;
      const plan = planDayStaff({
        session: { dateYmd, staffManual: s.staffManual, ended: classHasEnded(s.endsAt, tz, now) },
        rules,
        existingRows: rows,
      });
      for (const c of plan.create) {
        creates.push({
          clubId: cls.clubId, sessionId: s.id, userId: c.userId, roleName: c.roleName,
          kind: "REGULAR", status: "SCHEDULED", source: "RULE", ruleId: c.ruleId,
        });
      }
      for (const u of plan.update) {
        const key = `${u.ruleId}|${u.roleName ?? ""}|${u.roleName === null ? "n" : "s"}`;
        const g = updateGroups.get(key);
        if (g) g.ids.push(u.id);
        else updateGroups.set(key, { ruleId: u.ruleId, roleName: u.roleName, ids: [u.id] });
        updated++;
      }
      deleteIds.push(...plan.deleteIds);
      // A new recurring coach on a day that a removed staff member left open
      // settles that opening (one per new coach) — see releaseRemovedStaff.
      if (plan.create.length > 0) {
        const left = rows.filter((r) => r.status === "NEEDS_COVERAGE" && r.calloutReason === REMOVED_STAFF_REASON);
        closeLeftIds.push(...left.slice(0, plan.create.length).map((r) => r.id));
      }
      const gone = new Set(plan.deleteIds);
      scheduled = coachingUserIds(rows.filter((r) => !gone.has(r.id)));
      for (const c of plan.create) if (!scheduled.includes(c.userId)) scheduled.push(c.userId);
    }
    scheduledBySession.set(s.id, scheduled);
  }

  if (deleteIds.length > 0) await db.classSessionStaff.deleteMany({ where: { id: { in: deleteIds } } });
  for (const g of updateGroups.values()) {
    await db.classSessionStaff.updateMany({ where: { id: { in: g.ids } }, data: { ruleId: g.ruleId, roleName: g.roleName } });
  }
  if (creates.length > 0) await db.classSessionStaff.createMany({ data: creates, skipDuplicates: true });
  if (closeLeftIds.length > 0) {
    await db.classSessionStaff.updateMany({
      where: { id: { in: closeLeftIds }, status: "NEEDS_COVERAGE" },
      data: { status: "REMOVED", note: "A new recurring coach was assigned" },
    });
  }

  // Legacy mirror — per day only. The series list is frozen (see the header).
  const series = asIdList(cls.assignedStaffIds);
  const seriesChanged = false;
  const overrideGroups = new Map<string, { value: string[] | null; ids: string[] }>();
  for (const s of sessions) {
    const target = legacyOverrideFor(scheduledBySession.get(s.id) ?? [], series);
    const current = Array.isArray(s.staffOverride) ? asIdList(s.staffOverride) : null;
    const same = target === null ? current === null : current !== null && sameList(current, target);
    if (same) continue;
    const key = JSON.stringify(target);
    const g = overrideGroups.get(key);
    if (g) g.ids.push(s.id);
    else overrideGroups.set(key, { value: target, ids: [s.id] });
  }
  let overridesWritten = 0;
  for (const g of overrideGroups.values()) {
    await db.classSession.updateMany({
      where: { id: { in: g.ids } },
      data: { staffOverride: g.value === null ? Prisma.DbNull : g.value },
    });
    overridesWritten += g.ids.length;
  }

  return {
    switchedOn: true, from, sessionsChecked: checked, created: creates.length, updated, deleted: deleteIds.length,
    seriesStaffIds: series, seriesChanged, overridesWritten,
  };
}

async function applyRuleOpsDb(db: Db, clubId: string, classId: string, ops: readonly RuleOp[], byUserId: string | null): Promise<void> {
  const del = ops.filter((o): o is Extract<RuleOp, { op: "delete" }> => o.op === "delete").map((o) => o.ruleId);
  if (del.length > 0) await db.classStaffRule.deleteMany({ where: { id: { in: del }, classId } });
  for (const o of ops) {
    if (o.op === "end") {
      await db.classStaffRule.updateMany({ where: { id: o.ruleId, classId }, data: { effectiveTo: ymdToDate(o.effectiveTo) } });
    }
  }
  const create = ops.filter((o): o is Extract<RuleOp, { op: "create" }> => o.op === "create");
  if (create.length > 0) {
    await db.classStaffRule.createMany({
      data: create.map((o) => ({
        clubId, classId, userId: o.userId, roleName: o.roleName, dayOfWeek: o.dayOfWeek,
        effectiveFrom: ymdToDate(o.effectiveFrom), effectiveTo: o.effectiveTo ? ymdToDate(o.effectiveTo) : null,
        createdByUserId: byUserId,
      })),
    });
  }
}

async function requireValidStaff(clubId: string, userIds: readonly string[]): Promise<void> {
  const ids = Array.from(new Set(userIds));
  if (ids.length === 0) return;
  const ok = new Set(await validScheduleStaffIds(clubId, ids));
  const bad = ids.filter((id) => !ok.has(id));
  if (bad.length > 0) throw new ClassStaffError("INVALID_STAFF", `Not a current staff member of this club: ${bad.join(", ")}`);
}

/**
 * Get-or-create the ClassSession for one class day — THE way to materialize a
 * day (it replaces the occurrence route's inline create, which stamped the
 * class's DEFAULT time on a weekday that has its own time).
 *   - times = the series time for THAT weekday (dayOverrides honoured)
 *   - race-safe and idempotent: createMany skipDuplicates on (classId, date)
 *   - when the club is switched on and the day is on/after the switch-on date,
 *     the new day gets its rule rows
 * Does not check that the class runs on that weekday (a one-off day is
 * allowed, as before). Throws NOT_FOUND for an unknown or deleted class.
 */
export async function ensureSession(
  classId: string,
  dateYmd: string,
  db: Db = prisma,
): Promise<{ session: { id: string; classId: string; clubId: string; date: Date; startsAt: Date; endsAt: Date; canceled: boolean }; created: boolean }> {
  if (!isYmd(dateYmd)) throw new ClassStaffError("BAD_INPUT", "date must be YYYY-MM-DD");
  const date = ymdToDate(dateYmd);
  const pick = { id: true, classId: true, clubId: true, date: true, startsAt: true, endsAt: true, canceled: true } as const;
  const existing = await db.classSession.findUnique({ where: { classId_date: { classId, date } }, select: pick });
  if (existing) return { session: existing, created: false };
  const cls = await db.recurringClass.findFirst({
    where: { id: classId, deletedAt: null },
    select: { id: true, clubId: true, startTime: true, endTime: true, dayOverrides: true },
  });
  if (!cls) throw new ClassStaffError("NOT_FOUND", "Class not found");
  const t = classTimesForDay(cls.startTime, cls.endTime, cls.dayOverrides, dowOfYmd(dateYmd));
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(date.getTime() + ((h || 0) * 60 + (m || 0)) * 60000);
  };
  const made = await db.classSession.createMany({
    data: [{ classId, clubId: cls.clubId, date, startsAt: at(t.startTime), endsAt: at(t.endTime), canceled: false }],
    skipDuplicates: true,
  });
  const session = await db.classSession.findUnique({ where: { classId_date: { classId, date } }, select: pick });
  if (!session) throw new ClassStaffError("NOT_FOUND", "Class day could not be created");
  if (made.count > 0) await syncSessionStaff(db, classId, dateYmd);
  return { session, created: made.count > 0 };
}

/**
 * A class created AFTER the club switched on: turn the coaches it was created
 * with (RecurringClass.assignedStaffIds) into all-days rules from today (never
 * before the switch-on date), then materialize its days. No-op when the club
 * is not switched on or the class already has rules.
 */
export async function initClassStaffFromLegacy(
  db: Db,
  classId: string,
  opts: { byUserId?: string | null; now?: Date } = {},
): Promise<StaffSyncResult> {
  const now = opts.now ?? new Date();
  const cls = await db.recurringClass.findUnique({
    where: { id: classId },
    select: { id: true, clubId: true, assignedStaffIds: true, club: { select: { timezone: true } } },
  });
  if (!cls) return { ...NO_SYNC };
  const settings = await getScheduleSettings(cls.clubId, db);
  if (!settings.assignmentsStartOn) return { ...NO_SYNC };
  const has = await db.classStaffRule.count({ where: { classId } });
  if (has === 0) {
    const ids = await validScheduleStaffIds(cls.clubId, asIdList(cls.assignedStaffIds));
    const from = maxYmd(settings.assignmentsStartOn, clubTodayYmd(cls.club?.timezone ?? null, now));
    if (ids.length > 0) {
      await db.classStaffRule.createMany({
        data: ids.map((userId) => ({
          clubId: cls.clubId, classId, userId, roleName: null, dayOfWeek: null,
          effectiveFrom: ymdToDate(from), createdByUserId: opts.byUserId ?? null,
        })),
      });
    }
  }
  return syncSessionStaff(db, classId, null, { now });
}

// ── Day operations ──────────────────────────────────────────────────────────

type Day = {
  sessionId: string;
  classId: string;
  clubId: string;
  className: string;
  dateYmd: string;
  startsAt: Date;
  endsAt: Date;
  canceled: boolean;
  staffManual: boolean;
  staffOverride: unknown;
  seriesStaffIds: string[];
  timezone: string | null;
  rows: DayStaffRow[];
};

export type DayOpResult = {
  sessionId: string;
  classId: string;
  className: string;
  /** YYYY-MM-DD */
  date: string;
  /** Wall-clock-UTC stamps, as stored. */
  startsAt: Date;
  endsAt: Date;
  timezone: string | null;
  /** Every row on the day before / after, any status — for the audit entry. */
  before: DayStaffRow[];
  after: DayStaffRow[];
  /** Who was coaching (SCHEDULED) before / after — for notifications. */
  coachingBefore: string[];
  coachingAfter: string[];
  changed: boolean;
};

async function loadDay(db: Db, clubId: string, sessionId: string): Promise<Day> {
  const s = await db.classSession.findFirst({
    where: { id: sessionId, clubId },
    select: {
      id: true, classId: true, clubId: true, date: true, startsAt: true, endsAt: true, canceled: true,
      staffManual: true, staffOverride: true,
      recurringClass: { select: { name: true, assignedStaffIds: true } },
      club: { select: { timezone: true } },
      staff: { select: ROW_SELECT, orderBy: ROW_ORDER },
    },
  });
  if (!s) throw new ClassStaffError("NOT_FOUND", "Class day not found");
  const settings = await getScheduleSettings(clubId, db);
  const dateYmd = toYmd(s.date);
  if (!isSwitchedOn(settings.assignmentsStartOn, dateYmd)) {
    throw new ClassStaffError("NOT_SWITCHED_ON", "This class day is before the assignment start date");
  }
  return {
    sessionId: s.id, classId: s.classId, clubId: s.clubId, className: s.recurringClass.name, dateYmd,
    startsAt: s.startsAt, endsAt: s.endsAt, canceled: s.canceled, staffManual: s.staffManual,
    staffOverride: s.staffOverride, seriesStaffIds: asIdList(s.recurringClass.assignedStaffIds),
    timezone: s.club?.timezone ?? null, rows: s.staff.map(toRow),
  };
}

async function loadDayByRow(db: Db, clubId: string, staffRowId: string): Promise<{ day: Day; row: DayStaffRow }> {
  const hit = await db.classSessionStaff.findFirst({ where: { id: staffRowId, clubId }, select: { sessionId: true } });
  if (!hit) throw new ClassStaffError("NOT_FOUND", "Assignment not found");
  const day = await loadDay(db, clubId, hit.sessionId);
  const row = day.rows.find((r) => r.id === staffRowId);
  if (!row) throw new ClassStaffError("NOT_FOUND", "Assignment not found");
  return { day, row };
}

/** Re-read the rows, refresh that day's legacy mirror (and staffManual when asked), build the result. */
async function finishDay(db: Db, day: Day, opts: { manual: boolean }): Promise<DayOpResult> {
  const after = (
    await db.classSessionStaff.findMany({ where: { sessionId: day.sessionId }, select: ROW_SELECT, orderBy: ROW_ORDER })
  ).map(toRow);
  const coachingAfter = coachingUserIds(after);
  const target = legacyOverrideFor(coachingAfter, day.seriesStaffIds);
  const current = Array.isArray(day.staffOverride) ? asIdList(day.staffOverride) : null;
  const mirrorSame = target === null ? current === null : current !== null && sameList(current, target);
  const setManual = opts.manual && !day.staffManual;
  if (!mirrorSame || setManual) {
    await db.classSession.update({
      where: { id: day.sessionId },
      data: {
        ...(setManual ? { staffManual: true } : {}),
        ...(mirrorSame ? {} : { staffOverride: target === null ? Prisma.DbNull : target }),
      },
    });
  }
  return {
    sessionId: day.sessionId, classId: day.classId, className: day.className, date: day.dateYmd,
    startsAt: day.startsAt, endsAt: day.endsAt, timezone: day.timezone,
    before: day.rows, after,
    coachingBefore: coachingUserIds(day.rows), coachingAfter,
    changed: JSON.stringify(day.rows) !== JSON.stringify(after),
  };
}

const CLEAR_CALLOUT = {
  calledOutAt: null, calledOutByUserId: null, calloutReason: null, lateCallout: false,
  coverageFilledAt: null, coverageFilledByUserId: null,
} as const;

async function applyDayOps(db: Db, day: Day, ops: readonly DayOp[], byUserId: string | null): Promise<void> {
  for (const op of ops) {
    if (op.op === "create") {
      await db.classSessionStaff.create({
        data: {
          clubId: day.clubId, sessionId: day.sessionId, userId: op.userId, roleName: op.roleName,
          kind: "REGULAR", status: "SCHEDULED", source: "MANUAL", changedByUserId: byUserId,
        },
      });
    } else if (op.op === "restore") {
      await db.classSessionStaff.update({
        where: { id: op.rowId },
        data: { status: "SCHEDULED", kind: "REGULAR", source: "MANUAL", replacesStaffId: null, roleName: op.roleName, ...CLEAR_CALLOUT, changedByUserId: byUserId },
      });
    } else if (op.op === "role") {
      await db.classSessionStaff.update({ where: { id: op.rowId }, data: { roleName: op.roleName, source: "MANUAL", changedByUserId: byUserId } });
    } else if (op.op === "remove") {
      await db.classSessionStaff.update({ where: { id: op.rowId }, data: { status: "REMOVED", source: "MANUAL", changedByUserId: byUserId } });
    } else {
      await db.classSessionStaff.update({
        where: { id: op.rowId },
        data: { status: "NEEDS_COVERAGE", coverageFilledAt: null, coverageFilledByUserId: null, changedByUserId: byUserId },
      });
    }
  }
}

async function editDay(db: Db, day: Day, desired: readonly DesiredStaff[], byUserId: string | null): Promise<DayOpResult & { dayOps: DayOp[] }> {
  const ops = planDayEdit(day.rows, desired);
  await requireValidStaff(day.clubId, ops.filter((o) => o.op === "create" || o.op === "restore").map((o) => o.userId));
  await applyDayOps(db, day, ops, byUserId);
  // A hand edit that changed something makes this a manual day; a no-op does not.
  const res = await finishDay(db, day, { manual: ops.length > 0 });
  return { ...res, dayOps: ops };
}

/**
 * Make one class day's coaches exactly `staff` ("this occurrence only").
 * People taken off become REMOVED (kept as the record), people put back are
 * restored, new people get a MANUAL row. Coaches waiting for cover who are not
 * in the list are left waiting. Flags the day staffManual so rules never
 * refill it. Ids being added must be current OWNER/STAFF (INVALID_STAFF).
 */
export async function setDayStaff(
  db: Db,
  args: { clubId: string; sessionId: string; staff: readonly DesiredStaff[]; byUserId: string | null },
): Promise<DayOpResult & { dayOps: DayOp[] }> {
  const day = await loadDay(db, args.clubId, args.sessionId);
  return editDay(db, day, args.staff, args.byUserId);
}

/** Put one person on one class day (keeps everyone else). Idempotent. */
export async function addDayStaff(
  db: Db,
  args: { clubId: string; sessionId: string; userId: string; roleName?: string | null; byUserId: string | null },
): Promise<DayOpResult & { dayOps: DayOp[] }> {
  const day = await loadDay(db, args.clubId, args.sessionId);
  const current: DesiredStaff[] = day.rows.filter((r) => r.status === "SCHEDULED" && r.userId !== args.userId).map((r) => ({ userId: r.userId }));
  const me: DesiredStaff = args.roleName === undefined ? { userId: args.userId } : { userId: args.userId, roleName: args.roleName };
  return editDay(db, day, [...current, me], args.byUserId);
}

/**
 * Take one person off one class day (status REMOVED). Used for a manager's
 * edit AND for a coach taking themself off — the route decides which is
 * allowed and who is told. If they were a substitute, the coach they covered
 * goes back to NEEDS_COVERAGE. NOT_ON_DAY when they are not coaching it.
 */
export async function removeDayStaff(
  db: Db,
  args: { clubId: string; sessionId: string; userId: string; byUserId: string | null },
): Promise<DayOpResult & { dayOps: DayOp[] }> {
  const day = await loadDay(db, args.clubId, args.sessionId);
  if (!day.rows.some((r) => r.userId === args.userId && r.status === "SCHEDULED")) {
    throw new ClassStaffError("NOT_ON_DAY", "That person is not coaching this class day");
  }
  const rest: DesiredStaff[] = day.rows.filter((r) => r.status === "SCHEDULED" && r.userId !== args.userId).map((r) => ({ userId: r.userId }));
  return editDay(db, day, rest, args.byUserId);
}

export type CallOutResult = DayOpResult & {
  staffRowId: string;
  userId: string;
  /** Called out less than 2 hours before the real start. */
  late: boolean;
  /** The real instant the class starts. */
  startInstant: Date;
};

async function callOutDay(db: Db, day: Day, args: { userId: string; reason?: string | null; byUserId: string | null; now: Date }): Promise<CallOutResult> {
  const row = day.rows.find((r) => r.userId === args.userId);
  if (!row) throw new ClassStaffError("NOT_ON_DAY", "That person is not on this class day");
  if (row.status !== "SCHEDULED") throw new ClassStaffError("BAD_STATE", "That person is not currently scheduled on this class day");
  if (day.canceled) throw new ClassStaffError("BAD_STATE", "This class day is canceled");
  if (classHasEnded(day.endsAt, day.timezone, args.now)) throw new ClassStaffError("DAY_ENDED", "This class day is already over");
  const startInstant = classStartInstant(day.startsAt, day.timezone);
  const late = isLateCallout(startInstant, args.now);
  await db.classSessionStaff.update({
    where: { id: row.id },
    data: {
      status: "NEEDS_COVERAGE", calledOutAt: args.now, calledOutByUserId: args.byUserId,
      calloutReason: (args.reason ?? "").trim().slice(0, 500) || null, lateCallout: late,
      coverageFilledAt: null, coverageFilledByUserId: null, changedByUserId: args.byUserId,
    },
  });
  const res = await finishDay(db, day, { manual: false });
  return { ...res, staffRowId: row.id, userId: args.userId, late, startInstant };
}

/**
 * "I can't make it" for one class day. The class STAYS scheduled; the coach's
 * row becomes NEEDS_COVERAGE with who/when/why. Never refused for being late —
 * `late` (and the row's lateCallout) is true inside 2 hours of the real start.
 * `byUserId` is the coach, or a manager acting for them. Does not flag the day
 * staffManual: the open request is protected on its own, and the other
 * coaches' rule rows keep following the rules.
 * Errors: NOT_ON_DAY, BAD_STATE (not SCHEDULED / day canceled), DAY_ENDED.
 */
export async function callOut(
  db: Db,
  args: { clubId: string; sessionId: string; userId: string; reason?: string | null; byUserId: string | null; now?: Date },
): Promise<CallOutResult> {
  const day = await loadDay(db, args.clubId, args.sessionId);
  return callOutDay(db, day, { userId: args.userId, reason: args.reason, byUserId: args.byUserId, now: args.now ?? new Date() });
}

/**
 * Call one coach out of EVERY class day they are scheduled on between two
 * dates (inclusive, at most 366 days) — per-day rows only; their recurring
 * rules are not changed. Skips canceled days, days already over, and days
 * before the switch-on date. One CallOutResult per day, in date order.
 */
export async function callOutRange(
  db: Db,
  args: { clubId: string; userId: string; fromDate: string; toDate: string; reason?: string | null; byUserId: string | null; now?: Date },
): Promise<{ results: CallOutResult[] }> {
  if (!isYmd(args.fromDate) || !isYmd(args.toDate) || args.toDate < args.fromDate) {
    throw new ClassStaffError("BAD_INPUT", "fromDate and toDate must be YYYY-MM-DD, in order");
  }
  if (args.toDate > addDaysYmd(args.fromDate, 366)) throw new ClassStaffError("BAD_INPUT", "A call-out can cover at most a year");
  const now = args.now ?? new Date();
  const settings = await getScheduleSettings(args.clubId, db);
  if (!settings.assignmentsStartOn) throw new ClassStaffError("NOT_SWITCHED_ON", "Assignments are not switched on for this club");
  const from = maxYmd(args.fromDate, settings.assignmentsStartOn);
  if (from > args.toDate) return { results: [] };
  const sessions = await db.classSession.findMany({
    where: {
      clubId: args.clubId, canceled: false,
      date: { gte: ymdToDate(from), lte: ymdToDate(args.toDate) },
      staff: { some: { userId: args.userId, status: "SCHEDULED" } },
    },
    select: { id: true },
    orderBy: [{ date: "asc" }, { startsAt: "asc" }],
  });
  const results: CallOutResult[] = [];
  for (const s of sessions) {
    const day = await loadDay(db, args.clubId, s.id);
    if (classHasEnded(day.endsAt, day.timezone, now)) continue;
    results.push(await callOutDay(db, day, { userId: args.userId, reason: args.reason, byUserId: args.byUserId, now }));
  }
  return { results };
}

/**
 * Undo a call-out while nobody has filled it: NEEDS_COVERAGE → SCHEDULED, the
 * call-out fields cleared. The coach or a manager (the route decides).
 * BAD_STATE once it has been filled, closed, or was never open.
 */
export async function cancelCoverageRequest(
  db: Db,
  args: { clubId: string; staffRowId: string; byUserId: string | null },
): Promise<DayOpResult & { staffRowId: string; userId: string }> {
  const { day, row } = await loadDayByRow(db, args.clubId, args.staffRowId);
  if (row.status !== "NEEDS_COVERAGE") throw new ClassStaffError("BAD_STATE", "This coverage request is no longer open");
  await db.classSessionStaff.update({ where: { id: row.id }, data: { status: "SCHEDULED", ...CLEAR_CALLOUT, changedByUserId: args.byUserId } });
  const res = await finishDay(db, day, { manual: false });
  return { ...res, staffRowId: row.id, userId: row.userId };
}

/**
 * A schedule manager fills an open coverage request: the original row becomes
 * REPLACED (coverageFilledAt/By stamped) and the substitute gets a SCHEDULED
 * SUBSTITUTE row pointing at it (roleName defaults to "Substitute"). The
 * substitute is paid from THEIR OWN plan (Branch 2) — nothing is copied here.
 * Errors: BAD_STATE (request not open / the substitute has their own open
 * call-out or no-show that day), INVALID_STAFF, ALREADY_ON_DAY (they are
 * already coaching it — close the request instead), BAD_INPUT (same person).
 */
export async function fillCoverage(
  db: Db,
  args: { clubId: string; staffRowId: string; substituteUserId: string; roleName?: string | null; byUserId: string | null; now?: Date },
): Promise<DayOpResult & { staffRowId: string; substituteRowId: string; originalUserId: string; substituteUserId: string }> {
  const now = args.now ?? new Date();
  const { day, row } = await loadDayByRow(db, args.clubId, args.staffRowId);
  if (row.status !== "NEEDS_COVERAGE") throw new ClassStaffError("BAD_STATE", "This coverage request is no longer open");
  if (args.substituteUserId === row.userId) throw new ClassStaffError("BAD_INPUT", "A coach cannot cover for themself");
  await requireValidStaff(args.clubId, [args.substituteUserId]);
  const existing = day.rows.find((r) => r.userId === args.substituteUserId);
  if (existing?.status === "SCHEDULED") throw new ClassStaffError("ALREADY_ON_DAY", "That person is already coaching this class day");
  if (existing && existing.status !== "REMOVED") throw new ClassStaffError("BAD_STATE", "That person has their own open change on this class day");
  const sub = {
    roleName: normalizeRoleName(args.roleName) ?? SUBSTITUTE_ROLE_NAME,
    kind: "SUBSTITUTE", status: "SCHEDULED", source: "MANUAL", replacesStaffId: row.id, ruleId: null,
    changedByUserId: args.byUserId,
  };
  let substituteRowId: string;
  if (existing) {
    await db.classSessionStaff.update({ where: { id: existing.id }, data: { ...sub, ...CLEAR_CALLOUT } });
    substituteRowId = existing.id;
  } else {
    const made = await db.classSessionStaff.create({
      data: { clubId: day.clubId, sessionId: day.sessionId, userId: args.substituteUserId, ...sub },
      select: { id: true },
    });
    substituteRowId = made.id;
  }
  await db.classSessionStaff.update({
    where: { id: row.id },
    data: { status: "REPLACED", coverageFilledAt: now, coverageFilledByUserId: args.byUserId, changedByUserId: args.byUserId },
  });
  const res = await finishDay(db, day, { manual: false });
  return { ...res, staffRowId: row.id, substituteRowId, originalUserId: row.userId, substituteUserId: args.substituteUserId };
}

/** A manager closes an open coverage request with nobody replacing: NEEDS_COVERAGE → REMOVED. */
export async function closeCoverage(
  db: Db,
  args: { clubId: string; staffRowId: string; byUserId: string | null; note?: string | null },
): Promise<DayOpResult & { staffRowId: string; userId: string }> {
  const { day, row } = await loadDayByRow(db, args.clubId, args.staffRowId);
  if (row.status !== "NEEDS_COVERAGE") throw new ClassStaffError("BAD_STATE", "This coverage request is no longer open");
  const note = (args.note ?? "").trim().slice(0, 500);
  await db.classSessionStaff.update({
    where: { id: row.id },
    data: { status: "REMOVED", ...(note ? { note } : {}), changedByUserId: args.byUserId },
  });
  const res = await finishDay(db, day, { manual: false });
  return { ...res, staffRowId: row.id, userId: row.userId };
}

/**
 * The scheduled coach did not turn up: SCHEDULED → NO_SHOW (not paid for the
 * day). Only once the class has started (BAD_STATE before that).
 */
export async function markNoShow(
  db: Db,
  args: { clubId: string; staffRowId: string; byUserId: string | null; note?: string | null; now?: Date },
): Promise<DayOpResult & { staffRowId: string; userId: string }> {
  const { day, row } = await loadDayByRow(db, args.clubId, args.staffRowId);
  if (row.status !== "SCHEDULED") throw new ClassStaffError("BAD_STATE", "Only a scheduled coach can be marked as a no-show");
  if (!classHasStarted(day.startsAt, day.timezone, args.now ?? new Date())) {
    throw new ClassStaffError("BAD_STATE", "This class has not started yet");
  }
  const note = (args.note ?? "").trim().slice(0, 500);
  await db.classSessionStaff.update({
    where: { id: row.id },
    data: { status: "NO_SHOW", ...(note ? { note } : {}), changedByUserId: args.byUserId },
  });
  const res = await finishDay(db, day, { manual: false });
  return { ...res, staffRowId: row.id, userId: row.userId };
}

/** Undo a no-show: NO_SHOW → SCHEDULED. */
export async function clearNoShow(
  db: Db,
  args: { clubId: string; staffRowId: string; byUserId: string | null },
): Promise<DayOpResult & { staffRowId: string; userId: string }> {
  const { day, row } = await loadDayByRow(db, args.clubId, args.staffRowId);
  if (row.status !== "NO_SHOW") throw new ClassStaffError("BAD_STATE", "This coach is not marked as a no-show");
  await db.classSessionStaff.update({ where: { id: row.id }, data: { status: "SCHEDULED", changedByUserId: args.byUserId } });
  const res = await finishDay(db, day, { manual: false });
  return { ...res, staffRowId: row.id, userId: row.userId };
}

// ── The three-scope coach edit ──────────────────────────────────────────────

export type ScopeChangeResult = {
  scope: ChangeScope;
  classId: string;
  /** The date the change applies from (rule scopes) / the class day (OCCURRENCE). */
  date: string;
  ruleOps: RuleOp[];
  dayOps: DayOp[];
  /** Recurring coaches for `date` before / after (rule scopes; [] for OCCURRENCE). */
  recurringBefore: RuleStaff[];
  recurringAfter: RuleStaff[];
  /** OCCURRENCE: the day's before/after. */
  day: DayOpResult | null;
  /** Rule scopes: what materialization then did. */
  sync: StaffSyncResult | null;
};

/**
 * Change a class's coaches at one of the three scopes — plan, write, and
 * regenerate, in one call (lib/classStaff.planScopeChange has the semantics).
 *
 *   OCCURRENCE       → setDayStaff on that class day (created if missing).
 *   WEEKDAY_FORWARD  → rule changes for that weekday from `date`
 *   ALL_FUTURE       → rule changes for every class day from `date`
 *                      then syncSessionStaff: days from today forward that
 *                      nobody edited by hand follow the new rules; days that
 *                      have ended never change.
 *
 * `date` must be on/after the switch-on date (NOT_SWITCHED_ON). People being
 * added must be current OWNER/STAFF (INVALID_STAFF). Run the conflict check
 * (loadStaffConflicts / conflictsForRuleChange) BEFORE calling this.
 */
export async function applyScopeChange(
  db: Db,
  args: {
    clubId: string; classId: string; scope: ChangeScope; date: string; dayOfWeek?: number;
    desired: readonly DesiredStaff[]; byUserId: string | null; now?: Date;
  },
): Promise<ScopeChangeResult> {
  if (!isYmd(args.date)) throw new ClassStaffError("BAD_INPUT", "date must be YYYY-MM-DD");
  const cls = await db.recurringClass.findFirst({
    where: { id: args.classId, clubId: args.clubId, deletedAt: null },
    select: { id: true, daysOfWeek: true },
  });
  if (!cls) throw new ClassStaffError("NOT_FOUND", "Class not found");
  const settings = await getScheduleSettings(args.clubId, db);
  if (!isSwitchedOn(settings.assignmentsStartOn, args.date)) {
    throw new ClassStaffError("NOT_SWITCHED_ON", "This date is before the assignment start date");
  }
  if (args.scope === "OCCURRENCE") {
    const { session } = await ensureSession(args.classId, args.date, db);
    const day = await setDayStaff(db, { clubId: args.clubId, sessionId: session.id, staff: args.desired, byUserId: args.byUserId });
    const { dayOps, ...rest } = day;
    return { scope: args.scope, classId: args.classId, date: args.date, ruleOps: [], dayOps, recurringBefore: [], recurringAfter: [], day: rest, sync: null };
  }
  const dow = args.scope === "WEEKDAY_FORWARD" ? (args.dayOfWeek ?? dowOfYmd(args.date)) : undefined;
  const rules = await loadClassRules(db, args.classId);
  const classDays = Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number) : [];
  const plan = planScopeChange({
    scope: args.scope, classDays, date: args.date, dayOfWeek: dow,
    currentRules: rules, currentDayStaff: [], desired: args.desired,
  });
  const have = new Set(rules.map((r) => r.userId));
  await requireValidStaff(args.clubId, plan.ruleOps.filter((o): o is Extract<RuleOp, { op: "create" }> => o.op === "create" && !have.has(o.userId)).map((o) => o.userId));
  await applyRuleOpsDb(db, args.clubId, args.classId, plan.ruleOps, args.byUserId);
  const after = plan.ruleOps.length > 0 ? await loadClassRules(db, args.classId) : rules;
  const sync = await syncSessionStaff(db, args.classId, args.date, { now: args.now });
  // For WEEKDAY_FORWARD the "day" shown is the first such weekday on/after `date`.
  const showDay = dow === undefined ? args.date : addDaysYmd(args.date, (dow - dowOfYmd(args.date) + 7) % 7);
  return {
    scope: args.scope, classId: args.classId, date: args.date, ruleOps: plan.ruleOps, dayOps: [],
    recurringBefore: rulesForDay(rules, showDay), recurringAfter: rulesForDay(after, showDay), day: null, sync,
  };
}

/**
 * Take ONE coach off a class's recurring list from `date` (every weekday),
 * leaving everyone else's rules alone, then regenerate. Used for "take me off
 * every week" (the route enforces that a non-manager may only name themself)
 * and when a coach leaves. Hand-edited days and coverage records are not
 * touched; use removeDayStaff for those.
 */
export async function endUserRules(
  db: Db,
  args: { clubId: string; classId: string; userId: string; date: string; byUserId: string | null; now?: Date },
): Promise<{ ruleOps: RuleOp[]; recurringBefore: RuleStaff[]; recurringAfter: RuleStaff[]; sync: StaffSyncResult }> {
  if (!isYmd(args.date)) throw new ClassStaffError("BAD_INPUT", "date must be YYYY-MM-DD");
  const cls = await db.recurringClass.findFirst({ where: { id: args.classId, clubId: args.clubId }, select: { id: true } });
  if (!cls) throw new ClassStaffError("NOT_FOUND", "Class not found");
  const settings = await getScheduleSettings(args.clubId, db);
  if (!isSwitchedOn(settings.assignmentsStartOn, args.date)) {
    throw new ClassStaffError("NOT_SWITCHED_ON", "This date is before the assignment start date");
  }
  const rules = await loadClassRules(db, args.classId);
  const ruleOps = planEndUserRules(rules, args.userId, args.date);
  await applyRuleOpsDb(db, args.clubId, args.classId, ruleOps, args.byUserId);
  const after = ruleOps.length > 0 ? await loadClassRules(db, args.classId) : rules;
  const sync = await syncSessionStaff(db, args.classId, args.date, { now: args.now });
  return { ruleOps, recurringBefore: rulesForDay(rules, args.date), recurringAfter: rulesForDay(after, args.date), sync };
}

export type ReleaseStaffResult = {
  /** false = the club is not switched on to the new assignments: nothing to do. */
  switchedOn: boolean;
  /** Classes whose recurring rules for this person were ended. */
  classesEnded: string[];
  /** Future class days that became "Needs coverage". */
  daysOpened: number;
};

/**
 * A staff member was removed from the staff (Julian, 2026-10-07):
 *   1. every FUTURE class day they are scheduled on (today's classes that have
 *      not ended included) becomes NEEDS_COVERAGE — reason "No longer on
 *      staff" — so each one is visible until somebody covers it;
 *   2. their recurring rules end from today on every class, so no new class
 *      day is generated for them.
 * Class days that have already ended are not read or written: what happened,
 * happened (and stays payable). Days already called out / replaced / no-show
 * are left as they are. A new recurring coach put on one of those days
 * settles the opening (syncSessionStaff). Idempotent.
 */
export async function releaseRemovedStaff(
  db: Db,
  args: { clubId: string; userId: string; byUserId: string | null; now?: Date },
): Promise<ReleaseStaffResult> {
  const now = args.now ?? new Date();
  const settings = await getScheduleSettings(args.clubId, db);
  if (!settings.assignmentsStartOn) return { switchedOn: false, classesEnded: [], daysOpened: 0 };
  const club = await db.club.findUnique({ where: { id: args.clubId }, select: { timezone: true } });
  const tz = club?.timezone ?? null;
  const today = clubTodayYmd(tz, now);
  const from = maxYmd(today, settings.assignmentsStartOn);

  const rows = await db.classSessionStaff.findMany({
    where: {
      clubId: args.clubId, userId: args.userId, status: "SCHEDULED",
      session: { canceled: false, date: { gte: ymdToDate(from) } },
    },
    select: { id: true, sessionId: true, session: { select: { startsAt: true, endsAt: true } } },
  });
  const open = rows.filter((r) => !classHasEnded(r.session.endsAt, tz, now));
  if (open.length > 0) {
    await db.classSessionStaff.updateMany({
      where: { id: { in: open.map((r) => r.id) }, status: "SCHEDULED" },
      data: {
        status: "NEEDS_COVERAGE", calledOutAt: now, calledOutByUserId: args.byUserId,
        calloutReason: REMOVED_STAFF_REASON, lateCallout: false,
        coverageFilledAt: null, coverageFilledByUserId: null, changedByUserId: args.byUserId,
      },
    });
  }

  const rules = await db.classStaffRule.findMany({
    where: { clubId: args.clubId, userId: args.userId, OR: [{ effectiveTo: null }, { effectiveTo: { gte: ymdToDate(from) } }] },
    select: { classId: true },
  });
  const classIds = Array.from(new Set(rules.map((r) => r.classId)));
  for (const classId of classIds) {
    const all = await loadClassRules(db, classId);
    await applyRuleOpsDb(db, args.clubId, classId, planEndUserRules(all, args.userId, from), args.byUserId);
  }
  // Refresh the per-day legacy mirror for every class touched (rows or rules).
  const touched = new Set(classIds);
  if (open.length > 0) {
    const sess = await db.classSession.findMany({ where: { id: { in: Array.from(new Set(open.map((r) => r.sessionId))) } }, select: { classId: true } });
    for (const s of sess) touched.add(s.classId);
  }
  for (const classId of touched) await syncSessionStaff(db, classId, from, { now });
  return { switchedOn: true, classesEnded: classIds, daysOpened: open.length };
}

/**
 * A legacy "series coach list" save for a switched-on club — the old class
 * editor / "+ Add coach" / "take me off every week" all send a whole list (or
 * one id) with no weekday or role. Applied as a DIFF against the recurring
 * coaches, from `date`:
 *   - someone no longer in the list → their rules end (every weekday)
 *   - someone new in the list       → an all-days rule from `date`
 *   - everyone else is left exactly as they are, weekday-only rules and roles
 *     included (a plain ALL_FUTURE replace would flatten a Tuesday-only coach
 *     into an every-day one just because an old screen listed them).
 * Then one syncSessionStaff. RecurringClass.assignedStaffIds is NOT written.
 * `date` must be on/after the switch-on date (NOT_SWITCHED_ON). New people
 * must be current OWNER/STAFF (INVALID_STAFF).
 */
export async function applySeriesListChange(
  db: Db,
  args: { clubId: string; classId: string; date: string; before: readonly string[]; after: readonly string[]; byUserId: string | null; now?: Date },
): Promise<{ ruleOps: RuleOp[]; added: string[]; removed: string[]; recurringBefore: RuleStaff[]; recurringAfter: RuleStaff[]; sync: StaffSyncResult }> {
  if (!isYmd(args.date)) throw new ClassStaffError("BAD_INPUT", "date must be YYYY-MM-DD");
  const cls = await db.recurringClass.findFirst({ where: { id: args.classId, clubId: args.clubId }, select: { id: true } });
  if (!cls) throw new ClassStaffError("NOT_FOUND", "Class not found");
  const settings = await getScheduleSettings(args.clubId, db);
  if (!isSwitchedOn(settings.assignmentsStartOn, args.date)) {
    throw new ClassStaffError("NOT_SWITCHED_ON", "This date is before the assignment start date");
  }
  const before = new Set(args.before);
  const after = new Set(args.after);
  const added = Array.from(after).filter((id) => !before.has(id));
  const removed = Array.from(before).filter((id) => !after.has(id));
  await requireValidStaff(args.clubId, added);
  const rules = await loadClassRules(db, args.classId);
  const ruleOps: RuleOp[] = [];
  for (const userId of removed) ruleOps.push(...planEndUserRules(rules, userId, args.date));
  for (const userId of added) {
    const live = rules.filter((r) => r.userId === userId && (r.effectiveTo === null || r.effectiveTo >= args.date));
    // Already an open all-days rule in force: nothing to add.
    if (live.some((r) => r.dayOfWeek === null && r.effectiveTo === null && r.effectiveFrom <= args.date)) continue;
    const role = live.find((r) => r.dayOfWeek === null)?.roleName ?? live[0]?.roleName ?? null;
    ruleOps.push(...planEndUserRules(rules, userId, args.date));
    ruleOps.push({ op: "create", userId, roleName: role, dayOfWeek: null, effectiveFrom: args.date, effectiveTo: null });
  }
  await applyRuleOpsDb(db, args.clubId, args.classId, ruleOps, args.byUserId);
  const afterRules = ruleOps.length > 0 ? await loadClassRules(db, args.classId) : rules;
  const sync = await syncSessionStaff(db, args.classId, args.date, { now: args.now });
  return { ruleOps, added, removed, recurringBefore: rulesForDay(rules, args.date), recurringAfter: rulesForDay(afterRules, args.date), sync };
}

/** Put ONE coach on a class's recurring list (every class day) from `date`, leaving everyone else alone. */
export async function addUserRule(
  db: Db,
  args: { clubId: string; classId: string; userId: string; date: string; byUserId: string | null; now?: Date },
): Promise<{ ruleOps: RuleOp[]; sync: StaffSyncResult }> {
  const res = await applySeriesListChange(db, { clubId: args.clubId, classId: args.classId, date: args.date, before: [], after: [args.userId], byUserId: args.byUserId, now: args.now });
  return { ruleOps: res.ruleOps, sync: res.sync };
}

/**
 * The first day a series-level change may apply from: today on the club's
 * wall clock, never before the switch-on date. null = the club is not
 * switched on (use the legacy path).
 */
export async function seriesChangeDate(clubId: string, db: Db = prisma, now: Date = new Date()): Promise<{ assignmentsStartOn: string | null; today: string; from: string | null; timezone: string | null }> {
  const [settings, club] = await Promise.all([
    getScheduleSettings(clubId, db),
    db.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
  ]);
  const timezone = club?.timezone ?? null;
  const today = clubTodayYmd(timezone, now);
  const startOn = settings.assignmentsStartOn;
  return { assignmentsStartOn: startOn, today, from: startOn ? maxYmd(today, startOn) : null, timezone };
}

// ── Cancellation ────────────────────────────────────────────────────────────

const CANCEL_SELECT = {
  id: true, classId: true, clubId: true, date: true, startsAt: true, endsAt: true, canceled: true,
  canceledAt: true, canceledByUserId: true, cancelReason: true, cancelNotifyAudience: true,
  cancelNotifiedCount: true, cancelPaid: true, cancelPaidByUserId: true, cancelPaidAt: true,
  recurringClass: { select: { name: true } },
} satisfies Prisma.ClassSessionSelect;

export type CancelState = {
  canceled: boolean;
  canceledAt: Date | null;
  canceledByUserId: string | null;
  cancelReason: string | null;
  cancelNotifyAudience: string | null;
  cancelNotifiedCount: number | null;
  cancelPaid: boolean;
  cancelPaidByUserId: string | null;
  cancelPaidAt: Date | null;
};

export type CancelResult = {
  sessionId: string;
  classId: string;
  className: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  before: CancelState;
  after: CancelState;
  changed: boolean;
};

type CancelRow = Prisma.ClassSessionGetPayload<{ select: typeof CANCEL_SELECT }>;
const cancelState = (s: CancelRow): CancelState => ({
  canceled: s.canceled, canceledAt: s.canceledAt, canceledByUserId: s.canceledByUserId, cancelReason: s.cancelReason,
  cancelNotifyAudience: s.cancelNotifyAudience, cancelNotifiedCount: s.cancelNotifiedCount,
  cancelPaid: s.cancelPaid, cancelPaidByUserId: s.cancelPaidByUserId, cancelPaidAt: s.cancelPaidAt,
});

async function writeCancel(db: Db, clubId: string, sessionId: string, build: (s: CancelRow) => Prisma.ClassSessionUpdateInput | null): Promise<CancelResult> {
  const s = await db.classSession.findFirst({ where: { id: sessionId, clubId }, select: CANCEL_SELECT });
  if (!s) throw new ClassStaffError("NOT_FOUND", "Class day not found");
  const data = build(s);
  const after = data ? await db.classSession.update({ where: { id: s.id }, data, select: CANCEL_SELECT }) : s;
  const b = cancelState(s);
  const a = cancelState(after);
  return {
    sessionId: s.id, classId: s.classId, className: s.recurringClass.name, date: toYmd(s.date),
    startsAt: s.startsAt, endsAt: s.endsAt, before: b, after: a, changed: JSON.stringify(b) !== JSON.stringify(a),
  };
}

/**
 * Cancel one class day and record who / when / why, which audience was chosen
 * and whether pay was preserved. Works on ANY class day (cancelling is not an
 * assignment change, so there is no switch-on requirement) — but "cancelled,
 * paid" only affects pay for days on/after the switch-on date.
 *   - bookings and staff rows are left as they are
 *   - `paid: true` needs finances:full — the ROUTE must check; pass false otherwise
 *   - notices are the route's job: cancelAudienceMembers() then recordCancelNotified()
 * Already canceled → nothing is written (changed: false); use setCancelPaid to
 * change the pay choice.
 */
export async function cancelOccurrence(
  db: Db,
  args: { clubId: string; sessionId: string; reason?: string | null; notifyAudience: CancelAudience; paid: boolean; byUserId: string | null; now?: Date },
): Promise<CancelResult> {
  const now = args.now ?? new Date();
  return writeCancel(db, args.clubId, args.sessionId, (s) =>
    s.canceled
      ? null
      : {
          canceled: true, canceledAt: now, canceledByUserId: args.byUserId,
          cancelReason: (args.reason ?? "").trim().slice(0, 1000) || null,
          cancelNotifyAudience: args.notifyAudience, cancelNotifiedCount: null,
          cancelPaid: !!args.paid, cancelPaidByUserId: args.paid ? args.byUserId : null, cancelPaidAt: args.paid ? now : null,
        },
  );
}

/** Put a canceled class day back on: clears the cancel + pay fields (the `before` in the result is the audit record). */
export async function uncancelOccurrence(db: Db, args: { clubId: string; sessionId: string; byUserId: string | null }): Promise<CancelResult> {
  return writeCancel(db, args.clubId, args.sessionId, (s) =>
    !s.canceled
      ? null
      : {
          canceled: false, canceledAt: null, canceledByUserId: null, cancelReason: null, cancelNotifyAudience: null,
          cancelNotifiedCount: null, cancelPaid: false, cancelPaidByUserId: null, cancelPaidAt: null,
        },
  );
}

/**
 * Mark a CANCELED class day "cancelled — paid" (or back to unpaid). Stamps who
 * and when. Needs finances:full — the ROUTE must check. BAD_STATE when the day
 * is not canceled.
 */
export async function setCancelPaid(
  db: Db,
  args: { clubId: string; sessionId: string; paid: boolean; byUserId: string | null; now?: Date },
): Promise<CancelResult> {
  const now = args.now ?? new Date();
  return writeCancel(db, args.clubId, args.sessionId, (s) => {
    if (!s.canceled) throw new ClassStaffError("BAD_STATE", "This class day is not canceled");
    if (s.cancelPaid === !!args.paid) return null;
    return { cancelPaid: !!args.paid, cancelPaidByUserId: args.byUserId, cancelPaidAt: now };
  });
}

/** After the cancellation notices went out: store how many people were told. */
export async function recordCancelNotified(db: Db, args: { clubId: string; sessionId: string; count: number }): Promise<void> {
  await db.classSession.updateMany({
    where: { id: args.sessionId, clubId: args.clubId },
    data: { cancelNotifiedCount: Math.max(0, Math.round(args.count)) },
  });
}

/** AttendanceRecord statuses that mean "booked into / attending this class day" (ABSENT is not). */
const BOOKED_STATUSES = ["PRESENT", "LATE", "DROP_IN", "TRIAL"];

export type CancelAudienceResult = {
  audience: CancelAudience;
  /** Everyone the notice is about (booked first), no duplicates. */
  memberIds: string[];
  bookedMemberIds: string[];
  classMemberIds: string[];
  /** One entry per email address — a guardian of two athletes appears once, with both. */
  recipients: AudienceRecipient[];
  /** Members with no usable address. */
  skipped: { memberId: string; reason: string }[];
};

/**
 * Who a cancellation notice goes to.
 *   BOOKED         members with a booking on that class day — an
 *                  AttendanceRecord on the session (that IS how a class
 *                  booking is stored), status PRESENT/LATE/DROP_IN/TRIAL
 *   CLASS_MEMBERS  members whose ACTIVE membership currently gives access to
 *                  this class day — the SAME rule booking uses
 *                  (lib/coverageQuery.loadSessionCoverageContext +
 *                  coverageForMembers → verdict.covered: accepted plan,
 *                  accepted option, entitled weekday, term not ended). Past
 *                  attendance alone never qualifies; a class that accepts no
 *                  plan has no class members.
 *   BOTH / NONE    the union / nobody
 * Deleted members are never included. Addresses come from the email system's
 * resolver (lib/emailRecipients.resolveRecipients — a minor's notice goes to
 * their guardian), transactional (opt-outs are for marketing), then folded to
 * one recipient per address.
 */
export async function cancelAudienceMembers(
  clubId: string,
  sessionId: string,
  audience: CancelAudience,
  db: Db = prisma,
): Promise<CancelAudienceResult> {
  const empty: CancelAudienceResult = { audience, memberIds: [], bookedMemberIds: [], classMemberIds: [], recipients: [], skipped: [] };
  if (audience === "NONE") return empty;
  const wantBooked = audience === "BOOKED" || audience === "BOTH";
  const wantClass = audience === "CLASS_MEMBERS" || audience === "BOTH";

  let booked: string[] = [];
  if (wantBooked) {
    const rows = await db.attendanceRecord.findMany({
      where: { clubId, classSessionId: sessionId, status: { in: BOOKED_STATUSES }, member: { deletedAt: null } },
      select: { memberId: true },
      orderBy: { createdAt: "asc" },
    });
    booked = Array.from(new Set(rows.map((r) => r.memberId)));
  }

  let classMembers: string[] = [];
  if (wantClass) {
    const ctx = await loadSessionCoverageContext(sessionId, clubId);
    if (ctx && ctx.acceptedMembershipIds.length > 0) {
      const subs = await db.memberSubscription.findMany({
        where: { status: "active", membershipId: { in: ctx.acceptedMembershipIds }, member: { clubId, deletedAt: null } },
        select: { memberId: true },
      });
      const candidates = Array.from(new Set(subs.map((s) => s.memberId)));
      const verdicts = await coverageForMembers(candidates, ctx, clubId);
      classMembers = candidates.filter((id) => verdicts.get(id)?.covered === true);
    }
  }

  const memberIds = mergeAudience(audience, booked, classMembers);
  if (memberIds.length === 0) return { ...empty, bookedMemberIds: booked, classMemberIds: classMembers };
  const resolution = await resolveRecipients({ clubId, memberIds, mode: "PER_MEMBER", respectMarketingOptOut: false });
  return {
    audience, memberIds, bookedMemberIds: booked, classMemberIds: classMembers,
    recipients: groupRecipientsByEmail(resolution.send),
    skipped: resolution.skipped.map((s) => ({ memberId: s.memberId, reason: s.reason })),
  };
}

// ── Coverage recipients ─────────────────────────────────────────────────────

export type CoverageRecipients = {
  userIds: string[];
  users: { id: string; email: string; firstName: string; lastName: string; role: string }[];
  /** From settings: IN_APP / EMAIL (PUSH later). */
  channels: string[];
};

/**
 * Who is told that a class day needs coverage, from the club's settings:
 * owners, everyone holding schedule:edit (lib/permissions.hasPermission on the
 * live StaffProfile), the other coaches on that class day, anyone whose role
 * on the day/class matches a configured role name, and named people — current
 * OWNER/STAFF only, deduped, never `excludingUserId` (the coach calling out).
 */
export async function coverageRecipients(
  clubId: string,
  sessionId: string,
  excludingUserId: string | null,
  db: Db = prisma,
): Promise<CoverageRecipients> {
  const [settings, staff, session] = await Promise.all([
    getScheduleSettings(clubId, db),
    db.user.findMany({
      where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, staffProfile: { select: { permissions: true } } },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    db.classSession.findFirst({
      where: { id: sessionId, clubId },
      select: { classId: true, date: true, staff: { select: { userId: true, roleName: true, status: true } } },
    }),
  ]);
  if (!session) throw new ClassStaffError("NOT_FOUND", "Class day not found");
  const dateYmd = toYmd(session.date);
  const rules = (await loadClassRules(db, session.classId)).filter((r) => ruleInForce(r, dateYmd));
  const userIds = pickCoverageRecipients({
    settings,
    staff: staff.map((u) => ({
      id: u.id,
      role: u.role,
      canManageSchedule: u.role === "OWNER" || hasPermission((u.staffProfile?.permissions ?? null) as Record<string, unknown> | null, "schedule", "edit"),
    })),
    dayRows: session.staff.map((r) => ({ userId: r.userId, roleName: r.roleName, status: r.status as StaffStatus })),
    classRules: rules,
    excludingUserId,
  });
  const pick = new Set(userIds);
  return {
    userIds,
    users: staff.filter((u) => pick.has(u.id)).map((u) => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role })),
    channels: settings.coverageChannels,
  };
}

// ── Conflicts ───────────────────────────────────────────────────────────────

export type ConflictCheck = {
  conflicts: StaffConflict[];
  /** Human lines, repeats folded — lib/classStaff.summarizeConflicts. */
  summary: string[];
  hasOverlap: boolean;
};

/**
 * Warnings for putting `userId` on the proposed class day(s): overlaps with
 * their other class days (post-switch rows, status SCHEDULED, not canceled),
 * events they staff (per event session when it has sessions), their CONFIRMED
 * private lessons, plus a softer "outside available hours" from their saved
 * availability (skipped for a coach with no saved hours and no time off in
 * range). Everything is compared as real instants (class wall clock →
 * instant through the club timezone; events and lessons already are).
 * `excludeSessionIds` / `excludeClassIds` leave out the thing being edited.
 * WARNINGS ONLY — the route requires `acknowledgeConflicts: true`, never blocks.
 */
export async function loadStaffConflicts(
  args: {
    clubId: string; userId: string;
    slots: readonly { date: string; startTime: string; endTime: string }[];
    excludeSessionIds?: readonly string[]; excludeClassIds?: readonly string[];
  },
  db: Db = prisma,
): Promise<ConflictCheck> {
  if (args.slots.length === 0) return { conflicts: [], summary: [], hasOverlap: false };
  const club = await db.club.findUnique({ where: { id: args.clubId }, select: { timezone: true } });
  const tz = club?.timezone ?? null;
  const proposed: ProposedSlot[] = args.slots.map((s) => proposedSlot(s.date, s.startTime, s.endTime, tz));
  const minDay = proposed.reduce((m, p) => (p.date < m ? p.date : m), proposed[0].date);
  const maxDay = proposed.reduce((m, p) => (p.date > m ? p.date : m), proposed[0].date);
  const winFrom = new Date(Math.min(...proposed.map((p) => p.startMs)));
  const winTo = new Date(Math.max(...proposed.map((p) => p.endMs)));
  const dayFrom = ymdToDate(addDaysYmd(minDay, -1));
  const dayTo = ymdToDate(addDaysYmd(maxDay, 1));

  const [classRows, eventRows, lessons, weekly, exceptions] = await Promise.all([
    db.classSessionStaff.findMany({
      where: {
        clubId: args.clubId, userId: args.userId, status: "SCHEDULED",
        ...(args.excludeSessionIds?.length ? { sessionId: { notIn: [...args.excludeSessionIds] } } : {}),
        session: {
          canceled: false, date: { gte: dayFrom, lte: dayTo },
          ...(args.excludeClassIds?.length ? { classId: { notIn: [...args.excludeClassIds] } } : {}),
          recurringClass: { deletedAt: null },
        },
      },
      select: { session: { select: { id: true, date: true, startsAt: true, endsAt: true, recurringClass: { select: { name: true } } } } },
    }),
    db.eventStaffAssignment.findMany({
      where: { clubId: args.clubId, userId: args.userId, event: { deletedAt: null, startsAt: { lte: winTo }, endsAt: { gte: winFrom } } },
      select: { event: { select: { id: true, name: true, startsAt: true, endsAt: true, sessions: { select: { startsAt: true, endsAt: true } } } } },
    }),
    db.privateBooking.findMany({
      where: { clubId: args.clubId, coachId: args.userId, status: "CONFIRMED", confirmedStartAt: { lte: winTo }, confirmedEndAt: { gte: winFrom } },
      select: { id: true, confirmedStartAt: true, confirmedEndAt: true, lessonType: { select: { title: true } } },
    }),
    db.staffAvailability.findMany({
      where: { clubId: args.clubId, userId: args.userId, active: true },
      select: { dayOfWeek: true, startTime: true, endTime: true, active: true },
    }),
    db.staffAvailabilityException.findMany({
      where: { clubId: args.clubId, userId: args.userId, date: { gte: dayFrom, lte: dayTo } },
      select: { date: true, type: true, startTime: true, endTime: true, note: true },
    }),
  ]);

  const busy: BusySlot[] = [];
  for (const r of classRows) {
    const s = r.session;
    busy.push({
      kind: "CLASS", id: s.id, name: s.recurringClass.name,
      startMs: wallClockUTCToInstant(s.startsAt, tz).getTime(), endMs: wallClockUTCToInstant(s.endsAt, tz).getTime(),
      date: toYmd(s.date), startTime: hhmmUTC(s.startsAt), endTime: hhmmUTC(s.endsAt),
    });
  }
  const instantSlot = (kind: BusySlot["kind"], id: string, name: string, start: Date, end: Date): BusySlot => {
    const a = instantToWallClock(start, tz);
    const b = instantToWallClock(end, tz);
    return { kind, id, name, startMs: start.getTime(), endMs: Math.max(end.getTime(), start.getTime()), date: a.date, startTime: a.time, endTime: b.time };
  };
  for (const r of eventRows) {
    const e = r.event;
    const parts = e.sessions.length > 0 ? e.sessions : [{ startsAt: e.startsAt, endsAt: e.endsAt }];
    for (const p of parts) busy.push(instantSlot("EVENT", e.id, e.name, p.startsAt, p.endsAt));
  }
  for (const l of lessons) {
    if (!l.confirmedStartAt || !l.confirmedEndAt) continue;
    busy.push(instantSlot("PRIVATE_LESSON", l.id, `Private lesson (${l.lessonType.title})`, l.confirmedStartAt, l.confirmedEndAt));
  }
  // A coach who has never saved any hours (and has no time off in range) is
  // not "outside their hours" — there is nothing to be outside of. Judging
  // them would put an availability warning on every single assignment.
  const hasHours = weekly.length > 0 || exceptions.length > 0;
  const conflicts = findStaffConflicts(proposed, busy, hasHours ? {
    slots: weekly,
    exceptions: exceptions.map((e) => ({ date: toYmd(e.date), type: e.type, startTime: e.startTime, endTime: e.endTime, note: e.note })),
  } : null);
  return { conflicts, summary: summarizeConflicts(conflicts), hasOverlap: conflicts.some((c) => c.severity === "overlap") };
}

/**
 * The conflict check for a RECURRING assignment: the next `weeks` (default 8)
 * weeks of this class's days from `fromDate` — every class day, or one weekday
 * — summarised ("Overlaps Evening Group on Wednesdays 6:00–7:00 PM (8 times)").
 * The class's own days are excluded (a coach already on it does not clash with
 * themself).
 */
export async function conflictsForRuleChange(
  args: { clubId: string; classId: string; userId: string; dayOfWeek: number | null; fromDate: string; weeks?: number },
  db: Db = prisma,
): Promise<ConflictCheck> {
  const cls = await db.recurringClass.findFirst({
    where: { id: args.classId, clubId: args.clubId, deletedAt: null },
    select: { daysOfWeek: true, startTime: true, endTime: true, dayOverrides: true, recurrenceStartDate: true, recurrenceEndDate: true, club: { select: { timezone: true } } },
  });
  if (!cls) throw new ClassStaffError("NOT_FOUND", "Class not found");
  const slots = ruleOccurrenceSlots(cls, args.dayOfWeek, args.fromDate, cls.club?.timezone ?? null, args.weeks ?? 8);
  return loadStaffConflicts({ clubId: args.clubId, userId: args.userId, slots, excludeClassIds: [args.classId] }, db);
}

// ── Switch-on ───────────────────────────────────────────────────────────────

export type SwitchOnResult = {
  clubId: string;
  clubName: string;
  date: string;
  /** Set when nothing may be done: the club is already switched on from a DIFFERENT date. */
  refused: string | null;
  /** The club already had this switch-on date before this run. */
  alreadyOn: boolean;
  plan: SwitchOnPlan;
  applied: boolean;
  written: { rules: number; rows: number; manualDays: number; settings: boolean };
};

/**
 * Switch one club on to the new assignment system from `date` (class days on
 * or after it). DRY RUN unless `apply`. See lib/classStaff.planSwitchOn for
 * exactly what is written; this adds the settings row's assignmentsStartOn.
 * One transaction per club; idempotent (a second run writes nothing); never
 * touches a class day before `date`; never changes the legacy columns.
 * Refuses (writes nothing) when the club is already switched on from another
 * date — moving the date is a decision, not a re-run.
 */
export async function runSwitchOn(args: { clubId: string; date: string; apply: boolean; byUserId?: string | null }): Promise<SwitchOnResult> {
  if (!isYmd(args.date)) throw new ClassStaffError("BAD_INPUT", "date must be YYYY-MM-DD");
  const club = await prisma.club.findUnique({ where: { id: args.clubId }, select: { id: true, name: true } });
  if (!club) throw new ClassStaffError("NOT_FOUND", "Club not found");
  const settings = await getScheduleSettings(args.clubId);
  const base: SwitchOnResult = {
    clubId: club.id, clubName: club.name, date: args.date, refused: null,
    alreadyOn: settings.assignmentsStartOn === args.date,
    plan: { rules: [], rows: [], manualSessionIds: [], perClass: [] },
    applied: false, written: { rules: 0, rows: 0, manualDays: 0, settings: false },
  };
  if (settings.assignmentsStartOn && settings.assignmentsStartOn !== args.date) {
    return { ...base, refused: `already switched on from ${settings.assignmentsStartOn}` };
  }
  const classes = await prisma.recurringClass.findMany({
    where: { clubId: args.clubId, deletedAt: null },
    select: { id: true, name: true, assignedStaffIds: true },
    orderBy: { name: "asc" },
  });
  const classIds = classes.map((c) => c.id);
  const [rules, sessions, staff] = await Promise.all([
    loadClassRules(prisma, classIds),
    classIds.length
      ? prisma.classSession.findMany({
          where: { clubId: args.clubId, classId: { in: classIds }, date: { gte: ymdToDate(args.date) } },
          select: { id: true, classId: true, date: true, staffOverride: true, staffManual: true, _count: { select: { staff: true } } },
          orderBy: { date: "asc" },
        })
      : Promise.resolve([]),
    prisma.user.findMany({ where: { clubId: args.clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null }, select: { id: true } }),
  ]);
  const plan = planSwitchOn({
    date: args.date,
    classes: classes.map((c) => ({ ...c, existingRules: rules.filter((r) => r.classId === c.id) })),
    sessions: sessions.map((s) => ({
      id: s.id, classId: s.classId, dateYmd: toYmd(s.date), staffOverride: s.staffOverride,
      staffManual: s.staffManual, existingRowCount: s._count.staff,
    })),
    validStaffIds: new Set(staff.map((u) => u.id)),
  });
  const result: SwitchOnResult = { ...base, plan };
  const needsSettings = settings.assignmentsStartOn !== args.date;
  if (!args.apply) return result;
  if (plan.rules.length === 0 && plan.rows.length === 0 && plan.manualSessionIds.length === 0 && !needsSettings) return { ...result, applied: true };

  const written = await prisma.$transaction(
    async (tx) => {
      if (plan.rules.length > 0) {
        await tx.classStaffRule.createMany({
          data: plan.rules.map((r) => ({
            clubId: args.clubId, classId: r.classId, userId: r.userId, roleName: null, dayOfWeek: null,
            effectiveFrom: ymdToDate(r.effectiveFrom), createdByUserId: args.byUserId ?? null,
          })),
        });
      }
      const touched = Array.from(new Set(plan.rules.map((r) => r.classId)));
      const made = touched.length > 0 ? await loadClassRules(tx, touched) : [];
      const ruleIdByKey = new Map(made.map((r) => [`${r.classId}:${r.userId}`, r.id]));
      let rows = 0;
      for (let i = 0; i < plan.rows.length; i += 1000) {
        const chunk = plan.rows.slice(i, i + 1000);
        const res = await tx.classSessionStaff.createMany({
          data: chunk.map((r) => ({
            clubId: args.clubId, sessionId: r.sessionId, userId: r.userId, roleName: null,
            kind: "REGULAR", status: "SCHEDULED", source: r.source,
            ruleId: r.ruleKey ? ruleIdByKey.get(r.ruleKey) ?? null : null,
            changedByUserId: args.byUserId ?? null,
          })),
          skipDuplicates: true,
        });
        rows += res.count;
      }
      let manualDays = 0;
      for (let i = 0; i < plan.manualSessionIds.length; i += 1000) {
        const res = await tx.classSession.updateMany({
          where: { id: { in: plan.manualSessionIds.slice(i, i + 1000) }, clubId: args.clubId },
          data: { staffManual: true },
        });
        manualDays += res.count;
      }
      if (needsSettings) {
        await tx.clubScheduleSettings.upsert({
          where: { clubId: args.clubId },
          update: { assignmentsStartOn: ymdToDate(args.date), updatedByUserId: args.byUserId ?? null },
          create: { clubId: args.clubId, assignmentsStartOn: ymdToDate(args.date), updatedByUserId: args.byUserId ?? null },
        });
      }
      return { rules: plan.rules.length, rows, manualDays, settings: needsSettings };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  return { ...result, applied: true, written };
}
