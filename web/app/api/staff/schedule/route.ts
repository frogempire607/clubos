import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/staff/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns, for each staff member (and owners), their availability windows,
// exceptions in range, and assigned classes/events that fall in the range.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  if (!fromStr || !toStr) {
    return NextResponse.json({ error: "from and to required" }, { status: 400 });
  }
  const from = new Date(fromStr);
  const to = new Date(toStr);
  // Make `to` exclusive end-of-day
  to.setHours(23, 59, 59, 999);

  const clubId = session.user.clubId;

  const [staff, availability, exceptions, classes, events, sessionRows] = await Promise.all([
    prisma.user.findMany({
      where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, role: true, staffProfile: { select: { title: true } } },
      orderBy: { firstName: "asc" },
    }),
    prisma.staffAvailability.findMany({
      where: { clubId, active: true },
      select: { userId: true, dayOfWeek: true, startTime: true, endTime: true },
    }),
    prisma.staffAvailabilityException.findMany({
      where: { clubId, date: { gte: from, lte: to } },
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
        assignedStaffIds: true,
        recurrenceStartDate: true,
        recurrenceEndDate: true,
      },
    }),
    prisma.event.findMany({
      where: {
        clubId,
        deletedAt: null,
        startsAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        name: true,
        type: true,
        startsAt: true,
        endsAt: true,
        staffAssignments: {
          select: { userId: true, role: true },
        },
      },
    }),
    prisma.classSession.findMany({
      where: { clubId, date: { gte: from, lte: to } },
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

  // Per-occurrence overrides keyed by `${classId}|YYYY-MM-DD`.
  const sessionByKey = new Map<
    string,
    {
      id: string;
      startsAt: Date;
      endsAt: Date;
      canceled: boolean;
      staffOverride: string[] | null;
      note: string | null;
    }
  >();
  for (const s of sessionRows) {
    const key = `${s.classId}|${s.date.toISOString().slice(0, 10)}`;
    sessionByKey.set(key, {
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      canceled: s.canceled,
      staffOverride: Array.isArray(s.staffOverride) ? (s.staffOverride as string[]) : null,
      note: typeof s.note === "string" ? s.note : null,
    });
  }
  const hhmm = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

  // Build per-day class instances within the range
  type ClassInstance = {
    classId: string;
    sessionId: string | null;
    name: string;
    date: string; // YYYY-MM-DD
    startTime: string;
    endTime: string;
    staffIds: string[]; // effective (override or series)
    seriesStaffIds: string[];
    isSubstitute: boolean; // a per-occurrence staff override is in effect
    canceled: boolean;
    note: string | null;
  };
  const classInstances: ClassInstance[] = [];
  for (const c of classes) {
    const daysOfWeek = Array.isArray(c.daysOfWeek) ? (c.daysOfWeek as number[]) : [];
    const seriesStaff = Array.isArray(c.assignedStaffIds) ? (c.assignedStaffIds as string[]) : [];
    if (daysOfWeek.length === 0) continue;
    const recStart = new Date(c.recurrenceStartDate);
    const recEnd = c.recurrenceEndDate ? new Date(c.recurrenceEndDate) : null;
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(to);
    while (cursor <= end) {
      if (cursor >= recStart && (!recEnd || cursor <= recEnd) && daysOfWeek.includes(cursor.getDay())) {
        const dateStr = cursor.toISOString().slice(0, 10);
        const ov = sessionByKey.get(`${c.id}|${dateStr}`);
        const hasStaffOverride = !!ov && ov.staffOverride !== null;
        const effectiveStaff = hasStaffOverride ? (ov!.staffOverride as string[]) : seriesStaff;
        // Skip instances nobody is on (and no override clearing it) so the
        // schedule stays clean — unless it's canceled (shown as canceled).
        if (effectiveStaff.length === 0 && !(ov && ov.canceled)) {
          cursor.setDate(cursor.getDate() + 1);
          continue;
        }
        classInstances.push({
          classId: c.id,
          sessionId: ov?.id ?? null,
          name: c.name,
          date: dateStr,
          startTime: ov ? hhmm(ov.startsAt) : c.startTime,
          endTime: ov ? hhmm(ov.endsAt) : c.endTime,
          staffIds: effectiveStaff,
          seriesStaffIds: seriesStaff,
          isSubstitute: hasStaffOverride,
          canceled: !!ov?.canceled,
          note: ov?.note ?? null,
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Group everything by staff member
  const result = staff.map((s) => {
    const userAvailability = availability.filter((a) => a.userId === s.id);
    const userExceptions = exceptions
      .filter((e) => e.userId === s.id)
      .map((e) => ({
        id: e.id,
        date: e.date.toISOString().slice(0, 10),
        type: e.type,
        startTime: e.startTime,
        endTime: e.endTime,
        note: e.note,
      }));
    const userClasses = classInstances
      .filter((c) => c.staffIds.includes(s.id))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    const userEvents = events
      .filter((e) => e.staffAssignments.some((a) => a.userId === s.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
      }));

    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
      role: s.role,
      title: s.staffProfile?.title ?? null,
      availability: userAvailability,
      exceptions: userExceptions,
      classes: userClasses,
      events: userEvents,
    };
  });

  // All events in range + all active classes, so the schedule UI can offer
  // "assign to this event/class on this day" — not just show pre-assigned ones.
  const allEvents = events.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    startsAt: e.startsAt.toISOString(),
    date: e.startsAt.toISOString().slice(0, 10),
    assignedUserIds: e.staffAssignments.map((a) => a.userId),
  }));
  const allClasses = classes.map((c) => ({
    id: c.id,
    name: c.name,
    daysOfWeek: Array.isArray(c.daysOfWeek) ? (c.daysOfWeek as number[]) : [],
    startTime: c.startTime,
    endTime: c.endTime,
    assignedStaffIds: Array.isArray(c.assignedStaffIds) ? (c.assignedStaffIds as string[]) : [],
  }));

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    staff: result,
    allEvents,
    allClasses,
  });
}
