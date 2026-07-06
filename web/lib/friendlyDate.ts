/**
 * Friendly, human date/time formatting for the member portal.
 *
 * Goal (#13): dates/times read the way a parent would say them — "Today",
 * "Tomorrow", "Sat, Jun 21 · 5:30 PM" — instead of raw locale dumps. Pure
 * functions, no deps, safe on client or server. Display only; never used for
 * storage or comparison keys.
 *
 * ── Timezone convention (CRITICAL — see lib/datetime.ts) ─────────────────────
 * Two storage conventions coexist and MUST render differently:
 *   • ClassSession times are the owner's wall clock pinned to UTC (a 5:30 PM
 *     class is stored 17:30Z). Render with `utc = true` so every viewer sees
 *     5:30 PM regardless of their device timezone.
 *   • Events / private bookings are TRUE INSTANTS captured from a browser-local
 *     datetime-local input. Render with `utc = false` (the default) so they
 *     show in the viewer's local time — matching the owner dashboard.
 * Pass `utc = kindIsWallClockUTC(item.kind)` from callers that mix kinds.
 * Historically these helpers hard-coded UTC, which was correct for classes but
 * rendered events hours off on member surfaces (the "times don't match" bug).
 */

function asDate(input: Date | string | number): Date {
  return input instanceof Date ? input : new Date(input);
}

function startOfDayLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function startOfDayUTC(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Day offset from today: 0 = today, 1 = tomorrow, -1 = yesterday. */
export function dayDelta(input: Date | string | number, utc = false): number {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return NaN;
  const start = utc ? startOfDayUTC(d) : startOfDayLocal(d);
  const today = utc ? startOfDayUTC(new Date()) : startOfDayLocal(new Date());
  return Math.round((start - today) / 86_400_000);
}

/** "5:30 PM". `utc = true` for wall-clock-in-UTC class times. */
export function friendlyTime(input: Date | string | number, utc = false): string {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(utc ? { timeZone: "UTC" } : {}),
  });
}

/**
 * "Today", "Tomorrow", "Yesterday", or "Sat, Jun 21" (adds year when it
 * isn't the current year). `relative=false` forces the dated form.
 * `utc = true` for wall-clock-in-UTC class dates.
 */
export function friendlyDate(
  input: Date | string | number,
  opts: { relative?: boolean; weekday?: boolean } = {},
  utc = false,
): string {
  const { relative = true, weekday = true } = opts;
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  if (relative) {
    const delta = dayDelta(d, utc);
    if (delta === 0) return "Today";
    if (delta === 1) return "Tomorrow";
    if (delta === -1) return "Yesterday";
  }
  const now = new Date();
  const sameYear =
    (utc ? d.getUTCFullYear() : d.getFullYear()) ===
    (utc ? now.getUTCFullYear() : now.getFullYear());
  return d.toLocaleDateString("en-US", {
    ...(weekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
    ...(utc ? { timeZone: "UTC" } : {}),
  });
}

/** "Today · 5:30 PM" / "Sat, Jun 21 · 5:30 PM". `utc = true` for class times. */
export function friendlyDateTime(
  input: Date | string | number,
  opts: { relative?: boolean; weekday?: boolean } = {},
  utc = false,
): string {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  return `${friendlyDate(d, opts, utc)} · ${friendlyTime(d, utc)}`;
}

/** "5:30 – 6:30 PM" (same meridiem collapsed) or "11:30 AM – 1:00 PM". */
export function friendlyTimeRange(
  start: Date | string | number,
  end: Date | string | number,
  utc = false,
): string {
  const s = asDate(start);
  const e = asDate(end);
  if (Number.isNaN(s.getTime())) return "";
  if (Number.isNaN(e.getTime())) return friendlyTime(s, utc);
  const sMer = (utc ? s.getUTCHours() : s.getHours()) < 12 ? "AM" : "PM";
  const eMer = (utc ? e.getUTCHours() : e.getHours()) < 12 ? "AM" : "PM";
  const sStr = s.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(utc ? { timeZone: "UTC" } : {}),
    ...(sMer === eMer ? { hour12: true } : {}),
  });
  // Drop the meridiem from the start label when both ends share it.
  const sLabel = sMer === eMer ? sStr.replace(/\s?[AP]M$/i, "") : sStr;
  return `${sLabel} – ${friendlyTime(e, utc)}`;
}

/** "Saturday, June 21, 2026" — long form for headers. */
export function longDate(input: Date | string | number, utc = false): string {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(utc ? { timeZone: "UTC" } : {}),
  });
}

/** Calendar-pill parts: { month: "JUN", day: "21" }. `utc = true` for classes. */
export function datePillParts(
  input: Date | string | number,
  utc = false,
): { month: string; day: string } {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return { month: "", day: "" };
  return {
    month: d
      .toLocaleDateString("en-US", { month: "short", ...(utc ? { timeZone: "UTC" } : {}) })
      .toUpperCase(),
    day: utc ? String(d.getUTCDate()) : String(d.getDate()),
  };
}
