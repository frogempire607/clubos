import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { cancelCoverageRequest } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, viewerFor } from "@/lib/classStaffApi";
import { notifyCoverageUndone } from "@/lib/classStaffNotify";

// POST /api/classes/session-staff/[staffRowId]/undo-call-out
//
// Withdraw a call-out while nobody has filled it: Needs Coverage → Scheduled.
//   - the coach whose row it is, or
//   - schedule:edit (live) for anyone's
// Once it has been filled or closed it cannot be undone here (409 BAD_STATE) —
// a schedule manager changes the day instead.
export async function POST(_req: Request, context: { params: Promise<{ staffRowId: string }> }) {
  const { staffRowId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  const clubId = session.user.clubId;
  const me = session.user.id;

  const row = await prisma.classSessionStaff.findFirst({ where: { id: staffRowId, clubId }, select: { userId: true, sessionId: true } });
  if (!row) return NextResponse.json({ error: "Assignment not found", code: "NOT_FOUND" }, { status: 404 });
  if (row.userId !== me) {
    const denied = await requirePermissionLive(session, "schedule", "edit");
    if (denied) return denied;
  }

  let result: Awaited<ReturnType<typeof cancelCoverageRequest>>;
  try {
    result = await prisma.$transaction((tx) => cancelCoverageRequest(tx, { clubId, staffRowId, byUserId: me }), STAFF_TX);
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const notice = await notifyCoverageUndone({
    clubId, actorId: me, actorName: session.user.name, coachId: result.userId,
    day: { sessionId: result.sessionId, classId: result.classId, className: result.className, date: result.date, startsAt: result.startsAt },
  });
  const day = await loadDayViewBySession(clubId, result.sessionId, await viewerFor(session));
  return NextResponse.json({ ok: true, staffRowId, userId: result.userId, notified: notice.notified, day });
}
