// Class coach assignments, coverage and cancellation — the PURE half.
// No prisma, no IO: safe in client components, API routes and tests
// (scripts/class-staff-tests.ts). The database half is lib/classStaffServer.ts.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────
// Vocabulary
//   CLASS_STAFF_ROLES / DEFAULT_ROLE_LABEL / SUBSTITUTE_ROLE_NAME / roleLabel()
//       the standard role list. Roles are stored as FREE TEXT (the display
//       name); null shows as "Coach". A substitute row defaults to "Substitute".
//   StaffRule            a ClassStaffRule with dates as YYYY-MM-DD strings
//   DayStaffRow          a ClassSessionStaff row (one coach on one class day)
//   STAFF_STATUSES       SCHEDULED | NEEDS_COVERAGE | REPLACED | NO_SHOW | REMOVED
//
// The switch-on date (ClubScheduleSettings.assignmentsStartOn)
//   isSwitchedOn(startOn, dateYmd)        day >= startOn (null = never)
//   effectiveStaffForSession(...)         THE resolver. Before the switch-on
//       date it is exactly lib/staffAssignments.effectiveClassStaff (legacy
//       lists); on/after it the day's rows are the truth and "coaching" =
//       status SCHEDULED (a REPLACED / NEEDS_COVERAGE / NO_SHOW / REMOVED coach
//       is not returned; their SUBSTITUTE is).
//   sessionCountsForPay(...)              pre-switch: not canceled (unchanged).
//       post-switch: the day has ENDED and (not canceled OR cancelPaid).
//   makeStaffResolver({...}) → StaffResolver   the object readers hold for a
//       batch of sessions: isSwitched / rowsFor / forSession / forOccurrence /
//       countsForPay. Built by lib/classStaffServer.loadSessionStaffResolver.
//
// Recurring rules (ADDITIVE per coach)
//   rulesForDay(rules, dateYmd, dow?)     who the rules put on that day
//   planScopeChange({scope, ...})         exact rule/day mutations for
//       "this occurrence" | "this weekday going forward" | "all future"
//   planEndUserRules(rules, userId, date) take one coach off the recurring list
//   planDayEdit(rows, desired)            the day-level half of planScopeChange
//   planDayStaff({session, rules, rows})  materialization plan for ONE day
//
// Legacy columns
//   RecurringClass.assignedStaffIds is FROZEN at switch-on (the legacy record
//   for pre-switch days — never written again). Series-level display for a
//   switched-on club reads the rules: currentRuleStaff / currentRuleStaffIds.
//   legacyOverrideFor(scheduled, frozenSeries) → ClassSession.staffOverride,
//       still mirrored per day so legacy readers get the SCHEDULED set.
//   legacySeriesStaffIds(rules, asOf)     the distinct coaches the rules imply
//       (no longer written anywhere; kept for comparison/reporting)
//
// Stage 2 (API): describeScopeChange (the plan in words), calloutNotice /
//   lateCalloutBanner, coverageActionItems, richStaffRows, scheduleDayHref
//
// Coverage
//   isLateCallout(startInstant, now)      < 2h before the real start instant
//   pickCoverageRecipients(...)           who hears "needs coverage"
//
// Conflicts (warnings, never blocks)
//   proposedSlot / findStaffConflicts / summarizeConflicts / ruleOccurrenceSlots
//
// Cancellation audience
//   mergeAudience(audience, booked, classMembers) / groupRecipientsByEmail(rows)
//
// Switch-on
//   planSwitchOn(...)                     what scripts/switch-on-class-assignments.ts writes
//
// Days are calendar days as YYYY-MM-DD — the same wall-clock day
// ClassSession.date is stamped with (UTC midnight). Weekday = that date's
// getUTCDay(), never converted through the club timezone (lib/coverageQuery
// .sessionWeekday explains why). Only "has it started / ended / is it late"
// use real instants, via lib/datetime.wallClockUTCToInstant + Club.timezone.

import { asIdList, classTimesForDay } from "@/lib/staffAssignments";
import { tzOffsetMs, wallClockUTCToInstant } from "@/lib/datetime";
import { fitFor, type DateException, type WeeklySlot } from "@/lib/staffScheduleFit";

// ── Roles ───────────────────────────────────────────────────────────────────

export const CLASS_STAFF_ROLES = [
  { key: "LEAD_COACH", label: "Lead Coach" },
  { key: "ASSISTANT_COACH", label: "Assistant Coach" },
  { key: "SUBSTITUTE", label: "Substitute" },
  { key: "VOLUNTEER", label: "Volunteer" },
] as const;
export type ClassStaffRoleKey = (typeof CLASS_STAFF_ROLES)[number]["key"];

/** What a row with no role shows as. */
export const DEFAULT_ROLE_LABEL = "Coach";
/** The roleName a SUBSTITUTE row gets when none is given. */
export const SUBSTITUTE_ROLE_NAME = "Substitute";

/** Display text for a stored role name (null/blank → "Coach"). */
export function roleLabel(roleName: string | null | undefined): string {
  const t = (roleName ?? "").trim();
  return t || DEFAULT_ROLE_LABEL;
}

/** Trim; blank → null; capped at 60 characters. What gets stored. */
export function normalizeRoleName(roleName: string | null | undefined): string | null {
  const t = (roleName ?? "").trim().slice(0, 60);
  return t || null;
}

// ── Row vocabulary ──────────────────────────────────────────────────────────

export const STAFF_STATUSES = ["SCHEDULED", "NEEDS_COVERAGE", "REPLACED", "NO_SHOW", "REMOVED"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export type StaffKind = "REGULAR" | "SUBSTITUTE";
export type StaffSource = "RULE" | "MANUAL" | "BACKFILL";

export const CANCEL_AUDIENCES = ["BOOKED", "CLASS_MEMBERS", "BOTH", "NONE"] as const;
export type CancelAudience = (typeof CANCEL_AUDIENCES)[number];
export function isCancelAudience(v: unknown): v is CancelAudience {
  return typeof v === "string" && (CANCEL_AUDIENCES as readonly string[]).includes(v);
}

export type StaffRule = {
  id: string;
  classId: string;
  userId: string;
  roleName: string | null;
  /** null = every class day; 0–6 = that weekday only. */
  dayOfWeek: number | null;
  /** YYYY-MM-DD, inclusive. */
  effectiveFrom: string;
  /** YYYY-MM-DD, inclusive; null = open-ended. */
  effectiveTo: string | null;
};

export type DayStaffRow = {
  id: string;
  sessionId: string;
  userId: string;
  roleName: string | null;
  kind: StaffKind;
  status: StaffStatus;
  source: StaffSource;
  ruleId: string | null;
  replacesStaffId: string | null;
  lateCallout: boolean;
  calledOutAt?: Date | string | null;
  calledOutByUserId?: string | null;
  calloutReason?: string | null;
  coverageFilledAt?: Date | string | null;
  coverageFilledByUserId?: string | null;
  note?: string | null;
};

// ── Calendar-day helpers (UTC, like ClassSession.date) ──────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isYmd(v: unknown): v is string {
  return typeof v === "string" && YMD_RE.test(v) && Number.isFinite(ymdMs(v));
}
function ymdMs(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}
/** A Date (UTC-midnight day stamp or @db.Date) or string → YYYY-MM-DD. */
export function toYmd(d: Date | string): string {
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}
/** YYYY-MM-DD → the UTC-midnight Date ClassSession.date / @db.Date columns use. */
export function ymdToDate(ymd: string): Date {
  return new Date(ymdMs(ymd));
}
export function addDaysYmd(ymd: string, days: number): string {
  return new Date(ymdMs(ymd) + days * 86400000).toISOString().slice(0, 10);
}
/** Weekday (0=Sun) of a calendar day. */
export function dowOfYmd(ymd: string): number {
  return new Date(ymdMs(ymd)).getUTCDay();
}
export function maxYmd(...days: (string | null | undefined)[]): string {
  const real = days.filter((d): d is string => !!d);
  return real.reduce((a, b) => (a >= b ? a : b));
}
/**
 * Today's calendar day on the club's wall clock. Without a (valid) timezone it
 * is the UTC day — the same fallback lib/payReminders.clubTodayYmd uses.
 */
export function clubTodayYmd(timeZone: string | null | undefined, at: Date = new Date()): string {
  if (timeZone) {
    try {
      return new Date(at.getTime() + tzOffsetMs(timeZone, at)).toISOString().slice(0, 10);
    } catch {
      // invalid timezone — fall through
    }
  }
  return at.toISOString().slice(0, 10);
}

// ── Switch-on date + THE resolver ───────────────────────────────────────────

/** Does the new assignment system own this class day? (null start = not switched on) */
export function isSwitchedOn(assignmentsStartOn: string | null | undefined, dateYmd: string): boolean {
  return !!assignmentsStartOn && dateYmd.slice(0, 10) >= assignmentsStartOn.slice(0, 10);
}

