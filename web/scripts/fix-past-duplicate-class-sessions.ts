/**
 * Collapse PAST class days that hold more than one ClassSession, so
 * 20260910000000_class_session_unique_day can create its unique index.
 *
 * DRY RUN BY DEFAULT. Acting requires BOTH `--apply` and an explicit
 * `--sessions <id>,…` allowlist naming every row that will be REMOVED. A day
 * acts only when every one of its removals is on that list.
 *
 *   npx tsx scripts/fix-past-duplicate-class-sessions.ts
 *   npx tsx scripts/fix-past-duplicate-class-sessions.ts --apply --sessions cmt…,cmt…
 *
 * Dropping an attendance row needs a SECOND allowlist, because that is the only
 * operation here that can destroy a record of something that happened:
 *
 *   npx tsx scripts/fix-past-duplicate-class-sessions.ts --apply \
 *     --sessions <session ids> --drop-attendance <attendance ids>
 *
 * ── How this differs from fix-duplicate-class-sessions.ts ────────────────────
 *
 * That script is the FUTURE half and it deliberately refuses past days: "which
 * sitting a child actually attended is a fact about the gym, not about the
 * database." That principle still holds and this script does not overturn it —
 * it works within it. Three concrete differences:
 *
 *   1. TIMES ARE NEVER REWRITTEN. The future script moves the survivor to the
 *      time the series now says that weekday runs at. For a past day that would
 *      falsify history: the 5:30 sitting happened at 5:30, whatever the class
 *      has since been rescheduled to. The survivor keeps its own startsAt and
 *      endsAt, always.
 *   2. ATTENDANCE IS NEVER DROPPED SILENTLY. The future script drops a duplicate
 *      booking when the member is already on the survivor — safe, because a
 *      future booking is an intention and two intentions are one intention. A
 *      past AttendanceRecord is an observation, and it can carry `status`,
 *      `checkedInAt`, `notes`, `paymentMethod` and `amountCharged`. Two
 *      observations are not automatically one. See the merge rules below.
 *   3. OVERRIDDEN AND CANCELED ROWS ARE IN SCOPE, reluctantly. The future script
 *      leaves them alone as deliberate statements. A unique index cannot: if a
 *      past day holds two rows and one is overridden, one of them still has to
 *      go. Those days are reported with a loud marker and require the id on the
 *      allowlist like anything else — the script never picks for you.
 *
 * ── Why attendance must MOVE before a session is DELETED ─────────────────────
 *
 * `attendance_records.classSessionId` is `ON DELETE SET NULL`, not CASCADE
 * (20260429192044, line 770). So deleting a duplicate session does NOT remove
 * its attendance — it NULLs the link and leaves the rows behind, attached to no
 * session. They keep counting in club-wide attendance totals while vanishing
 * from every class roster, which is a worse state than the duplicate was. A
 * hand-written `DELETE FROM class_sessions …` would do exactly this. This script
 * moves attendance first, every time, in one transaction per day.
 *
 * ── Merge rules for a member who appears on BOTH rows ────────────────────────
 *
 * Per member, the record on the survivor is kept and the one on the loser is a
 * candidate to drop. It is only offered for dropping when it is MATERIALLY
 * IDENTICAL — same status, same paymentMethod, same amountCharged, same notes,
 * and checkedInAt either both null or within the same minute. Otherwise the day
 * is REFUSED and both records are printed for a human to reconcile, because a
 * PRESENT beside an ABSENT, or a $15 drop-in beside a $0, is a question about
 * what happened rather than about the schema.
 *
 * Money is a hard stop regardless: a record with a non-null `amountCharged` or a
 * `paymentMethod` is never offered for automatic dropping, even when its twin
 * looks identical, because two charges may be two real charges. It must be named
 * in --drop-attendance explicitly.
 *
 * ── Known shape of the six days, as reported 2026-09-10 ──────────────────────
 *
 *   08-18, 08-20, 08-23, 09-06  expected to be ordinary collapses.
 *   09-01  an empty 18:30 row beside a 17-person 19:00 session. The empty row
 *          has no attendance, so nothing moves and nothing is dropped; the
 *          19:00 row survives on booking count and keeps its 19:00 time.
 *   09-02  four members with attendance on BOTH rows. Expect four merge
 *          decisions. If the pairs are identical the script offers them for
 *          dropping; if any pair differs, or any carries money, 09-02 is
 *          refused until you pass those ids. That refusal is the correct
 *          outcome, not a failure.
 */
import { prisma } from "../lib/prisma";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

