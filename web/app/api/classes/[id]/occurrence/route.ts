import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermissionLive } from "@/lib/apiGuard";
import { syncFutureSessions } from "@/lib/classSessionSync";
import { staffOverrideValue, checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";
import { asIdList, effectiveClassStaff } from "@/lib/staffAssignments";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";

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
    const created = await prisma.classSession.create({
      data: {
        classId: id,
        clubId: cls.clubId,
        date: start,
        startsAt: atUTC(body.date, body.startTime ?? cls.startTime),
        endsAt: atUTC(body.date, body.endTime ?? cls.endTime),
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
