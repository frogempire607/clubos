/**
 * A class time change must MOVE its future sessions, not duplicate them.
 *
 *   npm run test:class-sessions
 *
 * The Tadpoles bug, 2026-09-02: the owner moved the Wednesday class from
 * 5:30-6:15 to 6:15-7:00. `PATCH /api/classes/[id]` deleted future sessions
 * and regenerated them — but the delete deliberately spares any session that
 * carries attendance, and a member BOOKING a class is an AttendanceRecord.
 * So every future date somebody had already booked kept its old-time row AND
 * gained a new-time row. Eleven days across three classes ended up doubled,
 * and on 2026-09-09 a trial member booked the stale 5:30 session five days
 * after it stopped being a real class.
 *
 * `createMany({ skipDuplicates: true })` did not help: `class_sessions` has no
 * unique constraint, so there is nothing for skipDuplicates to match on. Four
 * of the eleven duplicated days carry the SAME start time twice, which is that
 * fact in the data.
 *
 * `planSessionChanges` is the fix: reconcile by DATE. One session per class per
 * day, its time updated in place so the bookings on it come along, rows created
 * only for dates that have none, and nothing deleted that anyone has booked.
 */
import { buildSessions, planSessionChanges, type ExistingSession } from "../lib/classSessions";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const T = (s: string, hhmm: string) => new Date(`${s}T${hhmm}:00.000Z`);

let seq = 0;
function existing(
  date: string,
  start: string,
  end: string,
  o: Partial<Pick<ExistingSession, "canceled" | "overridden" | "attendanceCount">> = {},
): ExistingSession {
  return {
    id: `s${++seq}`,
    date: D(date),
    startsAt: T(date, start),
    endsAt: T(date, end),
    canceled: o.canceled ?? false,
    overridden: o.overridden ?? false,
    attendanceCount: o.attendanceCount ?? 0,
  };
}

/** Tadpoles, as stored: Wed(3) + Sun(0), Sunday overridden to 13:15-14:00. */
function tadpolesDesired(wedStart: string, wedEnd: string, from: string, to: string) {
  return buildSessions(
    "cls_tadpoles", "club_1", [3, 0], wedStart, wedEnd,
    [{ dayOfWeek: 0, startTime: "13:15", endTime: "14:00" },
     { dayOfWeek: 3, startTime: wedStart, endTime: wedEnd }],
    D(from), D(to),
  );
}

