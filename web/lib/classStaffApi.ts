// Class coach assignments — what the API ROUTES share (stage 2).
//
// lib/classStaff.ts is the pure rules, lib/classStaffServer.ts the database
// writers (which check no permissions and send nothing), lib/classStaffNotify.ts
// the notices. This file is the thin layer the route handlers have in common:
//   classStaffErrorResponse(err)   ClassStaffError → the HTTP answer
//   STAFF_TX                       options for the ONE transaction a request opens
//   viewerFor(session)             the caller's LIVE powers (never the token's)
//   loadStaffingView(...)          the GET /api/classes/[id]/staffing payload
//   loadDayViewBySession(...)      the `day` every write endpoint answers with
//   seriesStaffPayload(...)        staffRules + currentStaff for class list/detail
//   checkConflicts(...)            the 409 STAFF_CONFLICT body (warnings)
//   userOnDay(...)                 "is this person coaching that class day?" (self rule for pay)
//
// PERMISSIONS ARE NOT CHECKED HERE. Every mutating handler calls its own live
// guard (scripts/permission-boundary-guard.ts judges each handler by itself).
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasPermissionLive, isOwnerLive } from "@/lib/apiGuard";
import { asDayOverrides, asIdList, classTimesForDay, effectiveClassStaff, hhmmUTC } from "@/lib/staffAssignments";
import { wallClockUTCToInstant } from "@/lib/datetime";
import {
  CLASS_STAFF_ROLES,
  clubTodayYmd,
  currentRuleStaff,
  currentRuleStaffIds,
  dowOfYmd,
  isSwitchedOn,
  maxYmd,
  proposedSlot,
  richStaffRows,
  roleLabel,
  rulesForDay,
  toYmd,
  ymdToDate,
  type DayStaffRow,
  type RichStaffRow,
  type StaffConflict,
  type StaffKind,
  type StaffRule,
  type StaffSource,
  type StaffStatus,
} from "@/lib/classStaff";
import {
  ClassStaffError,
  conflictsForRuleChange,
  getScheduleSettings,
  loadClassRules,
  loadStaffConflicts,
  type ClassStaffErrorCode,
} from "@/lib/classStaffServer";

/** One interactive transaction per request; rule changes regenerate weeks of class days, so not the 5s default. */
export const STAFF_TX = { timeout: 30_000, maxWait: 10_000 } as const;

const STATUS: Record<ClassStaffErrorCode, number> = {
  NOT_FOUND: 404,
  NOT_SWITCHED_ON: 409,
  INVALID_STAFF: 400,
  BAD_INPUT: 400,
  NOT_ON_DAY: 409,
  BAD_STATE: 409,
  ALREADY_ON_DAY: 409,
  DAY_ENDED: 409,
};

/** A ClassStaffError → `{ error, code }` with its status. Anything else → null (re-throw it). */
export function classStaffErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ClassStaffError || (err && typeof err === "object" && (err as { name?: string }).name === "ClassStaffError")) {
    const e = err as ClassStaffError;
    return NextResponse.json({ error: e.message, code: e.code }, { status: STATUS[e.code] ?? 400 });
  }
  return null;
}

/** The standard "this club has not been switched on" answer for the new write endpoints. */
export function notSwitchedOn(): NextResponse {
  return NextResponse.json(
    { error: "Coach assignments are not switched on for this class day yet.", code: "NOT_SWITCHED_ON" },
    { status: 409 },
  );
}

type Sess = { user?: { id?: string; role?: string; clubId?: string; permissions?: Record<string, unknown> | null } } | null;

export type Viewer = {
  userId: string;
  /** schedule:view — may see other people's rows and names. */
  seesAll: boolean;
  /** schedule:edit — assigns, fills, closes. */
  canManage: boolean;
  /** classes:edit — cancels a class day. */
  canCancel: boolean;
  /** finances:full — may choose "cancelled, paid" (the self rule is applied per day). */
  hasFinancesFull: boolean;
  /** finances:view — may see what each coach is paid for a class day. */
  hasFinancesView?: boolean;
  isOwner: boolean;
};

