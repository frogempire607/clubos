// The club's timezone, for the server paths that need "what day is it there".
// Read once per club per minute per server instance: it changes about never,
// and these callers sit on charge paths that should not add a query each.

import { prisma } from "@/lib/prisma";
import { dayStartAtClub } from "@/lib/clubDay";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; tz: string | null }>();

export async function clubTimezone(clubId: string): Promise<string | null> {
  const hit = cache.get(clubId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  const tz = club?.timezone ?? null;
  cache.set(clubId, { at: Date.now(), tz });
  return tz;
}

/**
 * The real moment a "first charge on <date>" should run for this club: the
 * start of that day there. Null stays null (charge now); a value that already
 * has a time of day is left alone.
 */
export async function chargeMomentFor(clubId: string, date: Date | null | undefined): Promise<Date | null> {
  if (!date) return null;
  return dayStartAtClub(date, await clubTimezone(clubId));
}
