/**
 * Class coach scheduling — the WORDS the screens show (lib/classStaffUi.ts).
 *
 *   npx tsx scripts/class-staff-ui-tests.ts
 *
 * Pure: no React, no fetch, no database. Pins the state labels (Needs coverage,
 * Late call-out, Covered by, No-show, Canceled paid / unpaid), the three scope
 * choices with the real day in the label, what the coach editor starts from for
 * each scope, the cancellation audience choices with family counts, the cancel
 * audit line, the "who is told" sentence, the switch-on preview lines, the
 * "Needs coverage" strip ordering (late first) and the series summary.
 */
import { LATE_CALLOUT_MS } from "../lib/classStaff";
import {
  AUDIENCE_LABEL,
  AUDIENCE_ORDER,
  OTHER_ROLE,
  ROLE_CHOICES,
  audienceOptions,
  cancelAuditParts,
  cancelConfirmLabel,
  chipState,
  classDayState,
  coverageNotifySentence,
  coverageNotifyWho,
  currentStaffSummary,
  families,
  fmtInstant,
  fmtWeekdayMonthDay,
  fmtYmdFull,
  isLateNow,
  joinAnd,
  nextClassDay,
  openCoverage,
  roleChoiceOf,
  rowState,
  scopeOptions,
  seedForScope,
  switchOnLine,
  switchOnSentence,
  switchStatusText,
} from "../lib/classStaffUi";

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

console.log("\nCLASS STAFF UI — the words on the screens\n");

// ── Small helpers ───────────────────────────────────────────────────────────
section("1. Dates, lists and counts");
eq("joinAnd: nothing", joinAnd([]), "");
eq("joinAnd: one", joinAnd(["Sal"]), "Sal");
eq("joinAnd: two", joinAnd(["Sal", "Adrian"]), "Sal and Adrian");
eq("joinAnd: three", joinAnd(["Sal", "Adrian", "Matt"]), "Sal, Adrian and Matt");
eq("families: 1", families(1), "1 family");
eq("families: 0 and 9", [families(0), families(9)], ["0 families", "9 families"]);
eq("fmtYmdFull", fmtYmdFull("2026-10-08"), "Oct 8, 2026");
eq("fmtYmdFull ignores a time part", fmtYmdFull("2026-10-08T23:59:00.000Z"), "Oct 8, 2026");
eq("fmtWeekdayMonthDay", fmtWeekdayMonthDay("2026-10-20"), "Tuesday, Oct 20");
eq("fmtInstant in the club's timezone", fmtInstant("2026-10-12T19:04:00.000Z", "America/New_York"), "Oct 12, 3:04 PM");
eq("fmtInstant: another zone, same instant", fmtInstant("2026-10-12T19:04:00.000Z", "America/Los_Angeles"), "Oct 12, 12:04 PM");

// ── Switch-on ───────────────────────────────────────────────────────────────
section("2. Switch-on (Settings → Scheduling)");
eq("status: off", switchStatusText(null), "New coach scheduling: Off");
eq("status: off (undefined)", switchStatusText(undefined), "New coach scheduling: Off");
eq("status: on since the date", switchStatusText("2026-10-13"), "New coach scheduling: On since Oct 13, 2026");
eq("a class with coaches", switchOnLine({ name: "Jr Frogs", state: "new", coaches: ["Sal Jones", "Josh Antoine"], upcomingDays: 104 }),
  "Jr Frogs — Sal Jones, Josh Antoine every class day · 104 upcoming class days");
eq("one upcoming day is singular", switchOnLine({ name: "Jr Frogs", state: "new", coaches: ["Sal Jones"], upcomingDays: 1 }),
  "Jr Frogs — Sal Jones every class day · 1 upcoming class day");
eq("a class with nobody", switchOnLine({ name: "Open Mat", state: "new", coaches: [], upcomingDays: 12 }), "Open Mat — no coaches yet · 12 upcoming class days");
eq("one-day changes and former staff are mentioned", switchOnLine({ name: "Evening", state: "new", coaches: ["Sal"], upcomingDays: 30, manualDays: 2, droppedCount: 1 }),
  "Evening — Sal every class day · 30 upcoming class days · 2 days keep a one-day coach change · 1 former staff member is left off");
