import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { setCancelPaid } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse, loadDayViewBySession, userOnDay, viewerFor } from "@/lib/classStaffApi";

const schema = z.object({ paid: z.boolean() });

// PATCH /api/classes/sessions/[sessionId]/cancel-pay  { paid }
//
// Change the pay choice of an ALREADY canceled class day ("canceled, paid" ↔
// "canceled, unpaid"). finances:full (live), in either direction. The self
// rule: unless the caller is an owner, not on a class day they are coaching.
// Every change is written to the billing audit log (who, when, before, after).
export async function PATCH(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const me = session.user.id;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "paid (true or false) is required", code: "BAD_INPUT" }, { status: 400 });
  }

  const exists = await prisma.classSession.findFirst({ where: { id: sessionId, clubId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Class day not found", code: "NOT_FOUND" }, { status: 404 });
  if (!(await isOwnerLive(session)) && (await userOnDay(clubId, sessionId, me))) {
    return NextResponse.json({ error: "You can't decide pay for a class day you are coaching. Ask the owner.", code: "SELF_PAY_FORBIDDEN" }, { status: 403 });
  }

  let result: Awaited<ReturnType<typeof setCancelPaid>>;
  try {
    result = await prisma.$transaction((tx) => setCancelPaid(tx, { clubId, sessionId, paid: body.paid, byUserId: me }), STAFF_TX);
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (result.changed) {
    await writeBillingAudit({
      clubId, actorUserId: me, action: "CLASS_CANCEL_PAY",
      before: { classSessionId: sessionId, cancelPaid: result.before.cancelPaid, cancelPaidByUserId: result.before.cancelPaidByUserId },
      after: { classSessionId: sessionId, classId: result.classId, className: result.className, date: result.date, cancelPaid: result.after.cancelPaid },
      note: `${result.className} on ${result.date}: canceled, ${result.after.cancelPaid ? "coaches still paid" : "not paid"}`,
    });
  }
  return NextResponse.json({
    ok: true,
    changed: result.changed,
    paid: result.after.cancelPaid,
    day: await loadDayViewBySession(clubId, sessionId, await viewerFor(session)),
  });
}
