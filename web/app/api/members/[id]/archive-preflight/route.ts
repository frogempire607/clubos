// GET /api/members/[id]/archive-preflight
//
// Everything attached to this member, so the confirmation dialog can state
// what happens instead of asking someone to take it on faith.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import {
  deletionBlocks,
  deletionWarnings,
  deletionPreserved,
  confirmationPhrase,
  type AttachedRecords,
} from "@/lib/memberDeletion";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, userId: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [
    transactions,
    succeededTransactions,
    activeSubs,
    liveStripeSubs,
    guardianLinks,
    guardedByThisMember,
    emailSends,
    documentSignatures,
    attendanceRecords,
    pendingApprovals,
  ] = await Promise.all([
    prisma.transaction.count({ where: { memberId: id } }),
    prisma.transaction.count({ where: { memberId: id, status: "SUCCEEDED", reconciliationStatus: { not: "VOID" } } }),
    prisma.memberSubscription.count({ where: { memberId: id, status: "active" } }),
    prisma.memberSubscription.count({
      where: { memberId: id, status: "active", stripeSubscriptionId: { not: null } },
    }),
    prisma.memberGuardianUser.count({ where: { memberId: id, ...ACTIVE_GUARDIAN_LINK } }),
    // Athletes this person is a guardian FOR — they keep their guardian.
    member.userId
      ? prisma.memberGuardianUser.count({
          where: { userId: member.userId, ...ACTIVE_GUARDIAN_LINK, member: { deletedAt: null, id: { not: id } } },
        })
      : Promise.resolve(0),
    prisma.emailSend.count({ where: { recipientMemberId: id, clubId: session.user.clubId } }),
    prisma.documentSignature.count({ where: { memberId: id } }),
    prisma.attendanceRecord.count({ where: { memberId: id } }),
    prisma.pendingApproval.count({ where: { memberId: id, clubId: session.user.clubId, status: "PENDING" } }),
  ]);

  const attached: AttachedRecords = {
    transactions,
    succeededTransactions,
    activeSubscriptions: activeSubs,
    guardianLinks,
    guardedByThisMember,
    emailSends,
    documentSignatures,
    attendanceRecords,
    pendingApprovals,
    hasLogin: !!member.userId,
    hasLiveStripeSubscription: liveStripeSubs > 0,
  };

  const fullName = `${member.firstName} ${member.lastName}`.trim();
  return NextResponse.json({
    member: { id: member.id, fullName },
    attached,
    blocks: deletionBlocks(attached),
    warnings: deletionWarnings(attached),
    preserved: deletionPreserved(attached),
    confirmationPhrase: confirmationPhrase(fullName),
  });
}
