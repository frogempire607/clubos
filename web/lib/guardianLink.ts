// Shared authorization for "a User wants guardian access to a Member".
//
// SECURITY INVARIANT (relied on by ~10 downstream consumers):
//   a MemberGuardianUser row exists  ⇔  this user has active guardian access
//   to that member (bookings, documents, messages, billing, parental controls).
//
// Therefore we must NEVER create that row unless access is actually
// authorized. The only self-service auto-link we allow is when the club
// owner has ALREADY named this exact person as the minor's guardian
// (they typed the email into Member.guardianEmail when adding the athlete).
// Every other request goes into an owner-approval queue and grants nothing
// until the owner confirms.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
      update: { relationship: relationship || null },
      create: { userId: requestingUserId, memberId: child.id, relationship: relationship || null },
    });
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
