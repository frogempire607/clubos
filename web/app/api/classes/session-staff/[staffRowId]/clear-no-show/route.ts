import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { clearNoShow } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, viewerFor } from "@/lib/classStaffApi";
import { notifyNoShow } from "@/lib/classStaffNotify";

// POST /api/classes/session-staff/[staffRowId]/clear-no-show
//
// Undo a no-show mark: No-show → Scheduled. schedule:edit (live).
export async function POST(_req: Request, context: { params: Promise<{ staffRowId: string }> }) {
  const { staffRowId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "schedule", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const me = session.user.id;

  let result: Awaited<ReturnType<typeof clearNoShow>>;
  try {
    result = await prisma.$transaction((tx) => clearNoShow(tx, { clubId, staffRowId, byUserId: me }), STAFF_TX);
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const notice = await notifyNoShow({
    clubId, actorId: me, actorName: session.user.name, coachId: result.userId, cleared: true,
    day: { sessionId: result.sessionId, classId: result.classId, className: result.className, date: result.date, startsAt: result.startsAt },
  });
  const day = await loadDayViewBySession(clubId, result.sessionId, await viewerFor(session));
  return NextResponse.json({ ok: true, staffRowId, userId: result.userId, notified: notice.notified, day });
}
