import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";
import { currentRuleStaffIds } from "@/lib/classStaff";
import { applySeriesListChange, loadClassRules, seriesChangeDate } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse } from "@/lib/classStaffApi";

const schema = z.object({ userId: z.string().min(1) });

async function loadClass(id: string, clubId: string) {
  const cls = await prisma.recurringClass.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true, assignedStaffIds: true },
  });
  if (!cls) return null;
  // A club switched on to the new coach assignments keeps its recurring
  // coaches in ClassStaffRule; RecurringClass.assignedStaffIds is then the
  // FROZEN legacy record and is neither read as "who coaches it now" nor
  // written. `switchFrom` = the first day a series change applies from (today,
  // never before the switch-on date); null = not switched on (legacy path).
  const sw = await seriesChangeDate(clubId);
  return {
    id: cls.id,
    name: cls.name,
    staffIds: sw.from
      ? currentRuleStaffIds(await loadClassRules(prisma, cls.id), sw.from)
      : Array.isArray(cls.assignedStaffIds) ? (cls.assignedStaffIds as string[]) : [],
    switchFrom: sw.from,
  };
}

/** Switched-on club: a series add/remove becomes rule changes, in ONE transaction. */
async function writeRules(clubId: string, classId: string, from: string, before: string[], after: string[], byUserId: string) {
  try {
    await prisma.$transaction(
      (tx) => applySeriesListChange(tx, { clubId, classId, date: from, before, after, byUserId }),
      STAFF_TX,
    );
    return null;
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

// POST /api/classes/[id]/staff  { userId }  — add staff to a recurring class.
// An assignment: schedule:edit, read live (was classes:edit until 2026-10-07).
// Nobody without it can add anyone — themself included (lib/staffSelf.ts).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "schedule", "edit");
  if (denied) return denied;

  let userId: string;
  try {
    userId = schema.parse(await req.json()).userId;
  } catch {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const cls = await loadClass(id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const staff = await prisma.user.findFirst({
    where: { id: userId, clubId: session.user.clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true },
  });
  if (!staff) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

  if (cls.switchFrom) {
    // Every class day from today; a coach already on it (any weekday rule
    // included) is left exactly as they are.
    if (!cls.staffIds.includes(userId)) {
      const failed = await writeRules(session.user.clubId, cls.id, cls.switchFrom, [], [userId], session.user.id);
      if (failed) return failed;
    }
    return NextResponse.json({ ok: true });
  }
  if (!cls.staffIds.includes(userId)) {
    await prisma.recurringClass.update({
      where: { id: cls.id },
      data: { assignedStaffIds: [...cls.staffIds, userId] },
    });
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/classes/[id]/staff?userId=...  — remove staff from a recurring class.
// schedule:edit (live) removes anyone. Without it, a coach may take THEMSELF
// off — nothing else — and the other coaches + schedule managers are told.
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const selfRemoval = userId === session.user.id;
  if (!selfRemoval) {
    const denied = await requirePermissionLive(session, "schedule", "edit");
    if (denied) return denied;
  }

  const cls = await loadClass(id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const check = await checkAssignmentChange(
    session, session.user.clubId, cls.staffIds, cls.staffIds.filter((x) => x !== userId),
  );
  if (check.verdict === "deny") {
    return NextResponse.json({ error: ASSIGNMENT_DENY_MESSAGE, code: "ASSIGNMENT_FORBIDDEN" }, { status: 403 });
  }
  // Nothing to take off, and not a manager (who may still clear a stale id):
  // the caller is not on this class — or is not staff at all.
  if (check.verdict === "none" && !check.canManage) {
    return NextResponse.json({ error: "You're not assigned to this class." }, { status: 403 });
  }

  if (cls.switchFrom) {
    // Their recurring rules end from today (every weekday). Class days someone
    // edited by hand keep their own list.
    const failed = await writeRules(session.user.clubId, cls.id, cls.switchFrom, [userId], [], session.user.id);
    if (failed) return failed;
  } else {
    await prisma.recurringClass.update({
      where: { id: cls.id },
      data: { assignedStaffIds: cls.staffIds.filter((x) => x !== userId) },
    });
  }
  if (check.verdict === "self_remove") {
    await notifySelfRemoval({
      clubId: session.user.clubId,
      actorId: session.user.id,
      actorName: session.user.name,
      what: cls.name,
      when: "every week",
      otherCoachIds: check.after,
    });
  }
  return NextResponse.json({ ok: true, selfRemoved: check.verdict === "self_remove" });
}