/** The user ids actually coaching: SCHEDULED rows, in row order, no duplicates. */
export function coachingUserIds(rows: readonly Pick<DayStaffRow, "userId" | "status">[]): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.status === "SCHEDULED" && !out.includes(r.userId)) out.push(r.userId);
  return out;
}

export type EffectiveStaffRow = {
  /** null for a legacy (pre-switch) day — there is no row. */
  id: string | null;
  userId: string;
  roleName: string | null;
  kind: StaffKind;
  status: StaffStatus;
  source: StaffSource | "LEGACY";
  replacesStaffId: string | null;
  lateCallout: boolean;
  calledOutAt: Date | string | null;
  calloutReason: string | null;
};

export type EffectiveStaff = {
  /** true = this day is on/after the switch-on date and `rows` are real rows. */
  switched: boolean;
  /** Who is coaching (legacy shape — what every pre-existing reader wants). */
  staffIds: string[];
  /** A one-day change is in effect (legacy: an override; switched: a hand edit, a sub, or an open call-out). */
  isSubstitute: boolean;
  /** The recurring coaches for the day (legacy: the series list; switched: REGULAR rows that came from a rule). */
  seriesStaffIds: string[];
  /** Every row, any status. Legacy days: one synthetic SCHEDULED row per coach. */
  rows: EffectiveStaffRow[];
  /** At least one coach on this day is waiting for cover. */
  needsCoverage: boolean;
};

/**
 * THE resolver for "who is on this class day".
 *
 *   before the switch-on date (or never switched on)
 *       → exactly lib/staffAssignments.effectiveClassStaff(series, override)
 *   on/after it
 *       → the day's ClassSessionStaff rows. No rows = nobody.
 */
export function effectiveStaffForSession(args: {
  assignmentsStartOn: string | null | undefined;
  dateYmd: string;
  /** This session's ClassSessionStaff rows (ignored for a legacy day). */
  rows: readonly DayStaffRow[];
  /** RecurringClass.assignedStaffIds. */
  seriesStaffIds: unknown;
  /** ClassSession.staffOverride. */
  staffOverride: unknown;
  /** ClassSession.staffManual. */
  staffManual?: boolean | null;
}): EffectiveStaff {
  if (!isSwitchedOn(args.assignmentsStartOn, args.dateYmd)) {
    // Same branches as effectiveClassStaff — kept inline so this file has the
    // whole rule in one place; scripts/class-staff-tests.ts pins them equal.
    const series = asIdList(args.seriesStaffIds);
    const isOverride = Array.isArray(args.staffOverride);
    const staffIds = isOverride ? asIdList(args.staffOverride) : series;
    return {
      switched: false,
      staffIds,
      isSubstitute: isOverride,
      seriesStaffIds: series,
      rows: staffIds.map((userId) => ({
        id: null, userId, roleName: null, kind: "REGULAR", status: "SCHEDULED", source: "LEGACY",
        replacesStaffId: null, lateCallout: false, calledOutAt: null, calloutReason: null,
      })),
      needsCoverage: false,
    };
  }
  const rows = args.rows;
  return {
    switched: true,
    staffIds: coachingUserIds(rows),
    isSubstitute:
      !!args.staffManual || rows.some((r) => r.kind === "SUBSTITUTE" || r.status !== "SCHEDULED" || r.source === "MANUAL"),
    seriesStaffIds: Array.from(new Set(rows.filter((r) => r.kind === "REGULAR" && r.source === "RULE").map((r) => r.userId))),
    rows: rows.map((r) => ({
      id: r.id, userId: r.userId, roleName: r.roleName, kind: r.kind, status: r.status, source: r.source,
      replacesStaffId: r.replacesStaffId, lateCallout: r.lateCallout,
      calledOutAt: r.calledOutAt ?? null, calloutReason: r.calloutReason ?? null,
    })),
    needsCoverage: rows.some((r) => r.status === "NEEDS_COVERAGE"),
  };
}

/** Has this class day's END passed, in the club's real time? */
export function classHasEnded(endsAt: Date | string, timeZone: string | null | undefined, now: Date = new Date()): boolean {
  return wallClockUTCToInstant(endsAt, timeZone).getTime() <= now.getTime();
}

/**
 * Does a class day count toward class pay?
 *   pre-switch day   not canceled — today's rule, deliberately unchanged, so
 *                    numbers for days before the switch-on date do not move.
 *   post-switch day  its END has passed (future occurrences never pay) AND
 *                    it was not canceled, or it was canceled "but paid".
 * WHO is paid for a counting day is effectiveStaffForSession().staffIds.
 */
export function sessionCountsForPay(s: {
  switched: boolean;
  canceled: boolean;
  cancelPaid?: boolean | null;
  ended: boolean;
}): boolean {
  if (!s.switched) return !s.canceled;
  if (!s.ended) return false;
  return !s.canceled || !!s.cancelPaid;
}

// ── Recurring rules ─────────────────────────────────────────────────────────

/** Is the rule in force on this calendar day (weekday not considered)? */
export function ruleInForce(rule: Pick<StaffRule, "effectiveFrom" | "effectiveTo">, dateYmd: string): boolean {
  return rule.effectiveFrom <= dateYmd && (rule.effectiveTo === null || dateYmd <= rule.effectiveTo);
}

export type RuleStaff = { userId: string; roleName: string | null; ruleId: string };

/**
 * Who the rules put on one class day. ADDITIVE per coach: a coach is on the
 * day when they hold a rule in force that day with dayOfWeek null or equal to
 * the day's weekday. A weekday rule does NOT replace other coaches' rules.
 * When one coach holds several matching rules, one wins (for the role): the
 * weekday-specific rule, then the later effectiveFrom, then the higher id.
 * Order = first appearance in `rules`.
 */
export function rulesForDay(rules: readonly StaffRule[], dateYmd: string, dayOfWeek: number = dowOfYmd(dateYmd)): RuleStaff[] {
  const best = new Map<string, StaffRule>();
  const order: string[] = [];
  for (const r of rules) {
    if (!ruleInForce(r, dateYmd)) continue;
    if (r.dayOfWeek !== null && r.dayOfWeek !== dayOfWeek) continue;
    const cur = best.get(r.userId);
    if (!cur) {
      best.set(r.userId, r);
      order.push(r.userId);
      continue;
    }
    const a = [r.dayOfWeek !== null ? 1 : 0, r.effectiveFrom, r.id] as const;
    const b = [cur.dayOfWeek !== null ? 1 : 0, cur.effectiveFrom, cur.id] as const;
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best.set(r.userId, r);
  }
  return order.map((userId) => {
    const r = best.get(userId)!;
    return { userId, roleName: r.roleName, ruleId: r.id };
  });
}

export type DesiredStaff = {
  userId: string;
  /** undefined = keep whatever role they already have (new people get none). */
  roleName?: string | null;
};

export type RuleOp =
  | { op: "end"; ruleId: string; effectiveTo: string }
  | { op: "delete"; ruleId: string }
  | { op: "create"; userId: string; roleName: string | null; dayOfWeek: number | null; effectiveFrom: string; effectiveTo: string | null };

export type DayOp =
  /** A new row: kind REGULAR, source MANUAL, status SCHEDULED. */
  | { op: "create"; userId: string; roleName: string | null }
  /** A row that is not SCHEDULED goes back on: SCHEDULED, REGULAR, MANUAL, call-out fields cleared. */
  | { op: "restore"; rowId: string; userId: string; roleName: string | null }
  | { op: "role"; rowId: string; userId: string; roleName: string | null }
  /** SCHEDULED → REMOVED (kept, never deleted: it is the record that they were taken off). */
  | { op: "remove"; rowId: string; userId: string }
  /** REPLACED → NEEDS_COVERAGE: the substitute covering this coach was taken off. */
  | { op: "reopen"; rowId: string; userId: string };

export type ScopeChangePlan = { ruleOps: RuleOp[]; dayOps: DayOp[] };
export type ChangeScope = "OCCURRENCE" | "WEEKDAY_FORWARD" | "ALL_FUTURE";

function cleanDesired(desired: readonly DesiredStaff[]): DesiredStaff[] {
  const seen = new Set<string>();
  const out: DesiredStaff[] = [];
  for (const d of desired) {
    if (!d || typeof d.userId !== "string" || !d.userId || seen.has(d.userId)) continue;
    seen.add(d.userId);
    out.push(d.roleName === undefined ? { userId: d.userId } : { userId: d.userId, roleName: normalizeRoleName(d.roleName) });
  }
  return out;
}

/**
 * One class day's coach list → exactly `desired` (the SCHEDULED set).
 *   - SCHEDULED and not wanted            → remove (status REMOVED)
 *   - wanted, has a non-SCHEDULED row     → restore (one row per coach per day)
 *   - wanted, no row                      → create
 *   - wanted, role differs                → role
 *   - a REPLACED coach whose substitute is no longer on the day → reopen
 *     (back to NEEDS_COVERAGE), unless the same edit restores them.
 * NEEDS_COVERAGE / NO_SHOW rows of people not in `desired` are left alone.
 */