/** The caller's powers, read LIVE (database, 20s cache) — never from the token. */
export async function viewerFor(session: Sess): Promise<Viewer> {
  const [seesAll, canManage, canCancel, hasFinancesFull, hasFinancesView, isOwner] = await Promise.all([
    hasPermissionLive(session, "schedule", "view"),
    hasPermissionLive(session, "schedule", "edit"),
    hasPermissionLive(session, "classes", "edit"),
    hasPermissionLive(session, "finances", "full"),
    hasPermissionLive(session, "finances", "view"),
    isOwnerLive(session),
  ]);
  return { userId: session?.user?.id ?? "", seesAll, canManage, canCancel, hasFinancesFull, hasFinancesView, isOwner };
}

/** id → "First Last" for the given ids — removed staff included (history keeps their name). */
export async function namesFor(clubId: string, ids: readonly (string | null | undefined)[]): Promise<(id: string) => string> {
  const uniq = Array.from(new Set(ids.filter((x): x is string => typeof x === "string" && !!x)));
  const map = new Map<string, string>();
  if (uniq.length > 0) {
    const users = await prisma.user.findMany({
      where: { clubId, id: { in: uniq } },
      select: { id: true, firstName: true, lastName: true },
    });
    for (const u of users) map.set(u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "Staff member");
  }
  return (id: string) => map.get(id) ?? "Former staff";
}

