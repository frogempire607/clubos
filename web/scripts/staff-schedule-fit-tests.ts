// B21 staff profile — does an assignment fit the person's availability?
// npm run test:staff-schedule-fit
import {
  toMinutes,
  mergeWindows,
  availabilityForDate,
  fitsWindows,
  fitFor,
  scheduleFit,
  weekDates,
  dayOfWeekOf,
  type WeeklySlot,
  type DateException,
} from "../lib/staffScheduleFit";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// Sal: Sun 10–2, Mon/Tue 5:30–9 PM. Week of Sun Sep 20, 2026.
const sal: WeeklySlot[] = [
  { dayOfWeek: 0, startTime: "10:00", endTime: "14:00", active: true },
  { dayOfWeek: 1, startTime: "17:30", endTime: "21:00", active: true },
  { dayOfWeek: 2, startTime: "17:30", endTime: "21:00", active: true },
];
const none: DateException[] = [];

console.log("\ntime parsing");
eq("18:30 → 1110", toMinutes("18:30"), 1110);
eq("9:05 → 545", toMinutes("9:05"), 545);
eq("24:00 allowed as end of day", toMinutes("24:00"), 1440);
eq("25:00 invalid", toMinutes("25:00"), null);
eq("empty invalid", toMinutes(""), null);
eq("null invalid", toMinutes(null), null);

console.log("\ncalendar helpers");
eq("Sep 20 2026 is a Sunday", dayOfWeekOf("2026-09-20"), 0);
eq("ISO date with time still reads the calendar day", dayOfWeekOf("2026-09-24T00:00:00.000Z"), 4);
eq("week of Thu Sep 24 starts Sun Sep 20", weekDates("2026-09-24")[0], "2026-09-20");
eq("week has 7 days ending Sat", weekDates("2026-09-24")[6], "2026-09-26");
eq("week crossing a month", weekDates("2026-10-01"), ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);

console.log("\nweekly hours");
eq("Mon class 6:30–8:30 PM fits 5:30–9 PM", fitFor({ date: "2026-09-21", startTime: "18:30", endTime: "20:30" }, sal, none), "fits");
eq("Thu class with no Thursday hours → outside", fitFor({ date: "2026-09-24", startTime: "18:30", endTime: "20:30" }, sal, none), "outside");
eq("Sun class 11–1 fits 10–2", fitFor({ date: "2026-09-20", startTime: "11:00", endTime: "13:00" }, sal, none), "fits");
eq("exactly the window edges fit", fitFor({ date: "2026-09-21", startTime: "17:30", endTime: "21:00" }, sal, none), "fits");
eq("ends 15 min after hours → outside", fitFor({ date: "2026-09-21", startTime: "20:00", endTime: "21:15" }, sal, none), "outside");
eq("starts before hours → outside", fitFor({ date: "2026-09-21", startTime: "17:00", endTime: "18:00" }, sal, none), "outside");
eq("NO availability set at all → outside (matches the existing 'Off' day)", fitFor({ date: "2026-09-21", startTime: "18:30", endTime: "20:30" }, [], none), "outside");
eq("no-hours day band is 'none'", availabilityForDate("2026-09-24", sal, none).kind, "none");
eq("inactive slot doesn't count", fitFor({ date: "2026-09-23", startTime: "18:00", endTime: "19:00" }, [{ dayOfWeek: 3, startTime: "17:00", endTime: "20:00", active: false }], none), "outside");
eq("slot with active omitted counts (schedule feed only returns active slots)", fitFor({ date: "2026-09-23", startTime: "18:00", endTime: "19:00" }, [{ dayOfWeek: 3, startTime: "17:00", endTime: "20:00" }], none), "fits");
eq("backwards slot (end before start) is ignored", availabilityForDate("2026-09-23", [{ dayOfWeek: 3, startTime: "20:00", endTime: "17:00", active: true }], none).kind, "none");

console.log("\nsplit and touching slots");
const split: WeeklySlot[] = [
  { dayOfWeek: 3, startTime: "17:00", endTime: "19:00", active: true },
  { dayOfWeek: 3, startTime: "19:00", endTime: "21:00", active: true },
];
eq("touching slots merge", mergeWindows([{ start: 1020, end: 1140 }, { start: 1140, end: 1260 }]), [{ start: 1020, end: 1260 }]);
eq("overlapping slots merge", mergeWindows([{ start: 600, end: 720 }, { start: 660, end: 780 }, { start: 900, end: 960 }]), [{ start: 600, end: 780 }, { start: 900, end: 960 }]);
eq("class spanning two touching slots fits", fitFor({ date: "2026-09-23", startTime: "18:30", endTime: "19:30" }, split, none), "fits");
const gap: WeeklySlot[] = [
  { dayOfWeek: 3, startTime: "09:00", endTime: "12:00", active: true },
  { dayOfWeek: 3, startTime: "13:00", endTime: "17:00", active: true },
];
eq("class spanning a gap between slots → outside", fitFor({ date: "2026-09-23", startTime: "11:30", endTime: "13:30" }, gap, none), "outside");