eq("…singular / plural the other way", switchOnLine({ name: "Evening", state: "new", coaches: ["Sal"], upcomingDays: 30, manualDays: 1, droppedCount: 2 }),
  "Evening — Sal every class day · 30 upcoming class days · 1 day keeps a one-day coach change · 2 former staff members are left off");
eq("a class already switched on is left alone", switchOnLine({ name: "Evening", state: "already", coaches: ["Sal"], upcomingDays: 30 }),
  "Evening — already on the new scheduling, left as it is");
eq("the promise about the past", switchOnSentence("2026-10-13"), "Past class days are not changed. From Oct 13, 2026 on, coach changes are tracked per class day.");

// ── Roles ───────────────────────────────────────────────────────────────────
section("3. Roles");
eq("the dropdown: no role, the four standard names, Other…", ROLE_CHOICES.map((r) => r.label),
  ["Coach (no specific role)", "Lead Coach", "Assistant Coach", "Substitute", "Volunteer", "Other…"]);
eq("…standard names are stored as their label", ROLE_CHOICES.slice(1, 5).map((r) => r.value), ["Lead Coach", "Assistant Coach", "Substitute", "Volunteer"]);
eq("no role → the blank choice", [roleChoiceOf(null), roleChoiceOf(undefined), roleChoiceOf(""), roleChoiceOf("   ")], ["", "", "", ""]);
eq("a standard role → itself", roleChoiceOf("Lead Coach"), "Lead Coach");
eq("…trimmed", roleChoiceOf("  Volunteer "), "Volunteer");
eq("a free-text role → Other…", roleChoiceOf("Strength Coach"), OTHER_ROLE);
eq("standard names are case-sensitive (a different spelling is free text)", roleChoiceOf("lead coach"), OTHER_ROLE);

// ── Scopes ──────────────────────────────────────────────────────────────────
section("4. The three scopes — the real day is in the label");
{
  const o = scopeOptions("2026-10-20"); // a Tuesday
  eq("values, in order", o.map((x) => x.value), ["OCCURRENCE", "WEEKDAY_FORWARD", "ALL_FUTURE"]);
  eq("labels", o.map((x) => x.label), ["Only Tuesday, Oct 20", "Tuesdays from Oct 20 on", "Every class day from Oct 20 on"]);
  eq("hints", o.map((x) => x.hint), [
    "This one class day. The weekly coaches stay as they are.",
    "Every Tuesday this class runs, starting Oct 20. Other weekdays are not changed.",
    "Every day this class runs, starting Oct 20.",
  ]);
  eq("a Thursday", scopeOptions("2026-10-22").map((x) => x.label), ["Only Thursday, Oct 22", "Thursdays from Oct 22 on", "Every class day from Oct 22 on"]);
  eq("a Sunday in another month / year", scopeOptions("2027-01-03").map((x) => x.label), ["Only Sunday, Jan 3", "Sundays from Jan 3 on", "Every class day from Jan 3 on"]);
  eq("a Saturday", scopeOptions("2026-10-24")[1].label, "Saturdays from Oct 24 on");
}

