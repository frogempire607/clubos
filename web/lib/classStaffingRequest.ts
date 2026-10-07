// The body of POST /api/classes/[id]/staffing and …/staffing/preview, and the
// read both need before they plan or write: the class, the day's current
// rows, the rules, and who the change ADDS (the conflict check is about them).
// No permissions here — each handler runs its own live guard first.
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { classTimesForDay, hhmmUTC } from "@/lib/staffAssignments";
import {
  clubTodayYmd,
  dowOfYmd,
  isSwitchedOn,
  isYmd,
  maxYmd,
  normalizeRoleName,
  rulesForDay,
  addDaysYmd,
  toYmd,
  ymdToDate,
  type ChangeScope,
  type DayStaffRow,
  type DesiredStaff,
  type StaffKind,
  type StaffRule,
  type StaffSource,
  type StaffStatus,
} from "@/lib/classStaff";
import { getScheduleSettings, loadClassRules } from "@/lib/classStaffServer";

export const staffingBodySchema = z.object({
  scope: z.enum(["OCCURRENCE", "WEEKDAY_FORWARD", "ALL_FUTURE"]),
  date: z.string().refine(isYmd, "date must be YYYY-MM-DD"),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  staff: z.array(z.object({ userId: z.string().min(1), roleName: z.string().max(60).nullable().optional() })).max(50),
  acknowledgeConflicts: z.boolean().optional(),
});
export type StaffingBody = z.infer<typeof staffingBodySchema>;

export type StaffingContext = {
  cls: { id: string; name: string; daysOfWeek: number[]; startTime: string; endTime: string; dayOverrides: unknown };
  timezone: string | null;
  assignmentsStartOn: string | null;
  /** The date is on/after the switch-on date. */
  switched: boolean;
  today: string;
  scope: ChangeScope;
  date: string;
  /** WEEKDAY_FORWARD: the weekday; otherwise null. */
  dayOfWeek: number | null;
  rules: StaffRule[];
  /** OCCURRENCE: the day's session (null = not materialized yet) and its rows. */
  session: { id: string; startsAt: Date; endsAt: Date; canceled: boolean } | null;
  dayRows: DayStaffRow[];
  desired: DesiredStaff[];
  /** Who is on it now, for this scope. */
  beforeIds: string[];
  /** Coaches this change puts on who are not on it now. */
  addedIds: string[];
  /** The wall-clock slot of the class day (OCCURRENCE). */
  slot: { date: string; startTime: string; endTime: string };
  /** Rule scopes: the first day the conflict check looks from. */
  conflictFrom: string;
};

