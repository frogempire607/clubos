// `Member.createdVia` — how an athlete record came to exist.
//
// Column added by migration `20260815000000_member_created_via` (applied
// 2026-08-16). Deliberately TEXT, not a Postgres enum, so a new signup path
// becomes legible without a migration. This module is therefore the
// authoritative vocabulary — the migration's SQL comment is a snapshot of the
// intent at write time, and it has since drifted in two ways worth stating
// plainly, because the migration file itself must not be edited (its checksum
// is recorded in `_prisma_migrations`).
//
// ── DRIFT 1: MINOR_SELF and SELF_PROFILE were added ──────────────────────────
//
// The migration listed `ADULT_SELF` for "member portal signup, the signer is
// the athlete". But `planSignup` distinguishes ADULT_SELF from MINOR_SELF by
// DATE OF BIRTH, and collapsing them would erase the single cohort this column
// is most useful for: a minor who signed themselves up. That is Zachary
// Lawell's shape — the four-year-old holding his own login — and "find every
// member who self-registered while under 18" should be a SELECT, not another
// morning of inference. Recording him as ADULT_SELF would make the column lie
// about the exact case it exists to surface.
//
// `SELF_PROFILE` is likewise a genuinely distinct path: a guardian who already
// holds a portal login opting into their OWN athlete profile
// (`/api/member/self-profile`). Same shape as ADULT_SELF, different origin —
// and the migration frames these values as paths ("created on
// /dashboard/members", "CSV migration import"), not shapes.
//
// ── DRIFT 2: ACTIVATION is listed but nothing writes it ──────────────────────
//
// The migration lists `ACTIVATION` for "created during /activate/[token]".
// Activation does not create members. It resolves a member that the CSV import
// already created and updates it (`findFirst` → `update`/`updateMany`); there
// is no `member.create` anywhere in that route. Those rows are `IMPORT`, which
// is the truth — activation is where an imported athlete gains a login, not
// where the athlete record is born.
//
// So ACTIVATION is intentionally NOT exported as a writable value. A constant
// nothing produces reads as "we track this" when we don't. If a future path
// really does create a member during activation, add it here — free text means
// no migration is needed.
//
// ── NULL means "created before this column existed" ──────────────────────────
//
// The migration deliberately did not backfill. Every pre-2026-08-16 row is
// NULL, and that is the honest value: inferring an origin for 287 historical
// rows would manufacture exactly the guesswork this column exists to end.
// Treat NULL as unknown, never as a default bucket.

export const MEMBER_ORIGIN = {
  /** Portal signup; the account holder is the athlete and is an adult by DOB. */
  ADULT_SELF: "ADULT_SELF",
  /** Portal signup; the account holder is the athlete and is a MINOR by DOB. */
  MINOR_SELF: "MINOR_SELF",
  /** Portal signup; a guardian added their child. The child holds no login. */
  CHILD_BY_GUARDIAN: "CHILD_BY_GUARDIAN",
  /** An existing portal user opted into their own athlete profile. */
  SELF_PROFILE: "SELF_PROFILE",
  /** Created on /dashboard/members by an owner or staff member. */
  STAFF: "STAFF",
  /** CSV import — both the migration importer and the reports import commit. */
  IMPORT: "IMPORT",
} as const;

export type MemberOrigin = (typeof MEMBER_ORIGIN)[keyof typeof MEMBER_ORIGIN];

const VALUES = new Set<string>(Object.values(MEMBER_ORIGIN));

/** True for a value this codebase writes. NULL/unknown are not origins. */
export function isMemberOrigin(v: unknown): v is MemberOrigin {
  return typeof v === "string" && VALUES.has(v);
}

/**
 * The origin for a portal signup, taken from the planner's own decision rather
 * than re-derived here. `planSignup` already resolved adult-vs-minor from the
 * date of birth; asking it again from a different input is how the stored
 * `isMinor` flag came to disagree with the birthday in the first place.
 *
 * GUARDIAN_ONLY is absent by construction — it creates no Member row, so it has
 * no origin to record.
 */
export function originForSignupPlan(
  kind: "ADULT_SELF" | "MINOR_SELF" | "CHILD_BY_GUARDIAN",
): MemberOrigin {
  return MEMBER_ORIGIN[kind];
}

/** Human label for owner-facing surfaces. NULL renders as the unknown case. */
export function memberOriginLabel(v: unknown): string {
  switch (v) {
    case MEMBER_ORIGIN.ADULT_SELF:
      return "Signed up themselves";
    case MEMBER_ORIGIN.MINOR_SELF:
      return "Signed up themselves (minor)";
    case MEMBER_ORIGIN.CHILD_BY_GUARDIAN:
      return "Added by a guardian";
    case MEMBER_ORIGIN.SELF_PROFILE:
      return "Added their own athlete profile";
    case MEMBER_ORIGIN.STAFF:
      return "Added by staff";
    case MEMBER_ORIGIN.IMPORT:
      return "Imported";
    default:
      return "Unknown (created before this was recorded)";
  }
}
