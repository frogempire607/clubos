// Front desk helpers. PURE.

type SessionLike = { id: string; startsAt: string; endsAt: string; canceled: boolean };

// Class sessions store wall-clock time pinned to UTC (lib/classSessions), so
// "what time is it in the room" compares the UTC clock fields of the stamp to
// the device's LOCAL clock.
const wallMinutes = (iso: string) => { const d = new Date(iso); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const localNowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

/** The class to default to: the one running (or opening within the hour), else the next, else the last. */
export function pickCurrentSession(rows: SessionLike[], now = localNowMinutes()): string | null {
  const live = rows.filter((r) => !r.canceled);
  if (live.length === 0) return null;
  const running = live.find((r) => now >= wallMinutes(r.startsAt) - 60 && now <= wallMinutes(r.endsAt));
  if (running) return running.id;
  const next = live.find((r) => wallMinutes(r.startsAt) > now);
  return (next ?? live[live.length - 1]).id;
}
