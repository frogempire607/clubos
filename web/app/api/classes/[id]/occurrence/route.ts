import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermissionLive } from "@/lib/apiGuard";
import { syncFutureSessions } from "@/lib/classSessionSync";
import { staffOverrideValue, checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";
import { asIdList, classTimesForDay, effectiveClassStaff } from "@/lib/staffAssignments";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";
import { currentRuleStaffIds, isSwitchedOn, rulesForDay, ymdToDate } from "@/lib/classStaff";
import {
  applySeriesListChange,
  cancelOccurrence,
  ensureSession,
  loadClassRules,
  seriesChangeDate,
  setDayStaff,
  uncancelOccurrence,
} from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse } from "@/lib/classStaffApi";

const TIME = /^\d{2}:\d{2}$/;

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // the occurrence's calendar day
  scope: z.enum(["occurrence", "following", "series"]).default("occurrence"),
  // null on staffIds = clear the override (inherit the series again).
  staffIds: z.array(z.string()).nullable().optional(),
  startTime: z.string().regex(TIME).optional(),
  endTime: z.string().regex(TIME).optional(),
  note: z.string().max(2000).nullable().optional(),
  canceled: z.boolean().optional(),
  // "Take me off" — the server works out the list (everyone on it now, minus
  // the caller), so a coach who can only see their own schedule can still do it.
  removeSelf: z.boolean().optional(),
});

