// B21 — does an assignment fit a staff member's availability? Pure (no Prisma,
// no React) so scripts/staff-schedule-fit-tests.ts covers it, and the Schedule
// tab, the Overview banner and the red tab dot all use the same answer.
//
// Availability for the check = the SAVED weekly hours plus date exceptions:
//   - UNAVAILABLE on a date blocks that whole day.
//   - PARTIAL on a date REPLACES that day's weekly hours with its From–To.
//     A PARTIAL with no usable times leaves no hours that day.
//   - Several PARTIALs on one date are combined; any UNAVAILABLE wins.
//   - Inactive weekly slots don't count.
//   - No weekly hours for a weekday = not available that day. This matches
//     the existing Schedule and Availability pages, which show such a day as
//     "Off". So an assignment on a day with no hours is "outside".
// Touching or overlapping windows merge (5–7 PM + 7–9 PM covers 6:30–7:30 PM).
// An assignment fits only when ONE merged window contains all of it.
//
// Data shapes mirror the API exactly:
//   weekly slot  — /api/staff/[id]/availability  { dayOfWeek 0=Sun, startTime "HH:mm", endTime "HH:mm", active }
//   exception    — /api/staff/[id]/availability/exceptions and /api/staff/schedule
//                  { date (ISO or YYYY-MM-DD), type "UNAVAILABLE" | "PARTIAL", startTime?, endTime?, note? }

export type WeeklySlot = { dayOfWeek: number; startTime: string; endTime: string; active?: boolean };
export type DateException = {
  date: string;
  type: string; // "UNAVAILABLE" | "PARTIAL"
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
};
export type Assignment = { date: string; startTime: string; endTime: string };
export type Fit = "fits" | "outside";

/** A window in minutes after midnight, end exclusive. */
export type Window = { start: number; end: number };

export type DayBand = {
  date: string; // YYYY-MM-DD
  /** available = weekly hours · none = no hours that day · time_off = UNAVAILABLE · modified = PARTIAL replaces the hours */
  kind: "available" | "none" | "time_off" | "modified";
  windows: Window[];
  note: string | null;
};

const DAY_MIN = 24 * 60;

/** "18:30" → 1110. Returns null for anything that isn't a valid HH:mm. "24:00" is allowed (end of day). */
export function toMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** 1110 → "18:30". */
export function fromMinutes(n: number): string {
  const c = Math.max(0, Math.min(DAY_MIN, Math.round(n)));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
}

/** "2026-09-24" or "2026-09-24T00:00:00.000Z" → "2026-09-24". */
export function dateKey(d: string): string {
  return d.slice(0, 10);
}

/** Weekday (0=Sun) of a calendar date, independent of the machine's timezone. */
export function dayOfWeekOf(date: string): number {
  const k = dateKey(date);
  const [y, mo, d] = k.split("-").map(Number);
  return new Date(Date.UTC(y, (mo || 1) - 1, d || 1)).getUTCDay();
}

/** Start/end strings → a window. End at or before start is treated as "runs to midnight". Invalid → null. */
function toWindow(start: string | null | undefined, end: string | null | undefined): Window | null {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return null;
  if (e <= s) return null; // availability windows must run forward
  return { start: s, end: e };
}

/** Sort and merge overlapping or touching windows. */
export function mergeWindows(ws: Window[]): Window[] {
  const sorted = ws.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/** The availability band for one calendar date. */
export function availabilityForDate(date: string, slots: WeeklySlot[], exceptions: DateException[]): DayBand {
  const key = dateKey(date);
  const exc = exceptions.filter((e) => dateKey(e.date) === key);
  const notes = exc.map((e) => (e.note ?? "").trim()).filter(Boolean);
  const note = notes.length ? notes.join(" · ") : null;
  if (exc.some((e) => e.type === "UNAVAILABLE")) return { date: key, kind: "time_off", windows: [], note };
  const partial = exc.filter((e) => e.type === "PARTIAL");
  if (partial.length) {
    const windows = mergeWindows(partial.map((e) => toWindow(e.startTime, e.endTime)).filter((w): w is Window => !!w));
    return { date: key, kind: "modified", windows, note };
  }
  const dow = dayOfWeekOf(key);
  const windows = mergeWindows(
    slots
      .filter((s) => s.dayOfWeek === dow && s.active !== false)
      .map((s) => toWindow(s.startTime, s.endTime))
      .filter((w): w is Window => !!w),
  );
  return { date: key, kind: windows.length ? "available" : "none", windows, note: null };
}

/** Does [start,end) sit inside one window? End at/before start runs to midnight. Unreadable times never fit. */
export function fitsWindows(startTime: string, endTime: string, windows: Window[]): boolean {
  const s = toMinutes(startTime);
  if (s === null) return false;
  let e = toMinutes(endTime);
  if (e === null) e = s; // no end time: judge by the start alone
  else if (e < s) e = DAY_MIN; // runs past midnight — only the part on this date is checked
  const end = e;
  return windows.some((w) => w.start <= s && s < w.end && end <= w.end);
}

export function fitFor(a: Assignment, slots: WeeklySlot[], exceptions: DateException[]): Fit {
  const band = availabilityForDate(a.date, slots, exceptions);
  return fitsWindows(a.startTime, a.endTime, band.windows) ? "fits" : "outside";
}

/**
 * One call for a week (or any list of dates): the band per date and the fit
 * per assignment (same order as given), plus how many are outside.
 */
export function scheduleFit<A extends Assignment>(
  dates: string[],
  slots: WeeklySlot[],
  exceptions: DateException[],
  assignments: A[],
): { days: DayBand[]; results: { assignment: A; fit: Fit }[]; outside: number } {
  const days = dates.map((d) => availabilityForDate(d, slots, exceptions));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const results = assignments.map((a) => {
    const band = byDate.get(dateKey(a.date)) ?? availabilityForDate(a.date, slots, exceptions);
    return { assignment: a, fit: (fitsWindows(a.startTime, a.endTime, band.windows) ? "fits" : "outside") as Fit };
  });
  return { days, results, outside: results.filter((r) => r.fit === "outside").length };
}

/** The 7 dates (YYYY-MM-DD) of the Sunday-start week containing `ymd`. */
export function weekDates(ymd: string): string[] {
  const [y, m, d] = dateKey(ymd).split("-").map(Number);
  const base = Date.UTC(y, m - 1, d) - dayOfWeekOf(ymd) * 86400000;
  return Array.from({ length: 7 }, (_, i) => new Date(base + i * 86400000).toISOString().slice(0, 10));
}

/** Local calendar date of a Date as YYYY-MM-DD (the viewer's timezone, like the rest of the dashboard). */
export function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local HH:mm of a Date. */
export function localHhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
