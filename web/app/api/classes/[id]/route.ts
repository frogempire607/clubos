import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requirePermissionLive } from "@/lib/apiGuard";
import { checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";
import { asIdList } from "@/lib/staffAssignments";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";
import { z } from "zod";
import { syncFutureSessions } from "@/lib/classSessionSync";
import { currentRuleStaffIds } from "@/lib/classStaff";
import { applySeriesListChange, loadClassRules, seriesChangeDate } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, seriesStaffPayload } from "@/lib/classStaffApi";

const TIME_REGEX = /^\d{2}:\d{2}$/;
const dayOverrideSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX),
  endTime: z.string().regex(TIME_REGEX),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  startTime: z.string().regex(TIME_REGEX).optional(),
  endTime: z.string().regex(TIME_REGEX).optional(),
  dayOverrides: z.array(dayOverrideSchema).optional(),
  capacity: z.number().int().positive().optional().nullable(),
  recurrenceStartDate: z.string().optional(),
  recurrenceEndDate: z.string().optional().nullable(),
  pricingOptions: z
    .array(z.union([
      z.object({ type: z.enum(["member", "nonmember", "dropin"]), price: z.number() }),
      z.object({ type: z.literal("membership"), membershipId: z.string(), optionIds: z.array(z.string().max(64)).max(50).optional() }),
    ]))
    .optional(),
  assignedStaffIds: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  color: z.string().optional().nullable(),
  textColor: z.string().optional().nullable(),
  visibility: z.enum(["PUBLIC", "MEMBERS_ONLY", "PRIVATE"]).optional(),
});

async function findClass(id: string, clubId: string) {
  return prisma.recurringClass.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Dashboard detail (coach ids, pricing). Members use /api/member/*.
  const denied = requirePermission(session, "classes", "view");
  if (denied) return denied;

  const cls = await prisma.recurringClass.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      location: { select: { name: true } },
      _count: { select: { sessions: true } },
    },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Who coaches it, at series level. For a club switched on to the new coach
  // assignments that is the RULES: `staffRules` + `currentStaff`, and
  // `assignedStaffIds` (what older screens show and send back) is those
  // coaches' ids. The stored column is frozen as the pre-switch record and
  // returned as `legacyAssignedStaffIds`.
  const staff = (await seriesStaffPayload(session.user.clubId, [cls])).get(cls.id);
  return NextResponse.json({ ...cls, ...(staff ?? {}) });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2026-10-07: this was role-only — ANY staff login could rewrite a class and
  // its coaches. Class details need classes:edit, read live.
  const denied = await requirePermissionLive(session, "classes", "edit");
  if (denied) return denied;

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { recurrenceStartDate, recurrenceEndDate, assignedStaffIds: requestedStaff, ...rest } = parsed.data;

  // Changing the coaches is an ASSIGNMENT, not a class detail: schedule:edit
  // (live). Without it the one allowed change is taking yourself off. The class
  // editor sends the whole form every save, so an unchanged list is a no-op and
  // is not rewritten.
  let staffWrite: string[] | undefined;
  let selfRemoved = false;
  let rulesFrom: string | null = null;
  let staffBefore: string[] = [];
  if (requestedStaff !== undefined) {
    // Switched-on club: "who coaches it now" is the rules, not the frozen
    // legacy column (which is also what the GET above hands the editor).
    const sw = await seriesChangeDate(session.user.clubId);
    rulesFrom = sw.from;
    staffBefore = rulesFrom
      ? currentRuleStaffIds(await loadClassRules(prisma, cls.id), rulesFrom)
      : asIdList(cls.assignedStaffIds);
    const check = await checkAssignmentChange(session, session.user.clubId, staffBefore, requestedStaff);
    if (check.verdict === "deny") {
      return NextResponse.json({ error: ASSIGNMENT_DENY_MESSAGE, code: "ASSIGNMENT_FORBIDDEN" }, { status: 403 });
    }
    if (check.verdict !== "none") staffWrite = check.after;
    staffBefore = check.before;
    selfRemoved = check.verdict === "self_remove";
  }

  // Clean overrides against the (possibly updated) daysOfWeek list
  const effectiveDaysOfWeek = (rest.daysOfWeek ?? (cls.daysOfWeek as number[])) || [];
  const incomingOverrides = rest.dayOverrides;
  const cleanOverrides = incomingOverrides
    ? incomingOverrides.filter((o) => effectiveDaysOfWeek.includes(o.dayOfWeek))
    : undefined;

  const classData = {
    ...rest,
    ...(cleanOverrides !== undefined ? { dayOverrides: cleanOverrides } : {}),
    ...(recurrenceStartDate !== undefined ? { recurrenceStartDate: new Date(recurrenceStartDate) } : {}),
    ...(recurrenceEndDate !== undefined ? { recurrenceEndDate: recurrenceEndDate ? new Date(recurrenceEndDate) : null } : {}),
  };
  let updated: Awaited<ReturnType<typeof prisma.recurringClass.update>>;
  if (rulesFrom && staffWrite !== undefined) {
    // Switched on: the coach change becomes rule changes from today (people no
    // longer listed come off, new people go on every class day, everyone else
    // — weekday-only coaches and roles included — is left alone), in the SAME
    // transaction as the class details. assignedStaffIds is not written.
    const from = rulesFrom;
    const after = staffWrite;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const row = await tx.recurringClass.update({ where: { id: params.id }, data: classData });
        await applySeriesListChange(tx, { clubId: session.user.clubId, classId: params.id, date: from, before: staffBefore, after, byUserId: session.user.id });
        return row;
      }, STAFF_TX);
    } catch (err) {
      const res = classStaffErrorResponse(err);
      if (res) return res;
      throw err;
    }
  } else {
    updated = await prisma.recurringClass.update({
      where: { id: params.id },
      data: { ...classData, ...(staffWrite !== undefined ? { assignedStaffIds: staffWrite } : {}) },
    });
  }

  // Bring future sessions in line when scheduling-relevant fields change. The
  // series is RECONCILED BY DATE, not deleted and regenerated: a member's
  // booking is an AttendanceRecord on a specific ClassSession row, so dropping
  // the row and making a new one is a cancellation as far as that member is
  // concerned. Moving the row's time carries the bookings with it. Past
  // sessions are never touched.
  const scheduleChanged =
    rest.daysOfWeek !== undefined ||
    rest.startTime !== undefined ||
    rest.endTime !== undefined ||
    cleanOverrides !== undefined ||
    recurrenceStartDate !== undefined ||
    recurrenceEndDate !== undefined;

  const sessionSync = scheduleChanged ? await syncFutureSessions(updated) : null;

  if (selfRemoved && staffWrite) {
    await notifySelfRemoval({
      clubId: session.user.clubId,
      actorId: session.user.id,
      actorName: session.user.name,
      what: updated.name,
      when: "every week",
      otherCoachIds: staffWrite,
    });
  }

  return NextResponse.json({ ...updated, sessionSync });
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Classes access can delete — not owner-only.
  const denied = requirePermission(session, "classes", "full");
  if (denied) return denied;

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.recurringClass.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
