/**
 * Collapse class days that hold more than one ClassSession, and put the
 * survivor at the time the class actually runs.
 *
 * DRY RUN BY DEFAULT. Acting requires BOTH `--apply` and an explicit
 * `--sessions <id>,…` allowlist naming every row that will be REMOVED. A day
 * acts only when every one of its removals is on that list.
 *
 *   npx tsx scripts/fix-duplicate-class-sessions.ts
 *   npx tsx scripts/fix-duplicate-class-sessions.ts --apply --sessions cmtkn7f7m0002kdo3yj17h7rm
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * `PATCH /api/classes/[id]` used to delete future sessions and regenerate them.
 * The delete deliberately spared any session carrying attendance — and a member
 * BOOKING a class is an AttendanceRecord. So on 2026-09-02, moving Tadpoles
 * from 5:30 to 6:15 left the already-booked Wednesdays at 5:30 and added a
 * second row at 6:15 beside each of them. `skipDuplicates` caught nothing:
 * `class_sessions` has no unique constraint for it to match on, which is why
 * four of the eleven affected days carry the SAME start time twice.
 *
 * The route no longer does this (lib/classSessionSync.ts reconciles by date and
 * MOVES the booked row). This script repairs the rows already written.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 *
 * Per duplicated day, from TODAY forward:
 *   survivor  the row the most people are booked on — so the fewest bookings
 *             have to move anywhere — with its time set to what the series
 *             says that weekday runs at. Nobody is cancelled on: the booking
 *             keeps its row and the row keeps its id.
 *   losers    every other row on that day. Attendance on a loser moves to the
 *             survivor first (a member already on the survivor is dropped
 *             rather than duplicated), then the emptied loser is deleted.
 *
 * ── What it refuses ───────────────────────────────────────────────────────
 *
 *   Past days are reported and left alone. Which sitting a child actually
 *   attended is a fact about the gym, not about the database, and a booking on
 *   a day that has happened is attendance history.
 *   Overridden or canceled rows are never touched or deleted — a one-off edit
 *   and a cancellation are deliberate statements about that day.
 *   A day whose survivor cannot be determined without a judgement call is
 *   printed and skipped.
 */
import { prisma } from "../lib/prisma";
import { buildSessions, type DayOverride } from "../lib/classSessions";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const allowRaw = (() => {
  const i = argv.indexOf("--sessions");
  return i >= 0 ? (argv[i + 1] ?? "") : "";
})();
const ALLOW = new Set(allowRaw.split(",").map((s) => s.trim()).filter(Boolean));

