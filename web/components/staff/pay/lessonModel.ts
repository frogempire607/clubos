// B21 — Lessons tab helpers, pure (scripts/staff-access-ui-tests.ts).
// Lives beside the pay helpers because it describes lesson pricing lines.

export type CoachLessonType = {
  id: string;
  title: string;
  durationMin: number;
  basePrice: number | string;
  eligibleCoachIds: string[] | null;
  priceOptions?: { id: string; label: string; price: number; coachIds?: string[] }[] | null;
};

/** "60 min · $70.00 · 3 options" */
export function lessonMeta(lt: Pick<CoachLessonType, "durationMin" | "basePrice" | "priceOptions">): string {
  const parts = [`${lt.durationMin} min`, `$${Number(lt.basePrice || 0).toFixed(2)}`];
  const n = lt.priceOptions?.length ?? 0;
  if (n > 0) parts.push(`${n} option${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The eligibleCoachIds to PATCH when this coach is switched on/off. De-duplicated; other coaches untouched. */
export function nextEligible(current: string[] | null | undefined, coachId: string, on: boolean): string[] {
  const base = (current ?? []).filter((c) => c !== coachId);
  return on ? Array.from(new Set([...base, coachId])) : Array.from(new Set(base));
}

/** Named only inside a price option (so the switch alone doesn't control it). */
export function offeredViaPriceOption(lt: Pick<CoachLessonType, "priceOptions">, coachId: string): boolean {
  return (lt.priceOptions ?? []).some((o) => (o.coachIds ?? []).includes(coachId));
}

/** The schema treats an empty eligibleCoachIds as "any staff member may coach this". */
export function openToAnyStaff(lt: Pick<CoachLessonType, "eligibleCoachIds">): boolean {
  return (lt.eligibleCoachIds ?? []).length === 0;
}
