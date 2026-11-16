// "Which day is it at the club?" — for values that are a DATE, not a moment.
// PURE.
//
// A date picked in a form ("expires Nov 15", "first payment Nov 16", "ends
// Nov 14") is stored as midnight UTC of that calendar day. Compared against
// the server's clock as if it were a moment, it is 7 pm THE EVENING BEFORE in
// New York. So, until 2026-11-16:
//   - a discount that "expires Nov 15" stopped working at 7 pm on Nov 14;
//   - a "first payment Nov 16" card was charged around 7 pm on Nov 15;
//   - a membership that "ends Nov 14" expired at 7 pm on Nov 13;
//   - a child's daily spending limit reset at 7 pm.
//
// These helpers turn a stored date into the real moment it means at the club.
// A club with NO timezone set gets exactly the old behaviour from every one of
// them — the offset is unknowable, and guessing would move money.

import { wallClockNowUTC, wallClockUTCToInstant } from "@/lib/datetime";

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a value stored as a bare calendar day (exactly midnight UTC). */
export function isDateOnly(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/**
 * The moment a stored calendar day BEGINS at the club (its local midnight).
 * A value that already carries a time of day is a real moment and is returned
 * unchanged.
 */
export function dayStartAtClub(d: Date, timeZone: string | null | undefined): Date {
  if (!timeZone || !isDateOnly(d)) return new Date(d);
  return wallClockUTCToInstant(d, timeZone);
}

/** The moment a stored calendar day ENDS at the club (local midnight after it). */
export function dayEndAtClub(d: Date, timeZone: string | null | undefined): Date {
  if (!timeZone) return new Date(d);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return wallClockUTCToInstant(new Date(day.getTime() + DAY_MS), timeZone);
}

/**
 * Has something that is good THROUGH a date run out? "Expires Nov 15" works
 * all day on the 15th, club time. (No timezone: the old rule, strictly after
 * the stored moment.)
 */
export function isPastThroughDate(through: Date, now: Date, timeZone: string | null | undefined): boolean {
  if (!timeZone) return through.getTime() < now.getTime();
  return now.getTime() >= dayEndAtClub(through, timeZone).getTime();
}

/** The moment today began at the club. (No timezone: UTC midnight, as before.) */
export function startOfClubDay(now: Date, timeZone: string | null | undefined): Date {
  if (!timeZone) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const wall = wallClockNowUTC(timeZone, now);
  const wallMidnight = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  return wallClockUTCToInstant(wallMidnight, timeZone);
}

/**
 * For "has this stored END DATE arrived?" as a database filter:
 *   endDate <= endDateCutoff(now, tz)
 * An end date is the first day NOT covered (a period that starts Oct 14 ends
 * Nov 14), so it has arrived once the club's own calendar reads that day.
 * (No timezone: `now`, the old rule.)
 */
export function endDateCutoff(now: Date, timeZone: string | null | undefined): Date {
  return timeZone ? wallClockNowUTC(timeZone, now) : new Date(now);
}
