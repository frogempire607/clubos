/**
 * Switch a club on to the new class coach assignments (rules + per-day rows).
 *
 * DRY RUN BY DEFAULT — prints what would be written and writes nothing.
 *
 *   npx tsx scripts/switch-on-class-assignments.ts --club="Frog Empire"
 *   npx tsx scripts/switch-on-class-assignments.ts --club=<club id> --date=2026-10-12
 *   npx tsx scripts/switch-on-class-assignments.ts --club=<club id> --date=2026-10-12 --apply
 *
 *   --club=<id or name>   which club. Optional only when there is exactly one.
 *   --date=YYYY-MM-DD     the switch-on date. Default: today in the club's
 *                         timezone. The new system owns class days ON or AFTER
 *                         this date; earlier days keep reading the old coach
 *                         lists exactly as today and are never touched.
 *   --apply               actually write.
 *
 * PREREQUISITE: migration 20261008000000_class_staff_assignments is applied.
 *
 * What --apply writes, in ONE transaction for the club
 * (lib/classStaffServer.runSwitchOn, planned by lib/classStaff.planSwitchOn):
 *   (a) one recurring rule per coach on each non-deleted class, from the
 *       class's current coach list, starting on the date, every class day, no
 *       role (shown as "Coach" — set real roles in the app afterwards)
 *   (b) coach rows for every existing class day on/after the date:
 *         a day with no one-day change  → the class's coaches
 *         a day with a one-day list     → exactly that list, flagged as edited
 *                                         by hand (rules will not refill it)
 *         a day set to "nobody"         → no rows, flagged as edited by hand
 *   (c) the club's assignment start date
 * Nothing existing is changed or removed: the old coach-list columns stay as
 * they are (the app keeps them in step from here on).
 *
 * Safe to re-run: a class that already has rules and a day that already has
 * rows are skipped, so a second run reports "nothing to write". It REFUSES if
 * the club is already switched on from a different date.
 */
import { prisma } from "../lib/prisma";
import { clubTodayYmd, isYmd } from "../lib/classStaff";
import { runSwitchOn } from "../lib/classStaffServer";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const arg = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3).trim() || null;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1].trim() : null;
};
const line = (s = "") => console.log(s);

async function main() {
  const clubArg = arg("club");
  const dateArg = arg("date");
  if (dateArg && !isYmd(dateArg)) {
    line(`✗ --date must be YYYY-MM-DD (got "${dateArg}")`);
    process.exitCode = 1;
    return;
  }

  const clubs = await prisma.club.findMany({ select: { id: true, name: true, timezone: true }, orderBy: { name: "asc" } });
  const matches = clubArg
    ? clubs.filter((c) => c.id === clubArg || c.name.toLowerCase() === clubArg.toLowerCase())
    : clubs.length === 1 ? clubs : [];
  if (matches.length !== 1) {
    line(clubArg ? `✗ no single club matches --club="${clubArg}".` : "✗ more than one club — pass --club=<id or name>.");
    for (const c of clubs) line(`    ${c.id}  ${c.name}`);
    process.exitCode = 1;
    return;
  }
  const club = matches[0];
  const date = dateArg ?? clubTodayYmd(club.timezone);

  const res = await runSwitchOn({ clubId: club.id, date, apply: APPLY });

  line();
  line(`Club:            ${res.clubName} (${res.clubId})`);
  line(`Switch-on date:  ${res.date}${dateArg ? "" : `  (today in ${club.timezone ?? "UTC — the club has no timezone set"})`}`);
  line(`Mode:            ${APPLY ? "APPLY" : "DRY RUN — nothing is written"}`);
  line("─".repeat(78));
  if (res.refused) {
    line(`✗ REFUSED: this club is ${res.refused}. Nothing was written.`);
    line("  Moving the start date is a decision, not a re-run — ask before changing it.");
    process.exitCode = 1;
    return;
  }
  if (res.alreadyOn) line("  (this club is already switched on from this date — showing what is still missing)");

  const staff = await prisma.user.findMany({
    where: { clubId: club.id },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameOf = new Map(staff.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const names = (ids: string[]) => (ids.length ? ids.map((id) => nameOf.get(id) ?? id).join(", ") : "nobody");

  for (const c of res.plan.perClass) {
    line();
    line(`  ${c.name}`);
    if (c.state === "already") {
      line(`      already switched on (has rules: ${names(c.coaches)}) — left alone; ${c.sessions} class day(s) on/after the date`);
      continue;
    }
    line(`      recurring coaches (rules from ${res.date}): ${names(c.coaches)}`);
    if (c.droppedIds.length) line(`      ! not current staff, left out: ${names(c.droppedIds)}`);
    line(`      class days on/after the date: ${c.sessions}`);
    line(`        coach rows from the rules:        ${c.ruleRows}`);
    line(`        days with a one-day coach change: ${c.manualDays} (${c.manualRows} row(s), kept exactly, flagged as edited by hand)`);
    if (c.skippedDays) line(`        days skipped (already have rows):  ${c.skippedDays}`);
  }

  line();
  line("─".repeat(78));
  line(`  rules: ${res.plan.rules.length}   coach rows: ${res.plan.rows.length}   days flagged as edited by hand: ${res.plan.manualSessionIds.length}`);
  const nothing = res.plan.rules.length === 0 && res.plan.rows.length === 0 && res.plan.manualSessionIds.length === 0 && res.alreadyOn;
  if (nothing) {
    line("  Nothing to write — this club is fully switched on.");
  } else if (!APPLY) {
    line(`  DRY RUN — nothing written. Re-run with --apply --date=${res.date} to switch on.`);
  } else {
    line(`  APPLIED: ${res.written.rules} rule(s), ${res.written.rows} coach row(s), ${res.written.manualDays} day(s) flagged` +
      `${res.written.settings ? `, assignment start date set to ${res.date}` : ""}.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