function main() {
  console.log("\nCLASS SESSIONS — a time change moves the series, it does not fork it\n");

  // ── The regression, exactly as it happened ────────────────────────────────
  {
    // Two future Wednesdays already booked at the old 17:30 time.
    const rows = [
      existing("2026-09-09", "17:30", "18:15", { attendanceCount: 2 }),
      existing("2026-09-16", "17:30", "18:15", { attendanceCount: 1 }),
    ];
    const desired = tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-16");
    const plan = planSessionChanges(rows, desired);

    check("no date ends up with two sessions",
      plan.create.every((c) => !rows.some((r) => r.date.getTime() === c.date.getTime())),
      JSON.stringify(plan.create.map((c) => c.date)));
    check("the booked 2026-09-09 row is MOVED to 18:15, not replaced",
      plan.update.some((u) => u.id === rows[0].id && u.startsAt.getTime() === T("2026-09-09", "18:15").getTime()),
      JSON.stringify(plan.update));
    check("nothing with attendance is deleted",
      plan.deleteIds.length === 0, JSON.stringify(plan.deleteIds));
    check("both booked Wednesdays move", plan.update.length === 2, JSON.stringify(plan.update));
  }

  // ── The empty duplicate the old code left behind gets cleaned up ──────────
  {
    const booked = existing("2026-09-09", "17:30", "18:15", { attendanceCount: 2 });
    const stray = existing("2026-09-09", "18:15", "19:00", { attendanceCount: 0 });
    const plan = planSessionChanges([booked, stray], tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-09"));

    check("the row carrying the bookings survives the duplicate day",
      plan.update.some((u) => u.id === booked.id), JSON.stringify(plan.update));
    check("the empty duplicate is deleted",
      plan.deleteIds.length === 1 && plan.deleteIds[0] === stray.id, JSON.stringify(plan.deleteIds));
    check("no third row is created for a day that already has one",
      plan.create.length === 0, JSON.stringify(plan.create));
  }

  // ── Two rows on one day where BOTH carry bookings: refuse, do not guess ───
  {
    const a = existing("2026-09-02", "17:30", "18:15", { attendanceCount: 4 });
    const b = existing("2026-09-02", "18:15", "19:00", { attendanceCount: 5 });
    const plan = planSessionChanges([a, b], tadpolesDesired("18:15", "19:00", "2026-09-02", "2026-09-02"));

    check("a duplicate day where both rows are attended deletes NEITHER",
      plan.deleteIds.length === 0, JSON.stringify(plan.deleteIds));
    check("it is reported as unresolved rather than merged silently",
      plan.unresolved.length === 1 && plan.unresolved[0].sessionIds.length === 2,
      JSON.stringify(plan.unresolved));
  }

  // ── Per-occurrence edits and cancellations outrank the series ─────────────
  {
    const oneOff = existing("2026-09-09", "16:00", "17:00", { overridden: true });
    const plan = planSessionChanges([oneOff], tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-09"));
    check("an overridden occurrence keeps its own time through a series change",
      plan.update.length === 0 && plan.deleteIds.length === 0 && plan.create.length === 0,
      JSON.stringify(plan));
  }
  {
    const off = existing("2026-09-09", "17:30", "18:15", { canceled: true });
    const plan = planSessionChanges([off], tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-09"));
    check("a canceled session stays canceled and is not re-created at the new time",
      plan.create.length === 0 && plan.deleteIds.length === 0, JSON.stringify(plan));
  }

  // ── Dropping a weekday ────────────────────────────────────────────────────
  {
    // Sunday removed from the schedule; the Sunday row is empty.
    const sun = existing("2026-09-13", "13:15", "14:00");
    const wed = existing("2026-09-09", "17:30", "18:15");
    const desired = buildSessions("cls_tadpoles", "club_1", [3], "18:15", "19:00", [],
      D("2026-09-09"), D("2026-09-13"));
    const plan = planSessionChanges([wed, sun], desired);
    check("a day removed from the schedule is deleted when nobody booked it",
      plan.deleteIds.length === 1 && plan.deleteIds[0] === sun.id, JSON.stringify(plan.deleteIds));
  }
  {
    // Same, but a member is booked on the Sunday being dropped.
    const sun = existing("2026-09-13", "13:15", "14:00", { attendanceCount: 1 });
    const desired = buildSessions("cls_tadpoles", "club_1", [3], "18:15", "19:00", [],
      D("2026-09-09"), D("2026-09-13"));
    const plan = planSessionChanges([sun], desired);
    check("dropping a day does NOT silently cancel a booking on it",
      plan.deleteIds.length === 0 && plan.orphaned.length === 1 && plan.orphaned[0].reason === "ATTENDED",
      JSON.stringify(plan));
  }

  // ── The ordinary cases still work ─────────────────────────────────────────
  {
    const plan = planSessionChanges([], tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-16"));
    check("a series with no materialized sessions creates them all",
      plan.create.length === 3 && plan.update.length === 0, JSON.stringify(plan.create.length));
  }
  {
    const rows = tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-16").map((r, i) => ({
      id: `k${i}`, date: r.date, startsAt: r.startsAt, endsAt: r.endsAt,
      canceled: false, overridden: false, attendanceCount: 0,
    }));
    const plan = planSessionChanges(rows, tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-16"));
    check("re-saving a class with no change writes nothing",
      plan.create.length === 0 && plan.update.length === 0 && plan.deleteIds.length === 0,
      JSON.stringify(plan));
  }
  {
    // Sunday's override is untouched while Wednesday's default time moves.
    const sun = existing("2026-09-13", "13:15", "14:00", { attendanceCount: 1 });
    const wed = existing("2026-09-09", "17:30", "18:15", { attendanceCount: 1 });
    const plan = planSessionChanges([wed, sun], tadpolesDesired("18:15", "19:00", "2026-09-09", "2026-09-13"));
    check("a day whose override did not change is not rewritten",
      !plan.update.some((u) => u.id === sun.id), JSON.stringify(plan.update));
    check("only the weekday that actually moved is updated",
      plan.update.length === 1 && plan.update[0].id === wed.id, JSON.stringify(plan.update));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
