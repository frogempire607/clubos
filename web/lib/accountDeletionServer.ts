// Reads the facts for, and carries out, a person deleting THEIR OWN account.
// The rules live in lib/accountDeletion.ts (pure, tested); this file is the
// database half.
//
// It only ever acts on the signed-in user's own row and on things that hang
// off it. A club removing a member or a staff member is a different action
// with different authority: see /api/members/[id] and /api/staff/[id].

import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MEMBERSHIP_CANCEL_KIND } from "@/lib/approvals";
import { GUARDIAN_LINK_STATUS } from "@/lib/familyAccess";
import { invalidatePermissionCache } from "@/lib/apiGuard";
import { releaseRemovedStaff } from "@/lib/classStaffServer";
import { recordStaffActivity } from "@/lib/staffActivity";
import {
  planAccountDeletion,
  tombstoneEmail,
  type AccountDeletionFacts,
  type AccountDeletionPlan,
  type AccountRole,
} from "@/lib/accountDeletion";

const LIVE_SUB = ["active", "past_due"];

type LiveCardSub = {
  id: string;
  memberId: string;
  stripeSubscriptionId: string;
  price: Prisma.Decimal | null;
  optionLabel: string | null;
  athleteName: string;
  planName: string;
};

type Loaded = {
  facts: AccountDeletionFacts;
  ownMemberId: string | null;
  liveCardSubs: LiveCardSub[];
};

