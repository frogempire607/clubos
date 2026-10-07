import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { uncancelOccurrence } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, viewerFor } from "@/lib/classStaffApi";
import { notifyClassUncanceled } from "@/lib/classStaffNotify";

// POST /api/classes/sessions/[sessionId]/uncancel
//
// Put a canceled class day back on. classes:edit (live). Clears the cancel
// record and the pay choice (the answer carries what they were). The day's
// coaches are told in-app. Families are NOT emailed again — the answer says
// how many were told it was canceled so the screen can warn the canceller.
export async function POST(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "classes", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const me = session.user.id;

  let result: Awaited<ReturnType<typeof uncancelOccurrence>>;
  try {
    result = await prisma.$transaction((tx) => uncancelOccurrence(tx, { clubId, sessionId, byUserId: me }), STAFF_TX);
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const viewer = await viewerFor(session);
  if (!result.changed) {
    return NextResponse.json({ ok: true, changed: false, day: await loadDayViewBySession(clubId, sessionId, viewer) });
  }
  if (result.before.cancelPaid) {
    // The pay decision disappears with the cancellation — keep the trail.
    await writeBillingAudit({
      clubId, actorUserId: me, action: "CLASS_CANCEL_PAY",
      before: { classSessionId: sessionId, canceled: true, cancelPaid: true, cancelPaidByUserId: result.before.cancelPaidByUserId },
      after: { classSessionId: sessionId, canceled: false, cancelPaid: false },
      note: `${result.className} on ${result.date} was put back on — "canceled, paid" no longer applies`,
    });
  }
  const notice = await notifyClassUncanceled({ clubId, sessionId, actorId: me, actorName: session.user.name });
  return NextResponse.json({
    ok: true,
    changed: true,
    /** What the cancellation had recorded, now cleared. */
    was: {
      canceledAt: result.before.canceledAt, canceledByUserId: result.before.canceledByUserId, reason: result.before.cancelReason,
      notifyAudience: result.before.cancelNotifyAudience, notifiedCount: result.before.cancelNotifiedCount, paid: result.before.cancelPaid,
    },
    coachesNotified: notice.coachesNotified,
    day: await loadDayViewBySession(clubId, sessionId, viewer),
  });
}
