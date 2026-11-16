// The "last-known schedule" the app can show with no connection. PURE.
//
// The website (inside the app) saves a small snapshot to the phone's native
// key/value store each time the schedule loads. The bundled offline screen
// (public/native-shell/native-shell-error.html) reads it back, because that
// screen runs when our server cannot be reached at all.
//
// Kept deliberately small and plain: class and event NAMES, times and whether
// the person is booked. No prices, no balances, no other family's data — it
// sits on the device unencrypted and is shown before sign-in is re-checked.

export const OFFLINE_SCHEDULE_KEY = "aox.schedule.v1";
export const OFFLINE_SCHEDULE_MAX = 20;
/** Past this age the offline screen says the snapshot is old rather than showing it as current. */
export const OFFLINE_SCHEDULE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export type OfflineScheduleEntry = {
  title: string;
  /** ISO string, exactly as the schedule API served it. */
  startsAt: string;
  /** "CLASS" stamps are the club's wall clock pinned to UTC (lib/datetime.ts). */
  wallClockUTC: boolean;
  booked: boolean;
  canceled: boolean;
};

export type OfflineSchedule = { savedAt: string; clubName: string | null; entries: OfflineScheduleEntry[] };

type SourceItem = { title?: unknown; startsAt?: unknown; kind?: unknown; bookingStatus?: unknown; canceled?: unknown };

/** Build the snapshot from schedule items: upcoming only, soonest first, capped. */
export function buildOfflineSchedule(items: readonly SourceItem[], clubName: string | null, now: Date): OfflineSchedule {
  const entries: OfflineScheduleEntry[] = [];
  for (const it of items) {
    if (typeof it.title !== "string" || typeof it.startsAt !== "string") continue;
    const t = Date.parse(it.startsAt);
    if (!Number.isFinite(t)) continue;
    // Keep anything from the last 12 hours on: class stamps are wall-clock
    // pinned to UTC, so "already started" cannot be judged exactly here.
    if (t < now.getTime() - 12 * 60 * 60 * 1000) continue;
    entries.push({
      title: it.title.slice(0, 80),
      startsAt: it.startsAt,
      wallClockUTC: typeof it.kind === "string" && it.kind.toLowerCase() === "class",
      booked: typeof it.bookingStatus === "string" && it.bookingStatus.length > 0,
      canceled: it.canceled === true,
    });
  }
  entries.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return { savedAt: now.toISOString(), clubName: clubName ? clubName.slice(0, 80) : null, entries: entries.slice(0, OFFLINE_SCHEDULE_MAX) };
}

/** Parse what the offline screen read back. Null for anything malformed. */
export function parseOfflineSchedule(raw: string | null | undefined): OfflineSchedule | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OfflineSchedule>;
    if (!v || typeof v.savedAt !== "string" || !Array.isArray(v.entries)) return null;
    const entries = v.entries.filter(
      (e): e is OfflineScheduleEntry => !!e && typeof e.title === "string" && typeof e.startsAt === "string" && Number.isFinite(Date.parse(e.startsAt)),
    );
    return { savedAt: v.savedAt, clubName: typeof v.clubName === "string" ? v.clubName : null, entries };
  } catch {
    return null;
  }
}

export function isStale(snapshot: OfflineSchedule, now: Date): boolean {
  const t = Date.parse(snapshot.savedAt);
  return !Number.isFinite(t) || now.getTime() - t > OFFLINE_SCHEDULE_STALE_MS;
}
