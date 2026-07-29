// Reports Phase 2.5.1 — shared range resolver.
//
// Every /api/reports/* endpoint calls resolveReportsRange() so weeks are
// Monday–Sunday and months are calendar months in the CLUB'S timezone
// (`Club.timezone`, not server-local). `before_athletix` and `since_athletix`
// use `Club.wentLiveAt` when set, else `Club.createdAt`.
//
// The resolved value carries partial-period detection + the comparison window
// (previous same-length period) so downstream endpoints don't have to
// re-derive it.

import { tzOffsetMs } from "@/lib/datetime";

export type RangeKey =
  | "this_week"
  | "last_week"
  | "month"
  | "last_month"
  | "qtd"
  | "ytd"
  | "year"
  | "all"
  | "before_athletix"
  | "since_athletix"
  | "custom";

export const RANGE_KEYS: RangeKey[] = [
  "this_week",
  "last_week",
  "month",
  "last_month",
  "qtd",
  "ytd",
  "year",
  "all",
  "before_athletix",
  "since_athletix",
  "custom",
];

export type ResolvedRange = {
  key: RangeKey;
  label: string;
  start: Date | null;
  end: Date;
  isPartialPeriod: boolean;
  // Human-readable "N of M days" when partial.
  partialNote: string | null;
  comparison: {
    key: RangeKey;
    label: string;
    start: Date | null;
    end: Date | null;
  } | null;
  timezone: string; // IANA zone applied to bucketing, or "UTC" if the club has none
};

export type RangeInputs = {
  key: RangeKey | string | null | undefined;
  from?: string | null;
  to?: string | null;
  timezone?: string | null;
  wentLiveAt?: Date | null;
  clubCreatedAt: Date;
  now?: Date;
};

// A tiny wrapper around tzOffsetMs — returns the calendar Y/M/D for `at` in
// the given zone. Falls back to UTC when the zone is missing or invalid.
function partsIn(at: Date, tz: string): { year: number; month: number; day: number; hour: number } {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hour12: false,
    });
    const parts = dtf.formatToParts(at);
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? "0");
    return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
  } catch {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
    };
  }
}

