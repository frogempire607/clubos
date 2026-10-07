// Nightly top-up for recurring classes: every ongoing class always has
// ClassSession rows TOP_UP_DAYS ahead. Before this, rows were created once
// (365 days at class creation) and nothing extended them — an ongoing class
// silently ran out of days to book, attend and pay.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────
//   TOP_UP_DAYS                         how far ahead rows must exist (180)
//   classNeedsTopUp(cls, todayYmd)      PURE — is this class ongoing?
//   planTopUp({cls, existingDates, todayYmd, horizonDays?})
//                                       PURE — the ClassSession rows to create:
//                                       scheduled weekdays from max(today,
//                                       recurrence start) through min(today +
//                                       horizon, recurrence end), at each
//                                       weekday's own time (dayOverrides), minus
//                                       days that already have a row
//   topUpClass(cls, now?)               one class: createMany skipDuplicates on
//                                       the (classId, date) unique, then
//                                       syncSessionStaff (staff rows for the new
//                                       days + the nightly legacy-mirror refresh;
//                                       a no-op for a club not switched on)
//   runClassTopUp(now?)                 every club, every non-deleted ACTIVE
//                                       class that is ongoing. Idempotent: a
//                                       second run creates nothing.
//   ensureSession(classId, dateYmd, db?) re-exported from lib/classStaffServer —
//                                       get-or-create ONE class day with the
//                                       right weekday time (use it instead of an
//                                       inline classSession.create)
//
// "Today" is the club's own calendar day (Club.timezone). It never touches an
// existing row: times of existing days are lib/classSessionSync's job, and a
// canceled / hand-edited day already "has a row", so it is left alone.
// Called by POST /api/cron/class-sessions-topup (netlify/functions/
// class-sessions-topup-cron.mts, daily).
import { prisma } from "@/lib/prisma";
import { buildSessions, type BuiltSession, type DayOverride } from "@/lib/classSessions";
import { asDayOverrides } from "@/lib/staffAssignments";
import { addDaysYmd, clubTodayYmd, toYmd, ymdToDate } from "@/lib/classStaff";
import { ensureSession, syncSessionStaff, type StaffSyncResult } from "@/lib/classStaffServer";

export { ensureSession };

/** Every ongoing class has rows at least this many days ahead. */
export const TOP_UP_DAYS = 180;

export type TopUpClass = {
  id: string;
  clubId: string;
  daysOfWeek: unknown;
  startTime: string;
  endTime: string;
  dayOverrides: unknown;
  recurrenceStartDate: Date;
  recurrenceEndDate: Date | null;
  active: boolean;
  deletedAt: Date | null;
};

/** Ongoing = active, not deleted, and not ended (no end date, or one that is today or later). */
export function classNeedsTopUp(cls: Pick<TopUpClass, "active" | "deletedAt" | "recurrenceEndDate">, todayYmd: string): boolean {
  if (!cls.active || cls.deletedAt) return false;
  return !cls.recurrenceEndDate || toYmd(cls.recurrenceEndDate) >= todayYmd;
}

/** The rows a class is missing between today and the horizon. Pure. */
export function planTopUp(args: {
  cls: TopUpClass;
  /** YYYY-MM-DD of every class day that already has a row (from today on is enough). */
  existingDates: ReadonlySet<string>;
  todayYmd: string;
  horizonDays?: number;
}): BuiltSession[] {
  const { cls, todayYmd } = args;
  if (!classNeedsTopUp(cls, todayYmd)) return [];
  const horizon = addDaysYmd(todayYmd, args.horizonDays ?? TOP_UP_DAYS);
  const recStart = toYmd(cls.recurrenceStartDate);
  const recEnd = cls.recurrenceEndDate ? toYmd(cls.recurrenceEndDate) : null;
  const from = recStart > todayYmd ? recStart : todayYmd;
  const to = recEnd && recEnd < horizon ? recEnd : horizon;
  if (from > to) return [];
  const days = Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  if (days.length === 0) return [];
  // buildSessions is the one place a class day's stamps are made (UTC-midnight
  // date, wall-clock times pinned to UTC, the weekday's own time when it has one).
  const overrides: DayOverride[] = asDayOverrides(cls.dayOverrides).filter((o) => days.includes(o.dayOfWeek));
  return buildSessions(cls.id, cls.clubId, days, cls.startTime, cls.endTime, overrides, ymdToDate(from), ymdToDate(to)).filter(
    (s) => !args.existingDates.has(toYmd(s.date)),
  );
}