section("5. What the coach editor starts from");
{
  const rule = (id: string, userId: string, roleName: string | null, dayOfWeek: number | null, effectiveFrom = "2026-10-12", effectiveTo: string | null = null) =>
    ({ id, userId, roleName, dayOfWeek, effectiveFrom, effectiveTo });
  const rules = [
    rule("r1", "julian", "Lead Coach", null),
    rule("r2", "sal", null, 1),           // Mondays
    rule("r3", "sal", null, 4),           // Thursdays
    rule("r4", "adrian", "Assistant Coach", 2), // Tuesdays
    rule("r5", "old", null, null, "2026-10-12", "2026-10-15"), // ended
  ];
  const dayRows = [
    { userId: "julian", roleName: "Lead Coach", status: "SCHEDULED" as const },
    { userId: "adrian", roleName: "Assistant Coach", status: "NEEDS_COVERAGE" as const },
    { userId: "matt", roleName: "Substitute", status: "SCHEDULED" as const },
    { userId: "gone", roleName: null, status: "REMOVED" as const },
    { userId: "rep", roleName: null, status: "REPLACED" as const },
  ];
  const base = { date: "2026-10-20", classDays: [1, 2, 4], rules, dayRows };
  eq("this day only → the coaches SCHEDULED on that day (called-out / replaced / removed are not ticked)",
    seedForScope({ ...base, scope: "OCCURRENCE" }), [{ userId: "julian", roleName: "Lead Coach" }, { userId: "matt", roleName: "Substitute" }]);
  eq("this weekday → the weekly plan for Tuesdays (not the one-day substitute)",
    seedForScope({ ...base, scope: "WEEKDAY_FORWARD" }).map((p) => p.userId).sort(), ["adrian", "julian"]);
  eq("…with their roles", seedForScope({ ...base, scope: "WEEKDAY_FORWARD" }).find((p) => p.userId === "adrian")?.roleName, "Assistant Coach");
  eq("every class day → only the coaches on EVERY weekday the class runs",
    seedForScope({ ...base, scope: "ALL_FUTURE" }), [{ userId: "julian", roleName: "Lead Coach" }]);
  eq("an ended rule is not offered", seedForScope({ ...base, scope: "ALL_FUTURE" }).some((p) => p.userId === "old"), false);
  eq("…but still counts on a day before it ended", seedForScope({ ...base, date: "2026-10-13", scope: "WEEKDAY_FORWARD" }).map((p) => p.userId).sort(), ["adrian", "julian", "old"]);
  eq("a coach on every weekday through separate weekday rules counts as every class day",
    seedForScope({ scope: "ALL_FUTURE", date: "2026-10-20", classDays: [1, 4], rules: [rule("a", "sal", null, 1), rule("b", "sal", null, 4)], dayRows: [] }).map((p) => p.userId), ["sal"]);
  eq("no weekdays on the class: falls back to the day itself",
    seedForScope({ scope: "ALL_FUTURE", date: "2026-10-20", classDays: [], rules, dayRows: [] }).map((p) => p.userId).sort(), ["adrian", "julian"]);
  eq("no rules, no rows → nobody", seedForScope({ scope: "ALL_FUTURE", date: "2026-10-20", classDays: [1, 2, 4], rules: [], dayRows: [] }), []);
}

section("6. The next class day");
eq("today counts when the class runs today", nextClassDay([1, 2, 4], "2026-10-13"), "2026-10-13");
eq("otherwise the next weekday it runs", nextClassDay([1, 2, 4], "2026-10-14"), "2026-10-15");
eq("across a week boundary", nextClassDay([1], "2026-10-13"), "2026-10-19");
eq("across a month boundary", nextClassDay([0], "2026-10-28"), "2026-11-01");
eq("no weekdays → the date given", nextClassDay([], "2026-10-13"), "2026-10-13");

