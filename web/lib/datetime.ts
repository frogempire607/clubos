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