export type TopUpClassResult = { classId: string; planned: number; created: number; staff: StaffSyncResult };

/** Top up one class and bring its staff rows + legacy mirror up to date. */
export async function topUpClass(cls: TopUpClass, timeZone: string | null, now: Date = new Date()): Promise<TopUpClassResult> {
  const today = clubTodayYmd(timeZone, now);
  let planned = 0;
  let created = 0;
  if (classNeedsTopUp(cls, today)) {
    const existing = await prisma.classSession.findMany({
      where: { classId: cls.id, date: { gte: ymdToDate(today) } },
      select: { date: true },
    });
    const plan = planTopUp({ cls, existingDates: new Set(existing.map((s) => toYmd(s.date))), todayYmd: today });
    planned = plan.length;
    if (plan.length > 0) {
      // (classId, date) is unique, so a concurrent run or a day created a moment
      // ago by a booking flow is skipped by the database, not raced.
      const res = await prisma.classSession.createMany({ data: plan, skipDuplicates: true });
      created = res.count;
    }
  }
  const staff = await syncSessionStaff(prisma, cls.id, today, { now });
  return { classId: cls.id, planned, created, staff };
}

export type TopUpClubResult = {
  clubId: string;
  outcome: "ok" | "error";
  classes: number;
  sessionsCreated: number;
  staffRowsCreated: number;
  staffRowsRemoved: number;
  error?: string;
};

/**
 * The nightly job. For every club: every non-deleted, active class that is
 * ongoing gets its missing class days through today + TOP_UP_DAYS, and — for a
 * club that is switched on — staff rows for the new days.
 * One club failing is recorded and does not stop the others. There is no
 * transaction: every step is idempotent, so the next run finishes what a
 * failed one started.
 */
export async function runClassTopUp(now: Date = new Date()): Promise<TopUpClubResult[]> {
  const classes = await prisma.recurringClass.findMany({
    where: { active: true, deletedAt: null },
    select: {
      id: true, clubId: true, daysOfWeek: true, startTime: true, endTime: true, dayOverrides: true,
      recurrenceStartDate: true, recurrenceEndDate: true, active: true, deletedAt: true,
    },
    orderBy: [{ clubId: "asc" }, { createdAt: "asc" }],
  });
  const clubIds = Array.from(new Set(classes.map((c) => c.clubId)));
  const clubs = clubIds.length
    ? await prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, timezone: true } })
    : [];
  const tzByClub = new Map(clubs.map((c) => [c.id, c.timezone]));
  const results: TopUpClubResult[] = [];
  for (const clubId of clubIds) {
    const r: TopUpClubResult = { clubId, outcome: "ok", classes: 0, sessionsCreated: 0, staffRowsCreated: 0, staffRowsRemoved: 0 };
    const tz = tzByClub.get(clubId) ?? null;
    const today = clubTodayYmd(tz, now);
    try {
      for (const cls of classes) {
        if (cls.clubId !== clubId || !classNeedsTopUp(cls, today)) continue;
        const one = await topUpClass(cls, tz, now);
        r.classes++;
        r.sessionsCreated += one.created;
        r.staffRowsCreated += one.staff.created;
        r.staffRowsRemoved += one.staff.deleted;
      }
    } catch (err) {
      r.outcome = "error";
      r.error = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
      console.error(`[class-topup] club ${clubId} failed`, err);
    }
    results.push(r);
  }
  return results;
}
