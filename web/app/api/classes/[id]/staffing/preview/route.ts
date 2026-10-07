import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { formatZodError } from "@/lib/zodErrors";
import { describeScopeChange } from "@/lib/classStaff";
import { checkConflicts, namesFor, notSwitchedOn } from "@/lib/classStaffApi";
import { loadStaffingContext, staffingBodySchema } from "@/lib/classStaffingRequest";
import { validScheduleStaffIds } from "@/lib/staffAssignmentsServer";

// POST /api/classes/[id]/staffing/preview — same body as POST …/staffing.
//
// WRITES NOTHING. Answers with the plan in words, from the same planner the
// real save uses:
//   "Tuesdays from Oct 20: Adrian replaces Sal. Sal stays on Mondays and Thursdays."
// plus the conflict warnings for the coaches being added (always computed —
// acknowledgeConflicts is ignored here). schedule:edit (live).
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
  // Same rule as the save: only current staff of THIS club can be put on. The
  // preview must not say a change would work when the save would refuse it.
  if (ctx.addedIds.length > 0 && (await validScheduleStaffIds(clubId, ctx.addedIds)).length !== ctx.addedIds.length) {
    return NextResponse.json({ error: "Not a current staff member of this club.", code: "INVALID_STAFF" }, { status: 400 });
  }

  const nameOf = await namesFor(clubId, [
    ...ctx.desired.map((d) => d.userId), ...ctx.rules.map((r) => r.userId), ...ctx.dayRows.map((r) => r.userId),
  ]);
  const words = describeScopeChange({
    scope: ctx.scope, classDays: ctx.cls.daysOfWeek, date: ctx.date, dayOfWeek: ctx.dayOfWeek ?? undefined,
    currentRules: ctx.rules, currentDayStaff: ctx.dayRows, desired: ctx.desired, nameOf,
  });
  const report = await checkConflicts({
    clubId,
    userIds: ctx.addedIds,
    target: ctx.scope === "OCCURRENCE"
      ? { kind: "day", slot: ctx.slot, excludeSessionId: ctx.session?.id ?? null }
      : { kind: "rule", classId: id, dayOfWeek: ctx.dayOfWeek, fromDate: ctx.conflictFrom },
  });

  return NextResponse.json({
    ok: true,
    scope: ctx.scope,
    date: ctx.date,
    dayOfWeek: ctx.dayOfWeek,
    changed: words.changed,
    plan: { heading: words.heading, lines: words.lines, text: words.text },
    added: words.added.map((userId) => ({ userId, name: nameOf(userId) })),
    removed: words.removed.map((userId) => ({ userId, name: nameOf(userId) })),
    conflicts: report.conflicts,
    summary: report.summary,
    hasOverlap: report.hasOverlap,
    /** true = POST …/staffing will answer 409 STAFF_CONFLICT without acknowledgeConflicts. */
    needsAcknowledge: report.conflicts.length > 0,
  });
}
