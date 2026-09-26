// B6 — the members LIST's remaining §1a / §1j pieces, as pure helpers.
//
// Everything here is free of Prisma client and React so scripts/
// members-list-b6-tests.ts can exercise it directly. lib/membersQuery.ts turns
// the where-builders into the roster query; MembersRoster.tsx uses the family
// grouper and the queue→bulk-action map.

import type { Prisma } from "@prisma/client";

// ── A–Z jump ────────────────────────────────────────────────────────────────

/** One uppercase letter or digit, or null. Anything longer keeps its first character. */
export function normalizeLetter(raw: string | null | undefined): string | null {
  const c = raw?.trim()?.[0];
  if (!c || !/[A-Za-z0-9]/.test(c)) return null;
  return c.toUpperCase();
}

/** Last names beginning with the letter. Case-insensitive; surrounding spaces are not trimmed in SQL. */
export function letterWhere(letter: string | null): Prisma.MemberWhereInput | null {
  const l = normalizeLetter(letter);
  if (!l) return null;
  return { lastName: { startsWith: l, mode: "insensitive" } };
}

export const AZ_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// ── Age ─────────────────────────────────────────────────────────────────────

/**
 * Age brackets offered in the Filters panel. `max` is inclusive. They are just
 * named (min, max) pairs — the URL carries ageMin / ageMax, so a hand-typed
 * range works too.
 */
export const AGE_BRACKETS: { key: string; label: string; min: number | null; max: number | null }[] = [
  { key: "u8", label: "Under 8", min: null, max: 7 },
  { key: "8-10", label: "8–10", min: 8, max: 10 },
  { key: "11-13", label: "11–13", min: 11, max: 13 },
  { key: "14-17", label: "14–17", min: 14, max: 17 },
  { key: "18+", label: "18+", min: 18, max: null },
];

export function parseAge(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 130) return null;
  return Math.floor(n);
}

function yearsBefore(now: Date, years: number): Date {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - years);
  return d;
}

/**
 * Date-of-birth bounds for an inclusive age range.
 *
 *   age ≥ min  ⇔  born on or before (today − min years)
 *   age ≤ max  ⇔  born AFTER (today − (max + 1) years)
 *
 * The second is the one people get wrong: "≤ 10" must include someone the day
 * before their 11th birthday.
 */
export function ageDobBounds(
  min: number | null,
  max: number | null,
  now: Date = new Date(),
): { lte?: Date; gt?: Date } | null {
  if (min == null && max == null) return null;
  const out: { lte?: Date; gt?: Date } = {};
  if (min != null) out.lte = yearsBefore(now, min);
  if (max != null) out.gt = yearsBefore(now, max + 1);
  return out;
}

/** People with no date of birth never match an age filter — an unknown age is not "any age". */
export function ageWhere(min: number | null, max: number | null, now: Date = new Date()): Prisma.MemberWhereInput | null {
  const b = ageDobBounds(min, max, now);
  if (!b) return null;
  return { dateOfBirth: { not: null, ...b } };
}

/** Whole years, for tests and labels. */
export function ageOn(dob: Date, now: Date = new Date()): number {
  let a = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) a--;
  return a;
}

export function ageLabel(min: number | null, max: number | null): string | null {
  const b = AGE_BRACKETS.find((x) => x.min === min && x.max === max);
  if (b) return `Age ${b.label}`;
  if (min != null && max != null) return `Age ${min}–${max}`;
  if (min != null) return `Age ${min}+`;
  if (max != null) return `Age ≤ ${max}`;
  return null;
}

// ── Custom field ────────────────────────────────────────────────────────────

/**
 * Member.customFieldValues is JSON.stringify({ [fieldId]: value }) — written by
 * the member routes and the import, always without whitespace. So a value test
 * is a substring test on `"<id>":"<value>` (a prefix match on the value,
 * case-insensitive). With no value, "the field has any non-empty answer".
 */
export function customFieldNeedle(fieldId: string, value: string | null): string {
  const enc = (s: string) => JSON.stringify(s).slice(1, -1);
  return `"${enc(fieldId)}":"${value ? enc(value) : ""}`;
}

export function customFieldWhere(fieldId: string | null, value: string | null): Prisma.MemberWhereInput | null {
  if (!fieldId) return null;
  const v = value?.trim() || null;
  if (v) return { customFieldValues: { contains: customFieldNeedle(fieldId, v), mode: "insensitive" } };
  return {
    AND: [
      { customFieldValues: { contains: customFieldNeedle(fieldId, null) } },
      { NOT: { customFieldValues: { contains: `${customFieldNeedle(fieldId, null)}"` } } },
    ],
  };
}

/** Pure mirror of customFieldWhere for tests: does a stored blob match? */
export function customFieldMatches(blob: string, fieldId: string, value: string | null): boolean {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(blob || "{}");
  } catch {
    return false;
  }
  const raw = parsed[fieldId];
  if (raw == null) return false;
  const s = String(raw);
  const v = value?.trim();
  if (!v) return s !== "";
  return s.toLowerCase().startsWith(v.toLowerCase());
}

// ── Tags ────────────────────────────────────────────────────────────────────

