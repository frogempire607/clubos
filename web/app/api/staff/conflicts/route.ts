import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { formatZodError } from "@/lib/zodErrors";
import { isYmd } from "@/lib/classStaff";
import { conflictsForRuleChange, loadStaffConflicts } from "@/lib/classStaffServer";
import { classStaffErrorResponse } from "@/lib/classStaffApi";
import { validScheduleStaffIds } from "@/lib/staffAssignmentsServer";

const TIME = /^\d{2}:\d{2}$/;
const ymd = z.string().refine(isYmd, "must be YYYY-MM-DD");
const schema = z.union([
  z.object({
    userId: z.string().min(1),
    slots: z.array(z.object({ date: ymd, startTime: z.string().regex(TIME), endTime: z.string().regex(TIME) })).min(1).max(200),
    excludeSessionIds: z.array(z.string()).max(200).optional(),
    excludeClassIds: z.array(z.string()).max(50).optional(),
  }),
  z.object({
    userId: z.string().min(1),
    classId: z.string().min(1),
    /** null / omitted = every class day. */
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    fromDate: ymd,
    weeks: z.number().int().min(1).max(26).optional(),
  }),
]);

// POST /api/staff/conflicts
//   { userId, slots: [{ date, startTime, endTime }], excludeSessionIds?, excludeClassIds? }
//   { userId, classId, dayOfWeek?, fromDate, weeks? }      (a recurring assignment: next 8 weeks)
//
// "Would putting this person here double-book them?" — on demand, for the
// picker. Reads only (POST because of the body). schedule:edit (live): it
// reveals another person's commitments. Answers are WARNINGS, never a block.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "schedule", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  if ((await validScheduleStaffIds(clubId, [body.userId])).length === 0) {
    return NextResponse.json({ error: "Not a current staff member of this club.", code: "INVALID_STAFF" }, { status: 400 });
  }
  try {
    const res = "slots" in body
      ? await loadStaffConflicts({ clubId, userId: body.userId, slots: body.slots, excludeSessionIds: body.excludeSessionIds, excludeClassIds: body.excludeClassIds })
      : await conflictsForRuleChange({ clubId, classId: body.classId, userId: body.userId, dayOfWeek: body.dayOfWeek ?? null, fromDate: body.fromDate, weeks: body.weeks });
    return NextResponse.json({ userId: body.userId, conflicts: res.conflicts, summary: res.summary, hasOverlap: res.hasOverlap });
  } catch (err) {
    const res = classStaffErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
