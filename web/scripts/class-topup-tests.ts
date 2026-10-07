/**
 * Nightly class top-up (lib/classTopUp.ts) + the get-or-create day helper.
 *
 *   npx tsx scripts/class-topup-tests.ts
 *
 * No database: the planner is pure, and runClassTopUp / ensureSession run
 * against the in-memory fake in scripts/fake-prisma.ts. Pins: an ongoing class
 * created 400 days ago is topped up to today + 180; an ended, deleted or
 * inactive class is not; each weekday gets its own time; a second run creates
 * nothing; and a lazily created day gets the weekday's time, not the default.
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";

const fake = makeFakeDb({
  relations: {
    classSession: {
      recurringClass: { model: "recurringClass", kind: "one", fk: "classId" },
      club: { model: "club", kind: "one", fk: "clubId" },
      staff: { model: "classSessionStaff", kind: "many", fk: "sessionId" },
    },
    classSessionStaff: { session: { model: "classSession", kind: "one", fk: "sessionId" } },
    recurringClass: { club: { model: "club", kind: "one", fk: "clubId" } },
  },
  uniques: { classSession: [["classId", "date"]], classSessionStaff: [["sessionId", "userId"]] },
});
installFakePrisma(fake.client);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const topUp = require("../lib/classTopUp.ts") as typeof import("../lib/classTopUp");
const { TOP_UP_DAYS, classNeedsTopUp, planTopUp, runClassTopUp, ensureSession } = topUp;

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq(label: string, got: unknown, want: unknown) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const section = (t: string) => console.log(`\n${t}`);
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(d(s).getTime() + n * 86400000));

const TODAY = "2026-10-07"; // a Wednesday
type Cls = Parameters<typeof planTopUp>[0]["cls"];
const cls = (o: Partial<Cls> = {}): Cls => ({
  id: "c1", clubId: "club_1", daysOfWeek: [1, 3], startTime: "18:00", endTime: "19:00",
  dayOverrides: [{ dayOfWeek: 1, startTime: "17:15", endTime: "18:00" }],
  recurrenceStartDate: d(addDays(TODAY, -400)), recurrenceEndDate: null, active: true, deletedAt: null, ...o,
});

async function main() {
  section("Planner");
  {
    eq("the horizon is 180 days", TOP_UP_DAYS, 180);
    const plan = planTopUp({ cls: cls(), existingDates: new Set(), todayYmd: TODAY });
    const days = plan.map((s) => ymd(s.date));
    eq("a class created 400 days ago is planned from TODAY, not from its start", days[0], TODAY);
    eq("…through today + 180 days", days[days.length - 1] <= addDays(TODAY, 180) && days[days.length - 1] > addDays(TODAY, 173), true);
    check("only its weekdays", plan.every((s) => [1, 3].includes(s.date.getUTCDay())));
    check("no day twice", new Set(days).size === days.length);
    eq("about 26 weeks × 2 days", plan.length, 52);
    const mon = plan.find((s) => s.date.getUTCDay() === 1)!;
    const wed = plan.find((s) => s.date.getUTCDay() === 3)!;
    eq("Monday uses its own time", [mon.startsAt.toISOString().slice(11, 16), mon.endsAt.toISOString().slice(11, 16)], ["17:15", "18:00"]);
    eq("Wednesday uses the default time", [wed.startsAt.toISOString().slice(11, 16), wed.endsAt.toISOString().slice(11, 16)], ["18:00", "19:00"]);
    check("dates are UTC midnight, times are that day's wall clock", wed.date.toISOString().endsWith("T00:00:00.000Z") && ymd(wed.startsAt) === ymd(wed.date));

    const have = new Set(days.slice(0, 40));
    eq("days that already have a row are left out", planTopUp({ cls: cls(), existingDates: have, todayYmd: TODAY }).map((s) => ymd(s.date)), days.slice(40));
    eq("fully stocked → nothing", planTopUp({ cls: cls(), existingDates: new Set(days), todayYmd: TODAY }), []);

    eq("an ENDED class is not topped up", planTopUp({ cls: cls({ recurrenceEndDate: d(addDays(TODAY, -1)) }), existingDates: new Set(), todayYmd: TODAY }), []);
    check("…and does not count as ongoing", !classNeedsTopUp(cls({ recurrenceEndDate: d(addDays(TODAY, -1)) }), TODAY));
    check("a class ending today is still ongoing today", classNeedsTopUp(cls({ recurrenceEndDate: d(TODAY) }), TODAY));
    const ending = planTopUp({ cls: cls({ recurrenceEndDate: d(addDays(TODAY, 20)) }), existingDates: new Set(), todayYmd: TODAY }).map((s) => ymd(s.date));
    check("a class ending in 20 days stops at its end date", ending.length > 0 && ending[ending.length - 1] <= addDays(TODAY, 20));
    eq("a DELETED class is not topped up", planTopUp({ cls: cls({ deletedAt: d("2026-09-01") }), existingDates: new Set(), todayYmd: TODAY }), []);
    eq("an INACTIVE class is not topped up", planTopUp({ cls: cls({ active: false }), existingDates: new Set(), todayYmd: TODAY }), []);
    const later = planTopUp({ cls: cls({ recurrenceStartDate: d(addDays(TODAY, 30)) }), existingDates: new Set(), todayYmd: TODAY }).map((s) => ymd(s.date));
    check("a class that starts next month begins at its start date", later[0] >= addDays(TODAY, 30));
    eq("a class starting beyond the horizon: nothing yet", planTopUp({ cls: cls({ recurrenceStartDate: d(addDays(TODAY, 200)) }), existingDates: new Set(), todayYmd: TODAY }), []);
    eq("no weekdays → nothing", planTopUp({ cls: cls({ daysOfWeek: [] }), existingDates: new Set(), todayYmd: TODAY }), []);
    eq("a shorter horizon is honoured", planTopUp({ cls: cls(), existingDates: new Set(), todayYmd: TODAY, horizonDays: 7 }).map((s) => ymd(s.date)), ["2026-10-07", "2026-10-12", "2026-10-14"]);
    eq("an override for a weekday the class does not run is ignored",
      planTopUp({ cls: cls({ daysOfWeek: [3], dayOverrides: [{ dayOfWeek: 1, startTime: "07:00", endTime: "08:00" }] }), existingDates: new Set(), todayYmd: TODAY, horizonDays: 7 }).map((s) => s.startsAt.toISOString().slice(11, 16)), ["18:00", "18:00"]);
  }

  section("The nightly run (in-memory database)");
  const NOW = new Date("2026-10-07T16:00:00.000Z"); // noon in New York
  fake.seed("club", [{ id: "club_1", timezone: "America/New_York" }, { id: "club_2", timezone: null }]);
  fake.seed("recurringClass", [
    { ...cls({ id: "old" }), name: "Old ongoing" },
    { ...cls({ id: "ended", recurrenceEndDate: d(addDays(TODAY, -10)) }), name: "Ended" },
    { ...cls({ id: "deleted", deletedAt: d("2026-09-01") }), name: "Deleted" },
    { ...cls({ id: "inactive", active: false }), name: "Inactive" },
    { ...cls({ id: "other", clubId: "club_2", daysOfWeek: [5], dayOverrides: [] }), name: "Other club" },
  ]);
  // The old class only has rows up to 30 days out — the state production is in
  // once the 365 days made at creation run down. One booked day, one canceled day.
  const stale = planTopUp({ cls: cls({ id: "old" }), existingDates: new Set(), todayYmd: TODAY, horizonDays: 30 });
  fake.seed("classSession", stale.map((s, i) => ({ id: `have_${i}`, ...s, canceled: i === 2, staffOverride: null, staffManual: false, note: i === 1 ? "bring water" : null })));
  const before = fake.table("classSession").map((r) => ({ ...r }));
  {
    const res = await runClassTopUp(NOW);
    const mine = fake.table("classSession").filter((r) => r.classId === "old");
    const days = mine.map((r) => ymd(r.date)).sort();
    eq("both clubs were processed", res.map((r) => [r.clubId, r.outcome, r.classes]), [["club_1", "ok", 1], ["club_2", "ok", 1]]);
    eq("the old class now reaches 180 days out", days[days.length - 1] > addDays(TODAY, 173), true);
    eq("52 class days in all", mine.length, 52);
    check("one row per day (no duplicates)", new Set(days).size === days.length);
    eq("only the missing days were created", res[0].sessionsCreated, 52 - stale.length);
    check("existing rows were not touched (ids, notes, cancel flags)",
      before.every((b) => { const a = fake.table("classSession").find((r) => r.id === b.id); return !!a && a.note === b.note && a.canceled === b.canceled && a.startsAt.getTime() === b.startsAt.getTime(); }));
    const newMon = mine.find((r) => !String(r.id).startsWith("have_") && r.date.getUTCDay() === 1)!;
    eq("a new Monday has Monday's time", newMon.startsAt.toISOString().slice(11, 16), "17:15");
    eq("ended / deleted / inactive classes got nothing", fake.table("classSession").filter((r) => ["ended", "deleted", "inactive"].includes(r.classId)).length, 0);
    check("the other club's class was topped up too", fake.table("classSession").filter((r) => r.classId === "other").length >= 25);
    check("created with skipDuplicates", fake.calls.filter((c) => c.model === "classSession" && c.method === "createMany").every((c) => c.args.skipDuplicates === true));
    eq("a club that is not switched on gets no coach rows", fake.table("classSessionStaff").length, 0);
  }
  {
    const count = fake.table("classSession").length;
    fake.resetCalls();
    const res = await runClassTopUp(NOW);
    eq("re-run: nothing created", res.map((r) => r.sessionsCreated), [0, 0]);
    eq("re-run: the table is the same size", fake.table("classSession").length, count);
    eq("re-run: no writes at all", fake.writes().map((w) => `${w.model}.${w.method}`), []);
  }
  {
    // The next night the horizon moves one day; at most the newly visible day is added.
    const count = fake.table("classSession").length;
    const res = await runClassTopUp(new Date(NOW.getTime() + 5 * 86400000));
    const added = fake.table("classSession").length - count;
    eq("five days later: only the days that came into view", [added, res[0].sessionsCreated + res[1].sessionsCreated], [added, added]);
    check("…which is a handful, not a regeneration", added >= 1 && added <= 3, `added ${added}`);
  }
  {
    // A row somebody else created between the read and the write must not make the run fail.
    const racy = cls({ id: "racy", daysOfWeek: [3], dayOverrides: [] });
    fake.seed("recurringClass", [{ ...racy, name: "Racy" }]);
    const realFindMany = fake.client.classSession.findMany;
    fake.client.classSession.findMany = async (args: any) => {
      const out = await realFindMany(args);
      if (args?.where?.classId === "racy" && !fake.table("classSession").some((r) => r.classId === "racy")) {
        fake.seed("classSession", [{ id: "race_row", classId: "racy", clubId: "club_1", date: d("2026-10-14"), startsAt: new Date("2026-10-14T18:00:00Z"), endsAt: new Date("2026-10-14T19:00:00Z"), canceled: false, staffOverride: null, staffManual: false }]);
      }
      return out;
    };
    const res = await runClassTopUp(NOW);
    fake.client.classSession.findMany = realFindMany;
    eq("a day created mid-run is skipped by the unique key, not an error", res[0].outcome, "ok");
    eq("…and that day still has exactly one row", fake.table("classSession").filter((r) => r.classId === "racy" && ymd(r.date) === "2026-10-14").length, 1);
  }

  section("ensureSession — one class day, the right time");
  {
    // The audit's bug: a lazily created Monday got the class DEFAULT time (18:00), not Monday's 17:15.
    fake.seed("recurringClass", [{ ...cls({ id: "lazy" }), name: "Lazy" }]);
    const made = await ensureSession("lazy", "2027-06-07"); // a Monday beyond the horizon
    eq("a Monday is created at Monday's time", [made.created, made.session.startsAt.toISOString(), made.session.endsAt.toISOString()], [true, "2027-06-07T17:15:00.000Z", "2027-06-07T18:00:00.000Z"]);
    eq("the date is stamped at UTC midnight", made.session.date.toISOString(), "2027-06-07T00:00:00.000Z");
    const again = await ensureSession("lazy", "2027-06-07");
    eq("asking again returns the same row", [again.created, again.session.id], [false, made.session.id]);
    eq("…and there is still one row for that day", fake.table("classSession").filter((r) => r.classId === "lazy").length, 1);
    const wed = await ensureSession("lazy", "2027-06-09");
    eq("a Wednesday gets the default time", wed.session.startsAt.toISOString(), "2027-06-09T18:00:00.000Z");
    let code = "";
    try { await ensureSession("deleted", "2027-06-07"); } catch (e) { code = (e as { code?: string }).code ?? "threw"; }
    eq("a deleted class is refused", code, "NOT_FOUND");
    code = "";
    try { await ensureSession("lazy", "June 7"); } catch (e) { code = (e as { code?: string }).code ?? "threw"; }
    eq("a malformed date is refused", code, "BAD_INPUT");
  }

  console.log(`\n${failures.length ? "✗" : "✓"} ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