// ── States ──────────────────────────────────────────────────────────────────
section("7. A class chip on one person's schedule");
{
  const rows = [
    { id: "row_sal", userId: "sal", name: "Sal Jones", replacesStaffId: null, coveredByName: "Adrian Cruz", status: "REPLACED" as const },
    { id: "row_adrian", userId: "adrian", name: "Adrian Cruz", replacesStaffId: "row_sal", coveredByName: null, status: "SCHEDULED" as const },
  ];
  eq("scheduled, no role → Coach", chipState({ canceled: false, myStatus: "SCHEDULED", myKind: "REGULAR", myRoleName: null }), { tone: "normal", label: "Coach", strike: false });
  eq("scheduled with a role", chipState({ canceled: false, myStatus: "SCHEDULED", myKind: "REGULAR", myRoleName: "Lead Coach" }).label, "Lead Coach");
  eq("a free-text role shows as typed", chipState({ canceled: false, myStatus: "SCHEDULED", myKind: "REGULAR", myRoleName: "Strength Coach" }).label, "Strength Coach");
  eq("Needs coverage", chipState({ canceled: false, myStatus: "NEEDS_COVERAGE", myLateCallout: false }), { tone: "warn", label: "Needs coverage", strike: false });
  eq("Late call-out", chipState({ canceled: false, myStatus: "NEEDS_COVERAGE", myLateCallout: true }), { tone: "late", label: "Late call-out · needs coverage", strike: false });
  eq("Covered by <name>", chipState({ canceled: false, myStatus: "REPLACED", myRowId: "row_sal", staffRows: rows }), { tone: "covered", label: "Covered by Adrian Cruz", strike: false });
  eq("Covered (the name is withheld from a coach who can't see the roster)", chipState({ canceled: false, myStatus: "REPLACED", myRowId: "row_sal", staffRows: [{ ...rows[0], coveredByName: null }] }).label, "Covered");
  eq("Covered (no rows at all)", chipState({ canceled: false, myStatus: "REPLACED" }).label, "Covered");
  eq("No-show", chipState({ canceled: false, myStatus: "NO_SHOW" }), { tone: "noshow", label: "No-show", strike: false });
  eq("the substitute: role · covering for <name>", chipState({ canceled: false, myStatus: "SCHEDULED", myKind: "SUBSTITUTE", myRoleName: "Substitute", myRowId: "row_adrian", staffRows: rows }),
    { tone: "normal", label: "Substitute · covering for Sal Jones", strike: false });
  eq("a substitute whose original row is not visible: just the role", chipState({ canceled: false, myStatus: "SCHEDULED", myKind: "SUBSTITUTE", myRoleName: "Substitute", myRowId: "row_adrian", staffRows: [rows[1]] }).label, "Substitute");
  eq("Canceled · unpaid (the default)", chipState({ canceled: true, cancel: { paid: false }, myStatus: "SCHEDULED" }), { tone: "canceled", label: "Canceled · unpaid", strike: true });
  eq("Canceled · paid", chipState({ canceled: true, cancel: { paid: true }, myStatus: "SCHEDULED" }), { tone: "canceled", label: "Canceled · paid", strike: true });
  eq("canceled with no audit → unpaid", chipState({ canceled: true }).label, "Canceled · unpaid");
  eq("canceled wins over needs coverage", chipState({ canceled: true, cancel: { paid: false }, myStatus: "NEEDS_COVERAGE", myLateCallout: true }).label, "Canceled · unpaid");
  eq("a legacy row (id null) never matches a null myRowId", chipState({ canceled: false, myStatus: "REPLACED", myRowId: null, staffRows: [{ id: null, userId: "x", name: "X", replacesStaffId: null, coveredByName: "Wrong Person", status: "REPLACED" }] }).label, "Covered");
}

section("8. A class day on the Calendar (the whole class)");
{
  const row = (status: "SCHEDULED" | "NEEDS_COVERAGE" | "REPLACED" | "NO_SHOW" | "REMOVED", lateCallout = false) => ({ status, lateCallout });
  eq("not on the new scheduling → nothing", classDayState({ switched: false, canceled: true, needsCoverage: true }), null);
  eq("nothing to flag → nothing", classDayState({ switched: true, staffRows: [row("SCHEDULED"), row("REPLACED")] }), null);
  eq("Needs coverage", classDayState({ switched: true, staffRows: [row("SCHEDULED"), row("NEEDS_COVERAGE")] }), { tone: "warn", label: "Needs coverage", strike: false });
  eq("Needs coverage from the flag alone", classDayState({ switched: true, needsCoverage: true })?.label, "Needs coverage");
  eq("Late call-out when any open call-out is late", classDayState({ switched: true, staffRows: [row("NEEDS_COVERAGE"), row("NEEDS_COVERAGE", true)] }), { tone: "late", label: "Late call-out · needs coverage", strike: false });
  eq("a late call-out that was COVERED no longer flags the day", classDayState({ switched: true, staffRows: [row("REPLACED", true), row("SCHEDULED")] }), null);
  eq("No-show", classDayState({ switched: true, staffRows: [row("NO_SHOW")] }), { tone: "noshow", label: "No-show", strike: false });
  eq("needs coverage outranks a no-show", classDayState({ switched: true, staffRows: [row("NO_SHOW"), row("NEEDS_COVERAGE")] })?.label, "Needs coverage");
  eq("Canceled · unpaid", classDayState({ switched: true, canceled: true, cancel: { paid: false }, staffRows: [row("NEEDS_COVERAGE")] }), { tone: "canceled", label: "Canceled · unpaid", strike: true });
  eq("Canceled · paid", classDayState({ switched: true, canceled: true, cancel: { paid: true } })?.label, "Canceled · paid");
}

