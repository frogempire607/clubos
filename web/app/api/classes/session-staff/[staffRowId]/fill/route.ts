import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { hhmmUTC } from "@/lib/staffAssignments";
import { toYmd } from "@/lib/classStaff";
import { fillCoverage } from "@/lib/classStaffServer";
import { STAFF_TX, checkConflicts, classStaffErrorResponse, conflictResponse, loadDayViewBySession, viewerFor } from "@/lib/classStaffApi";
import { notifyCoverageFilled } from "@/lib/classStaffNotify";

const schema = z.object({
  substituteUserId: z.string().min(1),
  roleName: z.string().max(60).nullable().optional(),
  acknowledgeConflicts: z.boolean().optional(),
});

// POST /api/classes/session-staff/[staffRowId]/fill
//   { substituteUserId, roleName?, acknowledgeConflicts? }
//
// A schedule manager fills an open coverage request: the original row becomes
// Replaced and the substitute gets their own Scheduled row (role defaults to
// "Substitute"). schedule:edit (live) — the same rule as every assignment: a
// manager may put anyone on, themself included; nobody else can.
// A double-booked / outside-hours substitute is a WARNING: 409 STAFF_CONFLICT
// until acknowledgeConflicts. The substitute, the coach who called out and the
// coverage group are told afterwards.
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
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "substituteUserId is required", code: "BAD_INPUT" }, { status: 400 });
  }

  const row = await prisma.classSessionStaff.findFirst({
    where: { id: staffRowId, clubId },
    select: { sessionId: true, session: { select: { id: true, date: true, startsAt: true, endsAt: true } } },
  });
  if (!row) return NextResponse.json({ error: "Assignment not found", code: "NOT_FOUND" }, { status: 404 });

  if (!body.acknowledgeConflicts) {
    const report = await checkConflicts({
      clubId,
      userIds: [body.substituteUserId],
      target: {
        kind: "day",
        slot: { date: toYmd(row.session.date), startTime: hhmmUTC(row.session.startsAt), endTime: hhmmUTC(row.session.endsAt) },
        excludeSessionId: row.sessionId,
      },
    });
    if (report.conflicts.length > 0) return conflictResponse(report);
  }

  let result: Awaited<ReturnType<typeof fillCoverage>>;
  try {
    result = await prisma.$transaction(
      (tx) => fillCoverage(tx, { clubId, staffRowId, substituteUserId: body.substituteUserId, roleName: body.roleName, byUserId: me }),
      STAFF_TX,
    );
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const notice = await notifyCoverageFilled({
    clubId, actorId: me, actorName: session.user.name,
    originalUserId: result.originalUserId, substituteUserId: result.substituteUserId,
    day: { sessionId: result.sessionId, classId: result.classId, className: result.className, date: result.date, startsAt: result.startsAt },
  });
  const day = await loadDayViewBySession(clubId, result.sessionId, await viewerFor(session));
  return NextResponse.json({
    ok: true,
    staffRowId,
    substituteRowId: result.substituteRowId,
    originalUserId: result.originalUserId,
    substituteUserId: result.substituteUserId,
    notified: notice.notified,
    notice: { subject: notice.subject, substitute: notice.substitute, original: notice.original, group: notice.group },
    day,
  });
}
