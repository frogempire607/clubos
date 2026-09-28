// Coach assignments — ONE connected system. PURE (no prisma, no IO): safe to
// import from client components, API routes and tests. The database-touching
// half lives in lib/staffAssignmentsServer.ts.
//
// ── The map: every place "who coaches / staffs this" is STORED ─────────────
//
//   RecurringClass.assignedStaffIds  Json userId[]   the series default ("every week")
//   ClassSession.staffOverride       Json? userId[]  one day only. null = inherit the
//                                                    series; [] = explicitly nobody;
//                                                    [..] = substitute/replacement
//   EventStaffAssignment             table          who works an event (unique per
//                                                    event+user; role COACH/…)
//   EventCompAssignment (STAFF rows) table          pay terms for an event. NOT a
//                                                    roster: it follows the event's
//                                                    staff — adding a STAFF payee puts
//                                                    them on the event, removing a coach
//                                                    from the event deletes their
//                                                    unpaid comp row (lib/staffAssignmentsServer)
//   Event.responsibleCoachUserId     column         who approves signups (not coverage).
//                                                    Cleared when that coach is removed
//                                                    from the event, unless the same save
//                                                    names them again.
//   PrivateBooking.coachId           column         private lessons — one coach per booking,
//                                                    set by the booking flow (not touched here)
//
// ── WRITE paths (one per thing) ─────────────────────────────────────────────
//   series      POST/DELETE /api/classes/[id]/staff            (classes:edit)
//               PATCH /api/classes/[id] assignedStaffIds       (class editor)
//               POST /api/classes/[id]/occurrence scope=series (schedule:edit)
//   one day     POST /api/classes/[id]/occurrence scope=occurrence|following (schedule:edit)
//               PATCH /api/classes/[id]/sessions/[sessionId] staffOverride
//   event       POST/DELETE /api/events/[id]/staff             (events:edit)
//               PATCH /api/events/[id] staffUserIds (event editor "Staff on this event")
//               PUT /api/events/[id]/comp (finances:edit) — adds STAFF payees to the event
//   All event writes go through lib/staffAssignmentsServer (addEventStaff /
//   setEventStaff / removeEventStaff) so comp + responsible coach stay in step.
//
// ── READ paths (all resolve through the helpers below) ──────────────────────
//   /api/staff/schedule          staff Schedule page, staff profile Schedule +
//                                Overview tabs  → classOccurrencesInRange, eventOverlaps
//   /api/calendar                dashboard Calendar (+ coach editing there)
//   /api/member/schedule         member "My Schedule" coach names   → effectiveClassStaff
//   /api/member/portal +         member bookings coach names        → effectiveClassStaff
//     components/member/BookingsPanel.tsx
//   lib/payroll.ts, lib/payrollCalc.ts  taught sessions per coach   → effectiveClassStaff
//   lib/coachAudience.ts         who a coach may message (series classes + the
//                                sessions they subbed, + event rosters)
//   lib/reportsRevenue.ts        event revenue per assigned coach (EventStaffAssignment)
//   /api/events/[id]/comp/generate-payouts  pays EventCompAssignment rows, which
//                                follow the roster (see above)
//
// Times: class times are the owner's wall clock stored in UTC fields (see
// lib/datetime.ts). Every day loop here runs in UTC so a server in any
// timezone lands on the same calendar day the session rows use. Events are
// real instants; the client places them on the viewer's local days.

export const SCHEDULE_STAFF_ROLES = ["OWNER", "STAFF"] as const;

/** Owners coach too — every OWNER and STAFF user is schedulable. */
export function isScheduleStaffRole(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "STAFF";
}

/** A Json userId list → string[] (anything else → []). */
export function asIdList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * Who is actually on one class occurrence.
 *   override null/undefined/not-an-array → the series list
 *   override []                          → nobody (explicit)
 *   override [a, b]                      → exactly those people
 */
export function effectiveClassStaff(
  seriesStaffIds: unknown,
  staffOverride: unknown,
): { staffIds: string[]; isSubstitute: boolean } {
  if (Array.isArray(staffOverride)) return { staffIds: asIdList(staffOverride), isSubstitute: true };
  return { staffIds: asIdList(seriesStaffIds), isSubstitute: false };
}

