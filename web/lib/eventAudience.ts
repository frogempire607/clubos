// Who an event is for (2026-10-14) — on top of its visibility.
//
//   { membershipIds?, minAge?, maxAge?, genders?, tags? }
//
// Every rule that is set must match ONE athlete:
//   membershipIds  holds an active membership on one of these plans
//   minAge/maxAge  age on the event's first day, from the athlete's date of
//                  birth (no date of birth on file = does not match an age rule)
//   genders        the athlete's gender on file is one of these
//   tags           the athlete carries at least one of these tags
// A family sees the event when one of its athletes matches; only matching
// athletes can register. Staff always see it. A public registration link
// cannot check any of this for a stranger, so an event with an audience is
// registered for from the member app (or a private share link, which staff
// send on purpose and which skips these rules like it skips visibility).
// Pure: no Prisma.
import { z } from "zod";

export type EventAudience = {
  membershipIds?: string[];
  minAge?: number | null;
  maxAge?: number | null;
  genders?: string[];
  tags?: string[];
};

export const audienceSchema = z.object({
  membershipIds: z.array(z.string().min(1)).max(50).optional(),
  minAge: z.number().int().min(0).max(120).nullable().optional(),
  maxAge: z.number().int().min(0).max(120).nullable().optional(),
  genders: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
}).strict();

/** Clean shape, or null when nothing is set (= everyone the visibility allows). */
export function normalizeAudience(raw: unknown): EventAudience | null {
  const p = audienceSchema.safeParse(raw ?? {});
  if (!p.success) return null;
  const a = p.data;
  const out: EventAudience = {};
  const uniq = (xs?: string[]) => (xs ? Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean))) : []);
  const m = uniq(a.membershipIds); if (m.length) out.membershipIds = m;
  const g = uniq(a.genders); if (g.length) out.genders = g;
  const t = uniq(a.tags); if (t.length) out.tags = t;
  if (a.minAge !== null && a.minAge !== undefined) out.minAge = a.minAge;
  if (a.maxAge !== null && a.maxAge !== undefined) out.maxAge = a.maxAge;
  return Object.keys(out).length ? out : null;
}

export function audienceProblem(raw: unknown): string | null {
  const p = audienceSchema.safeParse(raw ?? {});
  if (!p.success) return "The audience settings aren't valid.";
  if (p.data.minAge != null && p.data.maxAge != null && p.data.minAge > p.data.maxAge) return "The youngest age is above the oldest age.";
  return null;
}

/** Whole years old on `on` (YYYY-MM-DD or Date), from a date of birth. */
export function ageOn(dob: Date, on: Date): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export type AudienceAthlete = {
  dateOfBirth: Date | null;
  gender: string | null;
  tags: string | null; // the member record's comma-separated tags
  activeMembershipIds: readonly string[];
};

const splitTags = (s: string | null) => (s ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

/** Does this athlete meet every rule? `missing` says, in words, what didn't. */
export function athleteMatches(aud: EventAudience | null, a: AudienceAthlete, eventStart: Date, membershipName: (id: string) => string = (id) => id): { ok: boolean; missing: string[] } {
  if (!aud) return { ok: true, missing: [] };
  const missing: string[] = [];
  if (aud.membershipIds?.length && !aud.membershipIds.some((id) => a.activeMembershipIds.includes(id))) {
    missing.push(`needs a ${aud.membershipIds.map(membershipName).join(" or ")} membership`);
  }
  if (aud.minAge != null || aud.maxAge != null) {
    if (!a.dateOfBirth) missing.push("needs a date of birth on file");
    else {
      const age = ageOn(a.dateOfBirth, eventStart);
      if (aud.minAge != null && age < aud.minAge) missing.push(`must be at least ${aud.minAge}`);
      if (aud.maxAge != null && age > aud.maxAge) missing.push(`must be ${aud.maxAge} or younger`);
    }
  }
  if (aud.genders?.length) {
    const g = (a.gender ?? "").trim().toLowerCase();
    if (!aud.genders.some((x) => x.toLowerCase() === g)) missing.push(`open to ${aud.genders.join(" / ").toLowerCase()} athletes`);
  }
  if (aud.tags?.length) {
    const have = splitTags(a.tags);
    if (!aud.tags.some((t) => have.includes(t.toLowerCase()))) missing.push(`for ${aud.tags.join(" / ")}`);
  }
  return { ok: missing.length === 0, missing };
}

/** "MS/HS or Jr Frogs members · ages 8–12 · Girls" */
export function describeAudience(aud: EventAudience | null, membershipName: (id: string) => string = (id) => id): string | null {
  if (!aud) return null;
  const parts: string[] = [];
  if (aud.membershipIds?.length) parts.push(`${aud.membershipIds.map(membershipName).join(" or ")} members`);
  if (aud.minAge != null && aud.maxAge != null) parts.push(`ages ${aud.minAge}–${aud.maxAge}`);
  else if (aud.minAge != null) parts.push(`ages ${aud.minAge}+`);
  else if (aud.maxAge != null) parts.push(`ages ${aud.maxAge} and under`);
  if (aud.genders?.length) parts.push(aud.genders.join(" / "));
  if (aud.tags?.length) parts.push(aud.tags.join(" / "));
  return parts.join(" · ");
}