export function planDayEdit(currentRows: readonly DayStaffRow[], desiredIn: readonly DesiredStaff[]): DayOp[] {
  const desired = cleanDesired(desiredIn);
  const want = new Map(desired.map((d) => [d.userId, d]));
  const ops: DayOp[] = [];
  const finalStatus = new Map<string, StaffStatus>(currentRows.map((r) => [r.id, r.status]));
  const restored = new Set<string>();
  for (const r of currentRows) {
    const d = want.get(r.userId);
    if (r.status === "SCHEDULED") {
      if (!d) {
        ops.push({ op: "remove", rowId: r.id, userId: r.userId });
        finalStatus.set(r.id, "REMOVED");
      } else if (d.roleName !== undefined && d.roleName !== r.roleName) {
        ops.push({ op: "role", rowId: r.id, userId: r.userId, roleName: d.roleName });
      }
    } else if (d) {
      ops.push({ op: "restore", rowId: r.id, userId: r.userId, roleName: d.roleName === undefined ? (r.kind === "SUBSTITUTE" ? null : r.roleName) : d.roleName });
      finalStatus.set(r.id, "SCHEDULED");
      restored.add(r.id);
    }
  }
  const have = new Set(currentRows.map((r) => r.userId));
  for (const d of desired) {
    if (!have.has(d.userId)) ops.push({ op: "create", userId: d.userId, roleName: d.roleName ?? null });
  }
  // A restored SUBSTITUTE row becomes a plain REGULAR row, so it no longer covers anyone.
  for (const r of currentRows) {
    if (r.status !== "REPLACED" || restored.has(r.id)) continue;
    const stillCovered = currentRows.some(
      (s) => s.kind === "SUBSTITUTE" && s.replacesStaffId === r.id && !restored.has(s.id) && finalStatus.get(s.id) !== "REMOVED",
    );
    if (!stillCovered) ops.push({ op: "reopen", rowId: r.id, userId: r.userId });
  }
  return ops;
}

function endOrDelete(r: StaffRule, date: string): RuleOp {
  return r.effectiveFrom >= date ? { op: "delete", ruleId: r.id } : { op: "end", ruleId: r.id, effectiveTo: addDaysYmd(date, -1) };
}

/**
 * The exact mutations for a coach-list change at one of the three scopes.
 *
 *   OCCURRENCE       this class day only → dayOps (planDayEdit). No rule changes.
 *
 *   WEEKDAY_FORWARD  "this weekday going forward": from `date` on, the
 *                    recurring coaches on `dayOfWeek` are exactly `desired`.
 *                    A coach's rule that already says so (in force on `date`,
 *                    open-ended, same role) is kept. Every other rule touching
 *                    that weekday is cut from `date`:
 *                      weekday rule  → ended the day before (deleted if it had
 *                                      not started yet)
 *                      all-days rule → ended the day before, and re-opened from
 *                                      `date` as one rule per OTHER class
 *                                      weekday, so that coach keeps the rest of
 *                                      their week
 *                    then a weekday rule from `date` is opened for each desired
 *                    coach without a kept rule.
 *                    Example — "Sal off Tuesdays from Oct 20, Adrian on": Sal's
 *                    all-days rule ends Oct 19; Sal gets Mon + Thu rules from
 *                    Oct 20; Adrian gets a Tuesday rule from Oct 20.
 *
 *   ALL_FUTURE       from `date` on, every class day is exactly `desired`:
 *                    all-days rules that already say so are kept, every other
 *                    rule (weekday rules included) is ended/deleted, and an
 *                    all-days rule from `date` is opened for the rest.
 *
 * Rule scopes return no dayOps: lib/classStaffServer.syncSessionStaff then
 * regenerates the class days from today forward that nobody edited by hand.
 * A role change is a cut + a new rule, so earlier days keep the old role.
 *
 * `classDays` = RecurringClass.daysOfWeek. Known limit of the weekday split: a
 * coach split into per-weekday rules does not automatically join a weekday the
 * class adds later.
 */
export function planScopeChange(args: {
  scope: ChangeScope;
  classDays: readonly number[];
  /** The occurrence's day (OCCURRENCE) / the first day the change applies (rule scopes). */
  date: string;
  /** WEEKDAY_FORWARD only; defaults to the weekday of `date`. */
  dayOfWeek?: number;
  currentRules: readonly StaffRule[];
  /** That day's ClassSessionStaff rows (OCCURRENCE only). */
  currentDayStaff: readonly DayStaffRow[];
  desired: readonly DesiredStaff[];
}): ScopeChangePlan {
  const date = args.date.slice(0, 10);
  if (args.scope === "OCCURRENCE") return { ruleOps: [], dayOps: planDayEdit(args.currentDayStaff, args.desired) };

  const desired = cleanDesired(args.desired);
  const want = new Map(desired.map((d) => [d.userId, d]));
  const live = args.currentRules.filter((r) => r.effectiveTo === null || r.effectiveTo >= date);
  const ruleOps: RuleOp[] = [];
  const kept = new Set<string>();
  const currentRole = (userId: string): string | null => {
    const now = rulesForDay(args.currentRules, date, args.scope === "WEEKDAY_FORWARD" ? (args.dayOfWeek ?? dowOfYmd(date)) : dowOfYmd(date));
    return now.find((x) => x.userId === userId)?.roleName ?? live.find((r) => r.userId === userId)?.roleName ?? null;
  };
  const roleFor = (d: DesiredStaff): string | null => (d.roleName === undefined ? currentRole(d.userId) : d.roleName);
  const says = (r: StaffRule): boolean => {
    const d = want.get(r.userId);
    return !!d && r.effectiveFrom <= date && r.effectiveTo === null && r.roleName === roleFor(d);
  };

  if (args.scope === "ALL_FUTURE") {
    for (const r of live) {
      if (r.dayOfWeek === null && says(r)) kept.add(r.userId);
    }
    for (const r of live) {
      if (r.dayOfWeek === null && says(r)) continue;
      ruleOps.push(endOrDelete(r, date));
    }
    for (const d of desired) {
      if (kept.has(d.userId)) continue;
      ruleOps.push({ op: "create", userId: d.userId, roleName: roleFor(d), dayOfWeek: null, effectiveFrom: date, effectiveTo: null });
    }
    return { ruleOps, dayOps: [] };
  }

  // WEEKDAY_FORWARD
  const dow = args.dayOfWeek ?? dowOfYmd(date);
  const touching = live.filter((r) => r.dayOfWeek === null || r.dayOfWeek === dow);
  // A coach holding both an all-days and a weekday rule: whichever already
  // says what is wanted is kept and the other is cut below, so the kept one
  // decides their role from `date` on.
  const roles = new Map(desired.map((d) => [d.userId, roleFor(d)]));
  for (const r of touching) if (says(r)) kept.add(r.userId);
  const otherDays = Array.from(new Set(args.classDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6 && d !== dow))).sort((a, b) => a - b);
  for (const r of touching) {
    if (says(r)) continue;
    ruleOps.push(endOrDelete(r, date));
    if (r.dayOfWeek === null) {
      const from = r.effectiveFrom > date ? r.effectiveFrom : date;
      for (const d of otherDays) {
        ruleOps.push({ op: "create", userId: r.userId, roleName: r.roleName, dayOfWeek: d, effectiveFrom: from, effectiveTo: r.effectiveTo });
      }
    }
  }
  for (const d of desired) {
    if (kept.has(d.userId)) continue;
    ruleOps.push({ op: "create", userId: d.userId, roleName: roles.get(d.userId) ?? null, dayOfWeek: dow, effectiveFrom: date, effectiveTo: null });
  }
  return { ruleOps, dayOps: [] };
}

/**
 * Take ONE coach off the recurring list from `date` (every weekday), leaving
 * everyone else's rules alone — "take me off every week", or a coach leaving
 * the club. Rules that had not started are deleted; the rest end the day before.
 */
export function planEndUserRules(currentRules: readonly StaffRule[], userId: string, date: string): RuleOp[] {
  const d = date.slice(0, 10);
  return currentRules
    .filter((r) => r.userId === userId && (r.effectiveTo === null || r.effectiveTo >= d))
    .map((r) => endOrDelete(r, d));
}

/** Rules after applying ops — for previews and tests. Created rules get ids `new1`, `new2`, … */
export function applyRuleOps(rules: readonly StaffRule[], ops: readonly RuleOp[], classId = rules[0]?.classId ?? ""): StaffRule[] {
  let out = rules.map((r) => ({ ...r }));
  let n = 0;
  for (const op of ops) {
    if (op.op === "delete") out = out.filter((r) => r.id !== op.ruleId);
    else if (op.op === "end") out = out.map((r) => (r.id === op.ruleId ? { ...r, effectiveTo: op.effectiveTo } : r));
    else out.push({ id: `new${++n}`, classId, userId: op.userId, roleName: op.roleName, dayOfWeek: op.dayOfWeek, effectiveFrom: op.effectiveFrom, effectiveTo: op.effectiveTo });
  }
  return out;
}