/** Names for a list of ids, in list order, skipping unknown ids. */
export function staffNames(ids: string[], nameById: Map<string, string>): string[] {
  return ids.map((id) => nameById.get(id)).filter((n): n is string => !!n);
}

export type DayOverride = { dayOfWeek: number; startTime: string; endTime: string };

function isHhmm(s: unknown): s is string {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}

/** RecurringClass.dayOverrides Json → a clean list. */
export function asDayOverrides(v: unknown): DayOverride[] {
  if (!Array.isArray(v)) return [];
  const out: DayOverride[] = [];
  for (const o of v) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const dow = Number(r.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!isHhmm(r.startTime) || !isHhmm(r.endTime)) continue;
    out.push({ dayOfWeek: dow, startTime: r.startTime, endTime: r.endTime });
  }
  return out;
}

/** The series time on a weekday: that day's override if any, else the default. */
export function classTimesForDay(
  defaultStart: string,
  defaultEnd: string,
  dayOverrides: unknown,
  dayOfWeek: number,
): { startTime: string; endTime: string } {
  const o = asDayOverrides(dayOverrides).find((d) => d.dayOfWeek === dayOfWeek);
  return o ? { startTime: o.startTime, endTime: o.endTime } : { startTime: defaultStart, endTime: defaultEnd };
}

