import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { isYmd } from "@/lib/classStaff";
import { callOutRange } from "@/lib/classStaffServer";
import { STAFF_TX, classStaffErrorResponse } from "@/lib/classStaffApi";
import { notifyCoverageNeeded } from "@/lib/classStaffNotify";

const schema = z.object({
  fromDate: z.string().refine(isYmd, "fromDate must be YYYY-MM-DD"),
  toDate: z.string().refine(isYmd, "toDate must be YYYY-MM-DD"),
  reason: z.string().max(500).nullable().optional(),
});

// POST /api/staff/me/call-out-range  { fromDate, toDate, reason? }
//
// "I'm away from the 14th to the 20th": the caller is called out of EVERY
// class day they are scheduled on in the range (inclusive, at most a year).
// Their recurring assignment is not changed. Always the caller themself — a
// manager calling out for someone else uses the per-day endpoint. One notice
// per recipient listing every day, late ones first.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Current staff, read live.
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "fromDate and toDate are required (YYYY-MM-DD)", code: "BAD_INPUT" }, { status: 400 });
  }
  const me = session.user.id;
  const clubId = session.user.clubId;
  const now = new Date();

  let out: Awaited<ReturnType<typeof callOutRange>>;
  try {
    out = await prisma.$transaction(
      (tx) => callOutRange(tx, { clubId, userId: me, fromDate: body.fromDate, toDate: body.toDate, reason: body.reason ?? null, byUserId: me, now }),
      STAFF_TX,
    );
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const notice = await notifyCoverageNeeded({
    clubId, actorId: me, actorName: session.user.name, coachId: me, reason: body.reason ?? null, results: out.results, now,
  });
  return NextResponse.json({
    ok: true,
    count: out.results.length,
    lateCount: out.results.filter((r) => r.late).length,
    days: out.results.map((r) => ({
      sessionId: r.sessionId, classId: r.classId, className: r.className, date: r.date,
      staffRowId: r.staffRowId, late: r.late, startsAt: r.startInstant.toISOString(),
    })),
    notified: notice.notified,
    notice: { subject: notice.subject, body: notice.body },
  });
}
