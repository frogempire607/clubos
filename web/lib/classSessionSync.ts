import { prisma } from "@/lib/prisma";
import { buildSessions, planSessionChanges, type DayOverride, type SessionPlan } from "@/lib/classSessions";
import { syncSessionStaff, type StaffSyncResult } from "@/lib/classStaffServer";

type SeriesShape = {
  id: string;
  clubId: string;
  daysOfWeek: unknown;
  startTime: string;
  endTime: string;
  dayOverrides: unknown;
  recurrenceStartDate: Date;
  recurrenceEndDate: Date | null;
};

export type SessionSyncResult = {
  created: number;
  moved: number;
  removed: number;
  /** Days holding two attended sessions — the owner resolves these, we do not guess. */
  unresolved: { date: string; sessionIds: string[] }[];
  /** Sessions on days the series no longer runs, kept because somebody is on them. */
  kept: { id: string; date: string; reason: string }[];
  /**
   * Coach rows for the days just created (clubs switched on to the new
   * assignments — lib/classStaffServer.syncSessionStaff). switchedOn false =
   * the club is still on the legacy lists and nothing was written.
   */
  staffSync: StaffSyncResult;
};

// Bring a recurring class's FUTURE sessions in line with the series definition.
//
// Sessions are reconciled by date, never deleted-and-regenerated: a member's
// booking is an AttendanceRecord hanging off a specific ClassSession row, so
// recreating the row is indistinguishable from cancelling on them. Moving the
// row's time carries every booking with it.
//
// Past sessions are never touched — that is attendance history.
export async function syncFutureSessions(cls: SeriesShape): Promise<SessionSyncResult> {
  // UTC midnight, matching how buildSessions stamps ClassSession.date and how
  // the occurrence route's dayWindow() reads it. Local midnight would shift
  // today's boundary on any server not running in UTC, and today's session is
  // exactly the one a same-day time change is about.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const existingRows = await prisma.classSession.findMany({
    where: { classId: cls.id, date: { gte: todayStart } },
    select: {
      id: true, date: true, startsAt: true, endsAt: true,
      canceled: true, overridden: true,
      _count: { select: { attendance: true } },
    },
  });

  const desired = buildSessions(
    cls.id,
    cls.clubId,
    (cls.daysOfWeek as number[]) ?? [],
    cls.startTime,
    cls.endTime,
    (cls.dayOverrides as unknown as DayOverride[]) ?? [],
    new Date(Math.max(todayStart.getTime(), cls.recurrenceStartDate.getTime())),
    cls.recurrenceEndDate,
  );

  const plan: SessionPlan = planSessionChanges(
    existingRows.map((r) => ({
      id: r.id, date: r.date, startsAt: r.startsAt, endsAt: r.endsAt,
      canceled: r.canceled, overridden: r.overridden,
      attendanceCount: r._count.attendance,
    })),
    desired,
  );

  if (plan.deleteIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { id: { in: plan.deleteIds } } });
  }
  for (const u of plan.update) {
    await prisma.classSession.update({
      where: { id: u.id },
      data: { startsAt: u.startsAt, endsAt: u.endsAt },
    });
  }
  if (plan.create.length > 0) {
    await prisma.classSession.createMany({ data: plan.create });
  }

  // New days need their coaches; a moved day keeps its row (and its coaches).
  // A deleted day took its coach rows with it (cascade). No-op for a club that
  // is not switched on.
  const staffSync = await syncSessionStaff(prisma, cls.id);

  return {
    staffSync,
    created: plan.create.length,
    moved: plan.update.length,
    removed: plan.deleteIds.length,
    unresolved: plan.unresolved.map((u) => ({
      date: u.date.toISOString().slice(0, 10), sessionIds: u.sessionIds,
    })),
    kept: plan.orphaned.map((o) => ({
      id: o.id, date: o.date.toISOString().slice(0, 10), reason: o.reason,
    })),
  };
}