section("9. A coach row in the class-day sheet");
{
  const r = (o: Partial<Parameters<typeof rowState>[0]>) => rowState({ status: "SCHEDULED", kind: "REGULAR", lateCallout: false, coveredByName: null, calledOutAt: null, ...o });
  eq("Scheduled", r({}), { tone: "normal", label: "Scheduled" });
  eq("Covering (a substitute)", r({ kind: "SUBSTITUTE" }), { tone: "normal", label: "Covering" });
  eq("Needs coverage", r({ status: "NEEDS_COVERAGE" }), { tone: "warn", label: "Needs coverage" });
  eq("Late call-out", r({ status: "NEEDS_COVERAGE", lateCallout: true }), { tone: "late", label: "Late call-out · needs coverage" });
  eq("Covered by <name>", r({ status: "REPLACED", coveredByName: "Adrian Cruz", lateCallout: true }), { tone: "covered", label: "Covered by Adrian Cruz" });
  eq("Covered", r({ status: "REPLACED" }), { tone: "covered", label: "Covered" });
  eq("No-show", r({ status: "NO_SHOW" }), { tone: "noshow", label: "No-show" });
  eq("taken off by a manager → not listed", r({ status: "REMOVED" }), null);
  eq("called out, no replacement needed → stays listed", r({ status: "REMOVED", calledOutAt: "2026-10-13T16:00:00.000Z" }), { tone: "covered", label: "Called out · no replacement needed" });
}

section("10. Late = inside 2 hours of the start");
{
  const start = "2026-10-13T22:30:00.000Z";
  const at = (msBefore: number) => isLateNow(start, Date.parse(start) - msBefore);
  check("the 2-hour constant", LATE_CALLOUT_MS === 2 * 60 * 60 * 1000);
  eq("3 hours before → not late", at(3 * 3600_000), false);
  eq("exactly 2 hours before → NOT late", at(LATE_CALLOUT_MS), false);
  eq("one millisecond inside → late", at(LATE_CALLOUT_MS - 1), true);
  eq("1 minute before → late", at(60_000), true);
  eq("after it started → late", at(-60_000), true);
}

// ── Cancelling ──────────────────────────────────────────────────────────────
section("11. Who is told when a class day is canceled");
{
  const counts = {
    BOOKED: { members: 3, recipients: 2, noAddress: 0 },
    CLASS_MEMBERS: { members: 12, recipients: 9, noAddress: 1 },
    BOTH: { members: 13, recipients: 10, noAddress: 2 },
    NONE: { members: 0, recipients: 0, noAddress: 0 },
  };
  eq("the order", AUDIENCE_ORDER, ["BOOKED", "CLASS_MEMBERS", "BOTH", "NONE"]);
  eq("the names", AUDIENCE_ORDER.map((a) => AUDIENCE_LABEL[a]), ["Booked members", "Everyone with access to this class", "Both", "Nobody"]);
  const o = audienceOptions(counts);
  eq("labels carry the family count (one per email address)", o.map((x) => x.label),
    ["Booked members · 2 families", "Everyone with access to this class · 9 families", "Both · 10 families", "Nobody"]);
  eq("hints; people without an email are called out", o.map((x) => x.hint), [
    "Only the people booked into this class day.",
    "Active members whose membership includes this class. 1 person has no email on file.",
    "Booked members and everyone with access — each family once. 2 people have no email on file.",
    "No email is sent. Tell people yourself.",
  ]);
  eq("one family is singular; zero is said", audienceOptions({ BOOKED: { members: 1, recipients: 1, noAddress: 0 }, CLASS_MEMBERS: { members: 0, recipients: 0, noAddress: 0 } }).slice(0, 2).map((x) => x.label),
    ["Booked members · 1 family", "Everyone with access to this class · 0 families"]);
  eq("before the counts arrive: plain names", audienceOptions(null).map((x) => x.label), ["Booked members", "Everyone with access to this class", "Both", "Nobody"]);
  eq("…same for undefined", audienceOptions(undefined).map((x) => x.value), ["BOOKED", "CLASS_MEMBERS", "BOTH", "NONE"]);
  eq("Nobody never shows a count", audienceOptions({ NONE: { members: 5, recipients: 5, noAddress: 5 } })[3].label, "Nobody");

  eq("the button says what it does", cancelConfirmLabel("BOOKED", counts), "Cancel class · email 2 families");
  eq("…for both", cancelConfirmLabel("BOTH", counts), "Cancel class · email 10 families");
  eq("…one family", cancelConfirmLabel("BOOKED", { BOOKED: { members: 1, recipients: 1, noAddress: 0 } }), "Cancel class · email 1 family");
  eq("Nobody", cancelConfirmLabel("NONE", counts), "Cancel class · nobody is emailed");
  eq("an audience with nobody in it", cancelConfirmLabel("BOOKED", { BOOKED: { members: 0, recipients: 0, noAddress: 0 } }), "Cancel class · nobody is emailed");
  eq("counts not loaded yet", cancelConfirmLabel("BOOKED", null), "Cancel class");
}

