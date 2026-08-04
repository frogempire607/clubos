// Shared authorization for "a User wants guardian access to a Member".
//
// SECURITY INVARIANT (relied on by ~30 downstream consumers):
//   a MemberGuardianUser row with status='CONFIRMED'  ⇔  this user has active
//   guardian access to that member (bookings, documents, messages, billing,
//   parental controls).
//
// Phase 4 added the status qualifier — a PENDING row is a request and a REVOKED
// row is a removal we kept for the audit trail, and NEITHER grants anything.
// Read paths must filter with ACTIVE_GUARDIAN_LINK from lib/familyAccess.
//
// Therefore we must NEVER create that row unless access is actually
// authorized. The only self-service auto-link we allow is when the club
// owner has ALREADY named this exact person as the minor's guardian
// (they typed the email into Member.guardianEmail when adding the athlete).
// Every other request goes into an owner-approval queue and grants nothing
// until the owner confirms.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK, GUARDIAN_LINK_SOURCE } from "@/lib/familyAccess";

// PendingApproval.kind for an owner-reviewed guardian-link request. Kept
// distinct from the member-side ApprovalKind values (CLASS_BOOK, …) so it
// is only ever surfaced/actioned on the owner side, never in a member's
// family-approvals card.
export const GUARDIAN_LINK_KIND = "GUARDIAN_LINK" as const;

type ChildRef = { id: string; isMinor: boolean; guardianEmail: string | null };

// Owner-vouched ⇔ the owner already designated this email as the minor's
// guardian. Only then is a no-questions-asked auto-link safe.
export function isOwnerVouched(child: ChildRef, requesterEmail: string | null): boolean {
  const onFile = child.guardianEmail?.toLowerCase().trim() || null;
  const requester = requesterEmail?.toLowerCase().trim() || null;
  return !!child.isMinor && !!onFile && !!requester && onFile === requester;
}

export type GuardianLinkResult = { status: "linked" } | { status: "pending" };

// Single source of truth shared by the authenticated link-child route and
// the (unauthenticated) PARENT signup branch, so both enforce the identical
// gate. Returns "linked" when access was granted, "pending" when it was
// queued for owner approval (no access granted).
export async function requestGuardianLink(args: {
  clubId: string;
  requestingUserId: string;
  requestingUserEmail: string | null;
  child: ChildRef;
  relationship: string | null;
}): Promise<GuardianLinkResult> {
  const { clubId, requestingUserId, requestingUserEmail, child, relationship } = args;

  if (isOwnerVouched(child, requestingUserEmail)) {
    await prisma.memberGuardianUser.upsert({
      where: { userId_memberId: { userId: requestingUserId, memberId: child.id } },
      // Re-requesting an access that was revoked must not silently restore it —
      // only refresh the label. Restoring access is an explicit owner action.
      update: { relationship: relationship || null },
      create: {
        clubId: clubId,
        userId: requestingUserId,
        memberId: child.id,
        relationship: relationship || null,
        status: "CONFIRMED",
        source: GUARDIAN_LINK_SOURCE.OWNER_VOUCHED,
        confirmedAt: new Date(),
      },
    });
    await ensurePrimaryGuardian(child.id);
    return { status: "linked" };
  }

  // Not vouched → queue for the owner. Don't stack duplicate PENDING rows
  // for the same requester+child; refresh nothing if one already exists.
  const existing = await prisma.pendingApproval.findMany({
    where: { clubId, memberId: child.id, kind: GUARDIAN_LINK_KIND, status: "PENDING" },
    select: { payload: true },
  });
  const alreadyRequested = existing.some(
    (row) => (row.payload as { requestingUserId?: string } | null)?.requestingUserId === requestingUserId,
  );

  if (!alreadyRequested) {
    await prisma.pendingApproval.create({
      data: {
        clubId,
        memberId: child.id,
        kind: GUARDIAN_LINK_KIND,
        payload: {
          requestingUserId,
          requestingUserEmail: requestingUserEmail || null,
          relationship: relationship || null,
        } as Prisma.InputJsonValue,
        status: "PENDING",
      },
    });
  }

  return { status: "pending" };
}

// A member must always have exactly one primary guardian once anyone is linked,
// otherwise nobody can edit that child's parental controls. Call after creating
// a link: promotes the earliest CONFIRMED link when no primary exists yet.
// No-op when a primary is already set, so it never steals the role.
export async function ensurePrimaryGuardian(memberId: string): Promise<void> {
  const existing = await prisma.memberGuardianUser.findFirst({
    where: { memberId, isPrimary: true, ...ACTIVE_GUARDIAN_LINK },
    select: { id: true },
  });
  if (existing) return;

  const earliest = await prisma.memberGuardianUser.findFirst({
    where: { memberId, ...ACTIVE_GUARDIAN_LINK },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (earliest) {
    await prisma.memberGuardianUser.update({
      where: { id: earliest.id },
      data: { isPrimary: true },
    });
  }
}

// ── Primary guardian ─────────────────────────────────────────────────────────
// "The first guardian sets the controls." Co-guardians get full portal access —
// schedule, bookings, documents, billing — but cannot change parental controls
// or invite further guardians.
//
// This used to be DERIVED on every read: match Member.guardianEmail against the
// user's login email, else fall back to the earliest link. That derivation is
// what the Lister incident exposed — `guardianEmail` is a free-text contact
// string that can point at an address the parent never uses, so primary status
// could silently sit with the wrong account (or nobody). Phase 4 stores it on
// MemberGuardianUser.isPrimary; migration 20260803000000_family_accounts froze
// the old derivation into the column once, so no existing family changed hands.
//
// One source of truth now: the column. If a member somehow has no primary (only
// possible for links created outside the normal paths), fall back to the
// earliest CONFIRMED link rather than returning false for everyone — a family
// with no primary guardian can otherwise never edit its own controls.
export async function isPrimaryGuardian(userId: string, memberId: string): Promise<boolean> {
  const primary = await prisma.memberGuardianUser.findFirst({
    where: { memberId, isPrimary: true, ...ACTIVE_GUARDIAN_LINK },
    select: { userId: true },
  });
  if (primary) return primary.userId === userId;

  const earliest = await prisma.memberGuardianUser.findFirst({
    where: { memberId, ...ACTIVE_GUARDIAN_LINK },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  return earliest?.userId === userId;
}
