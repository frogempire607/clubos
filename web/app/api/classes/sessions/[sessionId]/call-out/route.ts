import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { callOut } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, viewerFor } from "@/lib/classStaffApi";
import { notifyCoverageNeeded } from "@/lib/classStaffNotify";

const schema = z.object({
  reason: z.string().max(500).nullable().optional(),
  /** Only with schedule:edit: call out on this coach's behalf. */
  userId: z.string().min(1).optional(),
});

// POST /api/classes/sessions/[sessionId]/call-out  { reason?, userId? }
//
// "I can't make it." The class STAYS scheduled; the coach's row becomes Needs
// Coverage and the club's coverage recipients are told (in-app + email).
//   - any current staff member may call out of a class day THEY are scheduled on
//   - calling out for someone else (`userId`) needs schedule:edit (live)
//   - never refused for being late: inside 2 hours of the start it is flagged
//     a LATE call-out and the notice says so
export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Current staff, read live (a removed login gets nothing).
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  const me = session.user.id;
  const coachId = body.userId ?? me;
  if (coachId !== me) {
    // On someone else's behalf: schedule managers only.
    const denied = await requirePermissionLive(session, "schedule", "edit");
    if (denied) return denied;
  }
  const clubId = session.user.clubId;
  const now = new Date();

  let result: Awaited<ReturnType<typeof callOut>>;
  try {
    result = await prisma.$transaction(
      (tx) => callOut(tx, { clubId, sessionId, userId: coachId, reason: body.reason ?? null, byUserId: me, now }),
      STAFF_TX,
    );
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const notice = await notifyCoverageNeeded({
    clubId, actorId: me, actorName: session.user.name, coachId, reason: body.reason ?? null, results: [result], now,
  });
  const day = await loadDayViewBySession(clubId, sessionId, await viewerFor(session));
  return NextResponse.json({
    ok: true,
    staffRowId: result.staffRowId,
    userId: coachId,
    late: result.late,
    /** The real instant the class starts. */
    startsAt: result.startInstant.toISOString(),
    notified: notice.notified,
    notice: { subject: notice.subject, body: notice.body },
    day,
  });
}
