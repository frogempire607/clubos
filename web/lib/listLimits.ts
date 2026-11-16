// Small "how many rows" query parameters for dashboard cards. PURE.
//
// A card that shows five rows asks for five rows. Every parser here answers
// null for anything that is not a sensible whole number, and the route then
// falls through to its normal behaviour — a malformed limit must never turn a
// list into an error.

function wholeNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}

/** `?recent=N` on GET /api/members — newest members, capped at 20. */
export const MAX_RECENT_MEMBERS = 20;
export function parseRecentLimit(raw: string | null | undefined): number | null {
  const n = wholeNumber(raw);
  return n == null ? null : Math.min(n, MAX_RECENT_MEMBERS);
}

/** `?next=N` on GET /api/events — the next N events to start, capped at 20. */
export const MAX_NEXT_EVENTS = 20;
export function parseNextEventsLimit(raw: string | null | undefined): number | null {
  const n = wholeNumber(raw);
  return n == null ? null : Math.min(n, MAX_NEXT_EVENTS);
}
