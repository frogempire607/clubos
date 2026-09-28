// Staff pay schedules — the pure date math behind payday reminders.
//
// Julian, 2026-09-28: "This should make payroll easy, so add reminders when to
// pay certain staff." Reminders show on the Payroll page and the dashboard
// Action Center, and the owner gets one email the morning a payment is due.
//
// Pure — no Prisma, no Next — so scripts/pay-schedule-tests.ts covers it.
//
// ── Dates ──────────────────────────────────────────────────────────────────
// Every date here is a calendar day as a "YYYY-MM-DD" string. Math is done on
// whole UTC days (Date.UTC), never on local Date objects, so a payday can't
// drift a day with the server's or the browser's timezone.
//
// ── Rules ──────────────────────────────────────────────────────────────────
//   WEEKLY       every 7 days, counting from the anchor payday.
//   BIWEEKLY     every 14 days, counting from the anchor payday.
//   SEMIMONTHLY  the 1st and the 15th of every month. The anchor only marks
//                where the schedule starts (the first 1st/15th on or after it).
//   MONTHLY      the anchor's day of the month. In a shorter month it falls on
//                that month's last day (31st → Feb 28, or Feb 29 in a leap
//                year; 30th → Feb 28/29) and returns to the 31st next month.
//
// The anchor is the FIRST payday: nothing earlier is ever generated, so
// setting up a schedule today never produces a backlog of "overdue" paydays.
//
// Weekends and holidays are NOT shifted. A payday that lands on a Saturday
// stays on the Saturday — the reminder fires two days ahead ("upcoming") so
// the owner can pay on the Friday if they want to.
//
// A payday's PAY PERIOD runs from the day after the previous payday through
// the payday itself (for the very first payday, the previous one is the
// schedule's rule applied backwards — e.g. 14 days earlier for BIWEEKLY).

export const PAY_FREQUENCIES = ["WEEKLY", "BIWEEKLY", "SEMIMONTHLY", "MONTHLY"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 weeks",
  SEMIMONTHLY: "Twice a month (1st & 15th)",
  MONTHLY: "Monthly",
};

export type PaySchedule = {
  frequency: PayFrequency | string;
  anchorDate: string; // YYYY-MM-DD
  active?: boolean;
};

export type ReminderStatus = "upcoming" | "due_today" | "overdue";

export type DueReminder = {
  userId: string;
  payday: string;
  periodStart: string;
  periodEnd: string;
  status: ReminderStatus;
  /** payday − today in days (negative when overdue). */
  daysUntil: number;
};

/** A reminder shows this many days before the payday. */
export const REMIND_DAYS_AHEAD = 2;
/** An unpaid payday stays on the list this many days, then drops off. */
export const OVERDUE_WINDOW_DAYS = 30;

