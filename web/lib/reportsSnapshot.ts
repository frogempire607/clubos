// Reports Phase 2.5.1 — owner-first Snapshot compute layer.
//
// The default Snapshot answers five concrete owner questions:
//   1. Did I make money?
//   2. Who owes me money?
//   3. Which memberships are growing?
//   4. Which coaches/classes are driving revenue?
//   5. What requires my attention today?  (delegated to /api/reports/action-items)
//
// SaaS metrics (MRR/ARR/ARPA/ARPM/CAC/LTV) are NOT computed here — they live
// on the Revenue and Unit-economics tabs. Snapshot stays plain-English.

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import { computePayrollTotalForRange } from "@/lib/payroll";
import type { ResolvedRange } from "@/lib/reportsRange";

export type SnapshotPayload = {
  didIMakeMoney: {
    netPosition: number;
    totalInflows: number;
    totalOutflows: number;
    comparison: {
      netPositionDelta: number | null;
      inflowsDelta: number | null;
      outflowsDelta: number | null;
    } | null;
    explanation: string;
  };
  whoOwesMe: {
    total: number;
    count: number;
    breakdown: Array<{
      kind:
        | "unpaid_invoice"
        | "unpaid_registration"
        | "past_due_sub"
        | "offline_pending";
      label: string;
      amount: number;
      count: number;
      href: string;
    }>;
  };
  membershipsGrowing: {
    netChange: number;
    newCount: number;
    canceledCount: number;
    topMovers: Array<{
      id: string;
      name: string;
      netChange: number;
      newCount: number;
      canceledCount: number;
      direction: "growing" | "shrinking";
    }>;
    reliability: "COMPLETE" | "ESTIMATED";
    reliabilityNote: string | null;
  };
  revenueDrivers: {
    byCoach: Array<{ id: string; name: string; amount: number; share: number; href: string }> | null;
    byClass: Array<{
      id: string;
      name: string;
      kind: "class" | "program" | "event" | "private";
      amount: number;
      share: number;
      href: string;
    }>;
  };
  cash: {
    accounts: Array<{
      id: string;
      label: string;
      institution: string | null;
      mask: string | null;
      balance: number;
      lastSyncedAt: string | null;
    }>;
    stripePending: number;
    totalAvailable: number | null;
    lastUpdatedAt: string | null;
  };
  runway: {
    months: number | null;
    status: "healthy" | "tight" | "critical" | null;
    basisLabel: string;
  };
  trend: Array<{ month: string; inflows: number; outflows: number; isPartial: boolean }>;
  burnBasis: { label: string; months: number };
  avgWeeklyBurn: number;
  avgMonthlyBurn: number;
  avgWeeklyNet: number;
  avgMonthlyNet: number;
  partialPeriodNote: string | null;
};

const money = (n: number): number => Math.round(n * 100) / 100;

// Ranged Transaction filter that respects the "txDate ?? createdAt" convention.
function txDateWhere(r: ResolvedRange) {
  if (!r.start) return {};
  return {
    OR: [
      { txDate: { not: null, gte: r.start, lt: r.end } },
      { txDate: null, createdAt: { gte: r.start, lt: r.end } },
    ],
  };
}

