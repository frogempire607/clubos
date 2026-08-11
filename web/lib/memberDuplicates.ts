// Duplicate detection — the rules, with no Prisma in sight.
//
// Extracted from `app/api/members/duplicates/route.ts` for two reasons: the
// work-queue card that advertises "<N> possible duplicates" needs the same
// matching the page uses (reimplementing it would guarantee the card and the
// list it opens eventually disagree, and a count that disagrees with its own
// list is worse than no count, because staff act on it), and the rules below
// deserve to be pinned by fixtures rather than asserted in a comment.
//
// ── The one rule that matters ────────────────────────────────────────────────
// Matching is high-precision on purpose; false positives scare owners. Members
// cluster only on a STRONG signal:
//
//   • same email
//   • same first+last name AND same date of birth
//   • same phone AND same last name
//
// GUARDIAN CONTACT IS NEVER A SIGNAL. Siblings share a guardian's email and
// phone by definition, and they share a surname, so keying on either groups
// real siblings as one person. The detector always believed it was safe here
// because minors are supposed to carry guardian contact on `guardianEmail` —
// but measured against production, 27 of the 34 live minors with an own email
// carried their guardian's, and 42 carried the guardian's phone. The importer
// had copied it into the child's own columns.
//
// So the guard is on the VALUE, not the column. That holds after the data is
// cleaned too, because the next import can reintroduce the same shape.
// `scripts/fix-guardian-contact-on-minors.ts` is the data half; neither half
// replaces the other.
//
// ── Why the guardianEmail COLUMN alone was not enough either ─────────────────
//
// The first version of the guard compared a contact value to the same row's
// `guardianEmail`. Cameron Lister still clustered with his father: his
// `guardianEmail` holds a stale address nobody uses, while his `members.email`
// holds his father's REAL one. Two different guardian addresses on one row, so
// the equality never fired.
//
// `guardianEmail` is one owner-typed field that goes stale the moment a parent
// changes their address. The CONFIRMED guardian links are the live truth about
// who manages an athlete, so callers pass every address belonging to one of
// them (see lib/guardianContacts.ts) and the guard matches against all of them.
// PENDING links are excluded by that loader on purpose — an unconfirmed link
// grants nothing, and honouring it would let anyone suppress duplicate
// detection by proposing one.
//
// `namedob` is deliberately untouched by all of this: siblings do not share a
// birthday, and twins do not share a first name. It is what still catches a
// genuinely duplicated minor once the contact keys are correctly withheld.

export type DuplicateCandidate = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | string | null;
  email: string | null;
  phone: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  /**
   * Every address belonging to somebody who manages this member — each
   * CONFIRMED guardian's login email plus their own member contact email and
   * phone. Optional: empty degrades to the guardianEmail/guardianPhone columns,
   * which is the previous behaviour — worse, but not wrong.
   */
  guardianContacts?: (string | null)[];
};

export type DuplicateKeyPrefix = "email" | "namedob" | "phone";

/**
 * Why a contact value was NOT used as a key. Returned by the diagnostics
 * helper so the rule can explain itself, rather than silently finding fewer
 * matches than an owner expects.
 */
export type SkippedKeyReason = { field: "email" | "phone"; reason: "matches-guardian-contact" };

const norm = (s: string | null) => (s ? s.trim().toLowerCase() : "");
const digits = (s: string | null) => (s || "").replace(/\D/g, "");
const dobKey = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** Every address that belongs to one of this member's guardians. */
function guardianContactSets(m: DuplicateCandidate): { emails: Set<string>; phones: Set<string> } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const raw of [m.guardianEmail, m.guardianPhone, ...(m.guardianContacts ?? [])]) {
    const e = norm(raw);
    if (e && e.includes("@")) emails.add(e);
    const p = digits(raw);
    if (p.length >= 10) phones.add(p);
  }
  return { emails, phones };
}

/**
 * The strong keys this row participates in, with guardian-owned contact
 * values excluded. See `duplicateKeyDiagnostics` when you need to know WHY a
 * value was withheld.
 */
export function duplicateKeysOf(m: DuplicateCandidate): string[] {
  return duplicateKeyDiagnostics(m).keys;
}

/** `duplicateKeysOf` plus the reason each withheld contact value was withheld. */
export function duplicateKeyDiagnostics(
  m: DuplicateCandidate,
): { keys: string[]; skipped: SkippedKeyReason[] } {
  const keys: string[] = [];
  const skipped: SkippedKeyReason[] = [];
  const guardian = guardianContactSets(m);

  const email = norm(m.email);
  if (email) {
    if (guardian.emails.has(email)) skipped.push({ field: "email", reason: "matches-guardian-contact" });
    else keys.push("email:" + email);
  }

  const first = norm(m.firstName);
  const last = norm(m.lastName);
  const dk = dobKey(m.dateOfBirth);
  if (first && last && dk) keys.push("namedob:" + first + "|" + last + "|" + dk);

  const phone = digits(m.phone);
  if (phone.length >= 10 && last) {
    if (guardian.phones.has(phone)) skipped.push({ field: "phone", reason: "matches-guardian-contact" });
    else keys.push("phone:" + phone + "|" + last);
  }

  return { keys, skipped };
}

export type DuplicateGroup<T extends DuplicateCandidate> = {
  /** Prefixes of the keys that ACTUALLY caused a union — never every key held. */
  reasons: Set<DuplicateKeyPrefix>;
  members: T[];
};

/**
 * Union-find over the strong keys.
 *
 * `reasons` records only collisions. The previous version collected every key
 * prefix held by every member of a group, so a group formed purely on email
 * still reported "same name & date of birth" — each member had a namedob key of
 * their own, it just never collided. Two records with two different addresses
 * were being told they matched on email. Evidence that doesn't exist is how an
 * owner learns to distrust the screen.
 */
export function groupDuplicates<T extends DuplicateCandidate>(members: T[]): DuplicateGroup<T>[] {
  const parent = new Map<string, string>();
  for (const m of members) parent.set(m.id, m.id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const keyToMember = new Map<string, string>();
  const collisions: { prefix: DuplicateKeyPrefix; member: string }[] = [];
  for (const m of members) {
    for (const k of duplicateKeysOf(m)) {
      const prev = keyToMember.get(k);
      if (prev) {
        union(prev, m.id);
        collisions.push({ prefix: k.split(":")[0] as DuplicateKeyPrefix, member: m.id });
      } else {
        keyToMember.set(k, m.id);
      }
    }
  }

  const byRoot = new Map<string, T[]>();
  for (const m of members) {
    const root = find(m.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(m);
  }

  // Roots are only final once every union has run, so attribute afterwards.
  const reasonByRoot = new Map<string, Set<DuplicateKeyPrefix>>();
  for (const c of collisions) {
    const root = find(c.member);
    if (!reasonByRoot.has(root)) reasonByRoot.set(root, new Set());
    reasonByRoot.get(root)!.add(c.prefix);
  }

  return [...byRoot.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([root, g]) => ({ reasons: reasonByRoot.get(root) ?? new Set<DuplicateKeyPrefix>(), members: g }));
}

export function duplicateReasonLabel(reasons: Set<DuplicateKeyPrefix> | undefined): string {
  const parts: string[] = [];
  if (reasons?.has("email")) parts.push("same email");
  if (reasons?.has("namedob")) parts.push("same name & date of birth");
  if (reasons?.has("phone")) parts.push("same phone & last name");
  return parts.join(" · ") || "possible duplicate";
}