/** Everything `planAccountDeletion` needs, for one user in one club. */
export async function loadAccountDeletion(userId: string, clubId: string): Promise<Loaded | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, clubId, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!user) return null;

  const [otherOwners, ownMember, links] = await Promise.all([
    user.role === "OWNER"
      ? prisma.user.count({ where: { clubId, role: "OWNER", deletedAt: null, id: { not: userId } } })
      : Promise.resolve(0),
    prisma.member.findFirst({ where: { userId, clubId, deletedAt: null }, select: { id: true, firstName: true, lastName: true } }),
    prisma.memberGuardianUser.findMany({
      where: { userId, status: GUARDIAN_LINK_STATUS.CONFIRMED, member: { clubId, deletedAt: null } },
      select: { memberId: true, member: { select: { id: true, firstName: true, lastName: true, responsiblePayerUserId: true } } },
    }),
  ]);

  const childIds = links.map((l) => l.memberId);
  const [otherGuardianRows, subs] = await Promise.all([
    childIds.length
      ? prisma.memberGuardianUser.groupBy({
          by: ["memberId"],
          where: {
            memberId: { in: childIds },
            status: GUARDIAN_LINK_STATUS.CONFIRMED,
            userId: { not: userId },
            user: { deletedAt: null },
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as { memberId: string; _count: { _all: number } }[]),
    // Card-billed memberships this person holds (their own profile) or pays for
    // (a child's). The SUBSCRIPTION names its payer — see the repo CLAUDE.md on
    // why a member-level field is not the answer — with the member's standing
    // payer as the fallback for rows written before payerUserId existed.
    prisma.memberSubscription.findMany({
      where: {
        status: { in: LIVE_SUB },
        stripeSubscriptionId: { not: null },
        member: { clubId, deletedAt: null },
        OR: [
          ...(ownMember ? [{ memberId: ownMember.id }] : []),
          ...(childIds.length
            ? [{ memberId: { in: childIds }, OR: [{ payerUserId: userId }, { payerUserId: null, member: { responsiblePayerUserId: userId } }] }]
            : []),
          { payerUserId: userId },
        ],
      },
      select: {
        id: true, memberId: true, stripeSubscriptionId: true, price: true, optionLabel: true,
        member: { select: { firstName: true, lastName: true } },
        membership: { select: { name: true } },
      },
    }),
  ]);

  const liveCardSubs: LiveCardSub[] = subs
    .filter((s): s is typeof s & { stripeSubscriptionId: string } => !!s.stripeSubscriptionId)
    .map((s) => ({
      id: s.id,
      memberId: s.memberId,
      stripeSubscriptionId: s.stripeSubscriptionId,
      price: s.price,
      optionLabel: s.optionLabel,
      athleteName: `${s.member.firstName} ${s.member.lastName}`.trim(),
      planName: s.membership?.name ?? "Membership",
    }));

  return {
    ownMemberId: ownMember?.id ?? null,
    liveCardSubs,
    facts: {
      role: user.role as AccountRole,
      otherOwners,
      hasOwnMemberProfile: !!ownMember,
      children: links.map((l) => ({
        name: `${l.member.firstName} ${l.member.lastName}`.trim(),
        otherGuardians: otherGuardianRows.find((r) => r.memberId === l.memberId)?._count._all ?? 0,
      })),
      liveCardMemberships: liveCardSubs.map((s) => ({ athleteName: s.athleteName, planName: s.planName })),
    },
  };
}

export type DeleteOwnAccountResult =
  | { ok: true; plan: AccountDeletionPlan; cancelRequestsFiled: number }
  | { ok: false; status: 404 | 409; error: string; plan?: AccountDeletionPlan };

/**
 * Delete the signed-in user's own account. Idempotent in effect: a second
 * call finds no live user and answers 404.
 */
export async function deleteOwnAccount(input: { userId: string; clubId: string; actorName?: string | null }): Promise<DeleteOwnAccountResult> {
  const loaded = await loadAccountDeletion(input.userId, input.clubId);
  if (!loaded) return { ok: false, status: 404, error: "This account no longer exists." };
  const plan = planAccountDeletion(loaded.facts);
  if (!plan.allowed) return { ok: false, status: 409, error: plan.blockedReason ?? "This account can't be deleted yet.", plan };

  const { userId, clubId } = input;
  const now = new Date();
  const role = loaded.facts.role;
  const ownMemberKeepsBilling = loaded.liveCardSubs.some((s) => s.memberId === loaded.ownMemberId);

  // ── 1. Tell the club about any membership still being charged ────────────
  // Before the login goes, while "who asked" can still be recorded. Never
  // cancels anything itself: the club approves cancellations, as it does for
  // every other cancellation request.
  let cancelRequestsFiled = 0;
  for (const sub of loaded.liveCardSubs) {
    const open = await prisma.pendingApproval.findMany({
      where: { clubId, memberId: sub.memberId, kind: MEMBERSHIP_CANCEL_KIND, status: "PENDING" },
      select: { payload: true },
    });
    const already = open.some((a) => (a.payload as { subscriptionId?: string } | null)?.subscriptionId === sub.id);
    if (already) continue;
    await prisma.pendingApproval.create({
      data: {
        clubId,
        memberId: sub.memberId,
        kind: MEMBERSHIP_CANCEL_KIND,
        amount: sub.price,
        payload: {
          subscriptionId: sub.id,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          optionLabel: sub.optionLabel,
          requestingUserId: userId,
          reason: "The account holder deleted their account. Their login is gone; this membership is still being charged until you decide.",
          source: "ACCOUNT_DELETED",
        } as Prisma.InputJsonValue,
        status: "PENDING",
      },
    });
    cancelRequestsFiled++;
  }

  // ── 2. The account itself, in one transaction ────────────────────────────
  await prisma.$transaction(async (tx) => {
    // Guardian access ends. REVOKED, not deleted: the link is the audit trail
    // of who could act for this child and until when.
    await tx.memberGuardianUser.updateMany({
      where: { userId, status: { in: [GUARDIAN_LINK_STATUS.CONFIRMED, GUARDIAN_LINK_STATUS.PENDING] } },
      data: { status: GUARDIAN_LINK_STATUS.REVOKED },
    });

    // Their own athlete profile. The members_userId index is global, so the
    // slot is always released. The row is archived — unless a card is still
    // being charged for it, in which case it must stay visible to the club
    // (archiving a member whose card is still running is the bug this whole
    // module exists to end).
    await tx.member.updateMany({
      where: { userId, deletedAt: null },
      data: ownMemberKeepsBilling ? { userId: null } : { deletedAt: now, userId: null },
    });

    if (role !== "MEMBER") {
      await tx.staffProfile.updateMany({ where: { userId }, data: { showOnPortal: false } });
      await tx.staffCalendarFeed.deleteMany({ where: { clubId, userId } });
    }

    // The login. Not a deactivation: the email is released, the password is
    // replaced with one nobody holds, and nothing can sign in as this row
    // again. Staff keep their name on the row because payments, classes and
    // payroll point at it; a member's login name is removed.
    await tx.user.update({
      where: { id: userId },
      data: {
        deletedAt: now,
        email: tombstoneEmail(userId),
        passwordHash: `deleted:${randomBytes(32).toString("hex")}`,
        resetToken: null,
        resetExpires: null,
        dashboardWidgets: Prisma.DbNull,
        ...(role === "MEMBER" ? { firstName: "Deleted", lastName: "account" } : {}),
      },
    });
  });
  invalidatePermissionCache(userId);

  // ── 3. Staff and owners: hand their classes back ─────────────────────────
  // Access has already ended, so a failure here is logged, never surfaced as
  // "your account was not deleted".
  if (role !== "MEMBER") {
    try {
      await releaseRemovedStaff(prisma, { clubId, userId, byUserId: userId });
      await recordStaffActivity({
        clubId,
        staffUserId: userId,
        actorUserId: userId,
        actorName: input.actorName ?? null,
        kind: "ACCOUNT",
        summary: "Deleted their own account — sign-in ended, future class days released",
      });
    } catch (err) {
      console.error("[account deletion] could not release staff schedule", err);
    }
  }

  return { ok: true, plan, cancelRequestsFiled };
}