// ── Day arithmetic ─────────────────────────────────────────────────────────

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isValidYmd(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = YMD.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** YYYY-MM-DD → whole days since 1970-01-01. */
export function toDayNum(ymd: string): number {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${ymd}`);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}

export function fromDayNum(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  return fromDayNum(toDayNum(ymd) + days);
}

export function daysBetween(a: string, b: string): number {
  return toDayNum(b) - toDayNum(a);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function parts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

function ymdOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Shift (year, month) by `delta` months. month is 1–12. */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12 + 12) % 12 + 1 };
}

/** The MONTHLY payday in (y, m) for a schedule anchored on day `anchorDay`. */
function monthlyDay(y: number, m: number, anchorDay: number): string {
  return ymdOf(y, m, Math.min(anchorDay, daysInMonth(y, m)));
}

/** A Date stored as @db.Date (UTC midnight) → YYYY-MM-DD. */
export function ymdFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → the Date Prisma expects for a @db.Date column. */
export function dateFromYmd(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function isPayFrequency(f: unknown): f is PayFrequency {
  return typeof f === "string" && (PAY_FREQUENCIES as readonly string[]).includes(f);
}

// ── Paydays ────────────────────────────────────────────────────────────────

/**
 * The payday the rule would put immediately BEFORE `payday` — ignoring the
 * anchor, so it is defined for the first payday too. Used for pay periods.
 */
export function previousPayday(schedule: PaySchedule, payday: string): string {
  const f = schedule.frequency;
  if (f === "WEEKLY") return addDays(payday, -7);
  if (f === "BIWEEKLY") return addDays(payday, -14);
  const { y, m, d } = parts(payday);
  if (f === "SEMIMONTHLY") {
    if (d > 15) return ymdOf(y, m, 15);
    if (d > 1) return ymdOf(y, m, 1);
    const p = shiftMonth(y, m, -1);
    return ymdOf(p.y, p.m, 15);
  }
  if (f === "MONTHLY") {
    const anchorDay = parts(schedule.anchorDate).d;
    const p = shiftMonth(y, m, -1);
    return monthlyDay(p.y, p.m, anchorDay);
  }
  throw new Error(`Unknown pay frequency: ${f}`);
}

/** Every payday with from ≤ payday ≤ to (inclusive), oldest first. */
export function paydaysInRange(schedule: PaySchedule, from: string, to: string): string[] {
  const anchor = schedule.anchorDate;
  const lo = Math.max(toDayNum(from), toDayNum(anchor));
  const hi = toDayNum(to);
  if (lo > hi) return [];
  const out: string[] = [];
  const f = schedule.frequency;

  if (f === "WEEKLY" || f === "BIWEEKLY") {
    const step = f === "WEEKLY" ? 7 : 14;
    const a = toDayNum(anchor);
    // first k ≥ 0 with a + k·step ≥ lo
    const k = Math.max(0, Math.ceil((lo - a) / step));
    for (let n = a + k * step; n <= hi; n += step) out.push(fromDayNum(n));
    return out;
  }

  if (f === "SEMIMONTHLY" || f === "MONTHLY") {
    const anchorDay = parts(anchor).d;
    const start = parts(fromDayNum(lo));
    const end = parts(fromDayNum(hi));
    let cur = { y: start.y, m: start.m };
    while (cur.y * 12 + cur.m <= end.y * 12 + end.m) {
      const days =
        f === "SEMIMONTHLY" ? [ymdOf(cur.y, cur.m, 1), ymdOf(cur.y, cur.m, 15)] : [monthlyDay(cur.y, cur.m, anchorDay)];
      for (const day of days) {
        const n = toDayNum(day);
        if (n >= lo && n <= hi) out.push(day);
      }
      cur = shiftMonth(cur.y, cur.m, 1);
    }
    return out;
  }

  throw new Error(`Unknown pay frequency: ${f}`);
}

/** The next `count` paydays on or after `today`. */
export function nextPaydays(schedule: PaySchedule, today: string, count: number): string[] {
  if (count <= 0) return [];
  // Longest gap between paydays is ~31 days; a window of (count + 1) months
  // plus the distance to the anchor always holds `count` paydays.
  const from = toDayNum(today) >= toDayNum(schedule.anchorDate) ? today : schedule.anchorDate;
  const to = addDays(from, 32 * (count + 1));
  return paydaysInRange(schedule, from, to).slice(0, count);
}

/** The pay period a payday settles: day after the previous payday → payday. */
export function periodFor(schedule: PaySchedule, payday: string): { start: string; end: string } {
  return { start: addDays(previousPayday(schedule, payday), 1), end: payday };
}

// ── Reminders ──────────────────────────────────────────────────────────────

export type ScheduleRow = PaySchedule & { userId: string };

export function settledKey(userId: string, payday: string): string {
  return `${userId}|${payday}`;
}

/**
 * Paydays that need the owner: within the next REMIND_DAYS_AHEAD days, today,
 * or up to OVERDUE_WINDOW_DAYS overdue — and not yet settled by a payout.
 * `settled` holds settledKey(userId, payday) for every payday already paid.
 * Inactive schedules produce nothing. Sorted oldest payday first, then userId.
 */
export function dueReminders(
  schedules: ScheduleRow[],
  settled: ReadonlySet<string> | readonly string[],
  today: string,
): DueReminder[] {
  const paid = settled instanceof Set ? settled : new Set(settled as readonly string[]);
  const from = addDays(today, -OVERDUE_WINDOW_DAYS);
  const to = addDays(today, REMIND_DAYS_AHEAD);
  const out: DueReminder[] = [];
  for (const s of schedules) {
    if (s.active === false) continue;
    if (!isPayFrequency(s.frequency) || !isValidYmd(s.anchorDate)) continue;
    for (const payday of paydaysInRange(s, from, to)) {
      if (paid.has(settledKey(s.userId, payday))) continue;
      const daysUntil = daysBetween(today, payday);
      const { start, end } = periodFor(s, payday);
      out.push({
        userId: s.userId,
        payday,
        periodStart: start,
        periodEnd: end,
        status: daysUntil < 0 ? "overdue" : daysUntil === 0 ? "due_today" : "upcoming",
        daysUntil,
      });
    }
  }
  out.sort((a, b) => (a.payday < b.payday ? -1 : a.payday > b.payday ? 1 : a.userId.localeCompare(b.userId)));
  return out;
}

// ── Plain-English formatting (no locale, no timezone) ──────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 3" */
export function formatShortDate(ymd: string): string {
  const { m, d } = parts(ymd);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Fri, Oct 3" */
export function formatPayday(ymd: string): string {
  const dow = new Date(toDayNum(ymd) * DAY_MS).getUTCDay();
  return `${WEEKDAYS[dow]}, ${formatShortDate(ymd)}`;
}

/** "Sep 20 – Oct 3" */
export function formatPeriod(start: string, end: string): string {
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

/** "every 2 weeks from Oct 3", "on the 1st and 15th from Oct 1" … */
export function describeSchedule(schedule: PaySchedule): string {
  const from = formatShortDate(schedule.anchorDate);
  switch (schedule.frequency) {
    case "WEEKLY":
      return `every week from ${from}`;
    case "BIWEEKLY":
      return `every 2 weeks from ${from}`;
    case "SEMIMONTHLY":
      return `on the 1st and 15th from ${from}`;
    case "MONTHLY": {
      const d = parts(schedule.anchorDate).d;
      return `monthly on the ${ordinal(d)}${d >= 29 ? " (last day in shorter months)" : ""} from ${from}`;
    }
    default:
      return `from ${from}`;
  }
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function statusLabel(r: Pick<DueReminder, "status" | "daysUntil">): string {
  if (r.status === "due_today") return "due today";
  if (r.status === "overdue") return `${-r.daysUntil} day${r.daysUntil === -1 ? "" : "s"} overdue`;
  return r.daysUntil === 1 ? "due tomorrow" : `due in ${r.daysUntil} days`;
}
