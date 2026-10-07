import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission, requirePermissionLive } from "@/lib/apiGuard";
import { ASSIGNMENT_DENY_MESSAGE } from "@/lib/staffSelf";
import { prisma } from "@/lib/prisma";
import { addEventStaff, removeEventStaff, checkAssignmentChange, notifySelfRemoval } from "@/lib/staffAssignmentsServer";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;

  const assignments = await prisma.eventStaffAssignment.findMany({
    where: { eventId: params.id, clubId: session.user.clubId },
    include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } },
  });

  return NextResponse.json(assignments);
}

const schema = z.object({
  userId: z.string(),
  role:   z.string().min(1).max(100).default("Coach"),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Putting someone on an event is an ASSIGNMENT: schedule:edit, read live
  // (was events:edit until 2026-10-07). Nobody without it can add anyone —
  // themself included (lib/staffSelf.ts "Assignments").
  const denied = await requirePermissionLive(session, "schedule", "edit");
  if (denied) return denied;

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  try {
    const data = schema.parse(await req.json());

    const staff = await prisma.user.findFirst({
      where: { id: data.userId, clubId: session.user.clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    });
    if (!staff) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

    const assignment = await addEventStaff(session.user.clubId, params.id, data.userId, data.role);

    return NextResponse.json(assignment, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  // schedule:edit (live) removes anyone. Without it, a coach may take THEMSELF
  // off this event — nothing else — and the rest of the roster + the schedule
  // managers are told.
  if (userId !== session.user.id) {
    const denied = await requirePermissionLive(session, "schedule", "edit");
    if (denied) return denied;
  }

  const roster = await prisma.eventStaffAssignment.findMany({
    where: { eventId: params.id, clubId: session.user.clubId },
    select: { userId: true, event: { select: { name: true } } },
  });
  if (!roster.some((r) => r.userId === userId)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const before = roster.map((r) => r.userId);
  const check = await checkAssignmentChange(session, session.user.clubId, before, before.filter((x) => x !== userId));
  if (check.verdict === "deny" || (check.verdict === "none" && !check.canManage)) {
    return NextResponse.json({ error: ASSIGNMENT_DENY_MESSAGE, code: "ASSIGNMENT_FORBIDDEN" }, { status: 403 });
  }

  // Through the shared helper so the coach's unpaid event comp row and any
  // "responsible coach" designation go with them (lib/staffAssignmentsServer).
  await removeEventStaff(session.user.clubId, params.id, [userId]);

  if (check.verdict === "self_remove") {
    await notifySelfRemoval({
      clubId: session.user.clubId,
      actorId: session.user.id,
      actorName: session.user.name,
      what: roster[0]?.event?.name ?? "an event",
      otherCoachIds: check.after,
    });
  }

  return new NextResponse(null, { status: 204 });
}
