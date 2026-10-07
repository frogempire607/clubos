import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwnerLive } from "@/lib/apiGuard";
import { clubTodayYmd, isYmd } from "@/lib/classStaff";
import { getScheduleSettings, runSwitchOn } from "@/lib/classStaffServer";
import { classStaffErrorResponse, namesFor } from "@/lib/classStaffApi";

const schema = z.object({
  apply: z.boolean().optional(),
  date: z.string().refine(isYmd, "date must be YYYY-MM-DD").optional(),
}).strict();

// POST /api/settings/schedule/switch-on  { apply?: boolean, date?: "YYYY-MM-DD" }
//
// Turn the new coach scheduling on for this club — the same writer as
// scripts/switch-on-class-assignments.ts (lib/classStaffServer.runSwitchOn),
// so the owner does not need a terminal. OWNER only, verified live.
//   apply false / omitted → DRY RUN: answers with what would be written, per
//                           class, and writes nothing
//   apply true            → writes it (one transaction; safe to repeat)
//   date                  → the first class day the new system owns. Default:
//                           today in the club's timezone. A club that is
//                           already on keeps its date: asking for a different
//                           one is refused (409 ALREADY_ON) and nothing changes.
// Class days before the date are never touched.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requireOwnerLive(session);
  if (denied) return denied;
  const clubId = session.user.clubId;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: "date must be YYYY-MM-DD", code: "BAD_INPUT" }, { status: 400 });
  }

  const [club, settings] = await Promise.all([
    prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
    getScheduleSettings(clubId),
  ]);
  // Already on: the date is the one it was switched on from (a repeat is a no-op).
  const date = body.date ?? settings.assignmentsStartOn ?? clubTodayYmd(club?.timezone ?? null);
  const apply = body.apply === true;

  let res: Awaited<ReturnType<typeof runSwitchOn>>;
  try {
    res = await runSwitchOn({ clubId, date, apply, byUserId: session.user.id });
  } catch (err) {
    const answer = classStaffErrorResponse(err);
    if (answer) return answer;
    throw err;
  }
  if (res.refused) {
    return NextResponse.json(
      {
        error: `New coach scheduling is already on from ${settings.assignmentsStartOn}. The start date can't be moved here.`,
        code: "ALREADY_ON",
        assignmentsStartOn: settings.assignmentsStartOn,
      },
      { status: 409 },
    );
  }

  const nameOf = await namesFor(clubId, res.plan.perClass.flatMap((c) => c.coaches));
  const classes = res.plan.perClass.map((c) => ({
    classId: c.classId,
    name: c.name,
    /** already = this class was switched on in an earlier run and is left alone. */
    state: c.state,
    coaches: c.coaches.map((id) => nameOf(id)),
    /** Class days on/after the date that already exist. */
    upcomingDays: c.sessions,
    /** Days that keep a one-day coach list of their own. */
    manualDays: c.manualDays,
    /** Coach ids on the old list that are no longer staff of this club (left off). */
    droppedCount: c.droppedIds.length,
  }));
  const after = apply ? await getScheduleSettings(clubId) : settings;
  return NextResponse.json({
    ok: true,
    applied: res.applied,
    date: res.date,
    alreadyOn: res.alreadyOn,
    switchedOn: !!after.assignmentsStartOn,
    assignmentsStartOn: after.assignmentsStartOn,
    classes,
    totals: {
      classes: classes.filter((c) => c.state === "new").length,
      coachAssignments: res.plan.rules.length,
      classDays: classes.filter((c) => c.state === "new").reduce((n, c) => n + c.upcomingDays, 0),
    },
    written: res.written,
  });
}