section("12. The cancel audit line");
{
  const base = { canceledAt: "2026-10-12T19:04:00.000Z", canceledByName: "Julian Ramirez", reason: "gym closed", notifyAudience: "BOOKED", notifiedCount: 14, paid: false };
  eq("who · when · reason · audience · pay", cancelAuditParts(base, "America/New_York"),
    ["Canceled by Julian Ramirez", "Oct 12, 3:04 PM", "Reason: gym closed", "Notified 14 families (booked members)", "Coaches not paid"]);
  eq("paid", cancelAuditParts({ ...base, paid: true }, "America/New_York").slice(-1), ["Coaches paid"]);
  eq("one family", cancelAuditParts({ ...base, notifiedCount: 1 }, "America/New_York")[3], "Notified 1 family (booked members)");
  eq("everyone with access", cancelAuditParts({ ...base, notifyAudience: "CLASS_MEMBERS", notifiedCount: 9 }, "America/New_York")[3], "Notified 9 families (everyone with access to this class)");
  eq("both", cancelAuditParts({ ...base, notifyAudience: "BOTH", notifiedCount: 10 }, "America/New_York")[3], "Notified 10 families (both)");
  eq("nobody", cancelAuditParts({ ...base, notifyAudience: "NONE", notifiedCount: 0 }, "America/New_York")[3], "Nobody was emailed");
  eq("count not recorded yet", cancelAuditParts({ ...base, notifiedCount: null }, "America/New_York")[3], "Told: booked members");
  eq("a legacy cancel with nothing recorded", cancelAuditParts({ canceledAt: null, canceledByName: null, reason: null, notifyAudience: null, notifiedCount: null, paid: false }), ["Canceled", "Coaches not paid"]);
  eq("an unknown audience value is skipped", cancelAuditParts({ ...base, notifyAudience: "SOMETHING" }, "America/New_York").length, 4);
}

// ── Call-outs ───────────────────────────────────────────────────────────────
section("13. Who hears about a call-out");
{
  const cfg = { owners: true, managers: true, classStaff: false, roleNames: [] as string[], people: 0 };
  eq("owners + managers", coverageNotifyWho(cfg), "The owners and the schedule managers");
  eq("the sentence", coverageNotifySentence(cfg), "The class stays on the schedule. The owners and the schedule managers will be told it needs coverage.");
  eq("everything on", coverageNotifyWho({ owners: true, managers: true, classStaff: true, roleNames: ["Lead Coach"], people: 2 }),
    "The owners, the schedule managers, the other coaches on this class, anyone assigned as Lead Coach and 2 named staff members");
  eq("owners off, one named person", coverageNotifyWho({ ...cfg, owners: false, people: 1 }), "The schedule managers and 1 named staff member");
  eq("a role only", coverageNotifyWho({ owners: false, managers: false, classStaff: false, roleNames: ["Lead Coach"], people: 0 }), "Anyone assigned as Lead Coach");
  eq("nobody configured", coverageNotifyWho({ owners: false, managers: false, classStaff: false, roleNames: [], people: 0 }), "");
  eq("…and the sentence says so", coverageNotifySentence({ owners: false, managers: false, classStaff: false, roleNames: [], people: 0 }),
    "The class stays on the schedule. Nobody is set to be told automatically — let a schedule manager know yourself.");
  eq("settings not known → the schedule managers", coverageNotifySentence(null), "The class stays on the schedule. The schedule managers will be told it needs coverage.");
}