// ── Materialization: rules → one day's rows ─────────────────────────────────

export type DayStaffPlan = {
  create: { userId: string; roleName: string | null; ruleId: string }[];
  update: { id: string; roleName: string | null; ruleId: string }[];
  deleteIds: string[];
};

/** A row the rules may regenerate. Everything else is somebody's decision or a coverage record. */
export function isRuleManaged(r: Pick<DayStaffRow, "source" | "kind" | "status">): boolean {
  return r.source === "RULE" && r.kind === "REGULAR" && r.status === "SCHEDULED";
}

/**
 * Make one class day's rows equal what the rules say — touching ONLY
 * rule-managed rows (source RULE, kind REGULAR, status SCHEDULED).
 * Never plans anything for a day edited by hand (staffManual) or one that has
 * ended, and never deletes or alters a NEEDS_COVERAGE / REPLACED / NO_SHOW /
 * REMOVED row, a SUBSTITUTE, or a MANUAL row. A coach the rules want who
 * already has such a protected row is left exactly as they are.
 */
export function planDayStaff(args: {
  session: { dateYmd: string; staffManual: boolean; ended: boolean };
  rules: readonly StaffRule[];
  existingRows: readonly DayStaffRow[];
}): DayStaffPlan {
  const plan: DayStaffPlan = { create: [], update: [], deleteIds: [] };
  if (args.session.staffManual || args.session.ended) return plan;
  const want = rulesForDay(args.rules, args.session.dateYmd);
  const wantIds = new Set(want.map((w) => w.userId));
  const byUser = new Map(args.existingRows.map((r) => [r.userId, r]));
  for (const w of want) {
    const row = byUser.get(w.userId);
    if (!row) plan.create.push(w);
    else if (isRuleManaged(row) && (row.roleName !== w.roleName || row.ruleId !== w.ruleId)) {
      plan.update.push({ id: row.id, roleName: w.roleName, ruleId: w.ruleId });
    }
  }
  for (const r of args.existingRows) {
    if (isRuleManaged(r) && !wantIds.has(r.userId)) plan.deleteIds.push(r.id);
  }
  return plan;
}

// ── Legacy mirror (dual-write) ──────────────────────────────────────────────

/**
 * NOT WRITTEN ANYWHERE since stage 2: RecurringClass.assignedStaffIds is frozen
 * at switch-on. What this computes is what the column WOULD say — the distinct
 * coaches holding a rule in force on `asOfYmd`, ANY weekday (weekday rules and
 * all-days rules alike), in rule order. If no rule is in force yet but some
 * start later (a class that begins next month), the earliest start is used
 * instead of `asOfYmd` so the list is not blank until then.
 * Documented approximation: the legacy column has no weekday or date
 * dimension, so a coach who is on Tuesdays only is listed for the class.
 * Exact per-day truth for legacy readers comes from legacyOverrideFor.
 */
export function legacySeriesStaffIds(rules: readonly StaffRule[], asOfYmd: string): string[] {
  const asOf = asOfYmd.slice(0, 10);
  const open = rules.filter((r) => r.effectiveTo === null || r.effectiveTo >= asOf);
  let day = asOf;
  if (!open.some((r) => r.effectiveFrom <= asOf) && open.length > 0) {
    day = open.reduce((m, r) => (r.effectiveFrom < m ? r.effectiveFrom : m), open[0].effectiveFrom);
  }
  const out: string[] = [];
  for (const r of open) if (ruleInForce(r, day) && !out.includes(r.userId)) out.push(r.userId);
  return out;
}

/**
 * The value dual-written to ClassSession.staffOverride for a class day on or
 * after the switch-on date:
 *   null  when the day's SCHEDULED coaches are the same SET as the series
 *         list (RecurringClass.assignedStaffIds, frozen at switch-on) — a
 *         legacy reader inheriting the series is right
 *   list  otherwise — the SCHEDULED coaches, exactly ([] = nobody)
 * So legacy effectiveClassStaff(assignedStaffIds, staffOverride) returns the
 * true SCHEDULED set for every post-switch day, weekday rules included.
 */
export function legacyOverrideFor(scheduledIds: readonly string[], seriesIds: readonly string[]): string[] | null {
  const a = new Set(scheduledIds);
  const b = new Set(seriesIds);
  if (a.size === b.size && Array.from(a).every((x) => b.has(x))) return null;
  return Array.from(a);
}

// ── Coverage ────────────────────────────────────────────────────────────────

export const LATE_CALLOUT_MS = 2 * 60 * 60 * 1000;

/** The real instant a class day starts (ClassSession.startsAt is wall clock stamped as UTC). */
export function classStartInstant(startsAt: Date | string, timeZone: string | null | undefined): Date {
  return wallClockUTCToInstant(startsAt, timeZone);
}

/**
 * Late = the call-out lands LESS than 2 hours before the real start instant
 * (exactly 2 hours is not late; after the start is late). A call-out is never
 * blocked for being late — it is only flagged.
 */
export function isLateCallout(startInstant: Date, now: Date, windowMs: number = LATE_CALLOUT_MS): boolean {
  return startInstant.getTime() - now.getTime() < windowMs;
}

export type ScheduleSettings = {
  coverageNotifyOwners: boolean;
  coverageNotifyManagers: boolean;
  coverageNotifyClassStaff: boolean;
  coverageNotifyRoleNames: string[];
  coverageNotifyUserIds: string[];
  coverageChannels: string[];
  classCancelNotifyDefault: CancelAudience;
  /** YYYY-MM-DD or null. Branch 2. */
  payLedgerStartsOn: string | null;
  /** YYYY-MM-DD or null = not switched on. */
  assignmentsStartOn: string | null;
};

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  coverageNotifyOwners: true,
  coverageNotifyManagers: true,
  coverageNotifyClassStaff: true,
  coverageNotifyRoleNames: [],
  coverageNotifyUserIds: [],
  coverageChannels: ["IN_APP", "EMAIL"],
  classCancelNotifyDefault: "BOOKED",
  payLedgerStartsOn: null,
  assignmentsStartOn: null,
};

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))) : [];

/** A club_schedule_settings row (or null) → clean settings with defaults. */
export function normalizeScheduleSettings(row: Record<string, unknown> | null | undefined): ScheduleSettings {
  if (!row) return { ...DEFAULT_SCHEDULE_SETTINGS, coverageChannels: [...DEFAULT_SCHEDULE_SETTINGS.coverageChannels] };
  const day = (v: unknown): string | null => {
    if (Object.prototype.toString.call(v) === "[object Date]") return toYmd(v as Date);
    return typeof v === "string" && isYmd(v.slice(0, 10)) ? v.slice(0, 10) : null;
  };
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const channels = strList(row.coverageChannels);
  return {
    coverageNotifyOwners: bool(row.coverageNotifyOwners, true),
    coverageNotifyManagers: bool(row.coverageNotifyManagers, true),
    coverageNotifyClassStaff: bool(row.coverageNotifyClassStaff, true),
    coverageNotifyRoleNames: strList(row.coverageNotifyRoleNames),
    coverageNotifyUserIds: strList(row.coverageNotifyUserIds),
    coverageChannels: channels.length ? channels : ["IN_APP", "EMAIL"],
    classCancelNotifyDefault: isCancelAudience(row.classCancelNotifyDefault) ? row.classCancelNotifyDefault : "BOOKED",
    payLedgerStartsOn: day(row.payLedgerStartsOn),
    assignmentsStartOn: day(row.assignmentsStartOn),
  };
}

export type CoverageStaffUser = {
  id: string;
  role: string;
  /** OWNER, or STAFF holding schedule:edit — resolved by the caller with lib/permissions.hasPermission. */
  canManageSchedule: boolean;
};

/**
 * Who is told a class day needs coverage. Any combination of: owners, schedule
 * managers, the other coaches SCHEDULED on that day, anyone whose role on that
 * day or on the class's current rules matches a configured role name
 * (case-insensitive), and named people. Only current staff (`staff` is the
 * club's live OWNER/STAFF list), never `excludingUserId` (the coach who called
 * out), no duplicates.
 */
