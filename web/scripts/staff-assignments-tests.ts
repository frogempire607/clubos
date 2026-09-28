// Coach assignments are one connected system — lib/staffAssignments.ts.
// npm run build runs this (scripts/run-build-tests.mjs GATED). Pure: no DB.
import {
  asDayOverrides,
  classOccurrencesInRange,
  classStaffScopes,
  classTimesForDay,
  daysBetween,
  effectiveClassStaff,
  eventDaysInRange,
  eventOverlaps,
  isScheduleStaffRole,
  nextDayStaff,
  rangeWindow,
  removedIds,
  staffNames,
  type ClassSeriesInput,
  type ClassSessionInput,
} from "../lib/staffAssignments";
import { to12h, range12h } from "../lib/time12";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

console.log("effective staff for a class occurrence");
eq("override null → series", effectiveClassStaff(["julian", "sal"], null), { staffIds: ["julian", "sal"], isSubstitute: false });
eq("override undefined → series", effectiveClassStaff(["julian"], undefined), { staffIds: ["julian"], isSubstitute: false });
eq("override [] → explicitly nobody", effectiveClassStaff(["julian"], []), { staffIds: [], isSubstitute: true });
eq("override list → exactly that list", effectiveClassStaff(["julian"], ["sal"]), { staffIds: ["sal"], isSubstitute: true });
eq("junk series → []", effectiveClassStaff("nope", null), { staffIds: [], isSubstitute: false });
eq("non-string ids dropped", effectiveClassStaff([1, "a", null, ""], null).staffIds, ["a"]);
eq("names in order, unknown skipped", staffNames(["b", "x", "a"], new Map([["a", "Ann"], ["b", "Bo"]])), ["Bo", "Ann"]);

console.log("owners coach too");
eq("OWNER schedulable", isScheduleStaffRole("OWNER"), true);
eq("STAFF schedulable", isScheduleStaffRole("STAFF"), true);
eq("MEMBER not", isScheduleStaffRole("MEMBER"), false);

console.log("dayOverrides — per-weekday class times");
const overrides = [{ dayOfWeek: 3, startTime: "18:30", endTime: "20:00" }, { dayOfWeek: 9, startTime: "01:00", endTime: "02:00" }, { dayOfWeek: 4, startTime: "7pm", endTime: "8pm" }];
eq("junk overrides filtered", asDayOverrides(overrides), [{ dayOfWeek: 3, startTime: "18:30", endTime: "20:00" }]);
eq("Wed uses its override", classTimesForDay("17:00", "18:30", overrides, 3), { startTime: "18:30", endTime: "20:00" });
eq("Mon uses the default", classTimesForDay("17:00", "18:30", overrides, 1), { startTime: "17:00", endTime: "18:30" });
eq("no overrides → default", classTimesForDay("17:00", "18:30", null, 3), { startTime: "17:00", endTime: "18:30" });

// Mon + Wed class, Wed runs late. Week of Sun Sep 27 2026.
const cls: ClassSeriesInput = {
  id: "c1",
  name: "Evening",
  daysOfWeek: [1, 3],
  startTime: "17:00",
  endTime: "18:30",
  dayOverrides: [{ dayOfWeek: 3, startTime: "18:30", endTime: "20:00" }],
  assignedStaffIds: ["julian"],
  recurrenceStartDate: new Date("2026-01-01T00:00:00Z"),
  recurrenceEndDate: null,
};
const occ = classOccurrencesInRange(cls, [], "2026-09-27", "2026-10-03");
eq("two occurrences in the week", occ.map((o) => o.date), ["2026-09-28", "2026-09-30"]);
eq("Mon at the default time", [occ[0].startTime, occ[0].endTime], ["17:00", "18:30"]);
eq("Wed at its override time (was wrong before)", [occ[1].startTime, occ[1].endTime], ["18:30", "20:00"]);
eq("unmaterialized day staffed by the series", occ[0].staffIds, ["julian"]);