/** YYYY-MM-DD of a Date in UTC (how ClassSession.date is stamped). */
export function ymdUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Wall-clock HH:mm of a class stamp (stored in UTC). */
export function hhmmUTC(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Inclusive list of YYYY-MM-DD days between two dates (max 400). */
export function daysBetween(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  let t = ymdToUtcMs(fromYmd);
  const end = ymdToUtcMs(toYmd);
  if (!Number.isFinite(t) || !Number.isFinite(end)) return out;
  while (t <= end && out.length < 400) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

export type ClassSeriesInput = {
  id: string;
  name: string;
  daysOfWeek: unknown;
  startTime: string;
  endTime: string;
  dayOverrides?: unknown;
  assignedStaffIds: unknown;
  recurrenceStartDate: Date;
  recurrenceEndDate: Date | null;
};

export type ClassSessionInput = {
  id: string;
  classId: string;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  canceled: boolean;
  staffOverride: unknown;
  note?: string | null;
};

export type ClassOccurrence = {
  classId: string;
  sessionId: string | null;
  name: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm wall clock
  endTime: string;
  staffIds: string[]; // effective (override or series)
  seriesStaffIds: string[];
  isSubstitute: boolean;
  canceled: boolean;
  note: string | null;
};

/**
 * Every occurrence of a class between two days (inclusive), resolved:
 *   - a materialized ClassSession row wins (its times, cancel flag, staff override)
 *   - otherwise a scheduled weekday inside the recurrence window, at the
 *     series time for THAT weekday (dayOverrides), staffed by the series.
 * A session row on a day the series no longer runs (kept for attendance or
 * a one-off edit) still counts — it is on the calendar, so it is on the schedule.
 */
export function classOccurrencesInRange(
  cls: ClassSeriesInput,
  sessions: ClassSessionInput[],
  fromYmd: string,
  toYmd: string,
): ClassOccurrence[] {
  const days = Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number) : [];
  const series = asIdList(cls.assignedStaffIds);
  const byDay = new Map<string, ClassSessionInput>();
  for (const s of sessions) {
    if (s.classId !== cls.id) continue;
    const k = ymdUTC(s.date);
    // One row per class per day is the rule (@@unique); keep the first if not.
    if (!byDay.has(k)) byDay.set(k, s);
  }
  const recStart = ymdUTC(cls.recurrenceStartDate);
  const recEnd = cls.recurrenceEndDate ? ymdUTC(cls.recurrenceEndDate) : null;
  const out: ClassOccurrence[] = [];
  for (const day of daysBetween(fromYmd, toYmd)) {
    const row = byDay.get(day);
    if (row) {
      const eff = effectiveClassStaff(series, row.staffOverride);
      out.push({
        classId: cls.id,
        sessionId: row.id,
        name: cls.name,
        date: day,
        startTime: hhmmUTC(row.startsAt),
        endTime: hhmmUTC(row.endsAt),
        staffIds: eff.staffIds,
        seriesStaffIds: series,
        isSubstitute: eff.isSubstitute,
        canceled: row.canceled,
        note: typeof row.note === "string" && row.note ? row.note : null,
      });
      continue;
    }
    const dow = new Date(ymdToUtcMs(day)).getUTCDay();
    if (!days.includes(dow)) continue;
    if (day < recStart || (recEnd && day > recEnd)) continue;
    const t = classTimesForDay(cls.startTime, cls.endTime, cls.dayOverrides, dow);
    out.push({
      classId: cls.id,
      sessionId: null,
      name: cls.name,
      date: day,
      startTime: t.startTime,
      endTime: t.endTime,
      staffIds: series,
      seriesStaffIds: series,
      isSubstitute: false,
      canceled: false,
      note: null,
    });
  }
  return out;
}

/** Does [startsAt, endsAt] touch [from, to]? (inclusive overlap) */
export function eventOverlaps(startsAt: Date, endsAt: Date, from: Date, to: Date): boolean {
  const end = endsAt.getTime() < startsAt.getTime() ? startsAt : endsAt;
  return startsAt.getTime() <= to.getTime() && end.getTime() >= from.getTime();
}

/**
 * The query window for a YYYY-MM-DD..YYYY-MM-DD request, as instants.
 * Events are real instants but the viewer's days are local, so the window
 * is padded 14h each side (covers UTC−12..UTC+14); the client then places
 * each event on its own local days with eventDaysInRange.
 */
export function rangeWindow(fromYmd: string, toYmd: string, padHours = 14): { from: Date; to: Date } {
  const pad = padHours * 3600000;
  return {
    from: new Date(ymdToUtcMs(fromYmd) - pad),
    to: new Date(ymdToUtcMs(toYmd) + 86400000 - 1 + pad),
  };
}

export type EventPart = { startsAt: string | Date; endsAt: string | Date };

/**
 * Which of `days` an event touches, one entry per day, using `toYmd` to read
 * an instant as a calendar day (pass localYmd on the client). An event with
 * sessions contributes each session on its own day; one without contributes
 * its whole span (a 3-day camp shows on all three days).
 */
export function eventDaysInRange(
  event: EventPart & { sessions?: EventPart[] | null },
  days: string[],
  toYmd: (d: Date) => string,
): { date: string; startsAt: Date; endsAt: Date }[] {
  const parts: EventPart[] = event.sessions && event.sessions.length > 0 ? event.sessions : [event];
  const want = new Set(days);
  const out: { date: string; startsAt: Date; endsAt: Date }[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const s = new Date(p.startsAt);
    let e = new Date(p.endsAt);
    if (e.getTime() < s.getTime()) e = s;
    const first = toYmd(s);
    const last = toYmd(e);
    for (const d of daysBetween(first, last)) {
      if (!want.has(d)) continue;
      const key = `${d}|${s.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date: d, startsAt: s, endsAt: e });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.getTime() - b.startsAt.getTime());
}

/** Ids removed going from `before` to `after`. */
export function removedIds(before: string[], after: string[]): string[] {
  const keep = new Set(after);
  return Array.from(new Set(before.filter((id) => !keep.has(id))));
}

/** A day's coach list after adding/removing one person (order kept, no dupes). */
export function nextDayStaff(current: string[], userId: string, op: "add" | "remove"): string[] {
  const base = Array.from(new Set(current));
  if (op === "remove") return base.filter((id) => id !== userId);
  return base.includes(userId) ? base : [...base, userId];
}

export type ClassStaffScope = "day" | "series";

/**
 * Which "Just this day" / "Every week" choices make sense for changing one
 * person on one class occurrence, given what the viewer may edit.
 *   day    — POST /api/classes/[id]/occurrence (schedule:edit)
 *   series — POST/DELETE /api/classes/[id]/staff (classes:edit)
 * "Every week" is offered only when it would change the series: adding
 * someone not on it, or removing someone who is.
 */
export function classStaffScopes(args: {
  op: "add" | "remove";
  userId: string;
  seriesStaffIds: string[];
  canEditDay: boolean;
  canEditSeries: boolean;
}): ClassStaffScope[] {
  const out: ClassStaffScope[] = [];
  if (args.canEditDay) out.push("day");
  const inSeries = args.seriesStaffIds.includes(args.userId);
  if (args.canEditSeries && (args.op === "add" ? !inSeries : inSeries)) out.push("series");
  return out;
}
