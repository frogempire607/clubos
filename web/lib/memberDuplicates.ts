// Duplicate detection — the rules, with no Prisma in sight.
//
// Extracted in session 4 (D-1 + D-3). The logic lived inside
// `app/api/members/duplicates/route.ts`, which meant the work-queue card that
// advertises "<N> possible duplicates" had no way to reach it. Reimplementing
// the matching for the count would have guaranteed the card and the page it
// opens eventually disagree — and a count that disagrees with its own list is
// worse than no count, because staff act on it.
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
// So the guard is on the VALUE, not the column: an email or phone that equals
// the same row's guardian field is dropped as a key. That holds after the data
// is cleaned too, because the next import can reintroduce the same shape.
// `scripts/fix-guardian-contact-on-minors.ts` is the data half; neither half
// replaces the other.

export type DuplicateCandidate = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | string | null;
  email: string | null;
  phone: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
};

export type DuplicateKeyPrefix = "email" | "namedob" | "phone";

const norm = (s: string | null) => (s ? s.trim().toLowerCase() : "");
const digits = (s: string | null) => (s || "").replace(/\D/g, "");
const dobKey = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** The strong keys this row participates in. Guardian-equal values excluded. */
export function duplicateKeysOf(m: DuplicateCandidate): string[] {
  const keys: string[] = [];

  const email = norm(m.email);
  if (email && email !== norm(m.guardianEmail)) keys.push("email:" + email);

  const first = norm(m.firstName);
  const last = norm(m.lastName);
  const dk = dobKey(m.dateOfBirth);
  if (first && last && dk) keys.push("namedob:" + first + "|" + last + "|" + dk);

  const phone = digits(m.phone);
  if (phone.length >= 10 && last && phone !== digits(m.guardianPhone)) {
    keys.push("phone:" + phone + "|" + last);
  }

  return keys;
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
