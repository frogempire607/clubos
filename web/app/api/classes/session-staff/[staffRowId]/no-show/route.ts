import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { markNoShow } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, viewerFor } from "@/lib/classStaffApi";
import { notifyNoShow } from "@/lib/classStaffNotify";

const schema = z.object({ note: z.string().max(500).nullable().optional() });

// POST /api/classes/session-staff/[staffRowId]/no-show  { note? }
//
// The scheduled coach did not turn up: Scheduled → No-show (not paid for that
// class day). Only once the class has started (409 BAD_STATE before then).
// schedule:edit (live). The coach is told in-app.
export async function POST(req: Request, context: { params: Promise<{ staffRowId: string }> }) {
  const { staffRowId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "schedule", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const me = session.user.id;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof markNoShow>>;
  try {
    result = await prisma.$transaction((tx) => markNoShow(tx, { clubId, staffRowId, byUserId: me, note: body.note ?? null }), STAFF_TX);
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const notice = await notifyNoShow({
    clubId, actorId: me, actorName: session.user.name, coachId: result.userId, cleared: false,
    day: { sessionId: result.sessionId, classId: result.classId, className: result.className, date: result.date, startsAt: result.startsAt },
  });
  const day = await loadDayViewBySession(clubId, result.sessionId, await viewerFor(session));
  return NextResponse.json({ ok: true, staffRowId, userId: result.userId, notified: notice.notified, day });
}