section("14. The Needs coverage strip — late first, then the soonest class");
{
  const cls = (o: Record<string, unknown>) => ({ classId: "c1", sessionId: "s", name: "Evening Group", date: "2026-10-20", startTime: "18:30", endTime: "20:30", canceled: false, myStatus: "NEEDS_COVERAGE" as const, myLateCallout: false, myRowId: null as string | null, ...o });
  const staff = [
    { id: "sal", firstName: "Sal", lastName: "Jones", classes: [
      cls({ date: "2026-10-15", myRowId: "row_a" }),
      cls({ date: "2026-10-20", myStatus: "SCHEDULED", myRowId: "row_b" }),
      cls({ date: "2026-10-22", canceled: true, myRowId: "row_c" }),
    ] },
    { id: "adrian", firstName: "Adrian", lastName: "", classes: [
      cls({ date: "2026-10-27", myLateCallout: true, myRowId: "row_d" }),
      cls({ date: "2026-10-14", startTime: "09:00", endTime: "10:00", name: "Kids Group", classId: "c2", myRowId: "row_e" }),
      cls({ date: "2026-10-14", startTime: "07:00", endTime: "08:00", myStatus: "REPLACED", myRowId: "row_f" }),
    ] },
  ];
  const open = openCoverage(staff);
  eq("only unfilled call-outs on days that are still on", open.map((x) => x.key), ["row_d", "row_e", "row_a"]);
  eq("late first even though it is the furthest away", [open[0].late, open[0].date, open[0].coachName], [true, "2026-10-27", "Adrian"]);
  eq("then by date and time", open.slice(1).map((x) => `${x.date} ${x.startTime} ${x.className} ${x.coachName}`), ["2026-10-14 09:00 Kids Group Adrian", "2026-10-15 18:30 Evening Group Sal Jones"]);
  eq("a row with no id still gets a stable key", openCoverage([{ id: "sal", firstName: "Sal", lastName: "Jones", classes: [cls({})] }])[0].key, "c1:2026-10-20:sal");
  eq("nothing open → empty", openCoverage([{ id: "sal", firstName: "Sal", lastName: "Jones", classes: [cls({ myStatus: "SCHEDULED" })] }]), []);
  eq("two late call-outs: the sooner first", openCoverage([{ id: "sal", firstName: "Sal", lastName: "J", classes: [cls({ date: "2026-10-21", myLateCallout: true, myRowId: "x2" }), cls({ date: "2026-10-20", myLateCallout: true, myRowId: "x1" })] }]).map((x) => x.key), ["x1", "x2"]);
}

// ── Series summary ──────────────────────────────────────────────────────────
section("15. The class's coaches in one line");
eq("nobody", currentStaffSummary([]), "Nobody assigned");
eq("every class day vs one weekday", currentStaffSummary([
  { userId: "sal", name: "Sal Jones", roleName: "Lead Coach", dayOfWeek: null },
  { userId: "adrian", name: "Adrian", roleName: "Assistant Coach", dayOfWeek: 2 },
]), "Sal Jones — Lead Coach · every class day; Adrian — Assistant Coach · Tuesdays");
eq("several weekdays are joined, in week order", currentStaffSummary([
  { userId: "sal", name: "Sal Jones", roleName: null, dayOfWeek: 4 },
  { userId: "sal", name: "Sal Jones", roleName: null, dayOfWeek: 1 },
]), "Sal Jones — Coach · Mondays and Thursdays");
eq("the same weekday twice is said once", currentStaffSummary([
  { userId: "sal", name: "Sal Jones", roleName: null, dayOfWeek: 1 },
  { userId: "sal", name: "Sal Jones", roleName: null, dayOfWeek: 1 },
]), "Sal Jones — Coach · Mondays");
eq("one person with two different roles is listed per role", currentStaffSummary([
  { userId: "sal", name: "Sal", roleName: "Lead Coach", dayOfWeek: 1 },
  { userId: "sal", name: "Sal", roleName: "Volunteer", dayOfWeek: 4 },
]), "Sal — Lead Coach · Mondays; Sal — Volunteer · Thursdays");
eq("a free-text role", currentStaffSummary([{ userId: "m", name: "Matt", roleName: "Strength Coach", dayOfWeek: null }]), "Matt — Strength Coach · every class day");

console.log(`\n${failures.length ? "✗" : "✓"} ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
