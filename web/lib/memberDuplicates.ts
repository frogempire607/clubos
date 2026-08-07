/**
 * Duplicate-detection keys for the members roster.
 *
 * Extracted from `app/api/members/duplicates/route.ts` so the rule below can be
 * pinned by fixtures instead of only being asserted in a comment.
 *
 * ── The sibling bug (Session D, D-1) ────────────────────────────────────────
 *
 * The detector's header used to claim siblings could never collide, because
 * minors carry guardian contact on `guardianEmail`/`guardianPhone` and the keys
 * read `email`/`phone`. That is the contact rule in CLAUDE.md, and the code was
 * written to it — but the DATA does not obey it. Measured read-only against
 * production on 2026-08-05:
 *
 *   27 of the 34 live minors with an own email have their GUARDIAN's email in
 *   `members.email`, and 42 have their guardian's phone in `members.phone`.
 *
 * The import path copied guardian contact into the child's own columns, so two
 * siblings shared an `email:` key, and shared a `phone:`+lastName key as well
 * (siblings share a surname). The algorithm was keying on guardian contact —
 * just laundered through the wrong column.
 *
 * So the rule is not "trust the column", it is:
 *
 *   **A contact value that equals the same row's guardian contact is evidence
 *   of a shared GUARDIAN, never of a shared PERSON.**
 *
 * This has to hold structurally rather than as a consequence of clean data,
 * because the next import can reintroduce the same shape. The data correction
 * (`scripts/fix-guardian-contact-bleed.ts`) is a separate, owner-run job; this
 * function must be correct whether or not it has been run.
 */

export type DuplicateKeyInput = {
  firstName: string;
  lastName: string;
  dateOfBirth: Date | string | null;
  email: string | null;
  phone: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
};

const norm = (s: string | null) => (s ? s.trim().toLowerCase() : "");
const digits = (s: string | null) => (s ? s.replace(/\D/g, "") : "");
const dobKey = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/**
 * Why a given contact value was NOT used as a duplicate key. Returned alongside
 * the keys so the duplicates page can explain itself rather than silently
 * finding fewer matches than an owner expects.
 */
export type SkippedKeyReason = { field: "email" | "phone"; reason: "matches-guardian-contact" };

export function duplicateKeysOf(m: DuplicateKeyInput): { keys: string[]; skipped: SkippedKeyReason[] } {
  const keys: string[] = [];
  const skipped: SkippedKeyReason[] = [];

  // Email — but never when it is the guardian's address on this same row.
  const email = norm(m.email);
  if (email) {
    if (email === norm(m.guardianEmail)) skipped.push({ field: "email", reason: "matches-guardian-contact" });
    else keys.push("email:" + email);
  }

  // Name + date of birth. Unaffected by the guardian-contact bleed: two
  // siblings do not share a birthday, and if they genuinely do (twins), they do
  // not share a first name. This is the key that still catches real duplicates
  // of a minor once the contact keys are correctly withheld.
  const first = norm(m.firstName);
  const last = norm(m.lastName);
  const dk = dobKey(m.dateOfBirth);
  if (first && last && dk) keys.push("namedob:" + first + "|" + last + "|" + dk);

  // Phone + last name — the worst offender, because siblings share a surname,
  // so a shared guardian phone number alone was enough to cluster them.
  const phone = digits(m.phone);
  if (phone.length >= 10 && last) {
    if (phone === digits(m.guardianPhone)) skipped.push({ field: "phone", reason: "matches-guardian-contact" });
    else keys.push("phone:" + phone + "|" + last);
  }

  return { keys, skipped };
}