console.log("\ndate exceptions");
const off: DateException[] = [{ date: "2026-09-21T00:00:00.000Z", type: "UNAVAILABLE", note: "Family event" }];
eq("UNAVAILABLE blocks a normally available day", fitFor({ date: "2026-09-21", startTime: "18:30", endTime: "20:30" }, sal, off), "outside");
eq("UNAVAILABLE band is time off with its note", availabilityForDate("2026-09-21", sal, off), { date: "2026-09-21", kind: "time_off", windows: [], note: "Family event" });
eq("UNAVAILABLE on another date doesn't matter", fitFor({ date: "2026-09-22", startTime: "18:30", endTime: "20:30" }, sal, off), "fits");
const partialLate: DateException[] = [{ date: "2026-09-21", type: "PARTIAL", startTime: "19:00", endTime: "22:00" }];
eq("PARTIAL replaces the day's hours (class now starts too early)", fitFor({ date: "2026-09-21", startTime: "18:30", endTime: "20:30" }, sal, partialLate), "outside");
eq("PARTIAL band is 'modified'", availabilityForDate("2026-09-21", sal, partialLate).kind, "modified");
const partialThu: DateException[] = [{ date: "2026-09-24", type: "PARTIAL", startTime: "18:00", endTime: "21:00" }];
eq("PARTIAL adds hours on a day with no weekly hours", fitFor({ date: "2026-09-24", startTime: "18:30", endTime: "20:30" }, sal, partialThu), "fits");
eq("PARTIAL with no times = no hours that day", fitFor({ date: "2026-09-21", startTime: "18:30", endTime: "20:30" }, sal, [{ date: "2026-09-21", type: "PARTIAL", startTime: null, endTime: null }]), "outside");
eq("UNAVAILABLE wins over PARTIAL on the same date", availabilityForDate("2026-09-21", sal, [...partialLate, ...off]).kind, "time_off");
eq("two PARTIALs on one date combine", fitFor({ date: "2026-09-24", startTime: "10:30", endTime: "11:30" }, sal, [
  { date: "2026-09-24", type: "PARTIAL", startTime: "10:00", endTime: "11:00" },
  { date: "2026-09-24", type: "PARTIAL", startTime: "11:00", endTime: "12:00" },
]), "fits");

console.log("\nodd assignment times");
eq("unreadable start never fits", fitsWindows("", "20:00", [{ start: 0, end: 1440 }]), false);
eq("missing end judged by start", fitsWindows("18:00", "", [{ start: 1020, end: 1260 }]), true);
eq("start exactly at the end of hours → outside", fitsWindows("21:00", "", [{ start: 1050, end: 1260 }]), false);
eq("runs past midnight → needs hours to midnight", fitsWindows("22:00", "01:00", [{ start: 1200, end: 1380 }]), false);
eq("runs past midnight fits a window to 24:00", fitsWindows("22:00", "01:00", [{ start: 1200, end: 1440 }]), true);

console.log("\na whole week");
const week = weekDates("2026-09-20");
const r = scheduleFit(week, sal, [{ date: "2026-09-26", type: "UNAVAILABLE", note: null }], [
  { date: "2026-09-20", startTime: "11:00", endTime: "13:00", name: "Sunday Funday" },
  { date: "2026-09-21", startTime: "18:30", endTime: "20:30", name: "MS/HS" },
  { date: "2026-09-22", startTime: "18:30", endTime: "20:30", name: "MS/HS" },
  { date: "2026-09-24", startTime: "18:30", endTime: "20:30", name: "MS/HS" },
]);
eq("one outside this week (Thu)", r.outside, 1);
eq("fits in order", r.results.map((x) => x.fit), ["fits", "fits", "fits", "outside"]);
eq("keeps the caller's extra fields", r.results[3].assignment.name, "MS/HS");
eq("day kinds Sun..Sat", r.days.map((d) => d.kind), ["available", "available", "available", "none", "none", "none", "time_off"]);
eq("empty week → nothing outside", scheduleFit(week, [], [], []).outside, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