// UTC day window matching how buildSessions stores ClassSession.date.
function dayWindow(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}
function atUTC(dateStr: string, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

// POST /api/classes/[id]/occurrence
// Recurring-calendar style edit. `scope` controls blast radius:
//   occurrence → just this day's ClassSession (created if it doesn't exist yet)
//   following  → this day and every later session of the series
//   series     → the RecurringClass itself (staff + default times), then
//                regenerate future sessions while preserving attendance and
//                any sessions that already carry a per-occurrence override.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // schedule:edit, read LIVE. Without it exactly one thing is allowed further
  // down: a coach taking THEMSELF off (this day or the series), nothing else in
  // the same request (lib/staffSelf.ts "Assignments").
  const canManage = await hasPermissionLive(session, "schedule", "edit");
  if (!canManage && session.user.role !== "OWNER" && session.user.role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await prisma.recurringClass.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  // ── Club switched on to the new coach assignments ──
  // A series change always goes to the rules; a day change does when the day
  // is on/after the switch-on date. Days before it — and every day of a club
  // that is not switched on — take the legacy path below, unchanged.
  const sw = await seriesChangeDate(cls.clubId);
  if (sw.assignmentsStartOn && sw.from) {
    if (body.scope === "following" && !isSwitchedOn(sw.assignmentsStartOn, body.date)) {
      return NextResponse.json(
        { error: `"This and following" has to start on or after ${sw.assignmentsStartOn}, when the new coach assignments began. Change earlier days one at a time.`, code: "SPANS_SWITCH_ON" },
        { status: 409 },
      );
    }
    if (body.scope === "series" || isSwitchedOn(sw.assignmentsStartOn, body.date)) {
      return switchedOnEdit({ session, cls, body, canManage, seriesFrom: sw.from });
    }
  }

  const seriesStaff = asIdList(cls.assignedStaffIds);

  // Who is on it now, for the scope being edited: the series list, or this
  // day's effective list (its override if it has one, else the series).
  const dayRow = body.scope === "series"
    ? null
    : await prisma.classSession.findFirst({
        where: { classId: id, date: { gte: dayWindow(body.date).start, lt: dayWindow(body.date).end } },
        select: { staffOverride: true },
      });
  const beforeStaff = body.scope === "series"
    ? seriesStaff
    : effectiveClassStaff(seriesStaff, dayRow?.staffOverride ?? null).staffIds;

  if (body.removeSelf) body.staffIds = beforeStaff.filter((x) => x !== session.user.id);

  let selfRemoved = false;
  let selfRemovedOthers: string[] = [];
  if (body.staffIds !== undefined) {
    // null = "inherit the series again" — its effect on this day is the series list.
    const requested = body.staffIds === null ? seriesStaff : body.staffIds;
    const check = await checkAssignmentChange(session, cls.clubId, beforeStaff, requested);
    if (check.verdict === "deny") {
      return NextResponse.json({ error: ASSIGNMENT_DENY_MESSAGE, code: "ASSIGNMENT_FORBIDDEN" }, { status: 403 });
    }
    // Only this club's OWNER/STAFF can be put on a class.
    if (Array.isArray(body.staffIds)) body.staffIds = check.after;
    selfRemoved = check.verdict === "self_remove";
    selfRemovedOthers = check.after;
  }
  if (!canManage) {
    // Not a schedule manager: a self-removal and nothing else. No times, no
    // cancel, no note, and not "this day and every later one".
    const onlyStaff =
      body.startTime === undefined && body.endTime === undefined &&
      body.note === undefined && body.canceled === undefined;
    if (!selfRemoved || !onlyStaff || body.scope === "following") {
      return NextResponse.json(
        { error: "You don't have permission to manage this.", code: "SCHEDULE_EDIT_REQUIRED" },
        { status: 403 },
      );
    }
  }
  const tellOthers = async () => {
    if (!selfRemoved) return;
    await notifySelfRemoval({
      clubId: cls.clubId,
      actorId: session.user.id,
      actorName: session.user.name,
      what: cls.name,
      when: body.scope === "series"
        ? "every week"
        : `on ${new Date(`${body.date}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
      otherCoachIds: selfRemovedOthers,
    });
  };

  // ── SERIES: change the recurring class itself ──
  if (body.scope === "series") {
    const data: Record<string, unknown> = {};
    if (body.staffIds !== undefined && body.staffIds !== null) data.assignedStaffIds = body.staffIds;
    if (body.startTime) data.startTime = body.startTime;
    if (body.endTime) data.endTime = body.endTime;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update for the series." }, { status: 400 });
    }
    const updated = await prisma.recurringClass.update({ where: { id }, data });

    // Move future sessions to the new times if the times moved. Reconciled by
    // date so an already-booked occurrence is UPDATED rather than replaced —
    // see lib/classSessionSync.ts. Per-occurrence edits and cancellations on
    // individual days survive a series change untouched.
    const sessionSync = (body.startTime || body.endTime)
      ? await syncFutureSessions(updated)
      : null;

    await tellOthers();
    return NextResponse.json({ ok: true, scope: "series", sessionSync, selfRemoved });
  }

  // ── OCCURRENCE / FOLLOWING: write per-session overrides ──
  const { start } = dayWindow(body.date);

  // Sessions to touch.
  const targets =
    body.scope === "following"
      ? await prisma.classSession.findMany({ where: { classId: id, date: { gte: start } } })
      : await prisma.classSession.findMany({ where: { classId: id, date: { gte: start, lt: dayWindow(body.date).end } } });

  // "occurrence" with no materialized row yet → create one for that day.
  if (body.scope === "occurrence" && targets.length === 0) {
    const weekdayTimes = classTimesForDay(cls.startTime, cls.endTime, cls.dayOverrides, start.getUTCDay());
    const created = await prisma.classSession.create({
      data: {
        classId: id,
        clubId: cls.clubId,
        date: start,
        // The series time for THIS weekday (dayOverrides) — it used to stamp the
        // class's default time on a weekday that has its own.
        startsAt: atUTC(body.date, body.startTime ?? weekdayTimes.startTime),
        endsAt: atUTC(body.date, body.endTime ?? weekdayTimes.endTime),
        canceled: body.canceled ?? false,
        // null = inherit the series. Prisma needs DbNull for a Json column —
        // a bare null here threw, so "reset to the series" never saved.
        staffOverride: body.staffIds !== undefined ? staffOverrideValue(body.staffIds) : undefined,
        note: body.note ?? null,
        overridden: true,
      },
    });
    await tellOthers();
    return NextResponse.json({ ok: true, scope: "occurrence", sessionId: created.id, selfRemoved });
  }

  let updatedCount = 0;
  for (const s of targets) {
    const dateStr = s.date.toISOString().slice(0, 10);
    const data: Record<string, unknown> = { overridden: true };
    if (body.staffIds !== undefined) {
      // null clears the override (re-inherit the series); array sets it.
      data.staffOverride = staffOverrideValue(body.staffIds);
    }
    if (body.note !== undefined) data.note = body.note;
    if (body.canceled !== undefined) data.canceled = body.canceled;
    if (body.startTime) data.startsAt = atUTC(dateStr, body.startTime);
    if (body.endTime) data.endsAt = atUTC(dateStr, body.endTime);
    await prisma.classSession.update({ where: { id: s.id }, data });
    updatedCount++;
  }

  await tellOthers();
  return NextResponse.json({
    ok: true,
    scope: body.scope,
    updated: updatedCount,
    seriesStaff,
    selfRemoved,
  });
}

