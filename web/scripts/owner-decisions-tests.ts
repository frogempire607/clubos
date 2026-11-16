/**
 * The seven "your call" items from the 2026-11-15 audit, as Julian decided
 * them on 2026-11-16.
 *
 *   npx tsx scripts/owner-decisions-tests.ts
 *
 * No database, no network. Dates are built from Date.now(), never typed in.
 *
 *   1  a discount is good through the day shown, club time
 *   2  one payment per person per class or event
 *   3  Stripe retries an event that failed on a connection problem
 *   4  opening the Attendees screen charges nobody
 *   5  the last spot in an event is sold once
 *   6  a child's daily spending limit resets at the club's midnight
 *   7  memberships end, and first charges run, on the day shown, club time
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { dayEndAtClub, dayStartAtClub, endDateCutoff, isDateOnly, isPastThroughDate, startOfClubDay } from "../lib/clubDay";
import { chargeTiming } from "../lib/billingAdmin";
import { isTransientFailure, webhookFailureStatus } from "../lib/webhookRetry";
import { hasRoom } from "../lib/eventCapacityServer";

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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Midnight UTC of the calendar day `n` days from today — how a picked date is stored. */
const storedDay = (n: number) => {
  const t = new Date(Date.now() + n * DAY);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};
/** How a moment reads on a wall clock in New York. */
const inNY = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(", ", " ");
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

console.log("\n§0 a stored date becomes the right moment at the club");
for (const n of [0, 1, 40, 150, 260]) {
  const d = storedDay(n);
  const start = dayStartAtClub(d, NY);
  const end = dayEndAtClub(d, NY);
  check(`day +${n}: starts at the club's midnight on that same calendar day`, inNY(start).replace("24:00", "00:00") === `${utcDay(d)} 00:00`, inNY(start));
  check(`day +${n}: that is 4 or 5 hours after midnight UTC (never before it)`, [4 * HOUR, 5 * HOUR].includes(start.getTime() - d.getTime()));
  check(`day +${n}: ends at the club's midnight starting the next day`, inNY(end).replace("24:00", "00:00") === `${utcDay(new Date(d.getTime() + DAY))} 00:00`, inNY(end));
}
{
  const d = storedDay(3);
  const withTime = new Date(d.getTime() + 13 * HOUR + 5 * 60_000);
  check("a value with a time of day is a real moment and is left alone", dayStartAtClub(withTime, NY).getTime() === withTime.getTime() && !isDateOnly(withTime) && isDateOnly(d));
  check("no timezone set: nothing moves (the old behaviour, exactly)", dayStartAtClub(d, null).getTime() === d.getTime() && dayEndAtClub(d, null).getTime() === d.getTime());
}

console.log("\n§1 a discount that 'expires' on a day works all of that day");
{
  const expires = storedDay(5);
  const eveningBefore = new Date(expires.getTime() - 2 * HOUR); // ~7–10 pm the day before, in New York
  const midday = new Date(dayStartAtClub(expires, NY).getTime() + 12 * HOUR);
  const lastMinute = new Date(dayEndAtClub(expires, NY).getTime() - 60_000);
  const nextDay = new Date(dayEndAtClub(expires, NY).getTime() + 60_000);
  check("the evening before: still good", !isPastThroughDate(expires, eveningBefore, NY));
  check("midday on the day: still good (this used to be refused)", !isPastThroughDate(expires, midday, NY));
  check("11:59 pm on the day: still good", !isPastThroughDate(expires, lastMinute, NY));
  check("just after midnight: expired", isPastThroughDate(expires, nextDay, NY));
  check("no timezone: the old rule (expired once the stored moment has passed)", isPastThroughDate(expires, new Date(expires.getTime() + 1000), null) && !isPastThroughDate(expires, new Date(expires.getTime() - 1000), null));
  check("the checkout check uses it", /isPastThroughDate\(d\.expiresAt, new Date\(\), await clubTimezone\(clubId\)\)/.test(code("lib/discounts.ts")));
  check("the staff dropdown uses the same rule", /isPastThroughDate\(d\.expiresAt, now, tz\)/.test(code("app/api/discounts/eligible/route.ts")));
  check("neither compares the raw date to the clock any more", !/expiresAt < new Date\(\)/.test(code("lib/discounts.ts")) && !/expiresAt < now/.test(code("app/api/discounts/eligible/route.ts")));
}