// Build a Date representing the wall-clock instant Y-M-D 00:00 in `tz`.
function wallClockInTz(year: number, month: number, day: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = tzOffsetMs(tz, new Date(guess));
  return new Date(guess - offset);
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

const RANGE_LABELS: Record<RangeKey, string> = {
  this_week: "This week",
  last_week: "Last week",
  month: "This month",
  last_month: "Last month",
  qtd: "Quarter to date",
  ytd: "Year to date",
  year: "Last 12 months",
  all: "All time",
  before_athletix: "Before AthletixOS",
  since_athletix: "Since joining AthletixOS",
  custom: "Custom range",
};

// Resolve a range from the query-string inputs. Never throws — invalid input
// falls back to "This month" and reports it as such via the returned key.
export function resolveReportsRange(input: RangeInputs): ResolvedRange {
  const tz = input.timezone && input.timezone.length ? input.timezone : "UTC";
  const now = input.now ?? new Date();
  const rawKey = (input.key || "month") as RangeKey;
  const key: RangeKey = RANGE_KEYS.includes(rawKey) ? rawKey : "month";
  const wentLiveAt = input.wentLiveAt ?? input.clubCreatedAt;
  const label = RANGE_LABELS[key];

  const nowParts = partsIn(now, tz);
  const nowMidnight = wallClockInTz(nowParts.year, nowParts.month, nowParts.day, tz);

  // Compute anchor booms first, then fold into ranges.
  // Week: Mon–Sun in `tz`.
  const nowDay = new Date(nowMidnight);
  const jsDow = (nowDay.getUTCDay() + 6) % 7; // 0=Mon..6=Sun; nowMidnight is UTC-shifted
  // Adjust: we want the local day of week. Re-derive from the tz-formatted date.
  // The Intl DTF short weekday gives us this reliably.
  const dowStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dowMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow = dowMap[dowStr] ?? jsDow;
  const thisMonMidnight = new Date(nowMidnight.getTime() - dow * 86400000);
  const nextMonMidnight = new Date(thisMonMidnight.getTime() + 7 * 86400000);
  const lastMonMidnight = new Date(thisMonMidnight.getTime() - 7 * 86400000);

  // Month.
  const thisMonthStart = wallClockInTz(nowParts.year, nowParts.month, 1, tz);
  const nextMonthStart = wallClockInTz(
    nowParts.month === 12 ? nowParts.year + 1 : nowParts.year,
    nowParts.month === 12 ? 1 : nowParts.month + 1,
    1,
    tz,
  );
  const lastMonthStart = wallClockInTz(
    nowParts.month === 1 ? nowParts.year - 1 : nowParts.year,
    nowParts.month === 1 ? 12 : nowParts.month - 1,
    1,
    tz,
  );
  const twoAgoStart = wallClockInTz(
    nowParts.month <= 2 ? nowParts.year - 1 : nowParts.year,
    ((nowParts.month + 9) % 12) + 1, // month - 2
    1,
    tz,
  );

  // Quarter.
  const quarter = Math.floor((nowParts.month - 1) / 3);
  const qStartMonth = quarter * 3 + 1;
  const qStart = wallClockInTz(nowParts.year, qStartMonth, 1, tz);

  // Year.
  const yStart = wallClockInTz(nowParts.year, 1, 1, tz);

  // Compute the range window.
  let start: Date | null = null;
  let end: Date = now;
  let compStart: Date | null = null;
  let compEnd: Date | null = null;
  let isPartialPeriod = false;
  let partialNote: string | null = null;

  switch (key) {
    case "this_week": {
      start = thisMonMidnight;
      end = now;
      const elapsedDays = daysBetween(thisMonMidnight, now);
      const totalDays = 7;
      isPartialPeriod = elapsedDays < totalDays;
      if (isPartialPeriod) partialNote = `${elapsedDays} of ${totalDays} days`;
      compStart = lastMonMidnight;
      compEnd = thisMonMidnight;
      break;
    }
    case "last_week": {
      start = lastMonMidnight;
      end = thisMonMidnight;
      compStart = new Date(lastMonMidnight.getTime() - 7 * 86400000);
      compEnd = lastMonMidnight;
      break;
    }
    case "month": {
      start = thisMonthStart;
      end = now;
      const totalDays = daysBetween(thisMonthStart, nextMonthStart);
      const elapsedDays = daysBetween(thisMonthStart, now);
      isPartialPeriod = elapsedDays < totalDays;
      if (isPartialPeriod) partialNote = `${elapsedDays} of ${totalDays} days`;
      compStart = lastMonthStart;
      compEnd = thisMonthStart;
      break;
    }
    case "last_month": {
      start = lastMonthStart;
      end = thisMonthStart;
      compStart = twoAgoStart;
      compEnd = lastMonthStart;
      break;
    }
    case "qtd": {
      start = qStart;
      end = now;
      const totalDays = 91;
      const elapsedDays = daysBetween(qStart, now);
      isPartialPeriod = elapsedDays < totalDays;
      if (isPartialPeriod) partialNote = `${elapsedDays} of ~${totalDays} days`;
      compStart = new Date(qStart.getTime() - 91 * 86400000);
      compEnd = qStart;
      break;
    }
    case "ytd": {
      start = yStart;
      end = now;
      const yStartLast = wallClockInTz(nowParts.year - 1, 1, 1, tz);
      const yEndLastEq = new Date(yStartLast.getTime() + (now.getTime() - yStart.getTime()));
      compStart = yStartLast;
      compEnd = yEndLastEq;
      break;
    }
    case "year": {
      start = new Date(now.getTime() - 365 * 86400000);
      end = now;
      compStart = new Date(now.getTime() - 730 * 86400000);
      compEnd = start;
      break;
    }
    case "all": {
      start = null;
      end = now;
      compStart = null;
      compEnd = null;
      break;
    }
    case "before_athletix": {
      start = null;
      end = wentLiveAt;
      break;
    }
    case "since_athletix": {
      start = wentLiveAt;
      end = now;
      break;
    }
    case "custom": {
      const from = input.from ? new Date(input.from) : null;
      const to = input.to ? new Date(input.to) : null;
      // Fall back to "month" if custom is missing dates.
      if (!from || !to) {
        return resolveReportsRange({ ...input, key: "month" });
      }
      start = from;
      end = to;
      break;
    }
  }

  const comparison =
    compStart && compEnd
      ? {
          key: `prev_${key}` as RangeKey,
          label: `Previous ${label.toLowerCase()}`,
          start: compStart,
          end: compEnd,
        }
      : null;

  return {
    key,
    label,
    start,
    end,
    isPartialPeriod,
    partialNote,
    comparison,
    timezone: tz,
  };
}

// Serialize a resolved range to the API response shape (`range: {...}`).
export function serializeRange(r: ResolvedRange) {
  return {
    key: r.key,
    label: r.label,
    start: r.start?.toISOString() ?? null,
    end: r.end.toISOString(),
    isPartialPeriod: r.isPartialPeriod,
    partialNote: r.partialNote,
    comparison: r.comparison
      ? {
          key: r.comparison.key,
          label: r.comparison.label,
          start: r.comparison.start?.toISOString() ?? null,
          end: r.comparison.end?.toISOString() ?? null,
        }
      : null,
    timezone: r.timezone,
  };
}