export function pickCoverageRecipients(args: {
  settings: Pick<ScheduleSettings, "coverageNotifyOwners" | "coverageNotifyManagers" | "coverageNotifyClassStaff" | "coverageNotifyRoleNames" | "coverageNotifyUserIds">;
  staff: readonly CoverageStaffUser[];
  dayRows: readonly Pick<DayStaffRow, "userId" | "roleName" | "status">[];
  /** Rules in force for the class on that day (any weekday). */
  classRules: readonly Pick<StaffRule, "userId" | "roleName">[];
  excludingUserId?: string | null;
}): string[] {
  const s = args.settings;
  const pick = new Set<string>();
  if (s.coverageNotifyOwners) for (const u of args.staff) if (u.role === "OWNER") pick.add(u.id);
  if (s.coverageNotifyManagers) for (const u of args.staff) if (u.role === "OWNER" || u.canManageSchedule) pick.add(u.id);
  if (s.coverageNotifyClassStaff) for (const r of args.dayRows) if (r.status === "SCHEDULED") pick.add(r.userId);
  const roles = new Set(s.coverageNotifyRoleNames.map((r) => r.trim().toLowerCase()).filter(Boolean));
  if (roles.size > 0) {
    const matches = (roleName: string | null) => roles.has(roleLabel(roleName).toLowerCase());
    for (const r of args.dayRows) if (r.status === "SCHEDULED" && matches(r.roleName)) pick.add(r.userId);
    for (const r of args.classRules) if (matches(r.roleName)) pick.add(r.userId);
  }
  for (const id of s.coverageNotifyUserIds) pick.add(id);
  if (args.excludingUserId) pick.delete(args.excludingUserId);
  return args.staff.filter((u) => pick.has(u.id)).map((u) => u.id);
}

// ── Conflicts (warnings) ────────────────────────────────────────────────────

/** "18:30" → "6:30 PM". Times are always shown 12-hour. */
export function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const ap = h % 24 >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${ap}`;
}
/** "18:00","19:00" → "6:00–7:00 PM"; "11:00","13:00" → "11:00 AM–1:00 PM". */
export function fmtTimeRange(startHhmm: string, endHhmm: string): string {
  const a = fmt12(startHhmm);
  const b = fmt12(endHhmm);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

export type ProposedSlot = {
  /** Class day, YYYY-MM-DD (wall clock). */
  date: string;
  startTime: string; // HH:mm wall clock
  endTime: string;
  /** Real instants (ms). */
  startMs: number;
  endMs: number;
};

export type BusySlot = {
  kind: "CLASS" | "EVENT" | "PRIVATE_LESSON";
  id: string;
  name: string;
  /** Real instants (ms). */
  startMs: number;
  endMs: number;
  /** For display — the club's wall clock. */
  date: string;
  startTime: string;
  endTime: string;
};

export type StaffConflict = {
  /** overlap = double-booked. availability = outside their saved hours (softer). */
  severity: "overlap" | "availability";
  kind: "CLASS" | "EVENT" | "PRIVATE_LESSON" | "AVAILABILITY";
  /** The thing it collides with (null for availability). */
  id: string | null;
  name: string;
  /** The proposed class day this is about. */
  proposedDate: string;
  /** The colliding item's (or, for availability, the proposed slot's) wall-clock day and times. */
  date: string;
  startTime: string;
  endTime: string;
};

function hhmmToUtcStamp(dateYmd: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(ymdMs(dateYmd) + ((h || 0) * 60 + (m || 0)) * 60000);
}

/** A class day + wall-clock times → a slot with real instants (an end at/before the start runs to midnight). */
export function proposedSlot(dateYmd: string, startTime: string, endTime: string, timeZone: string | null | undefined): ProposedSlot {
  const date = dateYmd.slice(0, 10);
  const startStamp = hhmmToUtcStamp(date, startTime);
  let endStamp = hhmmToUtcStamp(date, endTime);
  if (endStamp.getTime() <= startStamp.getTime()) endStamp = new Date(ymdMs(date) + 86400000);
  return {
    date, startTime, endTime,
    startMs: wallClockUTCToInstant(startStamp, timeZone).getTime(),
    endMs: wallClockUTCToInstant(endStamp, timeZone).getTime(),
  };
}

/** A real instant → the club's wall-clock day and HH:mm (no timezone = UTC). */
export function instantToWallClock(at: Date | number, timeZone: string | null | undefined): { date: string; time: string } {
  const d = new Date(at);
  let ms = d.getTime();
  if (timeZone) {
    try {
      ms += tzOffsetMs(timeZone, d);
    } catch {
      // invalid timezone — show UTC
    }
  }
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * Warnings for putting one coach on the proposed class day(s).
 *   overlap       the slot's real time overlaps something else they are on
 *                 (touching end-to-start is not an overlap)
 *   availability  the slot's wall-clock time is outside their saved hours
 *                 (lib/staffScheduleFit — weekly hours + date exceptions).
 *                 Skipped when `availability` is not passed.
 * Pure: the caller loads `busy` (lib/classStaffServer.loadStaffConflicts) and
 * leaves out anything that should not count (the class day being edited).
 * These are WARNINGS — the API asks the manager to acknowledge, never blocks.
 */
export function findStaffConflicts(
  proposed: readonly ProposedSlot[],
  busy: readonly BusySlot[],
  availability?: { slots: readonly WeeklySlot[]; exceptions: readonly DateException[] } | null,
): StaffConflict[] {
  const out: StaffConflict[] = [];
  for (const p of proposed) {
    for (const b of busy) {
      if (p.startMs < b.endMs && b.startMs < p.endMs) {
        out.push({ severity: "overlap", kind: b.kind, id: b.id, name: b.name, proposedDate: p.date, date: b.date, startTime: b.startTime, endTime: b.endTime });
      }
    }
    if (availability) {
      const fit = fitFor({ date: p.date, startTime: p.startTime, endTime: p.endTime }, [...availability.slots], [...availability.exceptions]);
      if (fit === "outside") {
        out.push({ severity: "availability", kind: "AVAILABILITY", id: null, name: "Outside available hours", proposedDate: p.date, date: p.date, startTime: p.startTime, endTime: p.endTime });
      }
    }
  }
  return out;
}

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
function fmtDay(ymd: string): string {
  return new Date(ymdMs(ymd)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * One line per distinct clash, repeats folded by weekday:
 *   "Overlaps Evening Group on Wednesdays 6:00–7:00 PM (8 times)"
 *   "Overlaps Fall Camp on Sat, Oct 17, 9:00 AM–12:00 PM"
 *   "Outside available hours on Tuesdays 5:00–6:00 PM (8 times)"
 * Overlaps first, then availability; each in first-seen order.
 */
export function summarizeConflicts(conflicts: readonly StaffConflict[]): string[] {
  const groups = new Map<string, { c: StaffConflict; n: number }>();
  for (const c of conflicts) {
    const key = [c.severity, c.kind, c.kind === "CLASS" || c.kind === "AVAILABILITY" ? c.name : c.id ?? c.name, dowOfYmd(c.date), c.startTime, c.endTime].join("|");
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { c, n: 1 });
  }
  const line = ({ c, n }: { c: StaffConflict; n: number }) => {
    const when = n > 1
      ? `${WEEKDAYS[dowOfYmd(c.date)]} ${fmtTimeRange(c.startTime, c.endTime)} (${n} times)`
      : `${fmtDay(c.date)}, ${fmtTimeRange(c.startTime, c.endTime)}`;
    return c.severity === "availability" ? `Outside available hours on ${when}` : `Overlaps ${c.name} on ${when}`;
  };
  const all = Array.from(groups.values());
  return [...all.filter((g) => g.c.severity === "overlap"), ...all.filter((g) => g.c.severity === "availability")].map(line);
}

/**
 * The class days a recurring assignment would put a coach on over the next
 * `weeks` weeks from `fromYmd` — for the rule-level conflict check.
 * `dayOfWeek` null = every class day. Times are the series times for each
 * weekday (dayOverrides honoured); days outside the recurrence window are skipped.
 */
export function ruleOccurrenceSlots(
  cls: { daysOfWeek: unknown; startTime: string; endTime: string; dayOverrides?: unknown; recurrenceStartDate: Date | string; recurrenceEndDate: Date | string | null },
  dayOfWeek: number | null,
  fromYmd: string,
  timeZone: string | null | undefined,
  weeks = 8,
): ProposedSlot[] {
  const days = Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number) : [];
  const recStart = toYmd(cls.recurrenceStartDate);
  const recEnd = cls.recurrenceEndDate ? toYmd(cls.recurrenceEndDate) : null;
  const out: ProposedSlot[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDaysYmd(fromYmd, i);
    const dow = dowOfYmd(day);
    if (!days.includes(dow)) continue;
    if (dayOfWeek !== null && dow !== dayOfWeek) continue;
    if (day < recStart || (recEnd && day > recEnd)) continue;
    const t = classTimesForDay(cls.startTime, cls.endTime, cls.dayOverrides, dow);
    out.push(proposedSlot(day, t.startTime, t.endTime, timeZone));
  }
  return out;
}

// ── Cancellation audience ───────────────────────────────────────────────────

/**
 * Member ids for a cancellation notice.
 *   BOOKED         booked into that class day
 *   CLASS_MEMBERS  an ACTIVE membership currently gives access to the class
 *   BOTH           the union
 *   NONE           nobody
 * Booked first, no duplicates.
 */
export function mergeAudience(audience: CancelAudience, bookedMemberIds: readonly string[], classMemberIds: readonly string[]): string[] {
  const src = audience === "BOOKED" ? bookedMemberIds : audience === "CLASS_MEMBERS" ? classMemberIds : audience === "BOTH" ? [...bookedMemberIds, ...classMemberIds] : [];
  return Array.from(new Set(src));
}

export type AudienceRecipient = { email: string; displayName: string | null; memberIds: string[]; memberNames: string[] };

/**
 * One recipient per email address (case-insensitive): a guardian of two
 * athletes on the class gets ONE notice naming both.
 */
export function groupRecipientsByEmail(
  rows: readonly { recipientEmail: string; recipientDisplayName?: string | null; memberId: string; memberFirstName?: string; memberLastName?: string }[],
): AudienceRecipient[] {
  const by = new Map<string, AudienceRecipient>();
  for (const r of rows) {
    const email = (r.recipientEmail ?? "").trim();
    if (!email) continue;
    const key = email.toLowerCase();
    let g = by.get(key);
    if (!g) {
      g = { email, displayName: r.recipientDisplayName ?? null, memberIds: [], memberNames: [] };
      by.set(key, g);
    }
    if (!g.displayName && r.recipientDisplayName) g.displayName = r.recipientDisplayName;
    if (!g.memberIds.includes(r.memberId)) {
      g.memberIds.push(r.memberId);
      g.memberNames.push(`${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim());
    }
  }
  return Array.from(by.values());
}

