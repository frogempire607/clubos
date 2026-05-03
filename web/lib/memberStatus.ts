import { prisma } from "@/lib/prisma";

/**
 * Recompute a member's `status` based on whether they have any active membership
 * subscription. Rules:
 *   - At least one MemberSubscription with status="active" → member status="ACTIVE"
 *   - No active subscription, current status was "ACTIVE"      → demote to "INACTIVE"
 *   - PAUSED is owner-controlled and is preserved
 *   - PROSPECT (never had a sub) is preserved if there's no active sub
 *
 * Call this after a subscription's status changes (Stripe webhook), or after
 * a manual subscription update.
 */
export async function recomputeMemberStatus(memberId: string): Promise<void> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, status: true },
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
    if (member.status === "ACTIVE") next = "INACTIVE";
    // PROSPECT stays PROSPECT (they never had a sub) — don't downgrade unnecessarily
  }

  if (next) {
    await prisma.member.update({ where: { id: memberId }, data: { status: next } });
  }
}
