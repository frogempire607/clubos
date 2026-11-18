// The time an email prints. PURE.
//
// Emails are written on a server whose clock is UTC, and the two kinds of
// time in this app need opposite handling (lib/datetime.ts):
//
//   an EVENT or a private lesson is a real moment. Printed in the server's
//     zone, a 6:00 PM event in New York emailed as "11:00 PM" (audit D3,
//     2026-11-15). It must be printed in the CLUB's zone.
//   a CLASS day is the owner's wall clock stored as if it were UTC (a 5:30 PM
//     class is 17:30Z). It must be printed exactly as stored, in UTC, and
//     must NEVER be shifted into the club's zone (that would move it twice).
//
// Every email that prints a time says which kind it has, so the choice is
// made once, by the caller that knows, and cannot be forgotten.

export type EmailClock =
  /** A class day: wall clock stored as UTC. */
  | { kind: "class" }
  /** A real moment, shown in the club's timezone (IANA name, or unset). */
  | { kind: "moment"; timeZone: string | null | undefined };

function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The zone to format in, and whether the reader needs to be told which it is. */
function resolve(clock: EmailClock): { timeZone: string; label: "none" | "short" | "utc" } {
  if (clock.kind === "class") return { timeZone: "UTC", label: "none" };
  const tz = validZone(clock.timeZone);
  // A club with no timezone set: there is nothing to convert to. Say "UTC"
  // out loud rather than print a UTC time that reads like a local one.
  return tz ? { timeZone: tz, label: "short" } : { timeZone: "UTC", label: "utc" };
}

export function emailDate(d: Date, clock: EmailClock, opts: { year?: boolean; weekday?: "long" | "short" } = {}): string {
  const { timeZone } = resolve(clock);
  return d.toLocaleDateString("en-US", {
    weekday: opts.weekday ?? "long",
    month: "long",
    day: "numeric",
    ...(opts.year === false ? {} : { year: "numeric" }),
    timeZone,
  });
}

/** "6:00 PM", with no zone name. */
function clockTime(d: Date, timeZone: string): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function zoneName(d: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** "6:00 PM EST", "6:00 PM – 8:00 PM EST", or for a class just "5:30 PM – 6:30 PM". */
export function emailTimeRange(start: Date, end: Date | null | undefined, clock: EmailClock): string {
  const { timeZone, label } = resolve(clock);
  const range = end ? `${clockTime(start, timeZone)} – ${clockTime(end, timeZone)}` : clockTime(start, timeZone);
  if (label === "none") return range;
  return `${range} ${label === "utc" ? "UTC" : zoneName(start, timeZone)}`.trim();
}

/** "Saturday, November 21 at 6:00 PM EST" */
export function emailDateTime(d: Date, clock: EmailClock): string {
  return `${emailDate(d, clock, { year: false })} at ${emailTimeRange(d, null, clock)}`;
}
