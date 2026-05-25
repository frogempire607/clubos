export const PRIVATE_DURATION_OPTIONS = Array.from(
  { length: 16 },
  (_, i) => (i + 1) * 15,
);

export function isValidPrivateDuration(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 240 && minutes % 15 === 0;
}

export function privateDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export function packageLessonTypeIds(
  lessonTypeIds: unknown,
  legacyLessonTypeId?: string | null,
): string[] {
  if (Array.isArray(lessonTypeIds)) {
    return lessonTypeIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return legacyLessonTypeId ? [legacyLessonTypeId] : [];
}

export function packageAllowsLessonType(
  lessonTypeIds: unknown,
  legacyLessonTypeId: string | null | undefined,
  lessonTypeId: string,
): boolean {
  const ids = packageLessonTypeIds(lessonTypeIds, legacyLessonTypeId);
  return ids.length === 0 || ids.includes(lessonTypeId);
}