function listArg(flag: string): Set<string> {
  const i = argv.indexOf(flag);
  const raw = i >= 0 ? (argv[i + 1] ?? "") : "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}
const ALLOW_SESSIONS = listArg("--sessions");
const ALLOW_ATTENDANCE = listArg("--drop-attendance");

const line = (s = "") => console.log(s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const clock = (d: Date) => d.toISOString().slice(11, 16);
const money = (v: unknown) => (v == null ? "—" : `$${Number(v).toFixed(2)}`);

type Att = {
  id: string;
  memberId: string;
  status: string;
  checkedInAt: Date | null;
  notes: string | null;
  paymentMethod: string | null;
  amountCharged: unknown;
  member: { firstName: string; lastName: string } | null;
};

const who = (a: Att) => (a.member ? `${a.member.firstName} ${a.member.lastName}` : a.memberId);

/** Does this record represent money? Money is never dropped automatically. */
const carriesMoney = (a: Att) => a.amountCharged != null || a.paymentMethod != null;

/** Same observation, or two different observations? */
function materiallyIdentical(a: Att, b: Att): { same: boolean; why: string[] } {
  const why: string[] = [];
  if (a.status !== b.status) why.push(`status ${a.status} vs ${b.status}`);
  if ((a.notes ?? "") !== (b.notes ?? "")) why.push(`notes differ`);
  if ((a.paymentMethod ?? "") !== (b.paymentMethod ?? ""))
    why.push(`paymentMethod ${a.paymentMethod ?? "—"} vs ${b.paymentMethod ?? "—"}`);
  const av = a.amountCharged == null ? null : Number(a.amountCharged);
  const bv = b.amountCharged == null ? null : Number(b.amountCharged);
  if (av !== bv) why.push(`amountCharged ${money(av)} vs ${money(bv)}`);
  const at = a.checkedInAt ? Math.floor(a.checkedInAt.getTime() / 60000) : null;
  const bt = b.checkedInAt ? Math.floor(b.checkedInAt.getTime() / 60000) : null;
  if (at !== bt) why.push(`checkedInAt differ`);
  return { same: why.length === 0, why };
}

async function main() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Every (classId, date) group with more than one row, in the past only.
  const groups = await prisma.classSession.groupBy({
    by: ["classId", "date"],
    where: { date: { lt: todayStart } },
    having: { id: { _count: { gt: 1 } } },
    _count: { id: true },
  });

  if (groups.length === 0) {
    line("  No past duplicate (classId, date) groups. The migration's guard will pass.");
    return;
  }

  const classNames = new Map(
    (
      await prisma.recurringClass.findMany({
        where: { id: { in: [...new Set(groups.map((g) => g.classId))] } },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );

  let refused = 0;
  let acted = 0;
  let plannedRemovals = 0;
  let plannedMoves = 0;
  let plannedDrops = 0;

  for (const g of [...groups].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const rows = await prisma.classSession.findMany({
      where: { classId: g.classId, date: g.date },
      select: {
        id: true, date: true, startsAt: true, endsAt: true,
        canceled: true, overridden: true,
        attendance: {
          select: {
            id: true, memberId: true, status: true, checkedInAt: true,
            notes: true, paymentMethod: true, amountCharged: true,
            member: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });

    line();
    line(`  ${classNames.get(g.classId) ?? g.classId} · ${day(g.date)} — ${rows.length} rows`);
    for (const r of rows) {
      const flags = [r.overridden ? "overridden" : null, r.canceled ? "canceled" : null]
        .filter(Boolean).join(", ");
      line(`      ${clock(r.startsAt)}-${clock(r.endsAt)}  ${String(r.attendance.length).padStart(2)} attendance${flags ? `, ${flags}` : ""}  ${r.id}`);
    }

    // Survivor: most attendance, then lowest id. Same rule as the future-half
    // script, so the two never disagree about which row is canonical.
    const survivor = rows.reduce((best, r) =>
      r.attendance.length > best.attendance.length ? r
        : r.attendance.length < best.attendance.length ? best
        : r.id < best.id ? r : best);
    const losers = rows.filter((r) => r.id !== survivor.id);

    if (rows.some((r) => r.overridden || r.canceled)) {
      line(`      ⚠ this day holds an overridden or canceled row. The unique index leaves no`);
      line(`        room for two rows, so one is going regardless of what it says. Check the`);
      line(`        list above before allowlisting.`);
    }

    // Plan the attendance merge.
    const onSurvivor = new Map<string, Att>();
    for (const a of survivor.attendance as Att[]) onSurvivor.set(a.memberId, a);

    const moving: Att[] = [];
    const dropCandidates: { loser: Att; keeper: Att }[] = [];
    // Records that may only be discarded if a human names them explicitly.
    const conflicts: Att[] = [];

    for (const l of losers) {
      for (const a of l.attendance as Att[]) {
        const keeper = onSurvivor.get(a.memberId);
        if (!keeper) {
          moving.push(a);
          onSurvivor.set(a.memberId, a);
          continue;
        }
        const { same, why } = materiallyIdentical(a, keeper);
        if (!same) {
          conflicts.push(a);
          line(`      ⚠ ${who(a)} appears on both rows and the records DIFFER: ${why.join("; ")}`);
          line(`          survivor ${keeper.id}  status=${keeper.status} checkedIn=${keeper.checkedInAt ? clock(keeper.checkedInAt) : "—"} ${money(keeper.amountCharged)} ${keeper.paymentMethod ?? ""}`);
          line(`          loser    ${a.id}  status=${a.status} checkedIn=${a.checkedInAt ? clock(a.checkedInAt) : "—"} ${money(a.amountCharged)} ${a.paymentMethod ?? ""}`);
          line(`          Reconcile, or discard the loser with --drop-attendance ${a.id}`);
          continue;
        }
        if (carriesMoney(a)) {
          conflicts.push(a);
          line(`      ⚠ ${who(a)} appears on both rows, records match, but this one carries money`);
          line(`          ${money(a.amountCharged)} ${a.paymentMethod ?? ""} — two charges may be two real charges.`);
          line(`          To discard it anyway: --drop-attendance ${a.id}`);
          continue;
        }
        dropCandidates.push({ loser: a, keeper });
      }
    }

    if (moving.length) line(`      MOVE   ${moving.length} attendance row(s) onto ${survivor.id}`);
    for (const { loser } of dropCandidates) {
      line(`      DROP   ${loser.id} — ${who(loser)}, duplicate of the survivor's record, nothing differs`);
    }
    line(`      KEEP   ${survivor.id} — ${clock(survivor.startsAt)}-${clock(survivor.endsAt)}, time UNCHANGED (past day)`);
    for (const l of losers) line(`      REMOVE ${l.id} — ${clock(l.startsAt)}-${clock(l.endsAt)}`);

    plannedRemovals += losers.length;
    plannedMoves += moving.length;
    plannedDrops += dropCandidates.length;

    // ── Refusals ────────────────────────────────────────────────────────────
    // Every conflict must be named in --drop-attendance before this day can be
    // touched. Un-named conflicts refuse the day even in --apply.
    const unnamed = conflicts.filter((a) => !ALLOW_ATTENDANCE.has(a.id));
    if (unnamed.length > 0) {
      refused++;
      line(`      REFUSED — ${unnamed.length} attendance conflict(s) above need a human.`);
      line(`        Reconcile them, or discard the loser records with:`);
      line(`        --drop-attendance ${unnamed.map((a) => a.id).join(",")}`);
      continue;
    }

    if (!APPLY) continue;

    const notAllowed = losers.map((l) => l.id).filter((id) => !ALLOW_SESSIONS.has(id));
    if (notAllowed.length > 0) {
      line(`      NOT APPLIED — pass --sessions ${notAllowed.join(",")} to remove ${notAllowed.length === 1 ? "it" : "them"}.`);
      continue;
    }

    // Everything that touches this day happens together, so a failure halfway
    // cannot leave attendance pointing at a session that is about to vanish.
    const explicitDrops = losers
      .flatMap((l) => l.attendance as Att[])
      .filter((a) => ALLOW_ATTENDANCE.has(a.id))
      .map((a) => a.id);
    const autoDrops = dropCandidates.map((d) => d.loser.id);
    const dropIds = [...new Set([...autoDrops, ...explicitDrops])];
    const moveIds = moving.map((a) => a.id).filter((id) => !dropIds.includes(id));

    await prisma.$transaction(async (tx) => {
      if (moveIds.length > 0) {
        await tx.attendanceRecord.updateMany({
          where: { id: { in: moveIds } },
          data: { classSessionId: survivor.id },
        });
      }
      if (dropIds.length > 0) {
        await tx.attendanceRecord.deleteMany({ where: { id: { in: dropIds } } });
      }
      // Only now, with nothing pointing at them, are the losers removable. If
      // any attendance were left behind, ON DELETE SET NULL would orphan it.
      const orphanCheck = await tx.attendanceRecord.count({
        where: { classSessionId: { in: losers.map((l) => l.id) } },
      });
      if (orphanCheck > 0) {
        throw new Error(
          `refusing to delete ${losers.length} session(s) on ${day(g.date)}: ${orphanCheck} attendance row(s) still point at them, which ON DELETE SET NULL would orphan`,
        );
      }
      await tx.classSession.deleteMany({ where: { id: { in: losers.map((l) => l.id) } } });
    });

    acted++;
    line(`      APPLIED`);
  }

  line();
  line("─".repeat(72));
  line(`  past duplicate groups: ${groups.length}${refused ? `, ${refused} refused pending a human decision` : ""}`);
  line(`  would remove ${plannedRemovals} session row(s), move ${plannedMoves} attendance row(s), drop ${plannedDrops} exact-duplicate attendance row(s)`);
  if (!APPLY) {
    line(`  DRY RUN — nothing written. Re-run with --apply --sessions <the REMOVE ids above>.`);
  } else {
    line(`  APPLIED to ${acted} day(s).`);
  }
  if (refused > 0) {
    line();
    line(`  ${refused} day(s) still hold duplicates, so`);
    line(`  20260910000000_class_session_unique_day WILL abort on its guard until they are resolved.`);
  }
  line();
  line(`  Verify before applying the migration — this must return zero rows:`);
  line(`    select "classId", date, count(*) from class_sessions group by 1,2 having count(*) > 1;`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
