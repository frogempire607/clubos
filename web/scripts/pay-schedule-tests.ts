// Staff pay schedules — pure date math + route guard checks.
// tsx scripts/pay-schedule-tests.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDays,
  dueReminders,
  describeSchedule,
  formatPayday,
  formatPeriod,
  isValidYmd,
  nextPaydays,
  paydaysInRange,
  periodFor,
  previousPayday,
  settledKey,
  statusLabel,
  type ScheduleRow,
} from "../lib/paySchedule";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

console.log("\nday arithmetic");
eq("addDays across a month end", addDays("2026-09-28", 5), "2026-10-03");
eq("addDays across a year end", addDays("2026-12-30", 3), "2027-01-02");
eq("addDays back across a leap day", addDays("2028-03-01", -1), "2028-02-29");
eq("isValidYmd rejects Feb 30", isValidYmd("2026-02-30"), false);
eq("isValidYmd accepts Feb 29 in a leap year", isValidYmd("2028-02-29"), true);
eq("isValidYmd rejects Feb 29 in a common year", isValidYmd("2027-02-29"), false);
eq("isValidYmd rejects junk", isValidYmd("10/03/2026"), false);

console.log("\nweekly");
const weekly = { frequency: "WEEKLY", anchorDate: "2026-10-02" };
eq("paydays every 7 days from the anchor", paydaysInRange(weekly, "2026-10-01", "2026-10-31"), [
  "2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30",
]);
eq("nothing before the anchor", paydaysInRange(weekly, "2026-09-01", "2026-10-02"), ["2026-10-02"]);
eq("range starting mid-cycle", paydaysInRange(weekly, "2026-10-10", "2026-10-20"), ["2026-10-16"]);
eq("period = 7 days ending on payday", periodFor(weekly, "2026-10-09"), { start: "2026-10-03", end: "2026-10-09" });
eq("first payday's period uses the rule backwards", periodFor(weekly, "2026-10-02"), { start: "2026-09-26", end: "2026-10-02" });

console.log("\nevery 2 weeks");
const biweekly = { frequency: "BIWEEKLY", anchorDate: "2026-10-03" };
eq("paydays every 14 days", paydaysInRange(biweekly, "2026-10-01", "2026-11-30"), [
  "2026-10-03", "2026-10-17", "2026-10-31", "2026-11-14", "2026-11-28",
]);
eq("period Sep 20 – Oct 3", periodFor(biweekly, "2026-10-03"), { start: "2026-09-20", end: "2026-10-03" });
eq("formatPeriod", formatPeriod("2026-09-20", "2026-10-03"), "Sep 20 – Oct 3");
eq("weekend payday is not shifted (Oct 3 2026 is a Saturday)", formatPayday("2026-10-03"), "Sat, Oct 3");
eq("next 3 paydays", nextPaydays(biweekly, "2026-10-04", 3), ["2026-10-17", "2026-10-31", "2026-11-14"]);
eq("next paydays before the anchor start at the anchor", nextPaydays(biweekly, "2026-09-28", 2), ["2026-10-03", "2026-10-17"]);
eq("describe", describeSchedule(biweekly), "every 2 weeks from Oct 3");

console.log("\ntwice a month (1st & 15th)");
const semi = { frequency: "SEMIMONTHLY", anchorDate: "2026-10-01" };
eq("1st and 15th", paydaysInRange(semi, "2026-10-01", "2026-12-01"), [
  "2026-10-01", "2026-10-15", "2026-11-01", "2026-11-15", "2026-12-01",
]);
eq("anchor mid-month starts at the next 1st/15th", paydaysInRange({ frequency: "SEMIMONTHLY", anchorDate: "2026-10-03" }, "2026-10-01", "2026-10-31"), ["2026-10-15"]);
eq("period for the 15th = 2nd–15th", periodFor(semi, "2026-10-15"), { start: "2026-10-02", end: "2026-10-15" });
eq("period for the 1st = 16th of last month – 1st", periodFor(semi, "2026-11-01"), { start: "2026-10-16", end: "2026-11-01" });
eq("period for Mar 1 in a leap year spans Feb 16–Mar 1", periodFor(semi, "2028-03-01"), { start: "2028-02-16", end: "2028-03-01" });
eq("previous of Jan 1 is Dec 15 of the prior year", previousPayday(semi, "2027-01-01"), "2026-12-15");