// ── Switch-on planner ───────────────────────────────────────────────────────

export type SwitchOnClass = {
  id: string;
  name: string;
  assignedStaffIds: unknown;
  /** Rules the class already has (any dates). */
  existingRules: readonly StaffRule[];
};
export type SwitchOnSession = {
  id: string;
  classId: string;
  dateYmd: string;
  staffOverride: unknown;
  staffManual: boolean;
  existingRowCount: number;
};
export type SwitchOnPlan = {
  rules: { classId: string; userId: string; roleName: null; dayOfWeek: null; effectiveFrom: string }[];
  /** ruleKey = `${classId}:${userId}` of the planned rule a RULE row comes from (null for MANUAL rows). */
  rows: { sessionId: string; classId: string; userId: string; source: "RULE" | "MANUAL"; ruleKey: string | null }[];
  /** Sessions to flag staffManual = true (they carried a legacy staffOverride, [] included). */
  manualSessionIds: string[];
  perClass: {
    classId: string; name: string;
    /** already = the class already has rules, so it was switched on before and is left alone. */
    state: "new" | "already";
    coaches: string[]; droppedIds: string[];
    sessions: number; ruleRows: number; manualRows: number; manualDays: number; skippedDays: number;
  }[];
};

/**
 * What switching a club on writes, for class days on/after `date`:
 *   (a) one all-days rule per coach in each class's current assignedStaffIds
 *       (roleName null — shown as "Coach"; no hierarchy is invented),
 *       effectiveFrom = `date`
 *   (b) rows for every existing session on/after `date`:
 *         staffOverride null → the rule coaches, source RULE
 *         staffOverride list → exactly that list, source MANUAL, and the day is
 *                              flagged staffManual so rules never refill it
 *         staffOverride []   → no rows, flagged staffManual
 * Ids that are not this club's current OWNER/STAFF (`validStaffIds`) are
 * dropped and reported. Sessions before `date` are never included.
 *
 * Idempotent: a class that already has ANY rule is skipped whole (it was
 * switched on in an earlier run and its legacy columns are now the mirror, not
 * the source), and a session that already has rows or is already staffManual
 * is skipped. A second run plans nothing.
 */
export function planSwitchOn(args: {
  date: string;
  classes: readonly SwitchOnClass[];
  sessions: readonly SwitchOnSession[];
  validStaffIds: ReadonlySet<string>;
}): SwitchOnPlan {
  const date = args.date.slice(0, 10);
  const plan: SwitchOnPlan = { rules: [], rows: [], manualSessionIds: [], perClass: [] };
  for (const cls of args.classes) {
    const mine = args.sessions.filter((s) => s.classId === cls.id && s.dateYmd >= date);
    const raw = Array.from(new Set(asIdList(cls.assignedStaffIds)));
    const coaches = raw.filter((id) => args.validStaffIds.has(id));
    const dropped = new Set(raw.filter((id) => !args.validStaffIds.has(id)));
    const stat = { classId: cls.id, name: cls.name, state: "new" as "new" | "already", coaches, droppedIds: [] as string[], sessions: mine.length, ruleRows: 0, manualRows: 0, manualDays: 0, skippedDays: 0 };
    if (cls.existingRules.length > 0) {
      stat.state = "already";
      stat.coaches = Array.from(new Set(cls.existingRules.map((r) => r.userId)));
      stat.skippedDays = mine.length;
      plan.perClass.push(stat);
      continue;
    }
    for (const userId of coaches) plan.rules.push({ classId: cls.id, userId, roleName: null, dayOfWeek: null, effectiveFrom: date });
    for (const s of mine) {
      if (s.existingRowCount > 0 || s.staffManual) {
        stat.skippedDays++;
        continue;
      }
      if (Array.isArray(s.staffOverride)) {
        const ids = Array.from(new Set(asIdList(s.staffOverride)));
        for (const id of ids) {
          if (!args.validStaffIds.has(id)) {
            dropped.add(id);
            continue;
          }
          plan.rows.push({ sessionId: s.id, classId: cls.id, userId: id, source: "MANUAL", ruleKey: null });
          stat.manualRows++;
        }
        plan.manualSessionIds.push(s.id);
        stat.manualDays++;
      } else {
        for (const userId of coaches) {
          plan.rows.push({ sessionId: s.id, classId: cls.id, userId, source: "RULE", ruleKey: `${cls.id}:${userId}` });
          stat.ruleRows++;
        }
      }
    }
    stat.droppedIds = Array.from(dropped);
    plan.perClass.push(stat);
  }
  return plan;
}

// ── Reader seam: one resolver object for a batch of sessions ────────────────

export type OccurrenceLike = {
  classId: string;
  sessionId: string | null;
  date: string;
  staffIds: string[];
  seriesStaffIds: string[];
  isSubstitute: boolean;
};

export type StaffResolver = {
  /** YYYY-MM-DD, or null when the club is not switched on. */
  assignmentsStartOn: string | null;
  timezone: string | null;
  isSwitched(date: Date | string): boolean;
  /** This session's rows (empty for a legacy day or a day with none). */
  rowsFor(sessionId: string): DayStaffRow[];
  /** THE resolver for one session — see effectiveStaffForSession. */
  forSession(
    s: { id: string; date: Date | string; staffOverride?: unknown; staffManual?: boolean | null },
    seriesStaffIds: unknown,
  ): EffectiveStaff;
  /**
   * A lib/staffAssignments ClassOccurrence, made switch-aware: a legacy day is
   * returned untouched; a post-switch day gets its rows (or, when no session
   * row exists yet, what the class's rules say for that day).
   */
  forOccurrence<T extends OccurrenceLike>(occ: T): T;
  /** sessionCountsForPay for one session. */
  countsForPay(s: { date: Date | string; endsAt: Date | string; canceled: boolean; cancelPaid?: boolean | null }, now?: Date): boolean;
};

/**
 * Build the resolver from already-loaded data (lib/classStaffServer
 * .loadSessionStaffResolver does the loading — two queries for any number of
 * sessions, none beyond the settings row when the club is not switched on).
 */
export function makeStaffResolver(input: {
  assignmentsStartOn: string | null;
  timezone?: string | null;
  rows?: readonly DayStaffRow[];
  /** Needed only by forOccurrence, for days that have no session row yet. */
  rules?: readonly StaffRule[];
}): StaffResolver {
  const startOn = input.assignmentsStartOn ? input.assignmentsStartOn.slice(0, 10) : null;
  const timezone = input.timezone ?? null;
  const bySession = new Map<string, DayStaffRow[]>();
  for (const r of input.rows ?? []) {
    const list = bySession.get(r.sessionId);
    if (list) list.push(r);
    else bySession.set(r.sessionId, [r]);
  }
  const rulesByClass = new Map<string, StaffRule[]>();
  for (const r of input.rules ?? []) {
    const list = rulesByClass.get(r.classId);
    if (list) list.push(r);
    else rulesByClass.set(r.classId, [r]);
  }
  const isSwitched = (date: Date | string) => isSwitchedOn(startOn, toYmd(date));
  const rowsFor = (sessionId: string) => bySession.get(sessionId) ?? [];
  const forSession: StaffResolver["forSession"] = (s, seriesStaffIds) =>
    effectiveStaffForSession({
      assignmentsStartOn: startOn,
      dateYmd: toYmd(s.date),
      rows: rowsFor(s.id),
      seriesStaffIds,
      staffOverride: s.staffOverride,
      staffManual: s.staffManual,
    });
  return {
    assignmentsStartOn: startOn,
    timezone,
    isSwitched,
    rowsFor,
    forSession,
    forOccurrence(occ) {
      if (!isSwitched(occ.date)) return occ;
      if (occ.sessionId) {
        const eff = effectiveStaffForSession({
          assignmentsStartOn: startOn, dateYmd: occ.date, rows: rowsFor(occ.sessionId),
          seriesStaffIds: [], staffOverride: null,
        });
        return { ...occ, staffIds: eff.staffIds, seriesStaffIds: eff.seriesStaffIds, isSubstitute: eff.isSubstitute };
      }
      const ids = rulesForDay(rulesByClass.get(occ.classId) ?? [], occ.date).map((r) => r.userId);
      return { ...occ, staffIds: ids, seriesStaffIds: ids, isSubstitute: false };
    },
    countsForPay(s, now = new Date()) {
      const switched = isSwitched(s.date);
      return sessionCountsForPay({
        switched,
        canceled: s.canceled,
        cancelPaid: s.cancelPaid,
        // Only a post-switch day needs the clock; a legacy day never asks.
        ended: switched ? classHasEnded(s.endsAt, timezone, now) : true,
      });
    },
  };
}

