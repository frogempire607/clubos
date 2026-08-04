// Pure decision rules for family access and membership transfer.
//
// NO prisma, NO I/O, NO Date.now(). Every function takes plain data and returns
// a decision. That is the point: these are the rules that decide who may act
// for a child and where a membership may move, and they must be testable
// exhaustively without a database — see scripts/family-fixtures-tests.ts.
//
// The routes stay thin: load rows, call a rule, act on the answer.

// ─────────────────────────────────────────────────────────────────────────────
// Staff capabilities
// ─────────────────────────────────────────────────────────────────────────────

export type ActorRole = "OWNER" | "STAFF" | "MEMBER";

export type ActorContext = {
  role: ActorRole;
  /** StaffProfile.permissions blob. Null for owners and members. */
  permissions: Record<string, unknown> | null;
};

export type FamilyCapabilities = {
  /** See the Family & access card at all. */
  canViewFamily: boolean;
  /** Create a PENDING link — a proposal someone else must confirm. */
  canProposeLink: boolean;
  /** Create/confirm/revoke a CONFIRMED link and edit its permission grid. */
  canGrantLink: boolean;
  /** Move a membership between family members (4A). */
  canTransferMembership: boolean;
  /** Deep-link into the booking surface for an athlete. */
  canBookForAthlete: boolean;
  /** See the billing centre link. */
  canViewBilling: boolean;
};

const RANK: Record<string, number> = { none: 0, view: 1, send: 2, edit: 3, full: 4 };

function level(perms: Record<string, unknown> | null, key: string): number {
  const v = perms?.[key];
  return typeof v === "string" ? (RANK[v] ?? 0) : 0;
}

function subScope(perms: Record<string, unknown> | null, parent: string, scope: string): boolean {
  const raw = perms?.[`${parent}_subScopes`];
  const sub = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return sub[scope] === true;
}

/**
 * What this actor may do on the Family & access surface.
 *
 * plan.md §4C: "Not every staff role should automatically be able to edit
 * family or financial relationships." So the thresholds are deliberately
 * split rather than all hanging off one level:
 *
 *   members:view  → look, change nothing
 *   members:edit  → PROPOSE a link (lands PENDING, someone else confirms)
 *   members:full  → grant, confirm, revoke, edit the permission grid
 *
 * Financial power is never inherited from members:*. Assigning a membership
 * needs billing.transfer_subscription; seeing billing needs billing:view.
 * A head coach with members:full still cannot move money.
 *
 * OWNER bypasses everything, as everywhere else in the codebase.
 */
export function resolveFamilyCapabilities(ctx: ActorContext): FamilyCapabilities {
  if (ctx.role === "OWNER") {
    return {
      canViewFamily: true,
      canProposeLink: true,
      canGrantLink: true,
      canTransferMembership: true,
      canBookForAthlete: true,
      canViewBilling: true,
    };
  }
  if (ctx.role !== "STAFF") {
    // Members never reach this surface — the client-side family screens are a
    // different, guardian-scoped set of routes.
    return {
      canViewFamily: false,
      canProposeLink: false,
      canGrantLink: false,
      canTransferMembership: false,
      canBookForAthlete: false,
      canViewBilling: false,
    };
  }

  const members = level(ctx.permissions, "members");
  return {
    canViewFamily: members >= RANK.view,
    canProposeLink: members >= RANK.edit,
    canGrantLink: members >= RANK.full,
    canTransferMembership: subScope(ctx.permissions, "billing", "transfer_subscription"),
    canBookForAthlete: level(ctx.permissions, "attendance") >= RANK.edit,
    canViewBilling: level(ctx.permissions, "billing") >= RANK.view,
  };
}

export type LinkGrant = "CONFIRMED" | "PENDING" | "DENIED";

/**
 * What status a newly staff-created link should land in.
 *
 * A proposal from someone who can't grant is not a soft failure — it is a real,
 * visible PENDING row that a `members:full` colleague confirms. That is how a
 * coach who spots "this kid's mum has no access" can act on it without being
 * handed the ability to attach any account to any child.
 */
