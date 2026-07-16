// Centralized date/time formatting for the dashboard.
//
// Two storage conventions exist in this codebase and they must be rendered
// differently:
//
//  • Class sessions (ClassSession.startsAt/endsAt) are built by
//    lib/classSessions.ts with setUTCHours — i.e. the owner's wall-clock
//    "HH:mm" is stored as that clock time IN UTC. To show it back as the
//    intended wall clock it MUST be formatted with timeZone:"UTC".
//
//  • Events and private bookings are true instants captured from a
//    browser-local <input type="datetime-local"> and round-tripped through
//    new Date(...).toISOString(). They render correctly in the viewer's
//    local timezone (no timeZone option).
//
// Use `kindIsWallClockUTC(kind)` to pick the right formatter for calendar
// feed items, or call the explicit helpers directly.

type Stamp = string | number | Date;

export function fmtTime(d: Stamp, opts?: { utc?: boolean }): string {
  return new Date(d).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(opts?.utc ? { timeZone: "UTC" } : {}),
  });
}

export function fmtDate(d: Stamp, opts?: { utc?: boolean }): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(opts?.utc ? { timeZone: "UTC" } : {}),
  });
}

export function fmtDateTime(d: Stamp, opts?: { utc?: boolean }): string {
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(opts?.utc ? { timeZone: "UTC" } : {}),
  });
}

// Calendar-feed item kind → does it use the UTC wall-clock convention?
// Only "class" (materialized ClassSession rows) does.
export function kindIsWallClockUTC(kind: string): boolean {
  return kind === "class";
}

// ── Club timezone (Club.timezone, IANA string) ──────────────────────────────
//
// Class times are stored as the owner's wall clock pinned to UTC (see above),
// which is deliberately timezone-less. Some surfaces need the REAL instant a
// class happens — the ICS feed (calendar apps demand instants), and check-in
// windows (compared against Date.now()). Given the club's IANA timezone these
// helpers resolve the stored wall clock to that instant. Isomorphic: safe in
// both server routes and client components.

/** UTC offset of `timeZone` at instant `at`, in ms (positive east of UTC). */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    era: "short",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // hourCycle quirk: some ICU versions emit "24" for midnight with hour12:false.
  const hour = get("hour") % 24;
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUTC - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The real instant of a wall-clock-UTC stamp (a ClassSession startsAt/endsAt)
 * for a club in `timeZone`. E.g. stored 17:30Z ("5:30 PM wall clock") in
 * America/Chicago (UTC-5 in summer) → 22:30Z. Invalid/empty timezone returns
 * the stamp unchanged, matching the no-timezone behavior.
 */
export function wallClockUTCToInstant(d: Stamp, timeZone: string | null | undefined): Date {
  const stamp = new Date(d);
  if (!timeZone) return stamp;
  try {
    // Two passes so a DST boundary between the naive guess and the true
    // instant resolves to the offset in force at the actual time.
    const guess = new Date(stamp.getTime() - tzOffsetMs(timeZone, stamp));
    return new Date(stamp.getTime() - tzOffsetMs(timeZone, guess));
  } catch {
    return stamp;
  }
}

/**
 * "Now" expressed in the wall-clock-UTC frame that class stamps use — for
 * filtering upcoming ClassSessions. With a valid IANA `timeZone` this is exact
 * (the club's current wall clock re-pinned to UTC). Without one the offset is
 * unknowable, so err on showing too much: `now - 12h`, which keeps a class
 * visible up to 12h late instead of dropping it hours EARLY (clubs west of UTC
 * saw today's evening classes vanish from schedules by early afternoon).
 */
export function wallClockNowUTC(timeZone: string | null | undefined, at: Date = new Date()): Date {
  if (timeZone) {
    try {
      return new Date(at.getTime() + tzOffsetMs(timeZone, at));
    } catch {
      // invalid timezone — fall through to the graced fallback
    }
  }
  return new Date(at.getTime() - 12 * 3_600_000);
}

// ── "Today" / date-input helpers ─────────────────────────────────────────────
//
// CRITICAL: never derive a calendar day from `new Date().toISOString()` — that
// is UTC, so after ~8pm US-Eastern it rolls to "tomorrow" and the dashboard
// shows the wrong day. Use these helpers, which read the VIEWER'S LOCAL day,
// for "today" and for default values of <input type="date">.

/** A Date → local-timezone calendar day as YYYY-MM-DD. */
export function localISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's calendar day in the viewer's local timezone, as YYYY-MM-DD. */
export function todayLocalISO(): string {
  return localISO(new Date());
}

// The calendar-day this stamp belongs to, honoring the storage convention so
// a 9pm class doesn't bleed onto the next/previous day in the grid.
export function dayNumber(d: Stamp, utc: boolean): number {
  const date = new Date(d);
  return utc ? date.getUTCDate() : date.getDate();
}
export function sameMonth(d: Stamp, year: number, month: number, utc: boolean): boolean {
  const date = new Date(d);
  return utc
    ? date.getUTCFullYear() === year && date.getUTCMonth() === month
    : date.getFullYear() === year && date.getMonth() === month;
}
