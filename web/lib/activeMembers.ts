import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  LIVE_SUBSCRIPTION_STATUSES,
  summarizeActiveMembers,
  type ActiveMemberSummary,
} from "@/lib/billingDataRules";

/**
 * THE definition of "active members" for every headline number — dashboard,
 * reports, unit economics. Distinct members holding a live subscription, and
 * the live subscriptions themselves. Never `Member.status = ACTIVE`: that is a
 * lifecycle label with its own money-proof rule, and on 2026-09-28 it said 42
 * while 49 members held 53 live subscriptions.
 *
 * The rule itself lives in lib/billingDataRules (pure, tested). This is only
 * the query. scripts/subscription-truth-guard.ts GUARD E fails the build if a
 * new `member.count({ status: "ACTIVE" })` headline appears.
 */
export function liveSubscriptionWhere(clubId: string): Prisma.MemberSubscriptionWhereInput {
  return {
    status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
    // Same member scope as the roster: not deleted, not import-only history.
    member: { clubId, deletedAt: null, isHistoricalOnly: false },
  };
}

export async function countActiveMembers(clubId: string): Promise<ActiveMemberSummary> {
  const rows = await prisma.memberSubscription.findMany({
    where: liveSubscriptionWhere(clubId),
    select: { memberId: true, status: true },
  });
  return summarizeActiveMembers(rows);
}
