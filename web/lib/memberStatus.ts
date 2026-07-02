import { prisma } from "@/lib/prisma";

// Prospects auto-expire to INACTIVE this many days after they were added if
// they never converted to an active membership.
export const PROSPECT_TTL_DAYS = 30;

/**
 * Recompute a member's `status` based on whether they have any active membership
 * subscription. Rules:
 *   - At least one MemberSubscription with status="active" → member status="ACTIVE"
 *   - No active subscription, current status was "ACTIVE"  → demote to "INACTIVE"
 *   - PROSPECT older than PROSPECT_TTL_DAYS with no active sub → "INACTIVE"
 *   - PROSPECT within the window (no sub) is preserved
 *   - PAUSED is owner-controlled and is preserved
 *
 * Call this after a subscription's status changes (Stripe webhook), or after
 * a manual subscription update.
 */
export async function recomputeMemberStatus(memberId: string, clubId: string): Promise<void> {
  // Defense-in-depth: every caller already resolved memberId from a clubId-
  // scoped lookup, but enforce it here too so a future caller can't leak
  // tenancy by passing a foreign memberId.
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId },
    select: { id: true, status: true, joinedAt: true, createdAt: true, migrationStatus: true },
  });
  if (!member) return;
  // PAUSED is sticky — owner controls that explicitly.
  if (member.status === "PAUSED") return;

  const activeCount = await prisma.memberSubscription.count({
    where: { memberId, status: "active" },
  });

  let next: "ACTIVE" | "INACTIVE" | "PROSPECT" | null = null;
  if (activeCount > 0) {
    if (member.status !== "ACTIVE") next = "ACTIVE";
  } else {
    if (member.status === "ACTIVE") {
      next = "INACTIVE";
    } else if (member.status === "PROSPECT" && !member.migrationStatus) {
      // Members in the migration/onboarding lifecycle are NOT funnel prospects —
      // they sit as PROSPECT only until activation/approval, which can take
      // longer than the TTL. Never decay them to INACTIVE while they wait.
      const since = member.joinedAt ?? member.createdAt;
      const ageDays = (Date.now() - new Date(since).getTime()) / 86_400_000;
      if (ageDays >= PROSPECT_TTL_DAYS) next = "INACTIVE";
    }
  }

  if (next) {
    await prisma.member.update({ where: { id: memberId }, data: { status: next } });
  }
}

/**
 * Sweep a club's stale prospects to INACTIVE. Cheap to call lazily whenever the
 * members list is loaded so the dashboard self-heals without a cron job.
 */
export async function expireStaleProspects(clubId: string): Promise<number> {
  const cutoff = new Date(Date.now() - PROSPECT_TTL_DAYS * 86_400_000);
  const stale = await prisma.member.findMany({
    where: {
      clubId,
      deletedAt: null,
      status: "PROSPECT",
      // Migrated/onboarding members (any migrationStatus) are exempt — they are
      // existing members mid-switch, not stale leads, and activation can take
      // longer than the TTL. Only true never-had-a-membership prospects decay.
      migrationStatus: null,
      joinedAt: { lt: cutoff },
      subscriptions: { none: { status: "active" } },
    },
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  await prisma.member.updateMany({
    where: { id: { in: stale.map((m) => m.id) } },
    data: { status: "INACTIVE" },
  });
  return stale.length;
}