console.log("\nmonthly — month ends and leap years");
const m31 = { frequency: "MONTHLY", anchorDate: "2026-01-31" };
eq("31st → last day of shorter months, back to 31st after", paydaysInRange(m31, "2026-01-01", "2026-05-31"), [
  "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
]);
eq("31st → Feb 29 in a leap year", paydaysInRange(m31, "2028-02-01", "2028-02-29"), ["2028-02-29"]);
const m30 = { frequency: "MONTHLY", anchorDate: "2027-11-30" };
eq("30th → Feb 29 (leap), Mar 30", paydaysInRange(m30, "2028-02-01", "2028-03-31"), ["2028-02-29", "2028-03-30"]);
eq("period for Mar 31 (anchor 31st) starts Mar 1", periodFor(m31, "2026-03-31"), { start: "2026-03-01", end: "2026-03-31" });
eq("period for Feb 28 (anchor 31st) = Feb 1–Feb 28", periodFor(m31, "2026-02-28"), { start: "2026-02-01", end: "2026-02-28" });
const m15 = { frequency: "MONTHLY", anchorDate: "2026-10-15" };
eq("mid-month day across a year end", paydaysInRange(m15, "2026-11-01", "2027-01-31"), ["2026-11-15", "2026-12-15", "2027-01-15"]);
eq("period for Jan 15 = Dec 16–Jan 15", periodFor(m15, "2027-01-15"), { start: "2026-12-16", end: "2027-01-15" });
eq("describe monthly on the 31st", describeSchedule(m31), "monthly on the 31st (last day in shorter months) from Jan 31");

console.log("\ndue reminders");
const rows: ScheduleRow[] = [
  { userId: "sal", frequency: "BIWEEKLY", anchorDate: "2026-09-05" }, // … Sep 19, Oct 3
  { userId: "ana", frequency: "WEEKLY", anchorDate: "2026-09-30" }, // Sep 30, Oct 7
  { userId: "off", frequency: "WEEKLY", anchorDate: "2026-09-28", active: false },
];
const today = "2026-10-01";
const r1 = dueReminders(rows, new Set<string>(), today);
eq("overdue + due window, inactive skipped, oldest first",
  r1.map((r) => `${r.userId} ${r.payday} ${r.status}`),
  ["sal 2026-09-05 overdue", "sal 2026-09-19 overdue", "ana 2026-09-30 overdue", "sal 2026-10-03 upcoming"]);
eq("settled paydays drop out", dueReminders(rows, [settledKey("sal", "2026-09-05"), settledKey("sal", "2026-09-19"), settledKey("ana", "2026-09-30")], today)
  .map((r) => `${r.userId} ${r.payday}`), ["sal 2026-10-03"]);
eq("due today", dueReminders(rows, new Set([settledKey("ana", "2026-09-30")]), "2026-10-07")
  .filter((r) => r.userId === "ana").map((r) => [r.payday, r.status, r.daysUntil]), [["2026-10-07", "due_today", 0]]);
eq("3 days out is not due yet", dueReminders([{ userId: "x", frequency: "WEEKLY", anchorDate: "2026-10-04" }], [], today), []);
eq("2 days out is upcoming", dueReminders([{ userId: "x", frequency: "WEEKLY", anchorDate: "2026-10-03" }], [], today)
  .map((r) => [r.status, r.daysUntil]), [["upcoming", 2]]);
eq("older than 30 days drops off", dueReminders([{ userId: "x", frequency: "MONTHLY", anchorDate: "2026-08-31" }], [], today)
  .map((r) => r.payday), ["2026-09-30"]);
eq("exactly 30 days overdue still shows", dueReminders([{ userId: "x", frequency: "MONTHLY", anchorDate: "2026-09-01" }], [], today)
  .map((r) => [r.payday, r.daysUntil]), [["2026-09-01", -30], ["2026-10-01", 0]]);