// ── The same request for a club switched on to ClassStaffRule / ClassSessionStaff ──
//
// Old scope names → the new functions, in ONE transaction:
//   occurrence → that class day's rows (setDayStaff). The day is created with
//                ensureSession, so it gets the time of ITS weekday (the inline
//                create above stamps the class's default time).
//   following  → the recurring rules from that date (a diff: people no longer
//                listed come off, new people go on every class day), plus that
//                day's own rows when a one-day change was hiding the rules
//   series     → the recurring rules from today
// RecurringClass.assignedStaffIds is never written (frozen legacy record).
// The security rules are the ones above: checkAssignmentChange, a non-manager
// may only take THEMSELF off (a day or the series) and the others are told.
async function switchedOnEdit(args: {
  session: { user: { id: string; name?: string | null; role?: string; clubId: string; permissions?: Record<string, unknown> | null } };
  cls: { id: string; clubId: string; name: string; startTime: string; endTime: string };
  body: z.infer<typeof schema>;
  canManage: boolean;
  seriesFrom: string;
}): Promise<NextResponse> {
  const { session, cls, body, canManage, seriesFrom } = args;
  const me = session.user.id;
  const rules = await loadClassRules(prisma, cls.id);
  const dayRow = body.scope === "series"
    ? null
    : await prisma.classSession.findUnique({
        where: { classId_date: { classId: cls.id, date: ymdToDate(body.date) } },
        select: { id: true, staff: { select: { userId: true, status: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
      });
  const ruleDayStaff = rulesForDay(rules, body.date).map((r) => r.userId);
  const seriesNow = currentRuleStaffIds(rules, seriesFrom);
  // Who is on it now: the recurring coaches, or the coaches SCHEDULED that day
  // (the rules, for a day that has no row yet — ensureSession gives it those).
  const beforeStaff = body.scope === "series"
    ? seriesNow
    : dayRow ? dayRow.staff.filter((r) => r.status === "SCHEDULED").map((r) => r.userId) : ruleDayStaff;

  let staffIds = body.staffIds;
  if (body.removeSelf) staffIds = beforeStaff.filter((x) => x !== me);

  let selfRemoved = false;
  let before: string[] = beforeStaff;
  let desired: string[] | undefined;
  if (staffIds !== undefined) {
    // null = "follow the recurring schedule again".
    const requested = staffIds === null ? (body.scope === "series" ? seriesNow : ruleDayStaff) : staffIds;
    const check = await checkAssignmentChange(session, cls.clubId, beforeStaff, requested);
    if (check.verdict === "deny") {
      return NextResponse.json({ error: ASSIGNMENT_DENY_MESSAGE, code: "ASSIGNMENT_FORBIDDEN" }, { status: 403 });
    }
    selfRemoved = check.verdict === "self_remove";
    before = check.before;
    if (check.verdict !== "none") desired = check.after;
  }
  if (!canManage) {
    const onlyStaff =
      body.startTime === undefined && body.endTime === undefined &&
      body.note === undefined && body.canceled === undefined;
    if (!selfRemoved || !onlyStaff || body.scope === "following") {
      return NextResponse.json(
        { error: "You don't have permission to manage this.", code: "SCHEDULE_EDIT_REQUIRED" },
        { status: 403 },
      );
    }
  }

  const setCanceled = async (tx: Parameters<typeof setDayStaff>[0], sessionId: string, canceled: boolean) => {
    // The old toggle has no audience or pay choice: recorded as "told nobody,
    // unpaid". The cancel sheet (POST /api/classes/sessions/[id]/cancel) is
    // the way to notify families or keep pay.
    if (canceled) await cancelOccurrence(tx, { clubId: cls.clubId, sessionId, reason: null, notifyAudience: "NONE", paid: false, byUserId: me });
    else await uncancelOccurrence(tx, { clubId: cls.clubId, sessionId, byUserId: me });
  };

  let out: { updatedClass?: Parameters<typeof syncFutureSessions>[0]; sessionId?: string; updated?: number; nothing?: boolean };
  try {
    out = await prisma.$transaction(async (tx) => {
      if (body.scope === "series") {
        const data: Record<string, unknown> = {};
        if (body.startTime) data.startTime = body.startTime;
        if (body.endTime) data.endTime = body.endTime;
        if (Object.keys(data).length === 0 && (staffIds === undefined || staffIds === null)) return { nothing: true };
        const updatedClass = Object.keys(data).length > 0 ? await tx.recurringClass.update({ where: { id: cls.id }, data }) : undefined;
        if (desired) await applySeriesListChange(tx, { clubId: cls.clubId, classId: cls.id, date: seriesFrom, before, after: desired, byUserId: me });
        return { updatedClass };
      }

      if (body.scope === "following") {
        if (desired) await applySeriesListChange(tx, { clubId: cls.clubId, classId: cls.id, date: body.date, before, after: desired, byUserId: me });
        const targets = await tx.classSession.findMany({
          where: { classId: cls.id, date: { gte: dayWindow(body.date).start } },
          select: { id: true, date: true },
        });
        for (const s of targets) {
          const dateStr = s.date.toISOString().slice(0, 10);
          const data: Record<string, unknown> = { overridden: true };
          if (body.note !== undefined) data.note = body.note;
          if (body.startTime) data.startsAt = atUTC(dateStr, body.startTime);
          if (body.endTime) data.endsAt = atUTC(dateStr, body.endTime);
          await tx.classSession.update({ where: { id: s.id }, data });
          if (body.canceled !== undefined) await setCanceled(tx, s.id, body.canceled);
        }
        // The day the change was made from: if a one-day change was in effect
        // there, the rules alone do not reach it — set it to the list asked for.
        if (desired && dayRow) {
          const now = await tx.classSessionStaff.findMany({ where: { sessionId: dayRow.id, status: "SCHEDULED" }, select: { userId: true } });
          const have = new Set(now.map((r) => r.userId));
          if (have.size !== desired.length || desired.some((id) => !have.has(id))) {
            await setDayStaff(tx, { clubId: cls.clubId, sessionId: dayRow.id, staff: desired.map((userId) => ({ userId })), byUserId: me });
          }
        }
        return { updated: targets.length };
      }

      // occurrence
      const { session: day } = await ensureSession(cls.id, body.date, tx);
      const data: Record<string, unknown> = { overridden: true };
      if (body.note !== undefined) data.note = body.note;
      if (body.startTime) data.startsAt = atUTC(body.date, body.startTime);
      if (body.endTime) data.endsAt = atUTC(body.date, body.endTime);
      await tx.classSession.update({ where: { id: day.id }, data });
      if (body.canceled !== undefined) await setCanceled(tx, day.id, body.canceled);
      if (desired) await setDayStaff(tx, { clubId: cls.clubId, sessionId: day.id, staff: desired.map((userId) => ({ userId })), byUserId: me });
      return { sessionId: day.id, updated: 1 };
    }, STAFF_TX);
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (out.nothing) return NextResponse.json({ error: "Nothing to update for the series." }, { status: 400 });

  // Moving the series time reconciles future class days by date (bookings
  // carried along) — the existing sync, after the commit as before.
  const sessionSync = out.updatedClass ? await syncFutureSessions(out.updatedClass) : null;

  if (selfRemoved) {
    await notifySelfRemoval({
      clubId: cls.clubId,
      actorId: me,
      actorName: session.user.name,
      what: cls.name,
      when: body.scope === "series"
        ? "every week"
        : `on ${new Date(`${body.date}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
      otherCoachIds: desired ?? [],
    });
  }
  if (body.scope === "series") return NextResponse.json({ ok: true, scope: "series", sessionSync, selfRemoved });
  return NextResponse.json({
    ok: true,
    scope: body.scope,
    ...(out.sessionId ? { sessionId: out.sessionId } : {}),
    updated: out.updated ?? 0,
    seriesStaff: seriesNow,
    selfRemoved,
  });
}