/** Member.tags is a comma-joined string ("Beginner, 14U, Travel team"). */
export function parseTags(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Append a tag without duplicating it (case-insensitive — "travel team" and
 * "Travel Team" are one tag to a human). Existing tags keep their spelling and
 * order; the result is re-joined in the same ", " form the member form writes.
 */
export function mergeTag(existing: string | null | undefined, tag: string): { tags: string; changed: boolean } {
  const clean = tag.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const current = parseTags(existing);
  if (!clean) return { tags: existing ?? "", changed: false };
  if (current.some((t) => t.toLowerCase() === clean.toLowerCase())) {
    // Already tagged: leave the stored string exactly as it is.
    return { tags: existing ?? "", changed: false };
  }
  return { tags: [...current, clean].join(", "), changed: true };
}

/** Distinct tags across rows, first spelling wins, sorted case-insensitively. */
export function distinctTags(rows: { tags: string | null }[]): string[] {
  const seen = new Map<string, string>();
  for (const r of rows) for (const t of parseTags(r.tags)) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// ── Family grouping ─────────────────────────────────────────────────────────

/**
 * The family facts the roster select already carries (MEMBER_TRACK_SELECT):
 * confirmed guardian links, a login that guards others, subscription payers,
 * and the legacy guardianEmail column. No new relationship model — these are
 * the same links lib/familyAccess.ts reads.
 */
export type FamilyKeyInput = {
  email: string | null;
  guardianEmail: string | null;
  userId: string | null;
  guardianLinks: { userId: string; user?: { deletedAt: Date | null } | null }[];
  user: { id: string; guardianOf: { memberId: string }[] } | null;
  subscriptions: { payerUserId: string | null; status: string }[];
};

/**
 * One key per household, or null for someone who stands alone.
 *
 *   1. A member whose own login guards somebody  → that login.
 *   2. A member with a confirmed guardian login   → the first such login (sorted, so stable).
 *   3. A live subscription paid by someone else   → the payer's login.
 *   4. Legacy guardianEmail                       → that address.
 */
export function familyKeyFor(r: FamilyKeyInput): string | null {
  if (r.user && r.user.guardianOf.length > 0) return `u:${r.user.id}`;
  const links = r.guardianLinks
    .filter((l) => !l.user?.deletedAt)
    .map((l) => l.userId)
    .sort();
  if (links.length) return `u:${links[0]}`;
  const payer = r.subscriptions
    .filter((s) => ["active", "past_due", "pending"].includes(s.status))
    .map((s) => s.payerUserId)
    .filter((p): p is string => !!p && p !== r.userId)
    .sort()[0];
  if (payer) return `u:${payer}`;
  const ge = r.guardianEmail?.trim().toLowerCase();
  if (ge) return `e:${ge}`;
  return null;
}

/**
 * Keys for a set of rows. Second pass: a parent row with no key of its own
 * joins the `e:` household that names its email as the guardian address —
 * otherwise a legacy-imported parent sits apart from their own children.
 */
export function familyKeysFor<T extends FamilyKeyInput & { id: string }>(rows: T[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const emailKeys = new Set<string>();
  for (const r of rows) {
    const k = familyKeyFor(r);
    out.set(r.id, k);
    if (k?.startsWith("e:")) emailKeys.add(k);
  }
  for (const r of rows) {
    if (out.get(r.id)) continue;
    const e = r.email?.trim().toLowerCase();
    if (e && emailKeys.has(`e:${e}`)) out.set(r.id, `e:${e}`);
  }
  return out;
}

export type FamilyGroup<T> = { key: string | null; head: T; others: T[] };

/**
 * Collapse a loaded page into family groups, preserving the page's order: a
 * group appears where its first member appeared. The head is the first account
 * holder / parent in the group, else the first row. Grouping is within the page
 * only — pagination stays exactly what the server returned.
 */
export function groupFamilies<T extends { id: string; familyKey?: string | null; tracks: { role: { role: string }[] } }>(
  rows: T[],
): FamilyGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.familyKey) continue;
    const list = byKey.get(r.familyKey) ?? [];
    list.push(r);
    byKey.set(r.familyKey, list);
  }
  const emitted = new Set<string>();
  const out: FamilyGroup<T>[] = [];
  for (const r of rows) {
    const k = r.familyKey ?? null;
    const members = k ? byKey.get(k) ?? [r] : [r];
    if (!k || members.length < 2) {
      out.push({ key: null, head: r, others: [] });
      continue;
    }
    if (emitted.has(k)) continue;
    emitted.add(k);
    const isHolder = (m: T) => m.tracks.role.some((x) => x.role === "ACCOUNT_HOLDER" || x.role === "PARENT");
    const head = members.find(isHolder) ?? members[0];
    out.push({ key: k, head, others: members.filter((m) => m !== head) });
  }
  return out;
}

// ── Work-queue card → bulk action ───────────────────────────────────────────

export type RosterBulkKind = "invite" | "resend" | "assign" | "message" | "email" | "tag";

/**
 * The bulk action each work-queue card arms (§1a: "each is a saved filter that
 * also arms the matching bulk action"). A card with no natural bulk action —
 * blocked, missing contact — only filters: fixing an address is per-person.
 */
export const QUEUE_BULK_ACTION: Partial<Record<string, RosterBulkKind>> = {
  neverInvited: "invite",
  renewingSoon: "email",
  paused: "message",
  stalledCheckout: "message",
  endingSoon: "email",
};

/** Setup-state filters that arm an action too (e.g. "Invited" → Resend). */
export const SETUP_BULK_ACTION: Partial<Record<string, RosterBulkKind>> = {
  NOT_INVITED: "invite",
  INVITED: "resend",
};

export function armedBulkAction(queue: string | null | undefined, setupState?: string | null): RosterBulkKind | null {
  if (queue && QUEUE_BULK_ACTION[queue]) return QUEUE_BULK_ACTION[queue] ?? null;
  if (setupState && SETUP_BULK_ACTION[setupState]) return SETUP_BULK_ACTION[setupState] ?? null;
  return null;
}
