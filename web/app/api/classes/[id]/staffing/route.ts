import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { formatZodError } from "@/lib/zodErrors";
import { clubTodayYmd, isYmd } from "@/lib/classStaff";
import { applyScopeChange } from "@/lib/classStaffServer";
import {
  STAFF_TX,
  checkConflicts,
  classStaffErrorResponse,
  conflictResponse,
  loadStaffingView,
  notSwitchedOn,
  viewerFor,
} from "@/lib/classStaffApi";
import { loadStaffingContext, staffingBodySchema, staffingWhen } from "@/lib/classStaffingRequest";
import { notifyAssignmentChange } from "@/lib/classStaffNotify";

// GET /api/classes/[id]/staffing?date=YYYY-MM-DD
//
// Everything the staffing sheet shows for one class on one calendar day: the
// recurring rules, that day's coach rows (status, role, call-out, cover), the
// cancel audit, the standard roles, and what the VIEWER may do.
//   schedule:view (live) → the whole day
//   without it           → only if the viewer has a row of their own on that
//                          day, and then only their own row (no other names)
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Must be current staff (live): a removed or demoted login gets nothing.
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  const viewer = await viewerFor(session);
  const clubId = session.user.clubId;

  let date = (new URL(req.url).searchParams.get("date") ?? "").slice(0, 10);
  if (!date) {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
    date = clubTodayYmd(club?.timezone ?? null);
  }
  if (!isYmd(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD", code: "BAD_INPUT" }, { status: 400 });

  const res = await loadStaffingView(clubId, id, date, viewer);
  if (!res) return NextResponse.json({ error: "Class not found", code: "NOT_FOUND" }, { status: 404 });
  if (res.forbidden) return NextResponse.json({ error: "You don't have permission to view this." }, { status: 403 });
  return NextResponse.json(res.view);
}

// POST /api/classes/[id]/staffing
//   { scope: "OCCURRENCE" | "WEEKDAY_FORWARD" | "ALL_FUTURE", date, dayOfWeek?,
//     staff: [{ userId, roleName? }], acknowledgeConflicts? }
//
// The three-scope coach edit. schedule:edit (live) — nobody without it can
// assign anyone, themself included. `staff` is the EXACT list for that scope.
// Conflicts for coaches being ADDED are warnings: 409 STAFF_CONFLICT until the
// body says acknowledgeConflicts. One transaction; the coaches put on / taken
// off are told in-app afterwards.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "schedule", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

  let body: z.infer<typeof staffingBodySchema>;
  try {
    body = staffingBodySchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }

  const ctx = await loadStaffingContext(clubId, id, body);
  if (!ctx) return NextResponse.json({ error: "Class not found", code: "NOT_FOUND" }, { status: 404 });
  if (!ctx.switched) return notSwitchedOn();

  if (ctx.addedIds.length > 0 && !body.acknowledgeConflicts) {
    const report = await checkConflicts({
      clubId,
      userIds: ctx.addedIds,
      target: ctx.scope === "OCCURRENCE"
        ? { kind: "day", slot: ctx.slot, excludeSessionId: ctx.session?.id ?? null }
        : { kind: "rule", classId: id, dayOfWeek: ctx.dayOfWeek, fromDate: ctx.conflictFrom },
    });
    if (report.conflicts.length > 0) return conflictResponse(report);
  }

  let result: Awaited<ReturnType<typeof applyScopeChange>>;
  try {
    result = await prisma.$transaction(
      (tx) => applyScopeChange(tx, {
        clubId, classId: id, scope: ctx.scope, date: ctx.date, dayOfWeek: ctx.dayOfWeek ?? undefined,
        desired: ctx.desired, byUserId: session.user.id,
      }),
      STAFF_TX,
    );
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // Who came on / went off, for the notices (after the commit; best-effort).
  const before = result.day ? result.day.coachingBefore : result.recurringBefore.map((r) => r.userId);
  const after = result.day ? result.day.coachingAfter : result.recurringAfter.map((r) => r.userId);
  const addedIds = after.filter((x) => !before.includes(x));
  const removedIds = before.filter((x) => !after.includes(x));
  const notice = await notifyAssignmentChange({
    clubId, actorId: session.user.id, actorName: session.user.name,
    className: ctx.cls.name, when: staffingWhen(ctx), addedIds, removedIds,
  });

  const viewer = await viewerFor(session);
  const view = await loadStaffingView(clubId, id, ctx.date, viewer);
  return NextResponse.json({
    ok: true,
    scope: ctx.scope,
    date: ctx.date,
    changed: result.ruleOps.length > 0 || result.dayOps.length > 0,
    added: addedIds,
    removed: removedIds,
    notified: notice.notified,
    sessionId: result.day?.sessionId ?? view?.view.day.sessionId ?? null,
    /** Rule scopes: how many class days were regenerated. */
    sync: result.sync ? { sessionsChecked: result.sync.sessionsChecked, created: result.sync.created, updated: result.sync.updated, deleted: result.sync.deleted } : null,
    staffing: view?.view ?? null,
  });
}
