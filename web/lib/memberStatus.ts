import { prisma } from "@/lib/prisma";

// Status policy (owner-confirmed 2026-07-13):
//   - ACTIVE   = currently has an active membership subscription.
//   - INACTIVE = previously had a valid membership that ended.
//   - PROSPECT = has NEVER had a valid membership — regardless of how long
//     they've had an account or whether they have a saved payment method.
//     Prospects are NEVER auto-aged into INACTIVE (the old 30-day TTL decay
//     was removed deliberately; INACTIVE is reserved for lapsed members).
//   - PAUSED is owner-controlled and always preserved.

/**
 * Recompute a member's `status` from their subscriptions.
 * Call after a subscription's status changes (Stripe webhook, manual update,
 * expiry sweep).
 */
export async function recomputeMemberStatus(memberId: string, clubId: string): Promise<void> {
  // Defense-in-depth: every caller already resolved memberId from a clubId-
  // scoped lookup, but enforce it here too so a future caller can't leak
  // tenancy by passing a foreign memberId.
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId },
    select: { id: true, status: true },
  });
  if (!member) return;
  // PAUSED is sticky — owner controls that explicitly.
  if (member.status === "PAUSED") return;

  const activeCount = await prisma.memberSubscription.count({
    where: { memberId, status: "active" },
  });

  let next: "ACTIVE" | "INACTIVE" | null = null;
  if (activeCount > 0) {
    if (member.status !== "ACTIVE") next = "ACTIVE";
  } else if (member.status === "ACTIVE") {
    // Their membership ended — a former member, not a prospect.
    next = "INACTIVE";
  }
  // PROSPECT with no sub stays PROSPECT forever (never had a membership).

  if (next) {
    await prisma.member.update({ where: { id: memberId }, data: { status: next } });
  }
}

/**
 * Expire MANUAL non-renewing subscriptions whose end date has passed, then
 * recompute each affected member's status (ACTIVE → INACTIVE when nothing
 * else is active). Stripe-linked subscriptions are deliberately untouched —
 * Stripe owns their lifecycle via webhooks. Rows are marked `expired` with a
 * timestamp, never deleted. Cheap to call lazily when the members list loads
 * so the roster self-heals without a cron job.
 */
export async function expireEndedManualSubscriptions(clubId: string): Promise<number> {
  const ended = await prisma.memberSubscription.findMany({
    where: {
      member: { clubId, deletedAt: null },
      billingType: "MANUAL",
      status: "active",
      autoRenew: false,
      stripeSubscriptionId: null,
      endDate: { lt: new Date() },
    },
    select: { id: true, memberId: true },
  });
  if (ended.length === 0) return 0;

  await prisma.memberSubscription.updateMany({
    where: { id: { in: ended.map((s) => s.id) } },
    data: { status: "expired", expiredAt: new Date() },
  });
  for (const memberId of new Set(ended.map((s) => s.memberId))) {
    await recomputeMemberStatus(memberId, clubId);
  }
  return ended.length;
}
