/**
 * Event emails print the club's time, not UTC (audit D3, 2026-11-15: a 6:00 PM
 * event emailed as "11:00 PM").
 *
 *   npx tsx scripts/email-time-tests.ts
 *
 * No database, no network. Dates are built from Date.now(), never typed in,
 * and the checks hold whatever zone this machine or the server is set to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emailDate, emailDateTime, emailTimeRange } from "../lib/emailTime";
import { wallClockUTCToInstant } from "../lib/datetime";

const ROOT = join(__dirname, "..");
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const DAY = 86_400_000;
/** 18:00 on the wall clock of `tz`, `n` days from today, as the real moment. */
function sixPmIn(tz: string, n: number): Date {
  const t = new Date(Date.now() + n * DAY);
  const wall = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 18, 0, 0));
  return wallClockUTCToInstant(wall, tz);
}

console.log("\n§1 an event is printed in the club's timezone");
for (const n of [3, 40, 150, 260]) {
  const start = sixPmIn(NY, n);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const range = emailTimeRange(start, end, { kind: "moment", timeZone: NY });
  check(`day +${n}: a 6:00 PM New York event reads 6:00 PM – 8:00 PM`, range.startsWith("6:00 PM – 8:00 PM"), range);
  check(`day +${n}: and names the zone (EST or EDT)`, /E[SD]T$/.test(range), range);
  check(`day +${n}: it does NOT read as the UTC hour`, !range.startsWith("10:00 PM") && !range.startsWith("11:00 PM"), range);
  const la = emailTimeRange(start, null, { kind: "moment", timeZone: LA });
  check(`day +${n}: the same moment for a Los Angeles club reads 3:00 PM`, la.startsWith("3:00 PM"), la);
}
{
  // 11:30 PM in New York is already tomorrow in UTC: the DATE must be the club's too.
  const t = new Date(Date.now() + 10 * DAY);
  const wall = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 23, 30, 0));
  const start = wallClockUTCToInstant(wall, NY);
  const expected = wall.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  check("a late-evening event keeps the club's calendar day, not UTC's next day", emailDate(start, { kind: "moment", timeZone: NY }) === expected, emailDate(start, { kind: "moment", timeZone: NY }));
  check("date and time together read naturally", /^\w+, \w+ \d+ at 11:30 PM E[SD]T$/.test(emailDateTime(start, { kind: "moment", timeZone: NY })), emailDateTime(start, { kind: "moment", timeZone: NY }));
}

console.log("\n§2 a club with no timezone set is told the truth");
{
  const start = sixPmIn(NY, 5);
  const r = emailTimeRange(start, null, { kind: "moment", timeZone: null });
  check("the time is labelled UTC instead of passing as local", r.endsWith(" UTC"), r);
  check("a timezone name that does not exist is treated the same, never a crash", emailTimeRange(start, null, { kind: "moment", timeZone: "Mars/Olympus" }).endsWith(" UTC"));
}

console.log("\n§3 a class day is printed exactly as the owner typed it");
{
  const t = new Date(Date.now() + 7 * DAY);
  const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 17, 30, 0));
  const end = new Date(start.getTime() + 3_600_000);
  const r = emailTimeRange(start, end, { kind: "class" });
  check("a class stored as 17:30 reads 5:30 PM – 6:30 PM", r === "5:30 PM – 6:30 PM", r);
  check("with no zone name, because it is not a converted time", !/[A-Z]{2,4}T$| UTC$/.test(r));
  const expected = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  check("and its date is the stored date", emailDate(start, { kind: "class" }) === expected);
}

console.log("\n§4 every email that prints a time says which kind it has");
{
  const email = code("lib/email.ts");
  const booking = email.slice(email.indexOf("export async function sendBookingConfirmationEmail"), email.indexOf("export async function", email.indexOf("export async function sendBookingConfirmationEmail") + 10));
  check("the booking confirmation formats through lib/emailTime", booking.includes("emailDate(startsAt, clock)") && booking.includes("emailTimeRange(startsAt, endsAt, clock)"));
  check("and no longer formats in the server's own zone", !/startsAt\.toLocale(Date|Time)String/.test(booking));
  check("the clock is a required argument, so a new caller cannot forget it", /\n\s+clock: EmailClock;/.test(booking));
  const partner = email.slice(email.indexOf("export async function sendPartnerInviteEmail"));
  check("the lesson partner invite prints the club's time", partner.includes('emailDateTime(confirmedStartAt, { kind: "moment", timeZone })') && !/confirmedStartAt\.toLocale/.test(partner));
  for (const [f, kind] of [
    ["app/api/member/events/[id]/register/route.ts", "moment"],
    ["app/api/events/[id]/charge/route.ts", "moment"],
    ["app/api/member/classes/book/route.ts", "class"],
    ["app/api/classes/[id]/charge/route.ts", "class"],
  ] as const) {
    const src = code(f);
    const other = kind === "moment" ? 'kind: "class"' : 'kind: "moment"';
    check(`${f} sends ${kind} times`, src.includes(`clock: { kind: "${kind}"`) && !src.includes(`clock: { ${other}`));
  }
  const hook = code("app/api/stripe/webhook/route.ts");
  check("the payment webhook: event confirmation uses the club's zone, class confirmation the class clock", hook.includes('clock: { kind: "moment", timeZone: contact.timeZone }') && hook.includes('clock: { kind: "class" }'));
}

{
  const door = code("app/api/checkin/[id]/route.ts");
  check("the door check-in page shows an event's start in the club's zone", door.includes('kind: "moment" as const, timeZone: timezone') && !/ev\.startsAt\.toLocale/.test(door));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
