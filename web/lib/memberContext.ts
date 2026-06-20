import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import type { Member } from "@prisma/client";

/**
 * Family-aware member context for the member portal.
 *
 * A logged-in portal user can act for:
 *   - their OWN member profile (Member.userId === user.id, or auto-linked by
 *     email via findOrAutoLinkMember), AND
 *   - every minor they are the guardian of (MemberGuardianUser / User.guardianOf).
 *
 * This is the single source of truth so every purchase/booking surface
 * (memberships, products, events, privates, schedule) resolves the same set of
 * "profiles I can act on" — and a guardian who has NO membership of their own is
 * never told "your account isn't linked to a member profile." They simply act
 * on behalf of their children.
 */

export type AccessibleMember = {
  id: string;
  firstName: string;
  lastName: string;
  status: string;
  isMinor: boolean;
  kind: "self" | "child";
  relationship: string | null;
};

export type FamilyContext = {
  /** The full Member row the action should apply to (or null if none). */
  context: Member | null;
  contextKind: "self" | "child" | null;
  /** Lightweight list for a profile switcher. */
  accessible: AccessibleMember[];
  /** The viewer's own member profile, if any. */
  self: Member | null;
  /** True when the booker is acting as a guardian for the resolved context. */
  bookerIsGuardian: boolean;
};

function lite(m: Member, kind: "self" | "child", relationship: string | null): AccessibleMember {
  return {
    id: m.id,
    firstName: m.firstName,
    lastName: m.lastName,
    status: String(m.status),
    isMinor: m.isMinor,
    kind,
    relationship,
  };
}

/**
 * Resolve the family context for a portal user.
 *
 * @param requestedMemberId  When the caller wants to act on a specific profile
 *   (e.g. a guardian choosing which child to buy for). Returns "FORBIDDEN" if
 *   the user can't act on that member. When omitted, the context defaults to the
 *   viewer's own profile, else their first child.
 */
export async function resolveFamilyContext(
  userId: string,
  clubId: string,
  email: string,
  requestedMemberId?: string | null,
): Promise<FamilyContext | "FORBIDDEN"> {
  // Own profile (auto-links an unclaimed same-email adult member if needed).
  const self = await findOrAutoLinkMember(userId, clubId, email);

  // Guardian-managed children — reached via MemberGuardianUser, NOT userId.
  const links = await prisma.memberGuardianUser.findMany({
    where: { userId, member: { clubId, deletedAt: null } },
    include: { member: true },
  });
  const children = links
    .filter((l) => l.member && (!self || l.member.id !== self.id))
    .map((l) => ({ member: l.member, relationship: l.relationship ?? null }));

  const accessible: AccessibleMember[] = [
    ...(self ? [lite(self, "self", null)] : []),
    ...children.map((c) => lite(c.member, "child", c.relationship)),
  ];

  let context: Member | null = null;
  let contextKind: "self" | "child" | null = null;

  if (requestedMemberId) {
    if (self && self.id === requestedMemberId) {
      context = self;
      contextKind = "self";
    } else {
      const child = children.find((c) => c.member.id === requestedMemberId);
      if (!child) return "FORBIDDEN";
      context = child.member;
      contextKind = "child";
    }
  } else if (self) {
    context = self;
    contextKind = "self";
  } else if (children[0]) {
    context = children[0].member;
    contextKind = "child";
  }

  return {
    context,
    contextKind,
    accessible,
    self,
    bookerIsGuardian: contextKind === "child",
  };
}
