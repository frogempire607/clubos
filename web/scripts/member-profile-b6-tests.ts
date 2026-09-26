/**
 * B6 — member profile Overview helpers. No database.
 *
 *   npm run test:member-profile-b6
 */
import {
  accountHolderRoles,
  appendAttributedNote,
  attendanceFigures,
  attendanceWindows,
  deriveFactGrid,
  invitationActivityText,
  mergeRecentActivity,
  migrationStepEvidence,
  noteStamp,
  parseAttributedNotes,
  pnlMonthHref,
  relativeDay,
  staffShortName,
  subscriptionActivityText,
  transactionActivityText,
  type ActivityItem,
} from "../lib/memberProfileFacts";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// Local-time fixture so month boundaries don't depend on the runner's TZ.
const NOW = new Date(2026, 8, 26, 15, 0, 0); // Sep 26 2026, 3pm local
const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo, d, h).toISOString();

console.log("\nmergeRecentActivity");
const item = (id: string, iso: string, kind: ActivityItem["kind"] = "payment"): ActivityItem => ({ id, kind, text: id, at: iso, tone: "ok" });
{
  const merged = mergeRecentActivity([
    [item("txn:1", at(2026, 8, 20)), item("txn:2", at(2026, 8, 10))],
    [item("att:1", at(2026, 8, 25), "attendance"), item("att:2", at(2026, 8, 1), "attendance")],
    [item("doc:1", at(2026, 8, 22), "document")],
  ]);
  eq("newest first across sources", merged.map((x) => x.id), ["att:1", "doc:1", "txn:1", "txn:2", "att:2"]);
  const many = Array.from({ length: 5 }, (_, i) => item(`a:${i}`, at(2026, 8, 1 + i)));
  const many2 = Array.from({ length: 5 }, (_, i) => item(`b:${i}`, at(2026, 7, 1 + i)));
  eq("bounded to 8 by default", mergeRecentActivity([many, many2]).length, 8);
  eq("custom limit", mergeRecentActivity([many], 2).map((x) => x.id), ["a:4", "a:3"]);
  eq("de-dupes by id", mergeRecentActivity([[item("x", at(2026, 8, 1))], [item("x", at(2026, 8, 2))]]).length, 1);
  eq("drops unparseable dates", mergeRecentActivity([[item("bad", "not a date"), item("ok", at(2026, 8, 1))]]).map((x) => x.id), ["ok"]);
  const same = at(2026, 8, 3);
  eq("stable tie-break by id", mergeRecentActivity([[item("z", same), item("a", same)]]).map((x) => x.id), ["a", "z"]);
  eq("empty input", mergeRecentActivity([]), []);
}

console.log("\nactivity wording");
eq("paid", transactionActivityText({ status: "SUCCEEDED", amount: "110", description: "September dues" }), { text: "Paid $110.00 · September dues", tone: "ok" });
eq("pending is owed", transactionActivityText({ status: "PENDING", amount: 50 }).tone, "warn");
eq("failed", transactionActivityText({ status: "FAILED", amount: 50 }), { text: "Payment failed · $50.00", tone: "danger" });
eq("refund type", transactionActivityText({ status: "SUCCEEDED", type: "REFUND", amount: -20 }).text, "Refunded $20.00");
eq("plan change", subscriptionActivityText({ kind: "PLAN_CHANGED", fromPlan: "Monthly", toPlan: "3 Months" }).text, "Plan changed · Monthly → 3 Months");
eq("canceled is danger", subscriptionActivityText({ kind: "CANCELED", fromPlan: "Monthly" }), { text: "Membership canceled · Monthly", tone: "danger" });
eq("bounce", invitationActivityText({ sentToEmail: "a@b.co", recipientKind: "GUARDIAN", bouncedAt: new Date() }), { text: "Invitation bounced · a@b.co (guardian)", tone: "danger" });

console.log("\nrelativeDay");
eq("today", relativeDay(at(2026, 8, 26, 9), NOW), "Today");
eq("yesterday", relativeDay(at(2026, 8, 25, 23), NOW), "Yesterday");
eq("days", relativeDay(at(2026, 8, 22), NOW), "4 days ago");
eq("weeks", relativeDay(at(2026, 8, 5), NOW), "3 wk ago");
eq("same-year date", relativeDay(at(2026, 5, 1), NOW), "Jun 1");
eq("other-year date", relativeDay(at(2025, 5, 1), NOW), "Jun 1, 2025");
eq("null", relativeDay(null, NOW), "—");

console.log("\nattendance figures");
{
  const w = attendanceWindows(NOW);
  eq("month start", w.monthStart.getDate() === 1 && w.monthStart.getMonth() === 8, true);
  eq("30 days back", Math.round((NOW.getTime() - w.since30.getTime()) / 86_400_000), 30);
  const f = attendanceFigures(
    [
      { status: "PRESENT", at: at(2026, 8, 24) }, // this month, last 30
      { status: "LATE", at: at(2026, 8, 2) }, // this month, last 30
      { status: "ABSENT", at: at(2026, 8, 20) }, // never counts
      { status: "PRESENT", at: at(2026, 7, 30) }, // last 30, not this month
      { status: "TRIAL", at: at(2026, 5, 1) }, // all time only
      { status: "PRESENT", at: at(2026, 9, 5) }, // future — ignored
    ],
    NOW,
  );
  eq("this month / last 30 / all time", [f.thisMonth, f.last30, f.allTime], [2, 3, 4]);
  eq("last attended ignores absences and the future", f.lastAttendedAt, at(2026, 8, 24));
  eq("no rows", attendanceFigures([], NOW), { thisMonth: 0, last30: 0, allTime: 0, lastAttendedAt: null });
}

