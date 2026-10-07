// Payday reminders — the server side of lib/paySchedule.ts.
//
// One loader feeds every surface: GET /api/payroll/reminders (Payroll page),
// the dashboard Action Center, and the morning email cron. The estimated
// amount on a reminder comes from lib/payrollCalc.ts — the same calculation
// the Payroll page runs — for that reminder's pay period.
//
// A payday counts as SETTLED when a PAYROLL payout for that staff member has
// payPeriodEnd = payday and is not VOID (PENDING or PAID). Marking a reminder
// paid (/api/payroll/reminders/mark-paid) writes exactly that payout.
import { prisma } from "@/lib/prisma";
import { wallClockNowUTC } from "@/lib/datetime";
import { computePayroll, payrollRange } from "@/lib/payrollCalc";
import { getLedgerStart, periodLines, syncPayLinesThrottled } from "@/lib/payLedgerServer";
import {
  REMIND_DAYS_AHEAD,
  OVERDUE_WINDOW_DAYS,
  addDays,
  dateFromYmd,
  dueReminders,
  nextPaydays,
  settledKey,
  ymdFromDate,
  type DueReminder,
  type PayFrequency,
} from "@/lib/paySchedule";

/**
 * Today's calendar day for the club, YYYY-MM-DD. Uses the club's timezone
 * when it has one; otherwise the UTC day (the cron runs at 12:00 UTC, when the
 * UTC day and every US day agree).
 */
export function clubTodayYmd(timeZone: string | null | undefined, at: Date = new Date()): string {
  if (timeZone) {
    try {
      // wallClockNowUTC re-pins the club's wall clock to UTC.
      Intl.DateTimeFormat("en-US", { timeZone });
      return wallClockNowUTC(timeZone, at).toISOString().slice(0, 10);
    } catch {
      // invalid timezone — fall through
    }
  }
  return at.toISOString().slice(0, 10);
}

export type ReminderView = DueReminder & {
  name: string;
  firstName: string;
  /** Payroll-page estimate for the period; null when they have no pay plan. */
  estimate: number | null;
  hasPlan: boolean;
  /** true = the amount is the total of this period's saved pay lines (pay ledger), not the old estimate. */
  fromLedger?: boolean;
  /** Pay lines in this period that still need a decision before they can be paid. */
  needsReview?: number;
};

export type ScheduleView = {
  userId: string;
  name: string;
  frequency: PayFrequency;
  anchorDate: string;
  active: boolean;
  nextPayday: string | null;
  lastEmailedFor: string | null;
  scheduleId: string;
};

export type ClubReminders = {
  today: string;
  reminders: ReminderView[];
  schedules: ScheduleView[];
  /** Staff with no pay schedule at all. */
  unscheduled: { userId: string; name: string }[];
};