/** null = no such class in this club. */
export async function loadStaffingContext(clubId: string, classId: string, body: StaffingBody, now: Date = new Date()): Promise<StaffingContext | null> {
  const cls = await prisma.recurringClass.findFirst({
    where: { id: classId, clubId, deletedAt: null },
    select: { id: true, name: true, daysOfWeek: true, startTime: true, endTime: true, dayOverrides: true, club: { select: { timezone: true } } },
  });
  if (!cls) return null;
  const timezone = cls.club?.timezone ?? null;
  const settings = await getScheduleSettings(clubId);
  const startOn = settings.assignmentsStartOn;
  const date = body.date.slice(0, 10);
  const switched = isSwitchedOn(startOn, date);
  const today = clubTodayYmd(timezone, now);
  const scope = body.scope as ChangeScope;
  const dayOfWeek = scope === "WEEKDAY_FORWARD" ? (body.dayOfWeek ?? dowOfYmd(date)) : null;
  const rules = startOn ? await loadClassRules(prisma, classId) : [];
  const desired: DesiredStaff[] = body.staff.map((s) => (s.roleName === undefined ? { userId: s.userId } : { userId: s.userId, roleName: normalizeRoleName(s.roleName) }));
  const wanted = Array.from(new Set(desired.map((d) => d.userId)));

  let session: StaffingContext["session"] = null;
  let dayRows: DayStaffRow[] = [];
  let beforeIds: string[];
  if (scope === "OCCURRENCE") {
    const s = await prisma.classSession.findUnique({
      where: { classId_date: { classId, date: ymdToDate(date) } },
      select: {
        id: true, startsAt: true, endsAt: true, canceled: true,
        staff: {
          select: {
            id: true, sessionId: true, userId: true, roleName: true, kind: true, status: true, source: true, ruleId: true,
            replacesStaffId: true, lateCallout: true, calledOutAt: true, calledOutByUserId: true, calloutReason: true,
            coverageFilledAt: true, coverageFilledByUserId: true, note: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
    if (s) {
      session = { id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, canceled: s.canceled };
      dayRows = s.staff.map((r) => ({ ...r, kind: r.kind as StaffKind, status: r.status as StaffStatus, source: r.source as StaffSource }));
      beforeIds = dayRows.filter((r) => r.status === "SCHEDULED").map((r) => r.userId);
    } else {
      // Not materialized yet: ensureSession will give it the rule coaches.
      const ruleStaff = rulesForDay(rules, date);
      beforeIds = ruleStaff.map((r) => r.userId);
      dayRows = ruleStaff.map((r, i) => ({
        id: `pending_${i}`, sessionId: "pending", userId: r.userId, roleName: r.roleName, kind: "REGULAR" as const, status: "SCHEDULED" as const,
        source: "RULE" as const, ruleId: r.ruleId, replacesStaffId: null, lateCallout: false,
      }));
    }
  } else {
    const dow = dayOfWeek ?? dowOfYmd(date);
    const first = dayOfWeek === null ? date : addDaysYmd(date, (dow - dowOfYmd(date) + 7) % 7);
    if (dayOfWeek === null) {
      // "All future": only someone already on EVERY class weekday is "not new"
      // for the conflict check (a Tuesday-only coach gains the other days).
      const days = Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number) : [];
      const check = days.length ? days : [dowOfYmd(date)];
      const onDay = check.map((d) => new Set(rulesForDay(rules, addDaysYmd(date, (d - dowOfYmd(date) + 7) % 7), d).map((r) => r.userId)));
      beforeIds = Array.from(onDay[0] ?? []).filter((id) => onDay.every((set) => set.has(id)));
    } else {
      beforeIds = rulesForDay(rules, first, dow).map((r) => r.userId);
    }
  }
  const before = new Set(beforeIds);
  const dow = dowOfYmd(date);
  const t = session ? { startTime: hhmmUTC(session.startsAt), endTime: hhmmUTC(session.endsAt) } : classTimesForDay(cls.startTime, cls.endTime, cls.dayOverrides, dow);
  return {
    cls: { id: cls.id, name: cls.name, daysOfWeek: Array.isArray(cls.daysOfWeek) ? (cls.daysOfWeek as unknown[]).map(Number) : [], startTime: cls.startTime, endTime: cls.endTime, dayOverrides: cls.dayOverrides },
    timezone, assignmentsStartOn: startOn, switched, today, scope, date, dayOfWeek, rules, session, dayRows, desired,
    beforeIds, addedIds: wanted.filter((id) => !before.has(id)),
    slot: { date, startTime: t.startTime, endTime: t.endTime },
    conflictFrom: maxYmd(date, today),
  };
}

/** For the notices: "on Tue Oct 20" / "on Tuesdays from Oct 20" / "every class day from Oct 20". */
export function staffingWhen(ctx: Pick<StaffingContext, "scope" | "date" | "dayOfWeek">): string {
  const md = new Date(`${ctx.date}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (ctx.scope === "OCCURRENCE") {
    const wd = new Date(`${ctx.date}T00:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    return `on ${wd} ${md}`;
  }
  if (ctx.scope === "WEEKDAY_FORWARD" && ctx.dayOfWeek !== null) {
    return `on ${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][ctx.dayOfWeek]} from ${md}`;
  }
  return `every class day from ${md}`;
}
// `toYmd` is re-exported for the routes that format a session's date.
export { toYmd };
