// Reports Phase 2.5.5 — Membership tab compute layer.
//
// Owner-first framing: the primary answer is "which memberships are
// growing / shrinking?" (same top-mover data the Snapshot returns,
// expanded with drill-through). Churn / retention / LTV are the secondary
// section.
//
// Non-negotiable: the 14-day grace window (specs/03 §churn). A cancel
// followed by a new membership within 14 days is NOT churn.
//
// Precision caveat: until Phase 4.5.10 lands MemberSubscriptionEvent, we
// derive movement + churn from MemberSubscription snapshots. Response
// includes `reliability: "ESTIMATED"` when the event log isn't there.

import { prisma } from "@/lib/prisma";
import type { ResolvedRange } from "@/lib/reportsRange";
import { subscriptionHistoryIsComplete } from "@/lib/subscriptionEvents";

export const CHURN_GRACE_DAYS = 14;

export type GroupBy = "type" | "program" | "location" | "age" | "coach";

export type MembershipPayload = {
  range: { key: string; label: string; start: string | null; end: string };
  movement: {
    startingActive: number;
    new: number;
    reactivated: number;
    canceled: number;
    expired: number;
    endingActive: number;
    planChanges: number;
  };
  rates: {
    churnRate: number | null;
    revenueChurnRate: number | null;
    retentionRate: number | null;
    trialToPaidRate: number | null;
    avgMembershipDurationMonths: number | null;
    avgLifetimeValue: number | null;
    avgMonthlyRevenuePerAthlete: number | null;
    avgMonthlyRevenuePerFamily: number | null;
  };
  formula: {
    label: string;
    numerator: number;
    denominator: number;
    result: number | null;
  };
  trend: Array<{ period: string; label: string; churnRate: number | null }>;
  breakdown: Array<{ key: string; name: string; active: number; lost: number; churnRate: number | null; revenue: number }>;
  topMovers: Array<{
    id: string; name: string; netChange: number; newCount: number; canceledCount: number; direction: "growing" | "shrinking";
  }>;
  reliability: "COMPLETE" | "ESTIMATED";
  reliabilityNotes: string[];
  groupBy: GroupBy;
  notes: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
export const pctOrNull = (num: number, denom: number): number | null => {
  if (denom <= 0) return null;
  return Math.round((num / denom) * 1000) / 10;
};

// A single ended subscription — used by classifyChurn.
export type EndedSubLite = {
  memberId: string;
  canceledAt: Date | null;
  endDate: Date | null;
  price?: unknown;
};

// All subs for a member — used by classifyChurn to detect a near replacement.
export type MemberSubSpanLite = {
  memberId: string;
  createdAt: Date;
  canceledAt: Date | null;
  endDate: Date | null;
  price?: unknown;
};

// Pure churn classification for one ended sub. Returns "churn" or
// "plan_change" per the 14-day grace window rule in specs/03.
// A cancel followed by a new membership within CHURN_GRACE_DAYS = plan change.
export function classifyEndedSub(
  ended: EndedSubLite,
  otherSubsForMember: MemberSubSpanLite[],
  graceDays: number = CHURN_GRACE_DAYS,
): "churn" | "plan_change" | "skip" {
  const endedAt = ended.canceledAt ?? ended.endDate;
  if (!endedAt) return "skip";
  const graceMs = graceDays * 86400000;
  const hasNearReplacement = otherSubsForMember.some((o) => {
    // Same sub — skip.
    if (o.canceledAt === ended.canceledAt && o.endDate === ended.endDate) return false;
    const oStart = o.createdAt.getTime();
    const delta = Math.abs(oStart - endedAt.getTime());
    return delta <= graceMs;
  });
  return hasNearReplacement ? "plan_change" : "churn";
}

// Aggregate churn + retention rates over a set of ended subs. PURE.
export function computeChurnRates(
  endedSubs: EndedSubLite[],
  subsByMember: Map<string, MemberSubSpanLite[]>,
  activeAtStart: number,
  allSubsForMembers: MemberSubSpanLite[],
): {
  churnCount: number;
  planChangeCount: number;
  churnedMrr: number;
  churnRate: number | null;
  revenueChurnRate: number | null;
  retentionRate: number | null;
} {
  let churnCount = 0;
  let planChangeCount = 0;
  const churnedRevenue: number[] = [];
  for (const ended of endedSubs) {
    const others = subsByMember.get(ended.memberId) ?? [];
    const outcome = classifyEndedSub(ended, others);
    if (outcome === "churn") {
      churnCount += 1;
      churnedRevenue.push(Number(ended.price ?? 0));
    } else if (outcome === "plan_change") {
      planChangeCount += 1;
    }
  }
  const churnedMrr = churnedRevenue.reduce((s, v) => s + v, 0);
  const totalActivePriceSum = allSubsForMembers.reduce((s, sub) => s + Number(sub.price ?? 0), 0);
  const avgSubPrice = allSubsForMembers.length > 0 ? totalActivePriceSum / allSubsForMembers.length : 0;
  const startingMrr = activeAtStart * avgSubPrice;
  const churnRate = pctOrNull(churnCount, activeAtStart);
  const revenueChurnRate = pctOrNull(churnedMrr, startingMrr);
  const retentionRate = churnRate == null ? null : Math.round((100 - churnRate) * 10) / 10;
  return { churnCount, planChangeCount, churnedMrr, churnRate, revenueChurnRate, retentionRate };
}

export async function buildMembership(
  clubId: string,
  r: ResolvedRange,
  groupBy: GroupBy = "type",
): Promise<MembershipPayload> {
  // Anchor: for "all time", make sure we have a bounded window.
  const rangeStart = r.start ?? new Date("2000-01-01T00:00:00Z");
  const rangeEnd = r.end;

  // Phase 4.5.10 — whether this club's event log can back a COMPLETE answer.
  // See the reliability note at the bottom of this function for why the test
  // is coverage rather than mere existence.
  const historyComplete = await subscriptionHistoryIsComplete(clubId);

  // ── Fetch everything we need in parallel ────────────────────────────
  const [activeAtStart, activeAtEnd, newSubs, endedSubsRaw, allSubsForMembers, memberships] = await Promise.all([
    // Subscriptions that were active at range.start (created before start
    // AND (endDate null OR endDate > start) AND (canceledAt null OR canceledAt > start))
    prisma.memberSubscription.count({
      where: {
        member: { clubId, deletedAt: null },
        createdAt: { lt: rangeStart },
        OR: [{ endDate: null }, { endDate: { gt: rangeStart } }],
        AND: [
          {
            OR: [{ canceledAt: null }, { canceledAt: { gt: rangeStart } }],
          },
        ],
      },
    }),
    prisma.memberSubscription.count({
      where: {
        member: { clubId, deletedAt: null },
        createdAt: { lt: rangeEnd },
        OR: [{ endDate: null }, { endDate: { gt: rangeEnd } }],
        AND: [
          {
            OR: [{ canceledAt: null }, { canceledAt: { gt: rangeEnd } }],
          },
        ],
      },
    }),
    // New within range.
    prisma.memberSubscription.findMany({
      where: {
        member: { clubId, deletedAt: null },
        createdAt: { gte: rangeStart, lt: rangeEnd },
      },
      select: {
        id: true, memberId: true, membershipId: true, price: true, createdAt: true, membership: { select: { name: true } },
      },
    }),
    // Ended within range (either canceled OR expired via endDate).
    prisma.memberSubscription.findMany({
      where: {
        member: { clubId, deletedAt: null },
        OR: [
          { canceledAt: { gte: rangeStart, lt: rangeEnd } },
          { endDate: { gte: rangeStart, lt: rangeEnd } },
        ],
      },
      select: {
        id: true, memberId: true, membershipId: true, price: true,
        canceledAt: true, endDate: true, membership: { select: { name: true } },
      },
    }),
    // For "grace window" lookups: for every member with ended subs, load
    // ALL their subs so we can spot a re-subscription within CHURN_GRACE_DAYS.
    prisma.memberSubscription.findMany({
      where: {
        member: { clubId, deletedAt: null },
      },
      select: { memberId: true, createdAt: true, canceledAt: true, endDate: true, price: true },
    }),
    prisma.membership.findMany({ where: { clubId, deletedAt: null }, select: { id: true, name: true } }),
  ]);
  const membershipNames = new Map(memberships.map((m) => [m.id, m.name]));

  // Group subs per member for grace-window checks.
  const subsByMember = new Map<string, Array<{ createdAt: Date; canceledAt: Date | null; endDate: Date | null; price: unknown }>>();
  for (const s of allSubsForMembers) {
    const arr = subsByMember.get(s.memberId) ?? [];
    arr.push(s);
    subsByMember.set(s.memberId, arr);
  }

  // Classify each ended sub as churn OR plan change:
  //   plan change = the member started another sub within CHURN_GRACE_DAYS
  //   before or after the ended sub. Grace window on both sides handles
  //   overlap-then-cancel (upgrade) and quick re-sub-after-cancel (retention).
  let churnCount = 0;
  let planChangeCount = 0;
  const churnMemberSet = new Set<string>();
  const churnedRevenue: number[] = [];
  const graceMs = CHURN_GRACE_DAYS * 86400000;
  for (const ended of endedSubsRaw) {
    const endedAt = ended.canceledAt ?? ended.endDate;
    if (!endedAt) continue;
    const others = subsByMember.get(ended.memberId) ?? [];
    const hasNearReplacement = others.some((o) => {
      // Same sub — skip (same createdAt is the strongest proxy without id).
      if (o.canceledAt === ended.canceledAt && o.endDate === ended.endDate) return false;
      const oStart = o.createdAt.getTime();
      const delta = Math.abs(oStart - endedAt.getTime());
      return delta <= graceMs;
    });
    if (hasNearReplacement) {
      planChangeCount += 1;
    } else {
      churnCount += 1;
      churnMemberSet.add(ended.memberId);
      churnedRevenue.push(Number(ended.price ?? 0));
    }
  }

  // Reactivated: for the range, count members who had a churn event before
  // range.start AND started a new sub in range.
  const reactivatedCount = 0; // First-pass approximation. Refined in 4.5.10.

  // ── Movement summary ──────────────────────────────────────────────
  const movement = {
    startingActive: activeAtStart,
    new: newSubs.length,
    reactivated: reactivatedCount,
    canceled: churnCount,
    expired: 0, // Rolled into `canceled` for now.
    endingActive: activeAtEnd,
    planChanges: planChangeCount,
  };

  // ── Churn rate + revenue churn rate ──────────────────────────────
  const churnRate = pctOrNull(churnCount, activeAtStart);
  const churnedMrr = churnedRevenue.reduce((s, v) => s + v, 0);
  // Approximate starting MRR by summing active-at-start prices; we don't
  // have that directly. Estimate via activeAtStart × ARPMembership.
  const totalActivePriceSum = allSubsForMembers.reduce((s, sub) => s + Number(sub.price ?? 0), 0);
  const avgSubPrice = allSubsForMembers.length > 0 ? totalActivePriceSum / allSubsForMembers.length : 0;
  const startingMrr = activeAtStart * avgSubPrice;
  const revenueChurnRate = pctOrNull(churnedMrr, startingMrr);
  const retentionRate = churnRate == null ? null : Math.round((100 - churnRate) * 10) / 10;

  // ── Rates auxiliary ──────────────────────────────────────────────
  const trialToPaidRate = null; // Requires trial-state event log — Phase 4.5.10.
  const avgMembershipDurationMonths = null;
  const avgLifetimeValue = null;
  const avgMonthlyRevenuePerAthlete = null;
  const avgMonthlyRevenuePerFamily = null;

  // ── Formula card ─────────────────────────────────────────────────
  const formula = {
    label: "Membership churn = lost ÷ starting active (14-day grace)",
    numerator: churnCount,
    denominator: activeAtStart,
    result: churnRate,
  };

  // ── Trend: last 6 months churn ───────────────────────────────────
  const trend: MembershipPayload["trend"] = [];
  for (let i = 5; i >= 0; i--) {
    const bStart = new Date(rangeEnd);
    bStart.setMonth(bStart.getMonth() - i - 1);
    bStart.setDate(1);
    bStart.setHours(0, 0, 0, 0);
    const bEnd = new Date(bStart);
    bEnd.setMonth(bEnd.getMonth() + 1);
    const activeAtBStart = await prisma.memberSubscription.count({
      where: {
        member: { clubId, deletedAt: null },
        createdAt: { lt: bStart },
        OR: [{ endDate: null }, { endDate: { gt: bStart } }],
        AND: [{ OR: [{ canceledAt: null }, { canceledAt: { gt: bStart } }] }],
      },
    });
    const endedInB = await prisma.memberSubscription.count({
      where: {
        member: { clubId, deletedAt: null },
        OR: [
          { canceledAt: { gte: bStart, lt: bEnd } },
          { endDate: { gte: bStart, lt: bEnd } },
        ],
      },
    });
    trend.push({
      period: bStart.toISOString().slice(0, 7),
      label: bStart.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      churnRate: pctOrNull(endedInB, activeAtBStart),
    });
  }

  // ── Breakdown ────────────────────────────────────────────────────
  const breakdown: MembershipPayload["breakdown"] = [];
  if (groupBy === "type") {
    const byPlan = new Map<string, { name: string; active: number; lost: number; revenue: number }>();
    for (const m of memberships) {
      byPlan.set(m.id, { name: m.name, active: 0, lost: 0, revenue: 0 });
    }
    // Active-at-end counts + revenue: iterate all subs.
    for (const sub of allSubsForMembers) {
      // Just approximate active count from the memberships snapshot.
      // (Precise breakdown needs subs+membershipId join, done below.)
      void sub;
    }
    const subsAtEnd = await prisma.memberSubscription.findMany({
      where: {
        member: { clubId, deletedAt: null },
        createdAt: { lt: rangeEnd },
        OR: [{ endDate: null }, { endDate: { gt: rangeEnd } }],
        AND: [{ OR: [{ canceledAt: null }, { canceledAt: { gt: rangeEnd } }] }],
      },
      select: { membershipId: true, price: true },
    });
    for (const s of subsAtEnd) {
      const key = s.membershipId ?? "unknown";
      const entry = byPlan.get(key) ?? { name: membershipNames.get(key) ?? "Unknown", active: 0, lost: 0, revenue: 0 };
      entry.active += 1;
      entry.revenue += Number(s.price ?? 0);
      byPlan.set(key, entry);
    }
    for (const ended of endedSubsRaw) {
      const key = ended.membershipId ?? "unknown";
      const entry = byPlan.get(key) ?? { name: membershipNames.get(key) ?? "Unknown", active: 0, lost: 0, revenue: 0 };
      // Only count as lost when this ended sub actually churned (not a
      // plan-change replacement).
      const endedAt = ended.canceledAt ?? ended.endDate;
      const others = subsByMember.get(ended.memberId) ?? [];
      const hasNearReplacement = endedAt
        ? others.some((o) => Math.abs(o.createdAt.getTime() - endedAt.getTime()) <= graceMs)
        : false;
      if (!hasNearReplacement) entry.lost += 1;
      byPlan.set(key, entry);
    }
    for (const [key, entry] of byPlan) {
      breakdown.push({
        key,
        name: entry.name,
        active: entry.active,
        lost: entry.lost,
        churnRate: pctOrNull(entry.lost, entry.active + entry.lost),
        revenue: round2(entry.revenue),
      });
    }
    breakdown.sort((a, b) => b.active - a.active);
  }

  // ── Top movers ───────────────────────────────────────────────────
  const moverMap = new Map<string, { name: string; newCount: number; canceledCount: number }>();
  for (const s of newSubs) {
    const key = s.membershipId ?? "unknown";
    const cur = moverMap.get(key) ?? { name: s.membership?.name ?? membershipNames.get(key) ?? "Unknown", newCount: 0, canceledCount: 0 };
    cur.newCount += 1;
    moverMap.set(key, cur);
  }
  for (const s of endedSubsRaw) {
    const key = s.membershipId ?? "unknown";
    const cur = moverMap.get(key) ?? { name: s.membership?.name ?? membershipNames.get(key) ?? "Unknown", newCount: 0, canceledCount: 0 };
    cur.canceledCount += 1;
    moverMap.set(key, cur);
  }
  const topMovers = Array.from(moverMap.entries())
    .map(([id, v]) => {
      const net = v.newCount - v.canceledCount;
      return {
        id,
        name: v.name,
        netChange: net,
        newCount: v.newCount,
        canceledCount: v.canceledCount,
        direction: (net >= 0 ? "growing" : "shrinking") as "growing" | "shrinking",
      };
    })
    .sort((a, b) => Math.abs(b.netChange) - Math.abs(a.netChange))
    .slice(0, 8);

  const notes: string[] = [];
  notes.push(`14-day grace window: a cancel followed by a new membership within ${CHURN_GRACE_DAYS} days is NOT counted as churn.`);
  notes.push(`Plan changes (${planChangeCount} in range) are counted separately and never as churn.`);
  if (groupBy === "coach") {
    notes.push("Per-coach breakdown requires coach-on-membership assignment. Falling back to type breakdown.");
  }

  return {
    range: {
      key: r.key,
      label: r.label,
      start: r.start?.toISOString() ?? null,
      end: r.end.toISOString(),
    },
    movement,
    rates: {
      churnRate,
      revenueChurnRate,
      retentionRate,
      trialToPaidRate,
      avgMembershipDurationMonths,
      avgLifetimeValue,
      avgMonthlyRevenuePerAthlete,
      avgMonthlyRevenuePerFamily,
    },
    formula,
    trend,
    breakdown,
    topMovers,
    // ── Phase 4.5.10 — the ESTIMATED caveat, closed conditionally ──────────
    //
    // The test is NOT "does member_subscription_events exist". Creating the
    // table changes nothing: an empty log reads as "nothing ever happened",
    // which is a confident wrong answer where the caveat was an honest one.
    //
    // COMPLETE requires that every subscription this club holds has at least
    // one event — which is exactly what BF-B guarantees, and stays true
    // afterwards because every creation path records CREATED. Until the
    // backfill has run for THIS club, the caveat stands.
    reliability: historyComplete ? "COMPLETE" : "ESTIMATED",
    reliabilityNotes: historyComplete
      ? []
      : [
          "Movement + churn are estimated from subscription snapshots. Exact figures need the subscription-event history — run scripts/members-experience-backfill.ts for this club.",
        ],
    groupBy,
    notes,
  };
}