eq("reminder carries its period", r1[r1.length - 1].periodStart + " → " + r1[r1.length - 1].periodEnd, "2026-09-20 → 2026-10-03");
eq("bad frequency is ignored, not thrown", dueReminders([{ userId: "x", frequency: "DAILY", anchorDate: "2026-10-01" }], [], today), []);
eq("status labels", [
  statusLabel({ status: "due_today", daysUntil: 0 }),
  statusLabel({ status: "upcoming", daysUntil: 1 }),
  statusLabel({ status: "upcoming", daysUntil: 2 }),
  statusLabel({ status: "overdue", daysUntil: -1 }),
  statusLabel({ status: "overdue", daysUntil: -12 }),
], ["due today", "due tomorrow", "due in 2 days", "1 day overdue", "12 days overdue"]);

console.log("\nroute guards (source) — staff can never set or mark their own pay");
{
  const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  const sched = src("app/api/staff/[id]/pay-schedule/route.ts");
  const put = sched.slice(sched.indexOf("export async function PUT"));
  eq("pay-schedule PUT refuses self via selfRule edit_pay", /selfRule\([^)]*"edit_pay"\) === "deny"/.test(put) && put.includes("SELF_DENY_MESSAGE.edit_pay"), true);
  eq("pay-schedule PUT requires finances:full (live)", put.includes('requirePermissionLive(session, "finances", "full")'), true);
  eq("pay-schedule PUT self check comes before the permission check", put.indexOf("edit_pay") < put.indexOf("requirePermissionLive"), true);
  eq("pay-schedule PUT records staff activity", put.includes("recordStaffActivity"), true);
  const get = sched.slice(sched.indexOf("export async function GET"), sched.indexOf("export async function PUT"));
  eq("pay-schedule GET: self may view, else finances:view", get.includes('"view_pay"') && get.includes('"finances", "view"'), true);
  const mark = src("app/api/payroll/reminders/mark-paid/route.ts");
  eq("mark-paid refuses self via selfRule edit_pay", /selfRule\([^)]*"edit_pay"\) === "deny"/.test(mark), true);
  eq("mark-paid requires finances:full (live)", mark.includes('requirePermissionLive(session, "finances", "full")'), true);
  eq("mark-paid writes kind PAYROLL + payPeriodEnd", mark.includes('kind: "PAYROLL"') && mark.includes("payPeriodEnd"), true);
  const rem = src("app/api/payroll/reminders/route.ts");
  eq("reminders GET requires finances:view", rem.includes('requirePermissionLive(session, "finances", "view")'), true);
  const payroll = src("app/api/staff/payroll/route.ts");
  eq("/api/staff/payroll uses the shared calculator (no duplicated math)", payroll.includes("computePayroll(") && !payroll.includes("computeStaffPayout"), true);
  const loader = src("lib/payReminders.ts");
  eq("reminder estimates use the same calculator + range", loader.includes("computePayroll(") && loader.includes("payrollRange("), true);
  eq("settled = PAYROLL payout, not VOID, matched on payPeriodEnd", loader.includes('kind: "PAYROLL"') && loader.includes('status: { not: "VOID" }') && loader.includes("payPeriodEnd"), true);
  const cron = src("app/api/cron/pay-reminders/route.ts");
  eq("cron route is CRON_SECRET-gated with a constant-time compare", cron.includes("CRON_SECRET") && cron.includes("timingSafeEqual"), true);
  const fn = src("netlify/functions/pay-reminders-cron.mts");
  eq("netlify function runs daily at 12:00 UTC", fn.includes('schedule: "0 12 * * *"'), true);
  const ac = src("lib/actionCenter.ts");
  eq("action center paydays gated on finances:view", /can\("finances", "view"\)\s*\?\s*loadClubReminders/.test(ac), true);
}

console.log(`\n${fail ? "✗" : "✓"} ${pass}/${pass + fail} passed — pay schedules`);
process.exit(fail ? 1 : 0);
