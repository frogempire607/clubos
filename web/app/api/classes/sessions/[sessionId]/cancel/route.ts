import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { CANCEL_AUDIENCES } from "@/lib/classStaff";
import { cancelOccurrence, getScheduleSettings } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, userOnDay, viewerFor } from "@/lib/classStaffApi";
import { notifyClassCanceled } from "@/lib/classStaffNotify";

const schema = z.object({
  reason: z.string().max(1000).nullable().optional(),
  notifyAudience: z.enum(CANCEL_AUDIENCES).optional(),
  paid: z.boolean().optional(),
});

// POST /api/classes/sessions/[sessionId]/cancel  { reason (required), notifyAudience?, paid? }
//
// Cancel ONE class day. classes:edit (live). Works on any class day, before
// or after the switch-on date.
//   notifyAudience  BOOKED | CLASS_MEMBERS | BOTH | NONE — default: the club's
//                   setting; the canceller may override it each time
//   paid            "cancelled, but the coaches are still paid". Default false.
//                   true needs finances:full (live) AND, unless the caller is
//                   an owner, that they are NOT coaching this class day — the
//                   self rule: nobody decides their own pay.
// Stored on the class day: who, when, why, the audience, how many were told,
// the pay choice. Families are emailed after the commit; the day's coaches are
// told in-app. Already canceled → 200 with changed:false and nothing is sent.
export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "classes", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const me = session.user.id;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: "notifyAudience must be BOOKED, CLASS_MEMBERS, BOTH or NONE", code: "BAD_INPUT" }, { status: 400 });
  }

  const exists = await prisma.classSession.findFirst({ where: { id: sessionId, clubId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Class day not found", code: "NOT_FOUND" }, { status: 404 });

  // The reason is part of the record (and of the email families get): required here, not just on the screen.
  if (!(body.reason ?? "").trim()) {
    return NextResponse.json({ error: "Give a reason for canceling this class day.", code: "BAD_INPUT" }, { status: 400 });
  }

  const paid = body.paid === true;
  if (paid) {
    const noMoney = await requirePermissionLive(session, "finances", "full");
    if (noMoney) {
      return NextResponse.json({ error: "Keeping pay for a canceled class needs full finances access.", code: "FINANCES_REQUIRED" }, { status: 403 });
    }
    if (!(await isOwnerLive(session)) && (await userOnDay(clubId, sessionId, me))) {
      return NextResponse.json({ error: "You can't decide pay for a class day you are coaching. Ask the owner.", code: "SELF_PAY_FORBIDDEN" }, { status: 403 });
    }
  }
  const audience = body.notifyAudience ?? (await getScheduleSettings(clubId)).classCancelNotifyDefault;
  const now = new Date();

  let result: Awaited<ReturnType<typeof cancelOccurrence>>;
  try {
    result = await prisma.$transaction(
      (tx) => cancelOccurrence(tx, { clubId, sessionId, reason: body.reason ?? null, notifyAudience: audience, paid, byUserId: me, now }),
      STAFF_TX,
    );
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const viewer = await viewerFor(session);
  if (!result.changed) {
    return NextResponse.json({ ok: true, changed: false, alreadyCanceled: true, day: await loadDayViewBySession(clubId, sessionId, viewer) });
  }

  if (paid) {
    await writeBillingAudit({
      clubId, actorUserId: me, action: "CLASS_CANCEL_PAY",
      before: { classSessionId: sessionId, canceled: false, cancelPaid: false },
      after: { classSessionId: sessionId, classId: result.classId, className: result.className, date: result.date, canceled: true, cancelPaid: true },
      note: `Canceled ${result.className} on ${result.date} — coaches still paid${result.after.cancelReason ? `. Reason: ${result.after.cancelReason}` : ""}`,
    });
  }
  const notice = await notifyClassCanceled({
    clubId, sessionId, actorId: me, actorName: session.user.name, audience, reason: result.after.cancelReason, canceledAt: result.after.canceledAt,
  });
  return NextResponse.json({
    ok: true,
    changed: true,
    notifyAudience: audience,
    paid,
    /** Stored on the class day: emails sent + queued. */
    notifiedCount: notice.notifiedCount,
    notice,
    day: await loadDayViewBySession(clubId, sessionId, viewer),
  });
}