// ── Stage 2: series-level display, plan-in-words, notices, Action Items ─────
// (all pure — scripts/class-staffing-api-tests.ts and class-staff-tests.ts)

export type CurrentStaffEntry = {
  userId: string;
  roleName: string | null;
  /** null = every class day; 0–6 = that weekday only. */
  dayOfWeek: number | null;
  ruleId: string;
  /** YYYY-MM-DD. After `asOf` = an assignment that has been made but has not started yet. */
  effectiveFrom: string;
  /** YYYY-MM-DD when the assignment is already set to end; null = open-ended. */
  effectiveTo: string | null;
};

/**
 * "This class's coaches" at SERIES level for a switched-on club: one entry per
 * (coach, weekday) rule that has NOT ENDED as of `asOfYmd` — rules in force
 * AND ones already made that start later (a coach put on "Tuesdays from next
 * week" is one of the class's coaches; hiding them would make an older screen
 * re-add them as an every-day coach). When one coach holds two rules for the
 * same weekday slot the later one wins. Order = rule order.
 */
export function currentRuleStaff(rules: readonly StaffRule[], asOfYmd: string): CurrentStaffEntry[] {
  const asOf = asOfYmd.slice(0, 10);
  const open = rules.filter((r) => r.effectiveTo === null || r.effectiveTo >= asOf);
  const best = new Map<string, StaffRule>();
  const order: string[] = [];
  for (const r of open) {
    const key = `${r.userId}|${r.dayOfWeek ?? "*"}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, r);
      order.push(key);
    } else if (r.effectiveFrom > cur.effectiveFrom || (r.effectiveFrom === cur.effectiveFrom && r.id > cur.id)) {
      best.set(key, r);
    }
  }
  return order.map((k) => {
    const r = best.get(k)!;
    return { userId: r.userId, roleName: r.roleName, dayOfWeek: r.dayOfWeek, ruleId: r.id, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo };
  });
}

/** Distinct coach ids of currentRuleStaff — what old screens get as `assignedStaffIds` for a switched-on club. */
export function currentRuleStaffIds(rules: readonly StaffRule[], asOfYmd: string): string[] {
  return Array.from(new Set(currentRuleStaff(rules, asOfYmd).map((e) => e.userId)));
}

const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
/** "Sun Oct 18" */
export function fmtDayShort(ymd: string): string {
  const d = new Date(ymdMs(ymd));
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${wd} ${md}`;
}
/** "Oct 20" */
export function fmtMonthDay(ymd: string): string {
  return new Date(ymdMs(ymd)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
/** "Tuesday, October 20" */
export function fmtDayLong(ymd: string): string {
  return new Date(ymdMs(ymd)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
/** A wall-clock-UTC stamp (ClassSession.startsAt) → "6:00 PM". */
export function fmtStampTime(stamp: Date | string): string {
  return fmt12(new Date(stamp).toISOString().slice(11, 16));
}
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type ScopeChangeWords = {
  /** "Tuesdays from Oct 20" / "Every class day from Oct 20" / "Tue Oct 20 only" */
  heading: string;
  /** One sentence each: "Adrian replaces Sal." "Sal stays on Mondays and Thursdays." */
  lines: string[];
  /** heading + ": " + lines, as one paragraph. */
  text: string;
  changed: boolean;
  added: string[];
  removed: string[];
  ruleOps: RuleOp[];
  dayOps: DayOp[];
};

/**
 * A coach-list change, in words, WITHOUT writing anything — the same planner
 * the write uses (planScopeChange), so the sentence cannot disagree with what
 * Apply then does.
 *   "Tuesdays from Oct 20: Adrian replaces Sal. Sal stays on Mondays and Thursdays."
 */
export function describeScopeChange(args: {
  scope: ChangeScope;
  classDays: readonly number[];
  date: string;
  dayOfWeek?: number;
  currentRules: readonly StaffRule[];
  currentDayStaff: readonly DayStaffRow[];
  desired: readonly DesiredStaff[];
  nameOf: (userId: string) => string;
}): ScopeChangeWords {
  const date = args.date.slice(0, 10);
  const plan = planScopeChange(args);
  const name = args.nameOf;
  const lines: string[] = [];
  let added: string[] = [];
  let removed: string[] = [];
  let heading: string;

  const swapLines = (roleChanges: string[]) => {
    if (added.length === 1 && removed.length === 1) lines.push(`${name(added[0])} replaces ${name(removed[0])}.`);
    else {
      if (added.length > 0) lines.push(`${joinAnd(added.map(name))} ${added.length === 1 ? "is" : "are"} added.`);
      if (removed.length > 0) lines.push(`${joinAnd(removed.map(name))} ${removed.length === 1 ? "comes" : "come"} off.`);
    }
    lines.push(...roleChanges);
  };

  if (args.scope === "OCCURRENCE") {
    heading = `${fmtDayShort(date)} only`;
    const roles: string[] = [];
    const reopened: string[] = [];
    for (const op of plan.dayOps) {
      if (op.op === "create" || op.op === "restore") added.push(op.userId);
      else if (op.op === "remove") removed.push(op.userId);
      else if (op.op === "role") roles.push(`${name(op.userId)} becomes ${roleLabel(op.roleName)}.`);
      else reopened.push(op.userId);
    }
    swapLines(roles);
    if (reopened.length > 0) lines.push(`${joinAnd(reopened.map(name))} ${reopened.length === 1 ? "needs" : "need"} coverage again.`);
    if (lines.length > 0) lines.push("The recurring schedule is not changed.");
  } else {
    const dow = args.scope === "WEEKDAY_FORWARD" ? (args.dayOfWeek ?? dowOfYmd(date)) : null;
    heading = dow === null ? `Every class day from ${fmtMonthDay(date)}` : `${WEEKDAY_PLURAL[dow]} from ${fmtMonthDay(date)}`;
    const afterRules = applyRuleOps(args.currentRules, plan.ruleOps, args.currentRules[0]?.classId ?? "");
    const classDays = Array.from(new Set(args.classDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b);
    const firstOf = (d: number) => addDaysYmd(date, (d - dowOfYmd(date) + 7) % 7);
    const checkDays = dow === null ? (classDays.length ? classDays : [dowOfYmd(date)]) : [dow];
    const beforeSet = new Map<string, string | null>();
    const afterSet = new Map<string, string | null>();
    for (const d of checkDays) {
      for (const r of rulesForDay(args.currentRules, firstOf(d), d)) if (!beforeSet.has(r.userId)) beforeSet.set(r.userId, r.roleName);
      for (const r of rulesForDay(afterRules, firstOf(d), d)) if (!afterSet.has(r.userId)) afterSet.set(r.userId, r.roleName);
    }
    added = Array.from(afterSet.keys()).filter((id) => !beforeSet.has(id));
    removed = Array.from(beforeSet.keys()).filter((id) => !afterSet.has(id));
    const roles: string[] = [];
    for (const [id, role] of afterSet) {
      if (beforeSet.has(id) && beforeSet.get(id) !== role) roles.push(`${name(id)} becomes ${roleLabel(role)}.`);
    }
    swapLines(roles);
    if (dow !== null) {
      for (const id of removed) {
        const stays = classDays.filter((d) => d !== dow && rulesForDay(afterRules, firstOf(d), d).some((r) => r.userId === id));
        if (stays.length > 0) lines.push(`${name(id)} stays on ${joinAnd(stays.map((d) => WEEKDAY_PLURAL[d]))}.`);
      }
    }
    // The comparison above looks at the FIRST class day of each weekday. When
    // the current rules were already set to change on a LATER date (a rule
    // that starts or ends after `date`), this save cuts that too — "from
    // `date` on, exactly these coaches". Say so by name: it must never read as
    // "nothing changes" while a planned change is being dropped.
    const laterPoints = Array.from(
      new Set(args.currentRules.flatMap((r) => [r.effectiveFrom, r.effectiveTo ? addDaysYmd(r.effectiveTo, 1) : ""]).filter((x) => x && x > date)),
    ).sort();
    const laterOff = new Map<string, string>();
    const laterOn = new Map<string, string>();
    for (const point of laterPoints) {
      for (const d of checkDays) {
        const day = addDaysYmd(point, (d - dowOfYmd(point) + 7) % 7);
        const was = new Set(rulesForDay(args.currentRules, day, d).map((r) => r.userId));
        const will = new Set(rulesForDay(afterRules, day, d).map((r) => r.userId));
        // `day` = the first class day on that weekday the planned change would have shown on.
        for (const id of was) if (!will.has(id) && !removed.includes(id) && (!laterOff.has(id) || day < laterOff.get(id)!)) laterOff.set(id, day);
        for (const id of will) if (!was.has(id) && !added.includes(id) && (!laterOn.has(id) || day < laterOn.get(id)!)) laterOn.set(id, day);
      }
    }
    for (const [id, day] of laterOff) lines.push(`${name(id)}, who was due to start ${fmtMonthDay(day)}, will not be added.`);
    for (const [id, day] of laterOn) lines.push(`${name(id)}, who was due to come off ${fmtMonthDay(day)}, stays on.`);
    // A change the rules already express (the same coaches on every day, held by fewer rules) still has ops.
    if (lines.length === 0 && plan.ruleOps.length > 0) lines.push("The recurring schedule is tidied; the coaches on each day stay the same.");
    if (lines.length > 0) lines.push("Class days already edited by hand keep their own coaches.");
  }
  const changed = plan.ruleOps.length > 0 || plan.dayOps.length > 0;
  if (!changed) lines.length = 0;
  const text = changed ? `${heading}: ${lines.join(" ")}` : `${heading}: no change.`;
  return { heading, lines: changed ? lines : ["No change."], text, changed, added, removed, ruleOps: plan.ruleOps, dayOps: plan.dayOps };
}

/** 80 minutes → "1h 20m"; 45 → "45m"; 120 → "2h". */
export function fmtCountdown(ms: number): string {
  const mins = Math.max(0, Math.round(Math.abs(ms) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "today" / "tomorrow" / "Sun Oct 18" relative to the club's calendar day. */
export function relativeDayLabel(dateYmd: string, todayYmd: string): string {
  if (dateYmd === todayYmd) return "today";
  if (dateYmd === addDaysYmd(todayYmd, 1)) return "tomorrow";
  return fmtDayShort(dateYmd);
}

export type CalloutNoticeInput = {
  className: string;
  dateYmd: string;
  /** Wall-clock-UTC stamp, as stored. */
  startsAt: Date | string;
  /** The coach who cannot make it. */
  coachName: string;
  reason?: string | null;
  late: boolean;
  /** The real instant the class starts. */
  startInstant: Date;
  now: Date;
  todayYmd: string;
  /** Set when a manager called out on the coach's behalf. */
  byName?: string | null;
};

/** The banner line a LATE call-out carries: "LATE CALL-OUT — class starts in 1h 20m". */
export function lateCalloutBanner(startInstant: Date, now: Date): string {
  const diff = startInstant.getTime() - now.getTime();
  return diff > 0 ? `LATE CALL-OUT — class starts in ${fmtCountdown(diff)}` : `LATE CALL-OUT — class started ${fmtCountdown(diff)} ago`;
}

/** Subject + body of the "needs coverage" notice (in-app message and email share it). */
export function calloutNotice(i: CalloutNoticeInput): { subject: string; headline: string; body: string; banner: string | null } {
  const when = `${relativeDayLabel(i.dateYmd, i.todayYmd)} ${fmtStampTime(i.startsAt)}`;
  const banner = i.late ? lateCalloutBanner(i.startInstant, i.now) : null;
  const headline = i.late
    ? `Late call-out: ${i.className} ${when} — ${i.coachName} can't make it`
    : `Needs coverage: ${i.className} ${when} — ${i.coachName} can't make it`;
  const reason = (i.reason ?? "").trim();
  const parts = [
    banner ? `${banner}.` : null,
    `${i.coachName} can't make ${i.className} on ${fmtDayLong(i.dateYmd)} at ${fmtStampTime(i.startsAt)}.`,
    reason ? `Reason: ${reason}${/[.!?]$/.test(reason) ? "" : "."}` : null,
    i.byName ? `Recorded by ${i.byName}.` : null,
    "The class is still on — it needs someone to cover.",
  ].filter(Boolean);
  return { subject: headline, headline, body: parts.join(" "), banner };
}

export type OpenCoverage = {
  staffRowId: string;
  sessionId: string;
  classId: string;
  className: string;
  coachName: string;
  dateYmd: string;
  /** Wall-clock-UTC stamp. */
  startsAt: Date | string;
  lateCallout: boolean;
};

export type CoverageActionItem = {
  kind: string;
  label: string;
  count: number;
  severity: "high";
  href: string;
  /** Sort key WITHIN the severity: late call-outs first, then the soonest class. */
  order: number;
};

/** Deep link to the staff schedule on one class day. */
export function scheduleDayHref(dateYmd: string, opts: { classId?: string | null; sessionId?: string | null } = {}): string {
  const q = [`date=${dateYmd}`];
  if (opts.classId) q.push(`class=${encodeURIComponent(opts.classId)}`);
  if (opts.sessionId) q.push(`session=${encodeURIComponent(opts.sessionId)}`);
  return `/dashboard/staff/schedule?${q.join("&")}`;
}

/**
 * Action Items for open coverage requests: one per unfilled call-out, LATE
 * call-outs first, then the soonest class.
 *   "Late call-out: Evening Group today 6:00 PM — Sal can't make it"
 *   "Needs coverage: Morning Group Sun Oct 18 1:15 PM — Mia can't make it"
 * `order` is negative so these sort ahead of every other high-severity item
 * (lib/actionCenter sorts severity → order → count).
 */
export function coverageActionItems(open: readonly OpenCoverage[], todayYmd: string): CoverageActionItem[] {
  const startMs = (o: OpenCoverage) => new Date(o.startsAt).getTime();
  const sorted = [...open].sort((a, b) => Number(b.lateCallout) - Number(a.lateCallout) || startMs(a) - startMs(b) || a.staffRowId.localeCompare(b.staffRowId));
  return sorted.map((o, i) => {
    const when = `${relativeDayLabel(o.dateYmd, todayYmd)} ${fmtStampTime(o.startsAt)}`;
    return {
      kind: `NEEDS_COVERAGE:${o.staffRowId}`,
      label: `${o.lateCallout ? "Late call-out" : "Needs coverage"}: ${o.className} ${when} — ${o.coachName} can't make it`,
      count: 1,
      severity: "high" as const,
      href: scheduleDayHref(o.dateYmd, { classId: o.classId, sessionId: o.sessionId }),
      order: -1_000_000 + i,
    };
  });
}

/** A day row as the API returns it: the stored row plus names and display text. */
export type RichStaffRow = {
  /** null = a synthetic row (legacy day, or a rule coach on a day with no session row yet). */
  id: string | null;
  userId: string;
  name: string;
  roleName: string | null;
  roleLabel: string;
  kind: StaffKind;
  status: StaffStatus;
  source: StaffSource | "LEGACY";
  replacesStaffId: string | null;
  /** The SUBSTITUTE row covering this coach, when REPLACED. */
  coveredByStaffId: string | null;
  coveredByName: string | null;
  lateCallout: boolean;
  calledOutAt: string | null;
  calledOutByUserId: string | null;
  calledOutByName: string | null;
  calloutReason: string | null;
  coverageFilledAt: string | null;
  coverageFilledByUserId: string | null;
  coverageFilledByName: string | null;
  note: string | null;
};

const isoOrNull = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/** Stored rows → API rows (names resolved; unknown ids show as "Former staff"). */
export function richStaffRows(
  rows: readonly (Omit<DayStaffRow, "id" | "sessionId" | "source" | "ruleId"> & { id: string | null; source: StaffSource | "LEGACY" })[],
  nameOf: (userId: string) => string,
): RichStaffRow[] {
  return rows.map((r) => {
    const sub = r.id ? rows.find((s) => s.kind === "SUBSTITUTE" && s.replacesStaffId === r.id && s.status !== "REMOVED") : undefined;
    return {
      id: r.id, userId: r.userId, name: nameOf(r.userId), roleName: r.roleName, roleLabel: roleLabel(r.roleName),
      kind: r.kind, status: r.status, source: r.source, replacesStaffId: r.replacesStaffId,
      coveredByStaffId: r.status === "REPLACED" ? sub?.id ?? null : null,
      coveredByName: r.status === "REPLACED" && sub ? nameOf(sub.userId) : null,
      lateCallout: !!r.lateCallout,
      calledOutAt: isoOrNull(r.calledOutAt), calledOutByUserId: r.calledOutByUserId ?? null,
      calledOutByName: r.calledOutByUserId ? nameOf(r.calledOutByUserId) : null,
      calloutReason: r.calloutReason ?? null,
      coverageFilledAt: isoOrNull(r.coverageFilledAt), coverageFilledByUserId: r.coverageFilledByUserId ?? null,
      coverageFilledByName: r.coverageFilledByUserId ? nameOf(r.coverageFilledByUserId) : null,
      note: r.note ?? null,
    };
  });
}
