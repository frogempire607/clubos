// Age from a date of birth. ONE implementation, deliberately.
//
// DOB is the authoritative minor test across this app — `resolveIsMinor` lets it
// outrank the stored `Member.isMinor` flag precisely so an owner or guardian
// cannot mark a 10-year-old as an adult to dodge the consent gate, and
// `lib/auth.ts` blocks a minor's own login on the same derivation.
//
// Signup used to be the one place that disagreed: it stored `isMinor` from
// whichever radio button was clicked and never looked at the DOB. That produced
// a live 4-year-old with his own portal login, flagged as an adult, with no
// guardian on record — and a 15-year-old in the same shape. Both would be locked
// out of their own accounts the moment FEATURE_PARENTAL_CONSENT was switched on,
// because the login gate reads the DOB the signup ignored.
//
// So this lives in its own pure module (no prisma, no next) and both the signup
// planner and the consent library import it. There is no second copy to drift.

export function ageFromDOB(dob: Date | string | null | undefined): number | null {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

/** Under 18. `null` DOB is NOT a minor — absence of evidence isn't evidence. */
export function isMinorAge(dob: Date | string | null | undefined): boolean {
  const age = ageFromDOB(dob);
  return age !== null && age < 18;
}

/** A DOB that is present, parseable, and not absurd. */
export function dobIsUsable(dob: Date | string | null | undefined): boolean {
  const age = ageFromDOB(dob);
  return age !== null && age >= 0 && age < 120;
}
