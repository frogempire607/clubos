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
  /**
   * Every address that belongs to somebody who manages this member — the login
   * email and the contact email/phone of each CONFIRMED guardian, plus the
   * account-holder's.
   *
   * ── Why the guardianEmail column alone was not enough (D-1 follow-up) ─────
   *
   * The first fix skipped a contact key when it equalled the row's own
   * `guardianEmail`. Cameron Lister still flagged against his father, because
   * his `guardianEmail` is a stale address nobody uses while his `members.email`
   * holds his dad's REAL one. Two different guardian addresses on one row, so
   * the equality test never fired, and the shared-with-dad address became a
   * duplicate key.
   *
   * `guardianEmail` is one owner-typed field that goes stale the moment a parent
   * changes their address. The confirmed guardian LINKS are the live truth about
   * who manages this athlete. Matching against all of them is what actually
   * answers the question the rule is asking: "is this address evidence of a
   * shared guardian rather than a shared person?"
   *
   * Empty is safe — the rule degrades to the guardianEmail/guardianPhone check.
   */
  guardianContacts?: (string | null)[];
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

  // Every address that belongs to somebody who manages this athlete. The
  // guardianEmail/guardianPhone columns are included, but they are no longer
  // the whole answer — see the note on `guardianContacts`.
  const guardianEmails = new Set<string>();
  const guardianPhones = new Set<string>();
  for (const raw of [m.guardianEmail, m.guardianPhone, ...(m.guardianContacts ?? [])]) {
    const e = norm(raw);
    if (e && e.includes("@")) guardianEmails.add(e);
    const p = digits(raw);
    if (p.length >= 10) guardianPhones.add(p);
  }

  // Email — but never when it belongs to one of this athlete's guardians.
  const email = norm(m.email);
  if (email) {
    if (guardianEmails.has(email)) skipped.push({ field: "email", reason: "matches-guardian-contact" });
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
    if (guardianPhones.has(phone)) skipped.push({ field: "phone", reason: "matches-guardian-contact" });
    else keys.push("phone:" + phone + "|" + last);
  }

  return { keys, skipped };
}