console.log("\n§2 one payment per person per class or event");
{
  const src = code("app/api/attendance/charge/route.ts");
  const before = (a: string, b: string) => src.indexOf(a) >= 0 && src.indexOf(b) >= 0 && src.indexOf(a) < src.indexOf(b);
  check("a visit that already carries a payment is refused with 409", /existing && existing\.amountCharged != null/.test(src) && /code: "ALREADY_CHARGED"/.test(src));
  check("…before any payment row is written", before('code: "ALREADY_CHARGED"', "prisma.transaction.create("));
  check("…and before a discount use is counted", before('code: "ALREADY_CHARGED"', "recordDiscountUse("));
  check("two requests at once: the row is claimed only while it carries no money", /updateMany\(\{\s*where: \{ id: existing\.id, amountCharged: null \}/.test(src) && /claimed\.count === 0/.test(src));
  check("the message says nothing was added and how to correct it", /Nothing was added/.test(src) && /Financials/.test(src));
}

console.log("\n§3 Stripe retries a connection problem, and only that");
{
  const prisma = (c: string) => new Prisma.PrismaClientKnownRequestError("x", { code: c, clientVersion: "t" });
  for (const c of ["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"]) check(`database ${c} → retry`, webhookFailureStatus(prisma(c)) === 500);
  for (const c of ["P2002", "P2025", "P2003"]) check(`database ${c} (a data problem) → no retry`, webhookFailureStatus(prisma(c)) === 200);
  check("Stripe unreachable → retry", isTransientFailure({ type: "StripeConnectionError" }) && isTransientFailure({ type: "StripeRateLimitError" }));
  check("Stripe rejecting the request → no retry", !isTransientFailure({ type: "StripeInvalidRequestError" }) && !isTransientFailure({ type: "StripeCardError" }));
  check("a dropped socket → retry, even when wrapped", isTransientFailure({ code: "ECONNRESET" }) && isTransientFailure(Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } })));
  check("a bug in our code → no retry (it would fail the same way for three days)", webhookFailureStatus(new TypeError("Cannot read properties of undefined")) === 200);
  check("nothing / a string → no retry", webhookFailureStatus(null) === 200 && webhookFailureStatus("boom") === 200);
  const hook = code("app/api/stripe/webhook/route.ts");
  check("the webhook answers with that status", /const status = webhookFailureStatus\(err\);/.test(hook) && /\{ status \}\);/.test(hook));
  check("the failed event is still written to the log first", hook.indexOf("errorMessage: String(err)") < hook.indexOf("webhookFailureStatus(err)"));
  check("retries are safe: payments are recorded once per PaymentIntent", /createTransactionOnce\(\{/.test(hook));
}

console.log("\n§4 opening the Attendees screen charges nobody and emails nobody");
{
  const src = code("app/api/events/[id]/registrations/route.ts");
  check("no charge sweep in the page read", !/runDueEventCharges/.test(src));
  check("no reminder sweep in the page read", !/runDueTournamentReminders/.test(src));
  check("the hourly charge job still exists", /runDueEventCharges\(/.test(code("app/api/cron/event-charges/route.ts")));
  check("the hourly reminder job still exists", /runDueTournamentReminders\(/.test(code("app/api/cron/tournament-reminders/route.ts")));
  check("both are scheduled", /schedule/.test(readFileSync(join(ROOT, "netlify/functions/event-charges-cron.mts"), "utf8")) && /schedule/.test(readFileSync(join(ROOT, "netlify/functions/tournament-reminders-cron.mts"), "utf8")));
}

console.log("\n§5 the last spot in an event is sold once");
{
  check("room while under the limit", hasRoom(10, 9));
  check("no room at the limit", !hasRoom(10, 10) && !hasRoom(10, 11));
  check("no limit means always room", hasRoom(null, 10_000) && hasRoom(undefined, 5));
  check("a limit of zero is full", !hasRoom(0, 0));
  const lib = code("lib/eventCapacityServer.ts");
  check("the count and the create share one transaction, behind a per-event lock", lib.indexOf("pg_advisory_xact_lock") < lib.indexOf("eventRegistration.count") && lib.indexOf("eventRegistration.count") < lib.indexOf("await create(db)"));
  check("spots are counted the same way the page counts them", /capacityWhere\(new Date\(\), \{ holdSpotDuringReview: args\.holdSpotDuringReview \}\)/.test(lib) && /status: \{ notIn: \["CANCELED"\] \}/.test(lib));
  check("an event with no limit takes no lock", /if \(args\.capacity == null\) \{[\s\S]{0,160}create\(/.test(lib));
  const route = code("app/api/public/events/[slug]/register/route.ts");
  check("the public registration is created through it", /withEventCapacityLock\(/.test(route) && /\(db\) => db\.eventRegistration\.create\(/.test(route) && !/await prisma\.eventRegistration\.create\(/.test(route));
  check("the loser is told the event is full", /if \(made\.full\) \{[\s\S]{0,120}This event is full/.test(route));
}

console.log("\n§6 a daily spending limit resets at the club's midnight");
{
  const now = new Date(Date.now());
  const start = startOfClubDay(now, NY);
  check("today's start is midnight at the club", /00:00$|24:00$/.test(inNY(start)), inNY(start));
  check("it is not in the future, and less than a day ago", start.getTime() <= now.getTime() && now.getTime() - start.getTime() < DAY + HOUR);
  check("it is the same club calendar day as now", inNY(start).slice(0, 10) === inNY(now).slice(0, 10));
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  check("no timezone: midnight UTC, as before", startOfClubDay(now, null).getTime() === utcMidnight.getTime());
  const pc = code("lib/parentalControls.ts");
  check("the limit is summed from the club's day start", /startOfClubDay\(new Date\(\), await clubTimezone\(member\.clubId\)\)/.test(pc) && !/setHours\(0, 0, 0, 0\)/.test(pc));
}

console.log("\n§7 memberships end, and first charges run, on the day shown");
{
  const now = new Date(Date.now());
  const cutoff = endDateCutoff(now, NY);
  const today = storedDay(0);
  // The club's own calendar day, as a stored date.
  const clubToday = new Date(`${inNY(now).slice(0, 10)}T00:00:00.000Z`);
  check("an end date of the club's today HAS arrived", clubToday.getTime() <= cutoff.getTime());
  check("an end date of the club's tomorrow has NOT", new Date(clubToday.getTime() + DAY).getTime() > cutoff.getTime());
  check("no timezone: the cutoff is now, as before", Math.abs(endDateCutoff(now, null).getTime() - now.getTime()) < 5 && today.getTime() <= now.getTime());
  check("manual memberships expire by that cutoff", /endDate: \{ lte: endDateCutoff\(new Date\(\), await clubTimezone\(clubId\)\) \}/.test(code("lib/memberStatus.ts")));

  const first = storedDay(4);
  const eveningBefore = new Date(first.getTime() + 2 * HOUR); // after midnight UTC, still the evening before in New York
  const old = chargeTiming(first, eveningBefore);
  const fixed = chargeTiming(first, eveningBefore, NY);
  check("the evening before: the old rule already called it 'charges immediately'", old.immediate === true);
  check("…with the club's timezone it is still a future first payment", fixed.immediate === false && fixed.firstChargeDate?.getTime() === first.getTime());
  check("once that day has started at the club, it is immediate", chargeTiming(first, new Date(dayStartAtClub(first, NY).getTime() + 5 * 60_000), NY).immediate === true);
  check("no date at all still means charge now", chargeTiming(null, now, NY).immediate === true);
  check("the date shown is the stored calendar day, never shifted", fixed.label.includes(first.toLocaleDateString("en-US", { month: "long", day: "numeric" })));

  check("a new card membership's first charge uses the club's day", /chargeMomentFor\(club\.id, input\.anchor\)/.test(code("lib/cardActivation.ts")));
  check("turning autopay on does too", /chargeMomentFor\(clubId, sub\.paidThroughDate \?\? sub\.currentPeriodEnd\)/.test(code("lib/autopay.ts")));
  const confirm = code("app/api/reactivate/[token]/confirm/route.ts");
  check("an accepted offer does too, and tells the person the same thing it does", /firstChargeMoment\.getTime\(\) \/ 1000/.test(confirm) && /chargeTiming\(firstCharge, new Date\(\), await clubTimezone\(club\.id\)\)/.test(confirm));
  for (const rel of ["app/api/reactivate/[token]/route.ts", "app/api/members/[id]/billing-admin/route.ts", "app/api/members/[id]/reactivation/route.ts", "app/api/members/[id]/reactivation/change-request/route.ts"]) {
    check(`${rel}: what the screen says uses the club's day`, /chargeTiming\(.*clubTimezone\(/.test(code(rel)));
  }
}

console.log(`\n${"─".repeat(70)}`);
if (failed) {
  console.log(`✗ ${failed} check(s) failed\n`);
  process.exit(1);
}
console.log("✓ owner-decision tests passed\n");
