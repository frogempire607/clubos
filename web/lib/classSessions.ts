// Shared helpers for recurring-class session generation. Lives in lib/ (not a
// route.ts) because Next.js 15 forbids non-handler exports from route files.

export type DayOverride = {
  dayOfWeek: number;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
};

// Materialize ClassSession rows for a recurring class between [start, end].
// Days listed in `overrides` use their own times; all other scheduled days use
// defaultStartTime/defaultEndTime.
export function buildSessions(
  classId: string,
  clubId: string,
  daysOfWeek: number[],
  defaultStartTime: string,
  defaultEndTime: string,
  overrides: DayOverride[],
  start: Date,
  end: Date | null
) {
  const ceiling = end ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const overridesByDay = new Map<number, DayOverride>(overrides.map((o) => [o.dayOfWeek, o]));

  const rows: {
    classId: string;
    clubId: string;
    date: Date;
    startsAt: Date;
    endsAt: Date;
    canceled: boolean;
  }[] = [];

  const cur = new Date(start);
  cur.setUTCHours(0, 0, 0, 0);

  while (cur <= ceiling) {
    const dow = cur.getUTCDay();
    if (daysOfWeek.includes(dow)) {
      const o = overridesByDay.get(dow);
      const startTime = o?.startTime ?? defaultStartTime;
      const endTime = o?.endTime ?? defaultEndTime;
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      const startsAt = new Date(cur);
      startsAt.setUTCHours(sh, sm, 0, 0);
      const endsAt = new Date(cur);
      endsAt.setUTCHours(eh, em, 0, 0);
      rows.push({ classId, clubId, date: new Date(cur), startsAt, endsAt, canceled: false });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return rows;
}

export type BuiltSession = ReturnType<typeof buildSessions>[number];

/** A ClassSession already in the database, as the reconciler needs to see it. */
export type ExistingSession = {
  id: string;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  canceled: boolean;
  overridden: boolean;
  attendanceCount: number;
};

export type SessionPlan = {
  create: BuiltSession[];
  update: { id: string; startsAt: Date; endsAt: Date }[];
  deleteIds: string[];
  /** A scheduled day already holding more than one attended row. Owner's call. */
  unresolved: { date: Date; sessionIds: string[] }[];
  /** A row on a day the series no longer runs, kept because deleting it would take something with it. */
  orphaned: { id: string; date: Date; reason: "ATTENDED" | "OVERRIDDEN" | "CANCELED" }[];
};

const dayKey = (d: Date) => d.getTime();

// Reconcile a class's future sessions against the series definition, BY DATE.
//
// The rule this exists to enforce: one session per class per day. The previous
// approach — delete the future, regenerate it — could not hold that line,
// because the delete spares any session carrying attendance (a booking IS an
// AttendanceRecord) while the regeneration recreated that day anyway. A time
// change therefore forked every already-booked date into an old-time row and a
// new-time row, and members went on booking the old one. `skipDuplicates` was
// no defence: class_sessions has no unique constraint for it to match on.
//
// So a moved class MOVES its sessions. Updating startsAt/endsAt in place keeps
// every booking attached to the row it was made against — nobody is cancelled
// on, no confirmation is re-sent, and attendance history stays where it is.
// This is the same thing the per-occurrence "following" edit already did; the
// series path was the one that forked instead.
//
// What it will not do: destroy anything a person is attached to, or guess when
// a day is already ambiguous. Attended rows on a dropped day are reported, not
// deleted; a day holding two attended rows is reported, not merged.
export function planSessionChanges(
  existing: ExistingSession[],
  desired: BuiltSession[],
): SessionPlan {
  const plan: SessionPlan = { create: [], update: [], deleteIds: [], unresolved: [], orphaned: [] };

  const byDate = new Map<number, ExistingSession[]>();
  for (const row of existing) {
    const k = dayKey(row.date);
    const list = byDate.get(k);
    if (list) list.push(row); else byDate.set(k, [row]);
  }

  for (const want of desired) {
    const k = dayKey(want.date);
    const rows = byDate.get(k);
    byDate.delete(k);

    if (!rows || rows.length === 0) {
      plan.create.push(want);
      continue;
    }

    // A one-off edit or a cancellation is a deliberate statement about this
    // day. The series does not get to overwrite it, and it still counts as
    // "this day has a session" — so no second row is created beside it.
    const movable = rows.filter((r) => !r.overridden && !r.canceled);
    if (movable.length === 0) continue;

    // Survivor = the row most people are attached to, so the fewest bookings
    // have to move anywhere. Ties break on id for a deterministic plan.
    const survivor = movable.reduce((best, r) =>
      r.attendanceCount > best.attendanceCount ? r
        : r.attendanceCount < best.attendanceCount ? best
        : r.id < best.id ? r : best);

    if (survivor.startsAt.getTime() !== want.startsAt.getTime() ||
        survivor.endsAt.getTime() !== want.endsAt.getTime()) {
      plan.update.push({ id: survivor.id, startsAt: want.startsAt, endsAt: want.endsAt });
    }

    const losers = movable.filter((r) => r.id !== survivor.id);
    const attendedLosers = losers.filter((r) => r.attendanceCount > 0);
    for (const r of losers) {
      if (r.attendanceCount === 0) plan.deleteIds.push(r.id);
    }
    if (attendedLosers.length > 0) {
      // Two sittings of the same class on one day, both with people on them.
      // Merging attendance is a judgement about who actually trained; it is
      // the owner's, made from scripts/fix-duplicate-class-sessions.ts.
      plan.unresolved.push({
        date: want.date,
        sessionIds: [survivor.id, ...attendedLosers.map((r) => r.id)],
      });
    }
  }

  // Anything left over sits on a day the series no longer runs.
  for (const rows of byDate.values()) {
    for (const r of rows) {
      if (r.attendanceCount > 0) plan.orphaned.push({ id: r.id, date: r.date, reason: "ATTENDED" });
      else if (r.overridden) plan.orphaned.push({ id: r.id, date: r.date, reason: "OVERRIDDEN" });
      else if (r.canceled) plan.orphaned.push({ id: r.id, date: r.date, reason: "CANCELED" });
      else plan.deleteIds.push(r.id);
    }
  }

  return plan;
}
