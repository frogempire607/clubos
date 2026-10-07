import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive, hasPermissionLive } from "@/lib/apiGuard";
import {
  asDayOverrides,
  asIdList,
  classOccurrencesInRange,
  eventOverlaps,
  rangeWindow,
  type ClassOccurrence,
} from "@/lib/staffAssignments";
import { listScheduleStaff } from "@/lib/staffAssignmentsServer";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/staff/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns, for every OWNER and STAFF user, their availability windows,
// exceptions in range, and the classes/events they are on in the range.
// Assignment resolution is lib/staffAssignments.ts — the same rules the
// calendar, member schedule and payroll use.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Must be current staff (live): a removed or demoted login gets nothing.
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  // 2026-10-07 — this was role-only and handed every staff login everyone's
  // email, weekly availability and time-off notes. Now:
  //   schedule:view (live) → the whole club's schedule, as before
  //   without it           → ONLY the caller's own row: their hours, their time
  //                          off, the classes/events they are on. No other
  //                          person, no club-wide "assign to" lists.
  const seesAll = await hasPermissionLive(session, "schedule", "view");
  const canAssign = seesAll && (await hasPermissionLive(session, "schedule", "edit"));
  const me = session.user.id;

  const url = new URL(req.url);
  const fromYmd = (url.searchParams.get("from") ?? "").slice(0, 10);
  const toYmd = (url.searchParams.get("to") ?? "").slice(0, 10);
  if (!YMD.test(fromYmd) || !YMD.test(toYmd)) {
    return NextResponse.json({ error: "from and to required (YYYY-MM-DD)" }, { status: 400 });
  }
  if (toYmd < fromYmd) {
    return NextResponse.json({ error: "to must be on or after from" }, { status: 400 });
  }
  // Day-keyed rows (sessions, exceptions) are stamped at UTC midnight.
  const dayFrom = new Date(`${fromYmd}T00:00:00.000Z`);
  const dayTo = new Date(`${toYmd}T23:59:59.999Z`);
  // Events are real instants; pad so every viewer timezone's days are covered.
  const win = rangeWindow(fromYmd, toYmd);

  const clubId = session.user.clubId;

  const [staff, availability, exceptions, classes, events, sessionRows] = await Promise.all([
    listScheduleStaff(clubId),
    prisma.staffAvailability.findMany({
      where: { clubId, active: true, ...(seesAll ? {} : { userId: me }) },
      select: { userId: true, dayOfWeek: true, startTime: true, endTime: true },
    }),
    prisma.staffAvailabilityException.findMany({
      where: { clubId, date: { gte: dayFrom, lte: dayTo }, ...(seesAll ? {} : { userId: me }) },
      orderBy: { date: "asc" },
    }),
    prisma.recurringClass.findMany({
      where: { clubId, active: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        daysOfWeek: true,
        startTime: true,
        endTime: true,
        dayOverrides: true,
        assignedStaffIds: true,
        recurrenceStartDate: true,
        recurrenceEndDate: true,
      },
    }),
    prisma.event.findMany({
      where: {
        clubId,
        deletedAt: null,
        // Overlap, not "starts inside the week": a camp that began last
        // Saturday and runs into this week is on this week's schedule.
        startsAt: { lte: win.to },
        endsAt: { gte: win.from },
      },
      select: {
        id: true,
        name: true,
        type: true,
        startsAt: true,
        endsAt: true,
        sessions: { select: { startsAt: true, endsAt: true }, orderBy: { startsAt: "asc" } },
        staffAssignments: { select: { userId: true, role: true } },
      },
    }),
    prisma.classSession.findMany({
      where: { clubId, date: { gte: dayFrom, lte: dayTo } },
      select: {
        id: true,
        classId: true,
        date: true,
        startsAt: true,
        endsAt: true,
        canceled: true,
        staffOverride: true,
        note: true,
      },
    }),
  ]);

  const classInstances: ClassOccurrence[] = [];
  for (const c of classes) {
    for (const occ of classOccurrencesInRange(c, sessionRows, fromYmd, toYmd)) {
      // Nobody on it and not canceled → not on anyone's schedule.
      if (occ.staffIds.length === 0 && !occ.canceled) continue;
      classInstances.push(occ);
    }
  }

  const eventsInRange = events.filter((e) => eventOverlaps(e.startsAt, e.endsAt, win.from, win.to));
  const iso = (d: Date) => d.toISOString();
  const eventOut = (e: (typeof eventsInRange)[number]) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    startsAt: iso(e.startsAt),
    endsAt: iso(e.endsAt),
    sessions: e.sessions.map((s) => ({ startsAt: iso(s.startsAt), endsAt: iso(s.endsAt) })),
  });

  // Own-only view: an occurrence still lists who else is on it by id, which
  // would leak the roster — reduce each to the caller.
  const visibleStaff = seesAll ? staff : staff.filter((s) => s.id === me);
  const ownOnly = <T extends { staffIds: string[]; seriesStaffIds: string[] }>(c: T): T =>
    seesAll ? c : { ...c, staffIds: c.staffIds.filter((x) => x === me), seriesStaffIds: c.seriesStaffIds.filter((x) => x === me) };

  const result = visibleStaff.map((s) => ({
    id: s.id,
    firstName: s.firstName,
    lastName: s.lastName,
    email: s.email,
    role: s.role,
    title: s.staffProfile?.title ?? null,
    availability: availability.filter((a) => a.userId === s.id),
    exceptions: exceptions
      .filter((e) => e.userId === s.id)
      .map((e) => ({
        id: e.id,
        date: e.date.toISOString().slice(0, 10),
        type: e.type,
        startTime: e.startTime,
        endTime: e.endTime,
        note: e.note,
      })),
    classes: classInstances
      .filter((c) => c.staffIds.includes(s.id))
      .map(ownOnly)
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)),
    events: eventsInRange.filter((e) => e.staffAssignments.some((a) => a.userId === s.id)).map(eventOut),
  }));

  // Everything in range, so the schedule UI can offer "assign to this
  // event/class on this day" — not just show pre-assigned ones.
  const allEvents = (seesAll ? eventsInRange : []).map((e) => ({
    ...eventOut(e),
    date: e.startsAt.toISOString().slice(0, 10),
    assignedUserIds: e.staffAssignments.map((a) => a.userId),
  }));
  const allClasses = (seesAll ? classes : []).map((c) => ({
    id: c.id,
    name: c.name,
    daysOfWeek: Array.isArray(c.daysOfWeek) ? (c.daysOfWeek as number[]) : [],
    startTime: c.startTime,
    endTime: c.endTime,
    dayOverrides: asDayOverrides(c.dayOverrides),
    assignedStaffIds: asIdList(c.assignedStaffIds),
  }));

  return NextResponse.json({
    from: fromYmd,
    to: toYmd,
    staff: result,
    allEvents,
    allClasses,
    // What the viewer may do — the write routes enforce the same (lib/staffSelf.ts).
    viewer: { userId: me, seesAll, canAssign },
  });
}