console.log("\nphone fact grid");
{
  const meter = { applicable: true, step: 3, total: 7 };
  const g = deriveFactGrid({ balanceOwed: 55, requiredDocs: 2, missingDocs: 1, lastAttendedAt: at(2026, 8, 25), migrationStatus: "INVITED", meter }, NOW);
  eq("labels in order", g.map((x) => x.label), ["Balance", "Waiver", "Last seen", "Migration"]);
  eq("values", g.map((x) => x.value), ["$55.00 owed", "1 missing", "Yesterday", "Step 3 of 7"]);
  eq("tones", g.map((x) => x.tone), ["danger", "danger", "muted", "warn"]);
  const clean = deriveFactGrid({ balanceOwed: null, requiredDocs: 1, missingDocs: 0, lastAttendedAt: null, migrationStatus: null }, NOW);
  eq("clean member", clean.map((x) => x.value), ["Nothing owed", "Signed", "Never", "Not imported"]);
  eq("no required docs", deriveFactGrid({ balanceOwed: 0, requiredDocs: 0, missingDocs: 0, lastAttendedAt: null, migrationStatus: null }, NOW)[1].value, "None required");
  eq("completed migration", deriveFactGrid({ balanceOwed: 0, requiredDocs: 0, missingDocs: 0, lastAttendedAt: null, migrationStatus: "COMPLETED", meter: { applicable: true, step: 7, total: 7 } }, NOW)[3].value, "Complete");
  eq("no meter falls back to status", deriveFactGrid({ balanceOwed: 0, requiredDocs: 0, missingDocs: 0, lastAttendedAt: null, migrationStatus: "PENDING_REVIEW" }, NOW)[3].value, "Pending review");
}

console.log("\nstaff notes attribution");
{
  eq("short name", staffShortName("Julian Ramirez"), "Julian R");
  eq("three names", staffShortName("Ana de Souza"), "Ana S");
  eq("one name", staffShortName("Ben"), "Ben");
  eq("no name", staffShortName(null), "Staff");
  eq("stamp", noteStamp("Julian Ramirez", NOW), "— Julian R, Sep 26, 2026");
  const one = appendAttributedNote(null, "  Bring spare headgear  ", "Julian Ramirez", NOW);
  eq("first note", one, "Bring spare headgear\n— Julian R, Sep 26, 2026");
  const legacy = "Old note typed in the member modal";
  const two = appendAttributedNote(legacy, "Prefers texts", "Coach Ben", new Date(2026, 8, 27));
  eq("prepends newest", two.startsWith("Prefers texts\n— Coach B, Sep 27, 2026\n\n"), true);
  eq("blank append is a no-op", appendAttributedNote(legacy, "   ", "X", NOW), legacy);
  const parsed = parseAttributedNotes(appendAttributedNote(two, "Line 1\n\nLine 2", "Julian Ramirez", new Date(2026, 9, 1)));
  eq("parse entries", parsed, [
    { text: "Line 1\n\nLine 2", by: "Julian R", on: "Oct 1, 2026" },
    { text: "Prefers texts", by: "Coach B", on: "Sep 27, 2026" },
    { text: legacy, by: null, on: null },
  ]);
  eq("parse empty", parseAttributedNotes("  "), []);
  eq("unstamped only", parseAttributedNotes("hello"), [{ text: "hello", by: null, on: null }]);
  eq("parse is repeatable (regex state reset)", parseAttributedNotes(one).length + parseAttributedNotes(one).length, 2);
}

console.log("\nP&L month link");
eq("month range", pnlMonthHref(new Date(2026, 1, 14)), "/dashboard/reports?tab=pnl&range=custom&from=2026-02-01&to=2026-02-28");
eq("december", pnlMonthHref(new Date(2026, 11, 31, 20)), "/dashboard/reports?tab=pnl&range=custom&from=2026-12-01&to=2026-12-31");
eq("bad date", pnlMonthHref("nope"), null);

console.log("\nmigration step evidence");
{
  const events = [
    { type: "IMPORTED", message: null, createdAt: at(2026, 7, 1), actor: "Julian Ramirez" },
    { type: "ACTIVATION_SENT", message: null, createdAt: at(2026, 7, 5), actor: "Sal" },
    { type: "REMINDER_SENT", message: null, createdAt: at(2026, 7, 12), actor: null },
    { type: "NOTE", message: "Information reviewed by Sal", createdAt: at(2026, 7, 3), actor: "Sal" },
    { type: "NOTE", message: "Set aside for 7 days by Sal", createdAt: at(2026, 7, 4), actor: "Sal" },
  ];
  eq("step 1", migrationStepEvidence(events, 1), { at: at(2026, 7, 1), actor: "Julian Ramirez" });
  eq("step 2 from review note", migrationStepEvidence(events, 2), { at: at(2026, 7, 3), actor: "Sal" });
  eq("step 3 latest send", migrationStepEvidence(events, 3), { at: at(2026, 7, 12), actor: null });
  eq("step 4 has none", migrationStepEvidence(events, 4), null);
}

console.log("\naccount holder roles");
eq("all three", accountHolderRoles({ canPay: true, canBook: true, canSignWaivers: true }), ["Pays", "Books", "Signs"]);
eq("pays only", accountHolderRoles({ canPay: true, canBook: false, canSignWaivers: false }), ["Pays"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
