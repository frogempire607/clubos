/**
 * The `?limit=` on GET /api/member/announcements. PURE.
 * A whole number from 1 to 50, or null for "no limit" (the full News page).
 * Anything else — missing, zero, negative, fractional, text — is null rather
 * than an error: a bad limit must never blank the announcements list.
 */
export const MAX_ANNOUNCEMENT_LIMIT = 50;

export function parseAnnouncementLimit(raw: string | null | undefined): number | null {
  if (raw == null || !/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  if (n < 1) return null;
  return Math.min(n, MAX_ANNOUNCEMENT_LIMIT);
}