const sess = (date: string, over: unknown, extra: Partial<ClassSessionInput> = {}): ClassSessionInput => ({
  id: `s-${date}`,
  classId: "c1",
  date: new Date(`${date}T00:00:00Z`),
  startsAt: new Date(`${date}T17:15:00Z`),
  endsAt: new Date(`${date}T18:45:00Z`),
  canceled: false,
  staffOverride: over,
  note: null,
  ...extra,
});
const withRows = classOccurrencesInRange(cls, [sess("2026-09-28", ["sal"]), sess("2026-09-30", null)], "2026-09-27", "2026-10-03");
eq("session row time wins (wall clock read in UTC)", [withRows[0].startTime, withRows[0].endTime], ["17:15", "18:45"]);
eq("substitute on Mon", [withRows[0].staffIds, withRows[0].isSubstitute, withRows[0].seriesStaffIds], [["sal"], true, ["julian"]]);
eq("Wed row inherits series", [withRows[1].staffIds, withRows[1].isSubstitute], [["julian"], false]);
const cleared = classOccurrencesInRange(cls, [sess("2026-09-28", [])], "2026-09-28", "2026-09-28");
eq("[] override → nobody on that day", cleared[0].staffIds, []);
const canceled = classOccurrencesInRange(cls, [sess("2026-09-28", null, { canceled: true, note: "Snow" })], "2026-09-28", "2026-09-28");
eq("canceled row carried with its note", [canceled[0].canceled, canceled[0].note], [true, "Snow"]);
const orphan = classOccurrencesInRange(cls, [sess("2026-09-29", null)], "2026-09-29", "2026-09-29");
eq("a kept row on a non-series day still shows", orphan.map((o) => o.date), ["2026-09-29"]);
const ended = classOccurrencesInRange({ ...cls, recurrenceEndDate: new Date("2026-09-29T00:00:00Z") }, [], "2026-09-27", "2026-10-03");
eq("respects recurrence end", ended.map((o) => o.date), ["2026-09-28"]);
const notYet = classOccurrencesInRange({ ...cls, recurrenceStartDate: new Date("2026-09-30T00:00:00Z") }, [], "2026-09-27", "2026-10-03");
eq("respects recurrence start", notYet.map((o) => o.date), ["2026-09-30"]);
eq("other class's rows ignored", classOccurrencesInRange(cls, [{ ...sess("2026-09-28", ["x"]), classId: "c2" }], "2026-09-28", "2026-09-28")[0].staffIds, ["julian"]);

// Server TZ must not matter: the loop is UTC.
const prevTZ = process.env.TZ;
process.env.TZ = "America/New_York";
eq("same days under a US server timezone", classOccurrencesInRange(cls, [], "2026-09-27", "2026-10-03").map((o) => o.date), ["2026-09-28", "2026-09-30"]);
process.env.TZ = "Asia/Tokyo";
eq("same days under an east-of-UTC server timezone", classOccurrencesInRange(cls, [], "2026-09-27", "2026-10-03").map((o) => o.date), ["2026-09-28", "2026-09-30"]);
process.env.TZ = prevTZ;

eq("daysBetween inclusive", daysBetween("2026-09-27", "2026-09-29"), ["2026-09-27", "2026-09-28", "2026-09-29"]);