const DAY_ROW_SELECT = {
  id: true, sessionId: true, userId: true, roleName: true, kind: true, status: true, source: true,
  ruleId: true, replacesStaffId: true, lateCallout: true, calledOutAt: true, calledOutByUserId: true,
  calloutReason: true, coverageFilledAt: true, coverageFilledByUserId: true, note: true,
} satisfies Prisma.ClassSessionStaffSelect;
const SESSION_VIEW_SELECT = {
  id: true, classId: true, clubId: true, date: true, startsAt: true, endsAt: true, canceled: true, note: true,
  staffOverride: true, staffManual: true,
  canceledAt: true, canceledByUserId: true, cancelReason: true, cancelNotifyAudience: true,
  cancelNotifiedCount: true, cancelPaid: true, cancelPaidByUserId: true, cancelPaidAt: true,
  staff: { select: DAY_ROW_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.ClassSessionSelect;

type ViewRow = Omit<DayStaffRow, "id" | "sessionId" | "source" | "ruleId"> & { id: string | null; source: StaffSource | "LEGACY" };
const synthetic = (userId: string, roleName: string | null, source: StaffSource | "LEGACY"): ViewRow => ({
  id: null, userId, roleName, kind: "REGULAR", status: "SCHEDULED", source, replacesStaffId: null, lateCallout: false,
  calledOutAt: null, calledOutByUserId: null, calloutReason: null, coverageFilledAt: null, coverageFilledByUserId: null, note: null,
});

export type CancelSummary = {
  canceledAt: string | null;
  canceledByUserId: string | null;
  canceledByName: string | null;
  reason: string | null;
  notifyAudience: string | null;
  notifiedCount: number | null;
  paid: boolean;
  paidByUserId: string | null;
  paidByName: string | null;
  paidAt: string | null;
};

type CancelCols = {
  canceled: boolean; canceledAt: Date | null; canceledByUserId: string | null; cancelReason: string | null;
  cancelNotifyAudience: string | null; cancelNotifiedCount: number | null; cancelPaid: boolean;
  cancelPaidByUserId: string | null; cancelPaidAt: Date | null;
};

/** The cancel audit of a class day (null when it is not canceled). */
export function cancelSummary(s: CancelCols, nameOf: (id: string) => string): CancelSummary | null {
  if (!s.canceled) return null;
  return {
    canceledAt: s.canceledAt ? s.canceledAt.toISOString() : null,
    canceledByUserId: s.canceledByUserId,
    canceledByName: s.canceledByUserId ? nameOf(s.canceledByUserId) : null,
    reason: s.cancelReason,
    notifyAudience: s.cancelNotifyAudience,
    notifiedCount: s.cancelNotifiedCount,
    paid: !!s.cancelPaid,
    paidByUserId: s.cancelPaidByUserId,
    paidByName: s.cancelPaidByUserId ? nameOf(s.cancelPaidByUserId) : null,
    paidAt: s.cancelPaidAt ? s.cancelPaidAt.toISOString() : null,
  };
}

export type RuleView = {
  id: string; userId: string; name: string; roleName: string | null; roleLabel: string;
  dayOfWeek: number | null; effectiveFrom: string; effectiveTo: string | null;
};
export type CurrentStaffView = {
  userId: string; name: string; roleName: string | null; roleLabel: string; dayOfWeek: number | null;
  /** Set for a switched-on club: when this assignment starts / is already set to end. */
  effectiveFrom?: string; effectiveTo?: string | null;
};

export function ruleViews(rules: readonly StaffRule[], nameOf: (id: string) => string): RuleView[] {
  return rules.map((r) => ({
    id: r.id, userId: r.userId, name: nameOf(r.userId), roleName: r.roleName, roleLabel: roleLabel(r.roleName),
    dayOfWeek: r.dayOfWeek, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
  }));
}
export function currentStaffViews(rules: readonly StaffRule[], asOfYmd: string, nameOf: (id: string) => string): CurrentStaffView[] {
  return currentRuleStaff(rules, asOfYmd).map((e) => ({
    userId: e.userId, name: nameOf(e.userId), roleName: e.roleName, roleLabel: roleLabel(e.roleName), dayOfWeek: e.dayOfWeek,
    effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo,
  }));
}

/**
 * Series-level coaches for the class list / detail responses.
 *   not switched on → switchedOn false, staffRules [], currentStaff = the
 *                     legacy list (every class day, no role), assignedStaffIds
 *                     untouched
 *   switched on     → staffRules = the class's live rules, currentStaff = who
 *                     the rules put on it now, and `assignedStaffIds` (what old
 *                     screens show and send back) = those coaches' ids. The
 *                     frozen column is returned as `legacyAssignedStaffIds`.
 */
export async function seriesStaffPayload(
  clubId: string,
  classes: readonly { id: string; assignedStaffIds: unknown }[],
  now: Date = new Date(),
): Promise<Map<string, { switchedOn: boolean; assignmentsStartOn: string | null; staffRules: RuleView[]; currentStaff: CurrentStaffView[]; assignedStaffIds: string[]; legacyAssignedStaffIds: string[] }>> {
  const out = new Map<string, { switchedOn: boolean; assignmentsStartOn: string | null; staffRules: RuleView[]; currentStaff: CurrentStaffView[]; assignedStaffIds: string[]; legacyAssignedStaffIds: string[] }>();
  if (classes.length === 0) return out;
  const settings = await getScheduleSettings(clubId);
  const startOn = settings.assignmentsStartOn;
  const rules = startOn ? await loadClassRules(prisma, classes.map((c) => c.id)) : [];
  const nameOf = await namesFor(clubId, [...rules.map((r) => r.userId), ...classes.flatMap((c) => asIdList(c.assignedStaffIds))]);
  let asOf = "";
  if (startOn) {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
    asOf = maxYmd(clubTodayYmd(club?.timezone ?? null, now), startOn);
  }
  for (const c of classes) {
    const legacy = asIdList(c.assignedStaffIds);
    if (!startOn) {
      out.set(c.id, {
        switchedOn: false, assignmentsStartOn: null, staffRules: [],
        currentStaff: legacy.map((userId) => ({ userId, name: nameOf(userId), roleName: null, roleLabel: roleLabel(null), dayOfWeek: null })),
        assignedStaffIds: legacy, legacyAssignedStaffIds: legacy,
      });
      continue;
    }
    const mine = rules.filter((r) => r.classId === c.id);
    const live = mine.filter((r) => r.effectiveTo === null || r.effectiveTo >= asOf);
    out.set(c.id, {
      switchedOn: true, assignmentsStartOn: startOn,
      staffRules: ruleViews(live, nameOf),
      currentStaff: currentStaffViews(mine, asOf, nameOf),
      assignedStaffIds: currentRuleStaffIds(mine, asOf),
      legacyAssignedStaffIds: legacy,
    });
  }
  return out;
}

export type DayView = {
  sessionId: string | null;
  date: string;
  /** false = no ClassSession row yet (rows are what the rules say). */
  exists: boolean;
  /** The class is scheduled on this weekday inside its recurrence window. */
  runsOnThisDay: boolean;
  /** true = on/after the switch-on date: rows are real and the new actions apply. */
  switched: boolean;
  /** Wall clock, HH:mm. */
  startTime: string;
  endTime: string;
  /** The real instants (ISO). */
  startsAt: string;
  endsAt: string;
  hasStarted: boolean;
  hasEnded: boolean;
  staffManual: boolean;
  note: string | null;
  canceled: boolean;
  cancel: CancelSummary | null;
  needsCoverage: boolean;
  rows: RichStaffRow[];
};

export type StaffingView = {
  switchedOn: boolean;
  assignmentsStartOn: string | null;
  class: {
    id: string; name: string; daysOfWeek: number[]; startTime: string; endTime: string;
    dayOverrides: { dayOfWeek: number; startTime: string; endTime: string }[];
    timezone: string | null;
    currentStaff: CurrentStaffView[];
  };
  rules: RuleView[];
  day: DayView;
  roles: typeof CLASS_STAFF_ROLES;
  defaults: {
    classCancelNotifyDefault: string;
    /**
     * Who is told when a coach calls out — the club's settings, WITHOUT names
     * (a coach who cannot see the roster still gets the sentence).
     */
    coverageNotify: { owners: boolean; managers: boolean; classStaff: boolean; roleNames: string[]; people: number };
  };
  viewer: {
    userId: string;
    canManage: boolean;
    canCancel: boolean;
    /** finances:full AND (owner OR not coaching this day) — the self rule. */
    canSetCancelPay: boolean;
    isOnDay: boolean;
    myRowId: string | null;
    myStatus: StaffStatus | null;
    canCallOut: boolean;
    canUndoCallOut: boolean;
    /** finances:view — the sheet may load "Pay for this day" (GET /api/classes/sessions/[id]/pay). */
    canSeePay?: boolean;
  };
};

/**
 * Everything the staffing sheet needs for one class on one calendar day.
 * null = no such class in this club. `forbidden` = the viewer has neither
 * schedule:view nor a row of their own on that day.
 * Without schedule:view the rows and rules are reduced to the viewer's own
 * (the shipped rule: no other person's name leaves the server).
 */
export async function loadStaffingView(
  clubId: string,
  classId: string,
  dateYmd: string,
  viewer: Viewer,
  now: Date = new Date(),
): Promise<{ view: StaffingView; forbidden: boolean } | null> {
  const cls = await prisma.recurringClass.findFirst({
    where: { id: classId, clubId, deletedAt: null },
    select: {
      id: true, name: true, daysOfWeek: true, startTime: true, endTime: true, dayOverrides: true, assignedStaffIds: true,
      recurrenceStartDate: true, recurrenceEndDate: true, club: { select: { timezone: true } },
    },
  });
  if (!cls) return null;
  const tz = cls.club?.timezone ?? null;
  const [settings, session] = await Promise.all([
    getScheduleSettings(clubId),
    prisma.classSession.findUnique({ where: { classId_date: { classId, date: ymdToDate(dateYmd) } }, select: SESSION_VIEW_SELECT }),
  ]);
  const startOn = settings.assignmentsStartOn;
  const rules = startOn ? await loadClassRules(prisma, classId) : [];
  const today = clubTodayYmd(tz, now);
  const asOf = startOn ? maxYmd(today, startOn) : today;
  const switched = isSwitchedOn(startOn, dateYmd);
  const dow = dowOfYmd(dateYmd);
  const classDays = Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number) : [];
  const recStart = toYmd(cls.recurrenceStartDate);
  const recEnd = cls.recurrenceEndDate ? toYmd(cls.recurrenceEndDate) : null;
  const runsOnThisDay = classDays.includes(dow) && dateYmd >= recStart && (!recEnd || dateYmd <= recEnd);

  let rows: ViewRow[];
  if (switched) {
    rows = session
      ? session.staff.map((r) => ({ ...r, kind: r.kind as StaffKind, status: r.status as StaffStatus, source: r.source as StaffSource }))
      : runsOnThisDay ? rulesForDay(rules, dateYmd).map((r) => synthetic(r.userId, r.roleName, "RULE")) : [];
  } else {
    const ids = session || runsOnThisDay ? effectiveClassStaff(asIdList(cls.assignedStaffIds), session?.staffOverride ?? null).staffIds : [];
    rows = ids.map((id) => synthetic(id, null, "LEGACY"));
  }
  const mine = rows.find((r) => r.userId === viewer.userId && r.status !== "REMOVED") ?? null;
  const isOnDay = !!mine;
  const liveRules = rules.filter((r) => r.effectiveTo === null || r.effectiveTo >= asOf);
  const shownRows = viewer.seesAll ? rows : rows.filter((r) => r.userId === viewer.userId);
  const shownRules = viewer.seesAll ? liveRules : liveRules.filter((r) => r.userId === viewer.userId);

  const nameOf = await namesFor(clubId, [
    ...rows.flatMap((r) => [r.userId, r.calledOutByUserId, r.coverageFilledByUserId]),
    ...rules.map((r) => r.userId),
    session?.canceledByUserId, session?.cancelPaidByUserId,
  ]);

  const t = session
    ? { startTime: hhmmUTC(session.startsAt), endTime: hhmmUTC(session.endsAt) }
    : classTimesForDay(cls.startTime, cls.endTime, cls.dayOverrides, dow);
  const slot = proposedSlot(dateYmd, t.startTime, t.endTime, tz);
  const startMs = session ? wallClockUTCToInstant(session.startsAt, tz).getTime() : slot.startMs;
  const endMs = session ? wallClockUTCToInstant(session.endsAt, tz).getTime() : slot.endMs;
  const hasStarted = startMs <= now.getTime();
  const hasEnded = endMs <= now.getTime();
  const canceled = !!session?.canceled;

  const day: DayView = {
    sessionId: session?.id ?? null, date: dateYmd, exists: !!session, runsOnThisDay, switched,
    startTime: t.startTime, endTime: t.endTime,
    startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(),
    hasStarted, hasEnded,
    staffManual: !!session?.staffManual, note: typeof session?.note === "string" && session.note ? session.note : null,
    canceled, cancel: session ? cancelSummary(session, nameOf) : null,
    needsCoverage: switched && rows.some((r) => r.status === "NEEDS_COVERAGE"),
    rows: richStaffRows(shownRows, nameOf),
  };
  const view: StaffingView = {
    switchedOn: !!startOn,
    assignmentsStartOn: startOn,
    class: {
      id: cls.id, name: cls.name, daysOfWeek: classDays, startTime: cls.startTime, endTime: cls.endTime,
      dayOverrides: asDayOverrides(cls.dayOverrides), timezone: tz,
      currentStaff: startOn
        ? currentStaffViews(viewer.seesAll ? rules : rules.filter((r) => r.userId === viewer.userId), asOf, nameOf)
        : asIdList(cls.assignedStaffIds).filter((id) => viewer.seesAll || id === viewer.userId)
            .map((userId) => ({ userId, name: nameOf(userId), roleName: null, roleLabel: roleLabel(null), dayOfWeek: null })),
    },
    rules: ruleViews(shownRules, nameOf),
    day,
    roles: CLASS_STAFF_ROLES,
    defaults: {
      classCancelNotifyDefault: settings.classCancelNotifyDefault,
      coverageNotify: {
        owners: settings.coverageNotifyOwners, managers: settings.coverageNotifyManagers, classStaff: settings.coverageNotifyClassStaff,
        roleNames: settings.coverageNotifyRoleNames, people: settings.coverageNotifyUserIds.length,
      },
    },
    viewer: {
      userId: viewer.userId,
      canManage: viewer.canManage,
      canCancel: viewer.canCancel,
      canSetCancelPay: viewer.hasFinancesFull && (viewer.isOwner || !isOnDay),
      isOnDay,
      myRowId: mine?.id ?? null,
      myStatus: mine?.status ?? null,
      canCallOut: switched && !!session && !canceled && !hasEnded && mine?.status === "SCHEDULED",
      canUndoCallOut: switched && !!session && mine?.status === "NEEDS_COVERAGE",
      canSeePay: !!viewer.hasFinancesView && switched && !!session,
    },
  };
  return { view, forbidden: !viewer.seesAll && !isOnDay };
}

/** The `day` block for a session id — what the write endpoints answer with. null if it is gone. */
export async function loadDayViewBySession(clubId: string, sessionId: string, viewer: Viewer, now: Date = new Date()): Promise<DayView | null> {
  const s = await prisma.classSession.findFirst({ where: { id: sessionId, clubId }, select: { classId: true, date: true } });
  if (!s) return null;
  const res = await loadStaffingView(clubId, s.classId, toYmd(s.date), viewer, now);
  return res?.view.day ?? null;
}

/**
 * Is this person coaching (or still attached to) that class day? Any row that
 * is not REMOVED on a post-switch day; the legacy list on a pre-switch day.
 * The self rule for "cancelled, paid": nobody but an owner decides pay for a
 * class day they are on.
 */
export async function userOnDay(clubId: string, sessionId: string, userId: string): Promise<boolean> {
  const s = await prisma.classSession.findFirst({
    where: { id: sessionId, clubId },
    select: { date: true, staffOverride: true, recurringClass: { select: { assignedStaffIds: true } }, staff: { select: { userId: true, status: true } } },
  });
  if (!s) return false;
  const settings = await getScheduleSettings(clubId);
  if (isSwitchedOn(settings.assignmentsStartOn, toYmd(s.date))) {
    return s.staff.some((r) => r.userId === userId && r.status !== "REMOVED");
  }
  return effectiveClassStaff(asIdList(s.recurringClass?.assignedStaffIds), s.staffOverride).staffIds.includes(userId);
}

export type ConflictReport = {
  /** Every warning, each tagged with the coach it is about. */
  conflicts: (StaffConflict & { userId: string; userName: string })[];
  /** Human lines, one coach per line prefix: "Adrian: Overlaps Evening Group on Wednesdays 6:00–7:00 PM (8 times)". */
  summary: string[];
  hasOverlap: boolean;
};

/**
 * The conflict check behind every assignment endpoint. WARNINGS: the route
 * answers 409 STAFF_CONFLICT unless the body carries acknowledgeConflicts.
 *   day  → one class day (the session being edited is excluded)
 *   rule → the next 8 weeks of the class's days (one weekday, or all of them)
 */
export async function checkConflicts(args: {
  clubId: string;
  userIds: readonly string[];
  target:
    | { kind: "day"; slot: { date: string; startTime: string; endTime: string }; excludeSessionId?: string | null }
    | { kind: "rule"; classId: string; dayOfWeek: number | null; fromDate: string };
}): Promise<ConflictReport> {
  const ids = Array.from(new Set(args.userIds));
  const report: ConflictReport = { conflicts: [], summary: [], hasOverlap: false };
  if (ids.length === 0) return report;
  const nameOf = await namesFor(args.clubId, ids);
  for (const userId of ids) {
    const t = args.target;
    const res = t.kind === "day"
      ? await loadStaffConflicts({ clubId: args.clubId, userId, slots: [t.slot], excludeSessionIds: t.excludeSessionId ? [t.excludeSessionId] : [] })
      : await conflictsForRuleChange({ clubId: args.clubId, classId: t.classId, userId, dayOfWeek: t.dayOfWeek, fromDate: t.fromDate });
    const userName = nameOf(userId);
    for (const c of res.conflicts) report.conflicts.push({ ...c, userId, userName });
    for (const line of res.summary) report.summary.push(`${userName}: ${line}`);
    if (res.hasOverlap) report.hasOverlap = true;
  }
  return report;
}

/** The 409 a conflicting assignment gets until the manager acknowledges it. */
export function conflictResponse(report: ConflictReport): NextResponse {
  return NextResponse.json(
    {
      error: "This would double-book or fall outside someone's available hours. Confirm to assign anyway.",
      code: "STAFF_CONFLICT",
      conflicts: report.conflicts,
      summary: report.summary,
      hasOverlap: report.hasOverlap,
    },
    { status: 409 },
  );
}