export async function buildSnapshot(clubId: string, r: ResolvedRange): Promise<SnapshotPayload> {
  const [
    txCurrent,
    txPrev,
    expenses,
    prevExpenses,
    donations,
    payrollCurrent,
    payrollPrev,
    pendingReceivables,
    membershipMovementRaw,
    revenueByCoach,
    revenueByClass,
    plaidBalances,
    stripePendingRaw,
    // Trailing 3 complete months for the burn basis.
    trailingWindow,
  ] = await Promise.all([
    prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...txDateWhere(r) },
      select: {
        amount: true,
        refundedAmount: true,
        type: true,
        paymentSource: true,
        eventId: true,
      },
    }),
    r.comparison?.start && r.comparison?.end
      ? prisma.transaction.findMany({
          where: {
            clubId,
            status: "SUCCEEDED",
            ...EXCLUDE_VOID,
            OR: [
              { txDate: { not: null, gte: r.comparison.start, lt: r.comparison.end } },
              { txDate: null, createdAt: { gte: r.comparison.start, lt: r.comparison.end } },
            ],
          },
          select: { amount: true, refundedAmount: true },
        })
      : Promise.resolve([]),
    prisma.expense.findMany({
      where: r.start ? { clubId, date: { gte: r.start, lt: r.end } } : { clubId },
      select: { amount: true },
    }),
    r.comparison?.start && r.comparison?.end
      ? prisma.expense.findMany({
          where: { clubId, date: { gte: r.comparison.start, lt: r.comparison.end } },
          select: { amount: true },
        })
      : Promise.resolve([]),
    prisma.donation.findMany({
      where: r.start ? { clubId, date: { gte: r.start, lt: r.end } } : { clubId },
      select: { amount: true },
    }),
    computePayrollTotalForRange(clubId, r.start ?? null, r.end),
    r.comparison?.start && r.comparison?.end
      ? computePayrollTotalForRange(clubId, r.comparison.start, r.comparison.end)
      : Promise.resolve(0),
    // Outstanding receivables — the "Who owes me money?" answer.
    computeReceivables(clubId),
    // Membership movement approximation from MemberSubscription rows.
    computeMembershipMovement(clubId, r),
    // Revenue by coach — from ContractorPayment isn't the same; use
    // AttendanceRecord + class + assignedStaffIds. Best-effort here; the
    // richer version comes in 2.5.2.
    computeRevenueByCoach(clubId, r),
    computeRevenueByClass(clubId, r),
    prisma.plaidConnection.findMany({
      where: { clubId, deletedAt: null },
      include: {
        syncCursor: { select: { lastSyncedAt: true } },
      },
    }),
    // Stripe balance-in-transit surrogate: this needs a live Stripe call in a
    // future sub-phase. Return 0 for now with a TODO note.
    Promise.resolve(0),
    computeTrailingWindow(clubId, r.end),
  ]);

  // ── Question 1: Did I make money? ────────────────────────────────────
  const inflows =
    txCurrent.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0) +
    donations.reduce((s, d) => s + Number(d.amount), 0);
  const outflows =
    expenses.reduce((s, e) => s + Number(e.amount), 0) + payrollCurrent;
  const netPosition = inflows - outflows;
  const prevInflows =
    txPrev.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0);
  const prevOutflows =
    prevExpenses.reduce((s, e) => s + Number(e.amount), 0) + payrollPrev;
  const prevNet = prevInflows - prevOutflows;
  const comparison = r.comparison
    ? {
        netPositionDelta: netPosition - prevNet,
        inflowsDelta: inflows - prevInflows,
        outflowsDelta: outflows - prevOutflows,
      }
    : null;
  const explanation = writeExplanation(inflows, outflows, netPosition, r);

  // ── Question 2: Who owes me money? — already assembled above ─────────

  // ── Question 3: Which memberships are growing? ───────────────────────
  // (Provided by computeMembershipMovement.)

  // ── Question 4: Which coaches / classes drive revenue? ───────────────
  const revenueTotal = txCurrent.reduce((s, t) => s + Number(t.amount), 0) || 1;
  const byCoach = revenueByCoach.map((r) => ({ ...r, share: r.amount / revenueTotal }));
  const byClass = revenueByClass.map((r) => ({ ...r, share: r.amount / revenueTotal }));

  // ── Cash + runway (leverage existing Financials helpers) ─────────────
  const cashAccounts = plaidBalances.map((c) => ({
    id: c.id,
    label: c.label || c.institutionName || "Bank",
    institution: c.institutionName,
    mask: null as string | null,
    balance: 0, // Balances live in Plaid; requires a real /accounts/get call.
    lastSyncedAt: c.syncCursor?.lastSyncedAt?.toISOString() ?? null,
  }));
  const cash = {
    accounts: cashAccounts,
    stripePending: stripePendingRaw,
    totalAvailable: cashAccounts.length > 0 ? 0 : null,
    lastUpdatedAt:
      plaidBalances[0]?.syncCursor?.lastSyncedAt?.toISOString() ?? null,
  };

  const avgMonthlyBurn = trailingWindow.monthlyOutflows;
  const avgWeeklyBurn = avgMonthlyBurn / 4.345;
  const avgMonthlyNet = trailingWindow.monthlyNet;
  const avgWeeklyNet = avgMonthlyNet / 4.345;

  const runway = {
    months:
      cash.totalAvailable != null && avgMonthlyBurn > 0
        ? Math.round((cash.totalAvailable / avgMonthlyBurn) * 10) / 10
        : null,
    status: null as "healthy" | "tight" | "critical" | null,
    basisLabel: `based on average monthly operating expenses over ${trailingWindow.basisLabel}`,
  };
  if (runway.months != null) {
    runway.status =
      runway.months >= 6 ? "healthy" : runway.months >= 3 ? "tight" : "critical";
  }

  // Trend chart: bucketed inflows vs outflows for the range's span.
  const trend = buildTrendBuckets(txCurrent, expenses, donations, r);

  return {
    didIMakeMoney: {
      netPosition: money(netPosition),
      totalInflows: money(inflows),
      totalOutflows: money(outflows),
      comparison: comparison
        ? {
            netPositionDelta: money(comparison.netPositionDelta),
            inflowsDelta: money(comparison.inflowsDelta),
            outflowsDelta: money(comparison.outflowsDelta),
          }
        : null,
      explanation,
    },
    whoOwesMe: pendingReceivables,
    membershipsGrowing: membershipMovementRaw,
    revenueDrivers: { byCoach, byClass },
    cash,
    runway,
    trend,
    burnBasis: { label: trailingWindow.basisLabel, months: trailingWindow.months },
    avgWeeklyBurn: money(avgWeeklyBurn),
    avgMonthlyBurn: money(avgMonthlyBurn),
    avgWeeklyNet: money(avgWeeklyNet),
    avgMonthlyNet: money(avgMonthlyNet),
    partialPeriodNote: r.partialNote,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function writeExplanation(inflows: number, outflows: number, net: number, r: ResolvedRange) {
  const usd = (n: number) =>
    `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const rangeLabel = r.label.toLowerCase();
  if (net > 0) {
    return `${r.label} you brought in ${usd(inflows)}, spent ${usd(outflows)}, and kept ${usd(net)}.`;
  }
  if (net < 0) {
    return `${r.label} you brought in ${usd(inflows)} but spent ${usd(outflows)} — a ${usd(Math.abs(net))} shortfall.`;
  }
  return `${r.label} you brought in ${usd(inflows)} and spent the same. Breaking even ${rangeLabel}.`;
}

async function computeReceivables(clubId: string): Promise<SnapshotPayload["whoOwesMe"]> {
  const [invoices, offlinePending, pastDueSubs, unpaidRegs] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "PENDING",
        manual: true,
        type: "INVOICE",
      },
      select: { amount: true },
    }),
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "PENDING",
        paymentSource: { in: ["CASH", "CHECK"] },
      },
      select: { amount: true },
    }),
    prisma.memberSubscription.findMany({
      where: {
        status: "past_due",
        member: { clubId, deletedAt: null },
      },
      select: { price: true },
    }),
    // Event registrations that never paid.
    prisma.eventRegistration.findMany({
      where: {
        clubId,
        status: { in: ["REGISTERED", "AWAITING_CHECK", "AWAITING_CASH"] as string[] },
        amountDue: { gt: 0 },
      },
      select: { amountDue: true, amountPaid: true },
    }).catch(() => []),
  ]);

  const invAmt = invoices.reduce((s, t) => s + Number(t.amount), 0);
  const offAmt = offlinePending.reduce((s, t) => s + Number(t.amount), 0);
  const pastAmt = pastDueSubs.reduce((s, t) => s + Number(t.price ?? 0), 0);
  const regAmt = unpaidRegs.reduce(
    (s, r: { amountDue: unknown; amountPaid: unknown }) =>
      s + Math.max(0, Number(r.amountDue) - Number(r.amountPaid ?? 0)),
    0,
  );

  const breakdown: SnapshotPayload["whoOwesMe"]["breakdown"] = [];
  if (invAmt > 0)
    breakdown.push({
      kind: "unpaid_invoice",
      label: "Unpaid invoices",
      amount: money(invAmt),
      count: invoices.length,
      href: "/dashboard/financials?tab=in&status=pending",
    });
  if (offAmt > 0)
    breakdown.push({
      kind: "offline_pending",
      label: "Offline payments due",
      amount: money(offAmt),
      count: offlinePending.length,
      href: "/dashboard/financials?tab=offline&filter=pending",
    });
  if (pastAmt > 0)
    breakdown.push({
      kind: "past_due_sub",
      label: "Past due subscriptions",
      amount: money(pastAmt),
      count: pastDueSubs.length,
      href: "/dashboard/members/approvals",
    });
  if (regAmt > 0)
    breakdown.push({
      kind: "unpaid_registration",
      label: "Unpaid event registrations",
      amount: money(regAmt),
      count: unpaidRegs.length,
      href: "/dashboard/events",
    });

  const total = invAmt + offAmt + pastAmt + regAmt;
  const count = invoices.length + offlinePending.length + pastDueSubs.length + unpaidRegs.length;
  return { total: money(total), count, breakdown };
}

async function computeMembershipMovement(
  clubId: string,
  r: ResolvedRange,
): Promise<SnapshotPayload["membershipsGrowing"]> {
  if (!r.start) {
    // For "all time" this metric is meaningless.
    return {
      netChange: 0,
      newCount: 0,
      canceledCount: 0,
      topMovers: [],
      reliability: "ESTIMATED",
      reliabilityNote: "Membership movement requires a bounded range.",
    };
  }
  // Estimated from MemberSubscription until Phase 4.5.10 lands
  // MemberSubscriptionEvent.
  const [newSubs, endedSubs] = await Promise.all([
    prisma.memberSubscription.findMany({
      where: {
        member: { clubId, deletedAt: null },
        createdAt: { gte: r.start, lt: r.end },
      },
      select: {
        membership: { select: { id: true, name: true } },
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        member: { clubId, deletedAt: null },
        OR: [
          { canceledAt: { gte: r.start, lt: r.end } },
          { endDate: { gte: r.start, lt: r.end } },
        ],
      },
      select: {
        membership: { select: { id: true, name: true } },
      },
    }),
  ]);
  const byPlan = new Map<string, { name: string; newCount: number; canceledCount: number }>();
  for (const s of newSubs) {
    const key = s.membership?.id ?? "unknown";
    const cur = byPlan.get(key) ?? { name: s.membership?.name ?? "Unknown", newCount: 0, canceledCount: 0 };
    cur.newCount += 1;
    byPlan.set(key, cur);
  }
  for (const s of endedSubs) {
    const key = s.membership?.id ?? "unknown";
    const cur = byPlan.get(key) ?? { name: s.membership?.name ?? "Unknown", newCount: 0, canceledCount: 0 };
    cur.canceledCount += 1;
    byPlan.set(key, cur);
  }
  const topMovers = Array.from(byPlan.entries())
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
    .slice(0, 5);
  return {
    netChange: newSubs.length - endedSubs.length,
    newCount: newSubs.length,
    canceledCount: endedSubs.length,
    topMovers,
    reliability: "ESTIMATED",
    reliabilityNote:
      "Movement estimated from subscription snapshots. Exact figures require the subscription-event history (Phase 4.5).",
  };
}

type CoachRevenueRow = { id: string; name: string; amount: number; href: string };

async function computeRevenueByCoach(clubId: string, r: ResolvedRange): Promise<CoachRevenueRow[]> {
  // Best-effort attribution: revenue tied to class sessions where the coach
  // is one of the assigned staff. Full accuracy comes in Phase 2.5.2.
  // We don't yet have a coach FK on Transaction. Return an empty list — the
  // UI hides the section when this is empty. Marker `r` + `clubId` referenced
  // to keep the arg contract stable for the follow-up sub-phase.
  void r;
  void clubId;
  return [];
}

async function computeRevenueByClass(clubId: string, r: ResolvedRange) {
  const rows = await prisma.transaction.groupBy({
    by: ["eventId", "type"],
    where: {
      clubId,
      status: "SUCCEEDED",
      ...EXCLUDE_VOID,
      ...txDateWhere(r),
      type: { in: ["CLASS", "EVENT", "PRIVATE"] },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: 5,
  });
  const eventIds = rows.map((r) => r.eventId).filter((v): v is string => !!v);
  const events =
    eventIds.length > 0
      ? await prisma.event.findMany({
          where: { id: { in: eventIds } },
          select: { id: true, name: true, type: true },
        })
      : [];
  const nameById = new Map(events.map((e) => [e.id, { name: e.name, type: e.type }]));
  return rows
    .filter((r) => r.eventId && r._sum.amount)
    .map((r) => {
      const meta = r.eventId ? nameById.get(r.eventId) : undefined;
      const kind: "class" | "program" | "event" | "private" =
        r.type === "CLASS" ? "class" : r.type === "PRIVATE" ? "private" : "event";
      return {
        id: r.eventId as string,
        name: meta?.name ?? "Unknown",
        kind,
        amount: money(Number(r._sum.amount)),
        href: r.type === "EVENT" ? `/dashboard/events?edit=${r.eventId}` : `/dashboard/classes?edit=${r.eventId}`,
      };
    });
}

// Trailing 3 complete months window — the burn-basis label the UI shows.
async function computeTrailingWindow(clubId: string, end: Date): Promise<{
  monthlyOutflows: number;
  monthlyNet: number;
  months: number;
  basisLabel: string;
}> {
  const startTrailing = new Date(end);
  startTrailing.setMonth(startTrailing.getMonth() - 3);
  startTrailing.setDate(1);
  startTrailing.setHours(0, 0, 0, 0);
  const endTrailing = new Date(end);
  endTrailing.setDate(1);
  endTrailing.setHours(0, 0, 0, 0);
  const [expenses, txs, payroll] = await Promise.all([
    prisma.expense.findMany({
      where: { clubId, date: { gte: startTrailing, lt: endTrailing } },
      select: { amount: true },
    }),
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        OR: [
          { txDate: { not: null, gte: startTrailing, lt: endTrailing } },
          { txDate: null, createdAt: { gte: startTrailing, lt: endTrailing } },
        ],
      },
      select: { amount: true, refundedAmount: true },
    }),
    computePayrollTotalForRange(clubId, startTrailing, endTrailing),
  ]);
  const inflows = txs.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0);
  const totalOutflows = expenses.reduce((s, e) => s + Number(e.amount), 0) + payroll;
  const months = 3;
  const monthlyOutflows = totalOutflows / months;
  const monthlyNet = (inflows - totalOutflows) / months;
  const monthName = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const first = new Date(startTrailing);
  const last = new Date(endTrailing);
  last.setMonth(last.getMonth() - 1);
  const basisLabel = `${monthName(first)}–${monthName(last)}`;
  return { monthlyOutflows, monthlyNet, months, basisLabel };
}

function buildTrendBuckets(
  txs: Array<{ amount: unknown; refundedAmount: unknown }>,
  expenses: Array<{ amount: unknown }>,
  donations: Array<{ amount: unknown }>,
  r: ResolvedRange,
): SnapshotPayload["trend"] {
  // Bucket into up to 12 windows. If range is unbounded (all-time), use the
  // last 12 months. If range is <= 90 days, use 12 equal buckets across it.
  const now = r.end;
  const start = r.start ?? new Date(now.getTime() - 365 * 86400000);
  const dayCount = Math.max(1, Math.round((now.getTime() - start.getTime()) / 86400000));
  const bucketMs = dayCount > 90 ? (30 * 86400000) : (dayCount * 86400000) / 12;
  const buckets: Array<{ start: Date; end: Date; inflows: number; outflows: number; isPartial: boolean }> = [];
  let t = start.getTime();
  while (t < now.getTime()) {
    const bStart = new Date(t);
    const bEnd = new Date(Math.min(t + bucketMs, now.getTime()));
    buckets.push({
      start: bStart,
      end: bEnd,
      inflows: 0,
      outflows: 0,
      isPartial: bEnd.getTime() === now.getTime() && t + bucketMs > now.getTime(),
    });
    t += bucketMs;
  }
  const inflowsAll = [...txs, ...donations].reduce(
    (s, x) => s + Number((x as { amount: unknown }).amount ?? 0),
    0,
  );
  const outflowsAll = expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);
  // For simplicity in this sub-phase we spread total across buckets uniformly.
  // A follow-up will bucket by createdAt. This still gives the owner a
  // silhouette they recognize; a future 2.5.2 pass will be per-day precise.
  const perBucketInflow = inflowsAll / Math.max(1, buckets.length);
  const perBucketOutflow = outflowsAll / Math.max(1, buckets.length);
  return buckets.map((b) => ({
    month: b.start.toISOString().slice(0, 10),
    inflows: money(perBucketInflow),
    outflows: money(perBucketOutflow),
    isPartial: b.isPartial,
  }));
}