export async function loadClubReminders(
  clubId: string,
  opts: { today?: string; withAmounts?: boolean } = {},
): Promise<ClubReminders> {
  const withAmounts = opts.withAmounts !== false;
  let today = opts.today;
  if (!today) {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
    today = clubTodayYmd(club?.timezone);
  }

  const [staff, rows] = await Promise.all([
    prisma.user.findMany({
      where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: "asc" },
    }),
    prisma.staffPaySchedule.findMany({ where: { clubId } }),
  ]);
  const names = new Map(staff.map((s) => [s.id, { first: s.firstName, full: `${s.firstName} ${s.lastName}`.trim() }]));
  const live = rows.filter((r) => names.has(r.userId));

  const schedules: ScheduleView[] = live.map((r) => {
    const sch = { frequency: r.frequency, anchorDate: ymdFromDate(r.anchorDate) };
    return {
      scheduleId: r.id,
      userId: r.userId,
      name: names.get(r.userId)!.full,
      frequency: r.frequency as PayFrequency,
      anchorDate: sch.anchorDate,
      active: r.active,
      nextPayday: r.active ? nextPaydays(sch, today!, 1)[0] ?? null : null,
      lastEmailedFor: r.lastEmailedFor ? ymdFromDate(r.lastEmailedFor) : null,
    };
  });
  const scheduled = new Set(live.map((r) => r.userId));
  const unscheduled = staff
    .filter((s) => !scheduled.has(s.id))
    .map((s) => ({ userId: s.id, name: names.get(s.id)!.full }));

  const active = schedules.filter((s) => s.active);
  if (active.length === 0) return { today, reminders: [], schedules, unscheduled };

  const settledRows = await prisma.payout.findMany({
    where: {
      clubId,
      kind: "PAYROLL",
      status: { not: "VOID" },
      payeeUserId: { in: active.map((s) => s.userId) },
      payPeriodEnd: {
        gte: dateFromYmd(addDays(today, -OVERDUE_WINDOW_DAYS)),
        lte: dateFromYmd(addDays(today, REMIND_DAYS_AHEAD)),
      },
    },
    select: { payeeUserId: true, payPeriodEnd: true },
  });
  const settled = new Set(
    settledRows
      .filter((p) => p.payeeUserId && p.payPeriodEnd)
      .map((p) => settledKey(p.payeeUserId!, ymdFromDate(p.payPeriodEnd!))),
  );

  const due = dueReminders(
    active.map((s) => ({ userId: s.userId, frequency: s.frequency, anchorDate: s.anchorDate, active: true })),
    settled,
    today,
  );

  // One payroll calculation per distinct period, limited to the staff due in it.
  const estimates = new Map<string, { estimate: number | null; hasPlan: boolean; fromLedger?: boolean; needsReview?: number }>();
  // Periods that start on/after the pay-ledger start date are read from the
  // saved pay lines; earlier periods keep the old estimate.
  const ledgerStart = withAmounts && due.length ? await getLedgerStart(clubId) : null;
  const onLedger = (r: { periodStart: string }) => !!ledgerStart && r.periodStart >= ledgerStart;
  if (withAmounts && due.some(onLedger)) {
    await syncPayLinesThrottled(clubId);
    const planned = await prisma.staffCompensation.findMany({ where: { clubId, archivedAt: null }, select: { userId: true } });
    const hasPlan = new Set(planned.map((p) => p.userId));
    for (const r of due.filter(onLedger)) {
      const got = await periodLines(clubId, r.userId, r.periodEnd);
      estimates.set(`${r.userId}|${r.periodStart}|${r.periodEnd}`, {
        estimate: got.amountCents / 100, hasPlan: hasPlan.has(r.userId), fromLedger: true, needsReview: got.reviewCount,
      });
    }
  }
  if (withAmounts && due.some((r) => !onLedger(r))) {
    const byPeriod = new Map<string, { start: string; end: string; userIds: Set<string> }>();
    for (const r of due) {
      if (onLedger(r)) continue;
      const k = `${r.periodStart}|${r.periodEnd}`;
      const g = byPeriod.get(k) ?? { start: r.periodStart, end: r.periodEnd, userIds: new Set<string>() };
      g.userIds.add(r.userId);
      byPeriod.set(k, g);
    }
    await Promise.all(
      Array.from(byPeriod.values()).map(async (g) => {
        const { from, to } = payrollRange(g.start, g.end);
        const calc = await computePayroll(clubId, from, to, { userIds: Array.from(g.userIds) });
        for (const s of calc.staff) {
          estimates.set(`${s.id}|${g.start}|${g.end}`, {
            estimate: s.payout ? s.payout.total : null,
            hasPlan: s.hasPlan,
          });
        }
      }),
    );
  }

  const reminders: ReminderView[] = due.map((r) => {
    const e = estimates.get(`${r.userId}|${r.periodStart}|${r.periodEnd}`);
    return {
      ...r,
      name: names.get(r.userId)!.full,
      firstName: names.get(r.userId)!.first,
      estimate: e?.estimate ?? null,
      hasPlan: e?.hasPlan ?? false,
      ...(e?.fromLedger ? { fromLedger: true, needsReview: e.needsReview ?? 0 } : {}),
    };
  });

  return { today, reminders, schedules, unscheduled };
}

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "$420" for whole dollars, "$420.50" otherwise — for short reminder copy. */
export function formatUsdShort(n: number): string {
  return Number.isInteger(n)
    ? `$${n.toLocaleString("en-US")}`
    : formatUsd(n);
}
