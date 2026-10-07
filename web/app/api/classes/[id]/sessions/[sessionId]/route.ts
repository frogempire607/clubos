import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasPermissionLive } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { staffOverrideValue, checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";
import { asIdList, effectiveClassStaff } from "@/lib/staffAssignments";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";

// PATCH /api/classes/[id]/sessions/[sessionId]
//
// Per-occurrence edit for a single class session. Owner can change just this
// day's time, mark it canceled, add a one-off note, or override the assigned
// staff (substitute coach). Setting `overridden=true` makes the session
// regenerator preserve this row, so editing the parent recurring class later
// won't blow away the per-day customization.

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

const schema = z.object({
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  // "HH:mm" wall-clock alternatives — apply on the existing session date.
  startTime: z.string().regex(TIME_RE).optional(),
  endTime: z.string().regex(TIME_RE).optional(),
  canceled: z.boolean().optional(),
  staffOverride: z.array(z.string()).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
});

function applyWallClock(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  // Class sessions store wall-clock as UTC (see lib/classSessions.ts).
  const d = new Date(date);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; sessionId: string }> },
) {
  const { id: classId, sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Two different powers live in this one request (both read LIVE):
  //   time / cancel / note      → classes:edit
  //   staffOverride (who coaches this day) → schedule:edit, or a coach taking
  //                               THEMSELF off (lib/staffSelf.ts "Assignments")
  const canEditClass = await hasPermissionLive(session, "classes", "edit");
  if (!canEditClass && session.user.role !== "OWNER" && session.user.role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await prisma.recurringClass.findFirst({
    where: { id: classId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, name: true, assignedStaffIds: true },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const cs = await prisma.classSession.findFirst({
    where: { id: sessionId, classId, clubId: session.user.clubId },
  });
  if (!cs) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    }
    throw err;
  }

  const touchesDetails =
    data.startsAt !== undefined || data.endsAt !== undefined || data.startTime !== undefined ||
    data.endTime !== undefined || data.canceled !== undefined || data.note !== undefined;
  if (touchesDetails && !canEditClass) {
    return NextResponse.json({ error: "You don't have permission to manage this." }, { status: 403 });
  }

  let staffOverride: string[] | null | undefined = data.staffOverride;
  let selfRemovedOthers: string[] | null = null;
  if (data.staffOverride !== undefined) {
    const series = asIdList(cls.assignedStaffIds);
    const before = effectiveClassStaff(series, cs.staffOverride).staffIds;
    // null = "inherit the series again" — its effect on this day is the series list.
    const check = await checkAssignmentChange(session, session.user.clubId, before, data.staffOverride ?? series);
    if (check.verdict === "deny") {
      return NextResponse.json({ error: ASSIGNMENT_DENY_MESSAGE, code: "ASSIGNMENT_FORBIDDEN" }, { status: 403 });
    }
    // Only this club's OWNER/STAFF ids are ever stored.
    if (Array.isArray(data.staffOverride)) staffOverride = check.after;
    if (check.verdict === "self_remove") selfRemovedOthers = check.after;
  } else if (!touchesDetails && !canEditClass) {
    return NextResponse.json({ error: "You don't have permission to manage this." }, { status: 403 });
  }

  const startsAt = data.startsAt
    ? new Date(data.startsAt)
    : data.startTime
      ? applyWallClock(cs.startsAt, data.startTime)
      : undefined;
  const endsAt = data.endsAt
    ? new Date(data.endsAt)
    : data.endTime
      ? applyWallClock(cs.endsAt, data.endTime)
      : undefined;
  if (startsAt && isNaN(startsAt.getTime())) {
    return NextResponse.json({ error: "Invalid start time" }, { status: 400 });
  }
  if (endsAt && isNaN(endsAt.getTime())) {
    return NextResponse.json({ error: "Invalid end time" }, { status: 400 });
  }

  const updated = await prisma.classSession.update({
    where: { id: sessionId },
    data: {
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(data.canceled !== undefined ? { canceled: data.canceled } : {}),
      ...(staffOverride !== undefined
        ? // null clears the substitute (inherit the series) — it used to be
          // turned into `undefined`, i.e. silently ignored.
          { staffOverride: staffOverrideValue(staffOverride) }
        : {}),
      ...(data.note !== undefined ? { note: data.note ?? null } : {}),
      // Any per-occurrence edit pins this row so series regeneration
      // preserves it.
      overridden: true,
    },
  });

  if (selfRemovedOthers) {
    await notifySelfRemoval({
      clubId: session.user.clubId,
      actorId: session.user.id,
      actorName: session.user.name,
      what: cls.name,
      when: `on ${cs.date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
      otherCoachIds: selfRemovedOthers,
    });
  }

  return NextResponse.json(updated);
}