export function linkGrantFor(caps: FamilyCapabilities): LinkGrant {
  if (caps.canGrantLink) return "CONFIRMED";
  if (caps.canProposeLink) return "PENDING";
  return "DENIED";
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessible-member classification
// ─────────────────────────────────────────────────────────────────────────────

export type AccessibleKind = "self" | "child";

export type ClassifyInput = {
  /** The viewing user's id. */
  userId: string;
  /** The member row whose `userId` is this user, if any. */
  ownMemberId: string | null;
  /** CONFIRMED guardian links held by this user. */
  links: { memberId: string }[];
};

/**
 * Which members this user can act on, and in what capacity.
 *
 * The subtle case — and the one that made the first run of
 * verify-family-access.ts report two false regressions — is a member whose
 * `Member.userId` is this same user AND who also has a guardian link from that
 * user. It is one person, recorded twice. They must appear ONCE, as `self`.
 *
 * Real rows in this shape: Dakota Mastrantonio, Paris Battaglia. Counting only
 * `child` makes them look like lost access; emitting them twice makes the
 * profile switcher show a duplicate.
 */
export function classifyAccessibleMembers(
  input: ClassifyInput,
): { id: string; kind: AccessibleKind }[] {
  const out: { id: string; kind: AccessibleKind }[] = [];
  const seen = new Set<string>();

  if (input.ownMemberId) {
    out.push({ id: input.ownMemberId, kind: "self" });
    seen.add(input.ownMemberId);
  }
  for (const l of input.links) {
    if (seen.has(l.memberId)) continue; // self wins — never list a person twice
    out.push({ id: l.memberId, kind: "child" });
    seen.add(l.memberId);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Activation account resolution — the Cameron / 4B.7 rule
// ─────────────────────────────────────────────────────────────────────────────

export type ActivationAccountInput = {
  /** The contact email the activation token resolves to (guardianEmail for a guardian-managed minor). */
  contactEmail: string;
  /** A live account already using that email, if any. */
  existingUserForEmail: { id: string; role: ActorRole; deleted: boolean } | null;
  /** True when this is a minor being activated by their guardian. */
  guardianManaged: boolean;
  /** A MEMBER of this club who is signed in right now, if any. */
  sessionUser: { id: string; email: string } | null;
};

export type ActivationAccountOutcome =
  | { kind: "BLOCKED_PRIVILEGED_ACCOUNT" }
  | { kind: "RESURRECT_DELETED"; userId: string }
  | { kind: "USE_EXISTING_ACCOUNT"; userId: string }
  | { kind: "REUSE_SESSION_ACCOUNT"; userId: string; contactEmailMismatch: boolean }
  | { kind: "CREATE_NEW_ACCOUNT" };

/**
 * Which account an activation should attach an athlete to.
 *
 * THE LISTER BUG lives here. This used to be "look up guardianEmail; if nothing
 * matches, create an account". Michael Lister was signed in as himself
 * (karen.mikelister@gmail.com) and opened his son Cameron's activation link.
 * Cameron's record carried a different, unused address, so the lookup missed and
 * a SECOND "Michael" account was created 8 minutes after his real login. One
 * son then lived under each account and the portal could never show both.
 *
 * A live session is much stronger evidence of who a person is than a contact
 * string typed into a spreadsheet by previous software. So when a guardian is
 * already signed in and the email on file resolves to nothing, attach to the
 * session's account instead of minting a stranger.
 *
 * Deliberately narrow, in this order:
 *   1. An OWNER/STAFF account on that email is never attachable  — privileged.
 *   2. A soft-deleted account on that email is resurrected       — pre-existing rule.
 *   3. A live MEMBER account on that email wins                  — it IS the right answer.
 *   4. Only then, and only for a guardian-managed minor, reuse the session.
 *   5. Otherwise create, as before.
 *
 * Rule 3 before rule 4 matters: if the guardian email really does have its own
 * account, that account is correct even when someone else is signed in — e.g. a
 * coach helping a parent at the front desk on their own logged-in laptop.
 */
export function resolveActivationAccount(
  input: ActivationAccountInput,
): ActivationAccountOutcome {
  const existing = input.existingUserForEmail;

  if (existing && !existing.deleted && existing.role !== "MEMBER") {
    return { kind: "BLOCKED_PRIVILEGED_ACCOUNT" };
  }
  if (existing?.deleted) {
    return { kind: "RESURRECT_DELETED", userId: existing.id };
  }
  if (existing) {
    return { kind: "USE_EXISTING_ACCOUNT", userId: existing.id };
  }
  if (input.guardianManaged && input.sessionUser) {
    return {
      kind: "REUSE_SESSION_ACCOUNT",
      userId: input.sessionUser.id,
      // Flagged so the route can log the disagreement for staff to correct —
      // the stale contact string is itself the defect worth surfacing.
      contactEmailMismatch:
        input.sessionUser.email.trim().toLowerCase() !== input.contactEmail.trim().toLowerCase(),
    };
  }
  return { kind: "CREATE_NEW_ACCOUNT" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relationship conflicts
// ─────────────────────────────────────────────────────────────────────────────

export type RelationshipConflict = "SELF" | "DUPLICATE" | "REVERSE_DUPLICATE" | null;

/**
 * Whether a proposed MemberRelationship may be created.
 *
 * Direction-insensitive by design: A→B and B→A are the same family fact, and
 * the GET flattens both directions anyway. Allowing the reverse would render
 * the pair twice on both profiles.
 */
export function relationshipConflictFor(
  proposed: { memberId: string; relatedMemberId: string },
  existing: { memberId: string; relatedMemberId: string }[],
): RelationshipConflict {
  if (proposed.memberId === proposed.relatedMemberId) return "SELF";
  for (const e of existing) {
    if (e.memberId === proposed.memberId && e.relatedMemberId === proposed.relatedMemberId) {
      return "DUPLICATE";
    }
    if (e.memberId === proposed.relatedMemberId && e.relatedMemberId === proposed.memberId) {
      return "REVERSE_DUPLICATE";
    }
  }
  return null;
}

/**
 * Whether a proposed guardian link may be created.
 *
 * A member's own login is recorded on `Member.userId`; adding a guardian link
 * from that same user to that same member creates the duplicate-identity shape
 * seen on the Mastrantonio and Battaglia rows.
 */
export type GuardianLinkConflict = "SELF_LINK" | "ALREADY_CONFIRMED" | null;

export function guardianLinkConflictFor(input: {
  targetUserId: string;
  memberId: string;
  memberOwnUserId: string | null;
  existingLink: { status: string } | null;
}): GuardianLinkConflict {
  if (input.memberOwnUserId && input.memberOwnUserId === input.targetUserId) return "SELF_LINK";
  if (input.existingLink?.status === "CONFIRMED") return "ALREADY_CONFIRMED";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Membership transfer eligibility
// ─────────────────────────────────────────────────────────────────────────────

export const TRANSFERABLE_SUBSCRIPTION_STATUSES = ["active", "past_due", "pending"] as const;

export type TransferBlockerCode =
  | "NOT_TRANSFERABLE"
  | "SAME_MEMBER"
  | "TARGET_NOT_IN_FAMILY"
  | "TARGET_HAS_MEMBERSHIP";

export type TransferBlocker = { code: TransferBlockerCode; message: string };

export type TransferEligibilityInput = {
  subscriptionStatus: string;
  fromMemberId: string;
  targetMemberId: string | null;
  eligibleTargets: { memberId: string; name: string; hasActiveMembership: boolean }[];
};

/**
 * Why a transfer can't proceed. Empty array = it can.
 *
 * USAGE IS NOT HERE, deliberately. Owner decision 2026-08-02: prior attendance
 * or billing never blocks a transfer, because the primary case is correcting an
 * accidental self-purchase, which is by definition already billed. Usage is
 * surfaced and acknowledged in the UI instead — a warning, not a gate.
 */
export function transferBlockersFor(input: TransferEligibilityInput): TransferBlocker[] {
  const blockers: TransferBlocker[] = [];

  if (!(TRANSFERABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(input.subscriptionStatus)) {
    blockers.push({
      code: "NOT_TRANSFERABLE",
      message: `This membership is ${input.subscriptionStatus}. Only an active, past-due or pending membership can be moved.`,
    });
  }

  if (!input.targetMemberId) return blockers;

  if (input.targetMemberId === input.fromMemberId) {
    blockers.push({ code: "SAME_MEMBER", message: "That's already who this membership is for." });
    return blockers;
  }

  const match = input.eligibleTargets.find((t) => t.memberId === input.targetMemberId);
  if (!match) {
    blockers.push({
      code: "TARGET_NOT_IN_FAMILY",
      message:
        "That athlete isn't in this payer's family. Give the payer's account access to them first, " +
        "then move the membership.",
    });
    return blockers;
  }

  if (match.hasActiveMembership) {
    blockers.push({
      code: "TARGET_HAS_MEMBERSHIP",
      message: `${match.name} already has an active membership. Moving this one would bill the family twice.`,
    });
  }

  return blockers;
}

/**
 * Who may act on a transfer, and whether it takes effect immediately.
 *
 * Client-side authority comes from being the resolved PAYER of this specific
 * subscription — not from being a guardian of the athlete, which would let a
 * co-parent move a membership the other parent bought.
 */
export type TransferActor =
  | { kind: "STAFF"; immediate: true }
  | { kind: "ACCOUNT_HOLDER"; immediate: false }
  | { kind: "DENIED"; reason: "NOT_PAYER" | "NO_PERMISSION" | "UNAUTHENTICATED" };

export function resolveTransferActor(input: {
  actor: ActorContext | null;
  actorUserId: string | null;
  resolvedPayerUserId: string | null;
}): TransferActor {
  if (!input.actor || !input.actorUserId) return { kind: "DENIED", reason: "UNAUTHENTICATED" };

  if (input.actor.role === "OWNER" || input.actor.role === "STAFF") {
    const caps = resolveFamilyCapabilities(input.actor);
    return caps.canTransferMembership
      ? { kind: "STAFF", immediate: true }
      : { kind: "DENIED", reason: "NO_PERMISSION" };
  }

  if (input.resolvedPayerUserId && input.resolvedPayerUserId === input.actorUserId) {
    return { kind: "ACCOUNT_HOLDER", immediate: false };
  }
  return { kind: "DENIED", reason: "NOT_PAYER" };
}
