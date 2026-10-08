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
import { loadSessionStaffResolver } from "@/lib/classStaffServer";
import { clubTodayYmd, currentRuleStaffIds, maxYmd, proposedSlot, richStaffRows, type RichStaffRow, type StaffRule } from "@/lib/classStaff";
import { classActivityType, eventActivityType, findOverlaps, type Busy } from "@/lib/activityType";
import { cancelSummary, type CancelSummary } from "@/lib/classStaffApi";
import { loadClassRules } from "@/lib/classStaffServer";

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

  // Athlete names on OTHER coaches' private lessons need members:view; a coach always sees their own.
  const seesMembers = await hasPermissionLive(session, "members", "view");
  const [staff, availability, exceptions, classes, events, sessionRows, lessons] = await Promise.all([
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
        staffManual: true,
        note: true,
        canceledAt: true, canceledByUserId: true, cancelReason: true, cancelNotifyAudience: true,
        cancelNotifiedCount: true, cancelPaid: true, cancelPaidByUserId: true, cancelPaidAt: true,
      },
    }),
    // Private lessons with a set time — the existing booking rows, nothing copied.
    prisma.privateBooking.findMany({
      where: {
        clubId, status: { in: ["PENDING_COACH", "CONFIRMED", "COMPLETED"] }, coachId: seesAll ? { not: null } : me,
        confirmedStartAt: { gte: win.from, lte: win.to },
      },
      select: {
        id: true, coachId: true, status: true, confirmedStartAt: true, confirmedEndAt: true,
        lessonType: { select: { title: true, durationMin: true } },
        member: { select: { firstName: true, lastName: true } },
      },
      orderBy: { confirmedStartAt: "asc" },
    }),
  ]);

  // Legacy lists before the club's assignment start date; on/after it the
  // day's coach rows, or the class's rules for a day with no row yet.
  const staffOn = await loadSessionStaffResolver(clubId, sessionRows, { classIds: classes.map((c) => c.id) });
  // For a class day on/after the switch-on date each occurrence also carries
  // its coach ROWS (status, role, late call-out, who covers whom), whether it
  // still needs coverage, and — when canceled — the cancel record. `staffIds`
  // stays "who is coaching" (SCHEDULED), so older screens read it as before.
  type Occ = ClassOccurrence & {
    /** On/after the switch-on date: staffRows are real rows and the new actions apply. */
    switched: boolean;
    /** What kind of activity this is — one mapping for every screen (lib/activityType.ts). */
    activityType: string;
    staffRows: RichStaffRow[];
    needsCoverage: boolean;
    cancel: CancelSummary | null;
  };
  const staffNameById = new Map(staff.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const nameOf = (id: string) => staffNameById.get(id) ?? "Former staff";
  const sessionById = new Map(sessionRows.map((r) => [r.id, r]));
  const synthetic = (ids: string[], source: "RULE" | "LEGACY") =>
    ids.map((userId) => ({
      id: null, userId, roleName: null, kind: "REGULAR" as const, status: "SCHEDULED" as const, source,
      replacesStaffId: null, lateCallout: false,
    }));
  const classInstances: Occ[] = [];
  for (const c of classes) {
    for (const legacyOcc of classOccurrencesInRange(c, sessionRows, fromYmd, toYmd)) {
      const occ = staffOn.forOccurrence(legacyOcc);
      const switched = staffOn.isSwitched(occ.date);
      const rows = switched && occ.sessionId ? staffOn.rowsFor(occ.sessionId) : null;
      const staffRows = richStaffRows(rows ?? synthetic(occ.staffIds, switched ? "RULE" : "LEGACY"), nameOf);
      // Nobody attached to it and not canceled → not on anyone's schedule. A
      // coach who called out is still attached: the day needs coverage.
      if (occ.staffIds.length === 0 && !occ.canceled && !staffRows.some((r) => r.status !== "REMOVED")) continue;
      const row = occ.sessionId ? sessionById.get(occ.sessionId) : undefined;
      classInstances.push({
        ...occ,
        activityType: classActivityType(c.name),
        switched,
        staffRows,
        needsCoverage: switched && staffRows.some((r) => r.status === "NEEDS_COVERAGE"),
        cancel: row ? cancelSummary(row, nameOf) : null,
      });
    }
  }

  const eventsInRange = events.filter((e) => eventOverlaps(e.startsAt, e.endsAt, win.from, win.to));
  const iso = (d: Date) => d.toISOString();
  const eventOut = (e: (typeof eventsInRange)[number]) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    activityType: eventActivityType(String(e.type), e.name),
    startsAt: iso(e.startsAt),
    endsAt: iso(e.endsAt),
    sessions: e.sessions.map((s) => ({ startsAt: iso(s.startsAt), endsAt: iso(s.endsAt) })),
  });

  // Own-only view: an occurrence still lists who else is on it by id, which
  // would leak the roster — reduce each to the caller.
  const visibleStaff = seesAll ? staff : staff.filter((s) => s.id === me);
  const ownOnly = (c: Occ): Occ =>
    seesAll
      ? c
      : {
          ...c,
          staffIds: c.staffIds.filter((x) => x === me),
          seriesStaffIds: c.seriesStaffIds.filter((x) => x === me),
          // Only the caller's own row; no other person's name on it or on the cancel record.
          staffRows: c.staffRows.filter((r) => r.userId === me).map((r) => ({ ...r, coveredByName: null, calledOutByName: null, coverageFilledByName: null })),
          needsCoverage: c.staffRows.some((r) => r.userId === me && r.status === "NEEDS_COVERAGE"),
          cancel: c.cancel ? { ...c.cancel, canceledByName: null, paidByName: null } : null,
        };
  // A class day is on someone's schedule when they are coaching it OR still
  // attached to it in any state but Removed — so a coach who called out keeps
  // seeing the class (as "Needs coverage"), and one who was replaced sees who
  // covers. `my*` is that person's own row.
  const mine = (c: Occ, userId: string) => {
    const r = c.staffRows.find((x) => x.userId === userId && x.status !== "REMOVED") ?? null;
    return {
      myStatus: r ? r.status : c.staffIds.includes(userId) ? ("SCHEDULED" as const) : null,
      myRowId: r?.id ?? null,
      myRoleName: r?.roleName ?? null,
      myKind: r?.kind ?? null,
      myLateCallout: !!r?.lateCallout,
    };
  };
  const onDay = (c: Occ, userId: string) => c.staffIds.includes(userId) || c.staffRows.some((r) => r.userId === userId && r.status !== "REMOVED");

  // Private lessons per coach. The athlete's name goes to the coach themself
  // and to anyone who may see members; otherwise it is just "Private lesson".
  const privatesFor = (userId: string) =>
    lessons
      .filter((l) => l.coachId === userId && l.confirmedStartAt)
      .map((l) => {
        const startsAt = l.confirmedStartAt!;
        const endsAt = l.confirmedEndAt ?? new Date(startsAt.getTime() + (l.lessonType.durationMin || 60) * 60_000);
        const showName = userId === me || seesMembers;
        return {
          id: l.id,
          title: l.lessonType.title,
          athlete: showName ? `${l.member.firstName} ${l.member.lastName}`.trim() : null,
          status: l.status,
          startsAt: iso(startsAt),
          endsAt: iso(endsAt),
          activityType: "PRIVATE",
        };
      });

  // Overlaps on one person's own schedule (classes they are coaching, events,
  // confirmed private lessons), compared as real instants.
  const tz = staffOn.timezone ?? (await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }))?.timezone ?? null;
  const overlapsFor = (userId: string, cls: Occ[], evs: typeof eventsInRange, privs: ReturnType<typeof privatesFor>) => {
    const busy: Busy[] = [];
    for (const c of cls) {
      if (c.canceled || mine(c, userId).myStatus !== "SCHEDULED") continue;
      const slot = proposedSlot(c.date, c.startTime, c.endTime, tz);
      busy.push({ key: `c:${c.classId}:${c.date}`, startMs: slot.startMs, endMs: slot.endMs, label: c.name });
    }
    for (const e of evs) {
      const parts = e.sessions.length > 0 ? e.sessions : [{ startsAt: e.startsAt, endsAt: e.endsAt }];
      for (const p of parts) busy.push({ key: `e:${e.id}`, startMs: p.startsAt.getTime(), endMs: p.endsAt.getTime(), label: e.name });
    }
    for (const p of privs) {
      if (p.status === "PENDING_COACH") continue;
      busy.push({ key: `p:${p.id}`, startMs: Date.parse(p.startsAt), endMs: Date.parse(p.endsAt), label: p.athlete ? `Private lesson with ${p.athlete}` : "Private lesson" });
    }
    return findOverlaps(busy);
  };

  const result = visibleStaff.map((s) => {
    const myClasses = classInstances.filter((c) => onDay(c, s.id));
    const myEvents = eventsInRange.filter((e) => e.staffAssignments.some((a) => a.userId === s.id));
    const myPrivates = privatesFor(s.id);
    const overlaps = overlapsFor(s.id, myClasses, myEvents, myPrivates);
    const uniq = (list: string[] | undefined) => Array.from(new Set(list ?? []));
    return {
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
    classes: myClasses
      .map((c) => {
        const hit = uniq(overlaps.get(`c:${c.classId}:${c.date}`));
        return { ...ownOnly(c), ...mine(c, s.id), conflict: hit.length > 0, conflictWith: hit };
      })
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)),
    events: myEvents.map((e) => {
      const hit = uniq(overlaps.get(`e:${e.id}`));
      return { ...eventOut(e), conflict: hit.length > 0, conflictWith: hit };
    }),
    privates: myPrivates.map((p) => {
      const hit = uniq(overlaps.get(`p:${p.id}`));
      return { ...p, conflict: hit.length > 0, conflictWith: hit };
    }),
    };
  });

  // Everything in range, so the schedule UI can offer "assign to this
  // event/class on this day" — not just show pre-assigned ones.
  const allEvents = (seesAll ? eventsInRange : []).map((e) => ({
    ...eventOut(e),
    date: e.startsAt.toISOString().slice(0, 10),
    assignedUserIds: e.staffAssignments.map((a) => a.userId),
  }));
  // Series-level coaches: for a switched-on club the RULES (the stored list is
  // the frozen pre-switch record), so "not on this class yet" offers are right.
  let seriesRules: StaffRule[] = [];
  let seriesAsOf: string | null = null;
  if (seesAll && staffOn.assignmentsStartOn) {
    seriesRules = await loadClassRules(prisma, classes.map((c) => c.id));
    seriesAsOf = maxYmd(clubTodayYmd(staffOn.timezone), staffOn.assignmentsStartOn);
  }
  const allClasses = (seesAll ? classes : []).map((c) => ({
    id: c.id,
    name: c.name,
    daysOfWeek: Array.isArray(c.daysOfWeek) ? (c.daysOfWeek as number[]) : [],
    startTime: c.startTime,
    endTime: c.endTime,
    dayOverrides: asDayOverrides(c.dayOverrides),
    assignedStaffIds: seriesAsOf
      ? currentRuleStaffIds(seriesRules.filter((r) => r.classId === c.id), seriesAsOf)
      : asIdList(c.assignedStaffIds),
  }));

  return NextResponse.json({
    from: fromYmd,
    to: toYmd,
    staff: result,
    allEvents,
    allClasses,
    // What the viewer may do — the write routes enforce the same (lib/staffSelf.ts).
    viewer: { userId: me, seesAll, canAssign },
    /** Today on the CLUB's clock (YYYY-MM-DD) — "upcoming" is judged by this, not by the viewer's device. */
    today: clubTodayYmd(staffOn.timezone),
    /** YYYY-MM-DD the new coach assignments apply from; null = this club is not switched on. */
    assignmentsStartOn: staffOn.assignmentsStartOn,
  });
}