console.log("events in a week — overlap, not start date");
const wFrom = new Date("2026-09-27T00:00:00Z");
const wTo = new Date("2026-10-03T23:59:59Z");
const ev = (a: string, b: string) => eventOverlaps(new Date(a), new Date(b), wFrom, wTo);
eq("starts before the week, ends in it", ev("2026-09-25T14:00:00Z", "2026-09-28T20:00:00Z"), true);
eq("starts in the week, ends after it", ev("2026-10-02T14:00:00Z", "2026-10-05T20:00:00Z"), true);
eq("spans the whole week", ev("2026-09-20T14:00:00Z", "2026-10-10T20:00:00Z"), true);
eq("inside the week", ev("2026-09-29T14:00:00Z", "2026-09-29T16:00:00Z"), true);
eq("ends before the week", ev("2026-09-20T14:00:00Z", "2026-09-26T20:00:00Z"), false);
eq("starts after the week", ev("2026-10-04T14:00:00Z", "2026-10-05T20:00:00Z"), false);
eq("end before start treated as a point", eventOverlaps(new Date("2026-09-29T14:00:00Z"), new Date("2026-09-28T14:00:00Z"), wFrom, wTo), true);
const win = rangeWindow("2026-09-27", "2026-10-03");
eq("query window padded 14h each side", [win.from.toISOString(), win.to.toISOString()], ["2026-09-26T10:00:00.000Z", "2026-10-04T13:59:59.999Z"]);

const utcYmd = (d: Date) => d.toISOString().slice(0, 10);
const week = daysBetween("2026-09-27", "2026-10-03");
const camp = { startsAt: "2026-09-25T13:00:00Z", endsAt: "2026-09-29T21:00:00Z" };
eq("multi-day camp shows on each day it touches in the week", eventDaysInRange(camp, week, utcYmd).map((p) => p.date), ["2026-09-27", "2026-09-28", "2026-09-29"]);
const withSessions = { ...camp, sessions: [{ startsAt: "2026-09-28T13:00:00Z", endsAt: "2026-09-28T17:00:00Z" }, { startsAt: "2026-09-30T13:00:00Z", endsAt: "2026-09-30T17:00:00Z" }] };
eq("event with sessions → one entry per session day", eventDaysInRange(withSessions, week, utcYmd).map((p) => p.date), ["2026-09-28", "2026-09-30"]);
eq("filtered to the asked days", eventDaysInRange(camp, ["2026-09-28"], utcYmd).map((p) => p.date), ["2026-09-28"]);
eq("outside → none", eventDaysInRange(camp, ["2026-10-01"], utcYmd), []);

console.log("write helpers");
eq("removedIds", removedIds(["a", "b", "c"], ["b"]), ["a", "c"]);
eq("removedIds none", removedIds(["a"], ["a", "b"]), []);
eq("nextDayStaff add", nextDayStaff(["a"], "b", "add"), ["a", "b"]);
eq("nextDayStaff add existing is a no-op", nextDayStaff(["a", "b"], "b", "add"), ["a", "b"]);
eq("nextDayStaff remove", nextDayStaff(["a", "b"], "a", "remove"), ["b"]);
eq("nextDayStaff remove last → [] (explicitly nobody)", nextDayStaff(["a"], "a", "remove"), []);
eq("scopes: both perms, remove a series coach", classStaffScopes({ op: "remove", userId: "a", seriesStaffIds: ["a"], canEditDay: true, canEditSeries: true }), ["day", "series"]);
eq("scopes: remove a day-only substitute → just this day", classStaffScopes({ op: "remove", userId: "s", seriesStaffIds: ["a"], canEditDay: true, canEditSeries: true }), ["day"]);
eq("scopes: add someone already weekly → just this day", classStaffScopes({ op: "add", userId: "a", seriesStaffIds: ["a"], canEditDay: true, canEditSeries: true }), ["day"]);
eq("scopes: classes:edit only", classStaffScopes({ op: "add", userId: "b", seriesStaffIds: ["a"], canEditDay: false, canEditSeries: true }), ["series"]);
eq("scopes: no perms → none", classStaffScopes({ op: "add", userId: "b", seriesStaffIds: [], canEditDay: false, canEditSeries: false }), []);

console.log("12-hour display");
eq("to12h evening", to12h("18:30"), "6:30 PM");
eq("to12h midnight", to12h("00:00"), "12:00 AM");
eq("range12h same meridiem", range12h("18:30", "20:00"), "6:30 – 8:00 PM");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
