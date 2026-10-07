import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";

const schema = z.object({ userId: z.string().min(1) });

async function loadClass(id: string, clubId: string) {
  const cls = await prisma.recurringClass.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true, assignedStaffIds: true },
  });
  if (!cls) return null;
  return {
    id: cls.id,
    name: cls.name,
    staffIds: Array.isArray(cls.assignedStaffIds) ? (cls.assignedStaffIds as string[]) : [],
  };
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

  await prisma.recurringClass.update({
    where: { id: cls.id },
    data: { assignedStaffIds: cls.staffIds.filter((x) => x !== userId) },
  });
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
