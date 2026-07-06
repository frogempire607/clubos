/**
 * Friendly, human date/time formatting for the member portal.
 *
 * Goal (#13): dates/times read the way a parent would say them — "Today",
 * "Tomorrow", "Sat, Jun 21 · 5:30 PM" — instead of raw locale dumps. Pure
 * functions, no deps, safe on client or server. Display only; never used for
 * storage or comparison keys.
 */

function asDate(input: Date | string | number): Date {
  return input instanceof Date ? input : new Date(input);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Day offset from today: 0 = today, 1 = tomorrow, -1 = yesterday. */
export function dayDelta(input: Date | string | number): number {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return NaN;
  return Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
}

/** "5:30 PM" */
export function friendlyTime(input: Date | string | number): string {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  // Class/event times are stored as wall-clock pinned to UTC (a 5:30 PM class is
  // 17:30Z) and the owner dashboard renders them in UTC. Render the member portal
  // in UTC too so both sides show the same 5:30 PM — otherwise the member's
  // browser localizes 17:30Z to e.g. 1:30 PM (the ~4-hour-off bug).
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

/**
 * "Today", "Tomorrow", "Yesterday", or "Sat, Jun 21" (adds year when it
 * isn't the current year). `relative=false` forces the dated form.
 */
export function friendlyDate(
  input: Date | string | number,
  opts: { relative?: boolean; weekday?: boolean } = {},
): string {
  const { relative = true, weekday = true } = opts;
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  if (relative) {
    const delta = dayDelta(d);
    if (delta === 0) return "Today";
    if (delta === 1) return "Tomorrow";
    if (delta === -1) return "Yesterday";
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    ...(weekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
}

/** "Today · 5:30 PM" / "Sat, Jun 21 · 5:30 PM" */
export function friendlyDateTime(
  input: Date | string | number,
  opts: { relative?: boolean; weekday?: boolean } = {},
): string {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  return `${friendlyDate(d, opts)} · ${friendlyTime(d)}`;
}

/** "5:30 – 6:30 PM" (same meridiem collapsed) or "11:30 AM – 1:00 PM". */
export function friendlyTimeRange(
  start: Date | string | number,
  end: Date | string | number,
): string {
  const s = asDate(start);
  const e = asDate(end);
  if (Number.isNaN(s.getTime())) return "";
  if (Number.isNaN(e.getTime())) return friendlyTime(s);
  // UTC to match how session times are stored/rendered (see friendlyTime).
  const sMer = s.getUTCHours() < 12 ? "AM" : "PM";
  const eMer = e.getUTCHours() < 12 ? "AM" : "PM";
  const sStr = s.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    ...(sMer === eMer ? { hour12: true } : {}),
  });
  // Drop the meridiem from the start label when both ends share it.
  const sLabel = sMer === eMer ? sStr.replace(/\s?[AP]M$/i, "") : sStr;
  return `${sLabel} – ${friendlyTime(e)}`;
}

/** "Saturday, June 21, 2026" — long form for headers. */
export function longDate(input: Date | string | number): string {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Calendar-pill parts: { month: "JUN", day: "21" }. */
export function datePillParts(input: Date | string | number): { month: string; day: string } {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return { month: "", day: "" };
  return {
    month: d.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
    day: String(d.getDate()),
  };
}