const line = (s = "") => console.log(s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const clock = (d: Date) => d.toISOString().slice(11, 16);

async function main() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const classes = await prisma.recurringClass.findMany({
    where: { deletedAt: null },
    select: {
      id: true, name: true, clubId: true, daysOfWeek: true,
      startTime: true, endTime: true, dayOverrides: true,
      recurrenceStartDate: true, recurrenceEndDate: true,
    },
  });

  let futureDays = 0, pastDays = 0, moves = 0, removals = 0, attendanceMoves = 0, acted = 0;

  for (const cls of classes) {
    const rows = await prisma.classSession.findMany({
      where: { classId: cls.id },
      select: {
        id: true, date: true, startsAt: true, endsAt: true,
        canceled: true, overridden: true,
        attendance: { select: { id: true, memberId: true } },
      },
      orderBy: [{ date: "asc" }, { startsAt: "asc" }],
    });

    const byDate = new Map<number, typeof rows>();
    for (const r of rows) {
      const k = r.date.getTime();
      const list = byDate.get(k);
      if (list) list.push(r); else byDate.set(k, [r]);
    }

    // The series' intended time for each future day, keyed by date.
    const wantByDate = new Map<number, { startsAt: Date; endsAt: Date }>();
    for (const w of buildSessions(
      cls.id, cls.clubId, (cls.daysOfWeek as number[]) ?? [],
      cls.startTime, cls.endTime, (cls.dayOverrides as unknown as DayOverride[]) ?? [],
      new Date(Math.max(todayStart.getTime(), cls.recurrenceStartDate.getTime())),
      cls.recurrenceEndDate,
    )) {
      wantByDate.set(w.date.getTime(), { startsAt: w.startsAt, endsAt: w.endsAt });
    }

    for (const [k, dayRows] of [...byDate.entries()].sort((a, b) => a[0] - b[0])) {
      if (dayRows.length < 2) continue;
      const d = new Date(k);
      const detail = dayRows
        .map((r) => `${clock(r.startsAt)}-${clock(r.endsAt)} (${r.attendance.length} booked${r.overridden ? ", overridden" : ""}${r.canceled ? ", canceled" : ""}) ${r.id}`)
        .join("\n      ");

      if (k < todayStart.getTime()) {
        pastDays++;
        line(`\n  ${cls.name} · ${day(d)} — PAST, left alone`);
        line(`      ${detail}`);
        const dupMembers = new Map<string, number>();
        for (const r of dayRows) for (const a of r.attendance) dupMembers.set(a.memberId, (dupMembers.get(a.memberId) ?? 0) + 1);
        const doubled = [...dupMembers.values()].filter((n) => n > 1).length;
        if (doubled > 0) line(`      note: ${doubled} member(s) counted on BOTH rows — attendance for this day is double-counted.`);
        continue;
      }

      futureDays++;
      const want = wantByDate.get(k);
      const movable = dayRows.filter((r) => !r.overridden && !r.canceled);

      line(`\n  ${cls.name} · ${day(d)}`);
      line(`      ${detail}`);

      if (!want) {
        line(`      SKIP — the series no longer runs on this day. Removing a booked session is the owner's call.`);
        continue;
      }
      if (movable.length < 2) {
        line(`      SKIP — only ${movable.length} row here is movable; the rest are overridden or canceled and stay as they are.`);
        continue;
      }

      const survivor = movable.reduce((best, r) =>
        r.attendance.length > best.attendance.length ? r
          : r.attendance.length < best.attendance.length ? best
          : r.id < best.id ? r : best);
      const losers = movable.filter((r) => r.id !== survivor.id);

      const onSurvivor = new Set(survivor.attendance.map((a) => a.memberId));
      const moving: string[] = [];
      const dropping: string[] = [];
      for (const l of losers) {
        for (const a of l.attendance) {
          if (onSurvivor.has(a.memberId)) dropping.push(a.id);
          else { moving.push(a.id); onSurvivor.add(a.memberId); }
        }
      }

      const timeChanges =
        survivor.startsAt.getTime() !== want.startsAt.getTime() ||
        survivor.endsAt.getTime() !== want.endsAt.getTime();

      line(`      KEEP   ${survivor.id} — ${timeChanges
        ? `move ${clock(survivor.startsAt)}-${clock(survivor.endsAt)} → ${clock(want.startsAt)}-${clock(want.endsAt)}, carrying ${survivor.attendance.length} booking(s)`
        : `already at ${clock(want.startsAt)}-${clock(want.endsAt)}`}`);
      for (const l of losers) line(`      REMOVE ${l.id} — ${clock(l.startsAt)}-${clock(l.endsAt)}, ${l.attendance.length} booking(s)`);
      if (moving.length) line(`      MOVE   ${moving.length} attendance row(s) onto the survivor`);
      if (dropping.length) line(`      DROP   ${dropping.length} duplicate attendance row(s) — same member already on the survivor`);

      if (timeChanges) moves++;
      removals += losers.length;
      attendanceMoves += moving.length;

      if (!APPLY) continue;
      const notAllowed = losers.map((l) => l.id).filter((id) => !ALLOW.has(id));
      if (notAllowed.length > 0) {
        line(`      NOT APPLIED — pass --sessions ${notAllowed.join(",")} to remove ${notAllowed.length === 1 ? "it" : "them"}.`);
        continue;
      }

      if (moving.length > 0) {
        await prisma.attendanceRecord.updateMany({
          where: { id: { in: moving } },
          data: { classSessionId: survivor.id },
        });
      }
      if (dropping.length > 0) {
        await prisma.attendanceRecord.deleteMany({ where: { id: { in: dropping } } });
      }
      if (timeChanges) {
        await prisma.classSession.update({
          where: { id: survivor.id },
          data: { startsAt: want.startsAt, endsAt: want.endsAt },
        });
      }
      await prisma.classSession.deleteMany({ where: { id: { in: losers.map((l) => l.id) } } });
      acted++;
      line(`      APPLIED`);
    }
  }

  line();
  line("─".repeat(72));
  line(`  duplicated days: ${futureDays} from today forward, ${pastDays} in the past (reported only)`);
  line(`  would move ${moves} session time(s), remove ${removals} row(s), relocate ${attendanceMoves} booking(s)`);
  if (!APPLY) {
    line(`  DRY RUN — nothing written. Re-run with --apply --sessions <the REMOVE ids above>.`);
  } else {
    line(`  APPLIED to ${acted} day(s).`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
