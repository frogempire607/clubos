// Reports Phase 2.5.8 — Alerts + owner-configurable thresholds.
//
// Distinct from Action Items:
//   - Action Items = actionable task list ("3 payments failed") with snooze.
//   - Alerts       = threshold checks with severity ("Runway below 3 months")
//                     that the owner can enable/disable + configure per club.
//
// Both consume the same underlying data.

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import { computePayrollTotalForRange } from "@/lib/payroll";

export const ALERT_KINDS = [
  "RUNWAY_BELOW",
  "EXPENSES_EXCEED_REVENUE",
  "CHURN_SPIKE",
  "UNCATEGORIZED_COUNT",
  "BANK_SYNC_STALE",
  "REFUND_RATE",
  "RECURRING_REVENUE_DECLINE",
  "PAYROLL_ABOVE_AVERAGE",
  // Shared with Action Items thresholds.
  "UPCOMING_RENEWAL_LARGE",
  "UNCATEGORIZED_LARGE_BANK",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_DEFAULTS: Record<AlertKind, { threshold: number | null; enabled: boolean; label: string; unit: string; description: string }> = {
  RUNWAY_BELOW: { threshold: 3, enabled: true, label: "Runway below", unit: "months", description: "Trigger when runway drops below the threshold (default 3 months)." },
  EXPENSES_EXCEED_REVENUE: { threshold: null, enabled: true, label: "Expenses exceed revenue", unit: "", description: "Trigger when the current period's expenses exceed revenue." },
  CHURN_SPIKE: { threshold: 8, enabled: true, label: "Churn spike", unit: "%", description: "Trigger when membership churn exceeds the threshold percent." },
  UNCATEGORIZED_COUNT: { threshold: 20, enabled: true, label: "Uncategorized bank rows", unit: "rows", description: "Trigger when uncategorized bank rows exceed the threshold." },
  BANK_SYNC_STALE: { threshold: 48, enabled: true, label: "Bank sync stale", unit: "hours", description: "Trigger when a bank connection hasn't synced within N hours." },
  REFUND_RATE: { threshold: 5, enabled: true, label: "Refund rate", unit: "%", description: "Trigger when refunds exceed the threshold percent of revenue in the trailing 30 days." },
  RECURRING_REVENUE_DECLINE: { threshold: 5, enabled: true, label: "Recurring revenue decline", unit: "%", description: "Trigger when MRR drops more than the threshold percent vs the prior month." },
  PAYROLL_ABOVE_AVERAGE: { threshold: 15, enabled: true, label: "Payroll above average", unit: "%", description: "Trigger when payroll exceeds the trailing average by the threshold percent." },
  UPCOMING_RENEWAL_LARGE: { threshold: 200, enabled: true, label: "Large upcoming renewal", unit: "$", description: "Action-item threshold for large upcoming renewals ($200)." },
  UNCATEGORIZED_LARGE_BANK: { threshold: 500, enabled: true, label: "Uncategorized bank row size", unit: "$", description: "Action-item threshold for the size of a single uncategorized bank row ($500)." },
};

export type ResolvedSetting = { kind: AlertKind; threshold: number | null; enabled: boolean };

export type AlertItem = {
  kind: AlertKind;
  severity: "high" | "medium" | "low";
  state: "TRIGGERED" | "OK";
  title: string;
  detail: string;
  href: string;
  threshold: number | null;
  currentValue: number | null;
  unit: string;
};

// Load thresholds for a club, filling in defaults for missing rows.
export async function loadAlertSettings(clubId: string): Promise<ResolvedSetting[]> {
  const rows = await prisma.reportAlertSetting.findMany({
    where: { clubId },
    select: { kind: true, threshold: true, enabled: true },
  });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return ALERT_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return {
      kind,
      threshold: row ? (row.threshold != null ? Number(row.threshold) : null) : ALERT_DEFAULTS[kind].threshold,
      enabled: row ? row.enabled : ALERT_DEFAULTS[kind].enabled,
    };
  });
}

export async function buildAlerts(clubId: string): Promise<{ alerts: AlertItem[]; settings: ResolvedSetting[]; generatedAt: string }> {
  const settings = await loadAlertSettings(clubId);
  const enabled = new Set(settings.filter((s) => s.enabled).map((s) => s.kind));
  const threshold = (kind: AlertKind) => settings.find((s) => s.kind === kind)?.threshold ?? ALERT_DEFAULTS[kind].threshold;
  const now = new Date();
  const alerts: AlertItem[] = [];

  // ── Trailing-30 numbers for period-based alerts ────────────────────
  const trailing30Start = new Date(now.getTime() - 30 * 86400000);
  const [txsLast30, txsPrior30, expensesLast30, payrollLast30, syncStatus] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        OR: [
          { txDate: { not: null, gte: trailing30Start, lt: now } },
          { txDate: null, createdAt: { gte: trailing30Start, lt: now } },
        ],
      },
      select: { amount: true, refundedAmount: true },
    }),
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        OR: [
          { txDate: { not: null, gte: new Date(now.getTime() - 60 * 86400000), lt: trailing30Start } },
          { txDate: null, createdAt: { gte: new Date(now.getTime() - 60 * 86400000), lt: trailing30Start } },
        ],
      },
      select: { amount: true, refundedAmount: true },
    }),
    prisma.expense.findMany({
      where: { clubId, date: { gte: trailing30Start, lt: now } },
      select: { amount: true },
    }),
    computePayrollTotalForRange(clubId, trailing30Start, now),
    prisma.plaidSyncCursor.findMany({
      where: { clubId },
      select: { lastSyncedAt: true, lastSyncError: true },
    }),
  ]);
  const revenue30 = txsLast30.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0);
  const revenuePrior30 = txsPrior30.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0);
  const refunded30 = txsLast30.reduce((s, t) => s + Number(t.refundedAmount ?? 0), 0);
  const expenses30 = expensesLast30.reduce((s, e) => s + Number(e.amount), 0) + payrollLast30;

  // 1. EXPENSES_EXCEED_REVENUE
  if (enabled.has("EXPENSES_EXCEED_REVENUE")) {
    const triggered = expenses30 > revenue30 && revenue30 > 0;
    alerts.push({
      kind: "EXPENSES_EXCEED_REVENUE",
      severity: "high",
      state: triggered ? "TRIGGERED" : "OK",
      title: "Expenses vs revenue (last 30 days)",
      detail: triggered
        ? `Spent $${expenses30.toFixed(0)} · brought in $${revenue30.toFixed(0)}. Net down by $${(expenses30 - revenue30).toFixed(0)}.`
        : `Revenue $${revenue30.toFixed(0)} · expenses $${expenses30.toFixed(0)}. OK.`,
      href: "/dashboard/reports?tab=pnl",
      threshold: null,
      currentValue: revenue30 > 0 ? Math.round((expenses30 / revenue30) * 100) : null,
      unit: "%",
    });
  }

  // 2. REFUND_RATE
  if (enabled.has("REFUND_RATE")) {
    const t = threshold("REFUND_RATE") ?? 5;
    const rate = revenue30 > 0 ? (refunded30 / revenue30) * 100 : 0;
    const triggered = rate > t && revenue30 > 0;
    alerts.push({
      kind: "REFUND_RATE",
      severity: triggered ? "high" : "low",
      state: triggered ? "TRIGGERED" : "OK",
      title: `Refund rate ${rate.toFixed(1)}% (threshold ${t}%)`,
      detail: `$${refunded30.toFixed(0)} refunded / $${revenue30.toFixed(0)} revenue in the last 30 days.`,
      href: "/dashboard/reports?tab=pnl",
      threshold: t,
      currentValue: Math.round(rate * 10) / 10,
      unit: "%",
    });
  }

  // 3. RECURRING_REVENUE_DECLINE
  if (enabled.has("RECURRING_REVENUE_DECLINE") && revenuePrior30 > 0) {
    const t = threshold("RECURRING_REVENUE_DECLINE") ?? 5;
    const change = ((revenue30 - revenuePrior30) / revenuePrior30) * 100;
    const triggered = change < -t;
    alerts.push({
      kind: "RECURRING_REVENUE_DECLINE",
      severity: triggered ? "medium" : "low",
      state: triggered ? "TRIGGERED" : "OK",
      title: `Revenue trend ${change >= 0 ? "+" : ""}${change.toFixed(1)}% (threshold −${t}%)`,
      detail: `Trailing 30 days $${revenue30.toFixed(0)} · prior 30 days $${revenuePrior30.toFixed(0)}.`,
      href: "/dashboard/reports?tab=revenue",
      threshold: t,
      currentValue: Math.round(change * 10) / 10,
      unit: "%",
    });
  }

  // 4. UNCATEGORIZED_COUNT
  if (enabled.has("UNCATEGORIZED_COUNT")) {
    const t = threshold("UNCATEGORIZED_COUNT") ?? 20;
    const count = await prisma.plaidTransaction.count({
      where: {
        clubId,
        reviewedAt: null,
        categorizedExpenseId: null,
        markedAsTransfer: false,
        excludedFromTax: false,
      },
    });
    const triggered = count > t;
    alerts.push({
      kind: "UNCATEGORIZED_COUNT",
      severity: triggered ? "medium" : "low",
      state: triggered ? "TRIGGERED" : "OK",
      title: `${count} uncategorized bank rows (threshold ${t})`,
      detail: triggered ? "Categorize them to keep tax + P&L accurate." : "All caught up.",
      href: "/dashboard/financials?tab=bank&filter=needs_review",
      threshold: t,
      currentValue: count,
      unit: "rows",
    });
  }

  // 5. BANK_SYNC_STALE
  if (enabled.has("BANK_SYNC_STALE") && syncStatus.length > 0) {
    const t = threshold("BANK_SYNC_STALE") ?? 48;
    const worst = syncStatus.reduce((oldest, s) => {
      if (!s.lastSyncedAt) return oldest;
      if (!oldest || s.lastSyncedAt < oldest) return s.lastSyncedAt;
      return oldest;
    }, null as Date | null);
    const hours = worst ? Math.floor((now.getTime() - worst.getTime()) / 3600000) : Infinity;
    const anyError = syncStatus.some((s) => s.lastSyncError);
    const triggered = hours > t || anyError;
    alerts.push({
      kind: "BANK_SYNC_STALE",
      severity: anyError ? "high" : triggered ? "medium" : "low",
      state: triggered ? "TRIGGERED" : "OK",
      title: anyError ? "Bank sync error" : `Bank sync ${hours}h old (threshold ${t}h)`,
      detail: anyError ? "One or more bank connections returned an error. Reconnect the bank." : "Run Sync in the Bank tab to refresh.",
      href: "/dashboard/financials?tab=bank",
      threshold: t,
      currentValue: hours,
      unit: "hours",
    });
  }

  // 6. PAYROLL_ABOVE_AVERAGE — trailing 90 vs previous 90.
  if (enabled.has("PAYROLL_ABOVE_AVERAGE")) {
    const t = threshold("PAYROLL_ABOVE_AVERAGE") ?? 15;
    const prev90End = new Date(now.getTime() - 90 * 86400000);
    const prev90Start = new Date(now.getTime() - 180 * 86400000);
    const [thisPayroll, priorPayroll] = await Promise.all([
      computePayrollTotalForRange(clubId, new Date(now.getTime() - 90 * 86400000), now),
      computePayrollTotalForRange(clubId, prev90Start, prev90End),
    ]);
    if (priorPayroll > 0) {
      const delta = ((thisPayroll - priorPayroll) / priorPayroll) * 100;
      const triggered = delta > t;
      alerts.push({
        kind: "PAYROLL_ABOVE_AVERAGE",
        severity: triggered ? "medium" : "low",
        state: triggered ? "TRIGGERED" : "OK",
        title: `Payroll ${delta > 0 ? "+" : ""}${delta.toFixed(1)}% vs prior 90 days (threshold ${t}%)`,
        detail: `Trailing 90d: $${thisPayroll.toFixed(0)} · prior 90d: $${priorPayroll.toFixed(0)}.`,
        href: "/dashboard/staff/payroll",
        threshold: t,
        currentValue: Math.round(delta * 10) / 10,
        unit: "%",
      });
    }
  }

  // 7. CHURN_SPIKE — trailing month churn vs threshold.
  if (enabled.has("CHURN_SPIKE")) {
    const t = threshold("CHURN_SPIKE") ?? 8;
    const monthAgo = new Date(now.getTime() - 30 * 86400000);
    const [startingActive, endedInWindow] = await Promise.all([
      prisma.memberSubscription.count({
        where: {
          member: { clubId, deletedAt: null },
          createdAt: { lt: monthAgo },
          OR: [{ endDate: null }, { endDate: { gt: monthAgo } }],
          AND: [{ OR: [{ canceledAt: null }, { canceledAt: { gt: monthAgo } }] }],
        },
      }),
      prisma.memberSubscription.count({
        where: {
          member: { clubId, deletedAt: null },
          OR: [
            { canceledAt: { gte: monthAgo, lt: now } },
            { endDate: { gte: monthAgo, lt: now } },
          ],
        },
      }),
    ]);
    if (startingActive > 0) {
      const rate = (endedInWindow / startingActive) * 100;
      const triggered = rate > t;
      alerts.push({
        kind: "CHURN_SPIKE",
        severity: triggered ? "high" : "low",
        state: triggered ? "TRIGGERED" : "OK",
        title: `Churn ${rate.toFixed(1)}% (threshold ${t}%)`,
        detail: `${endedInWindow} of ${startingActive} memberships lost in the last 30 days.`,
        href: "/dashboard/reports?tab=membership",
        threshold: t,
        currentValue: Math.round(rate * 10) / 10,
        unit: "%",
      });
    }
  }

  // 8. RUNWAY_BELOW — requires live bank balance which we don't have on
  // the server without a Plaid call. Skip in MVP; reliability strip
  // already surfaces "connect a bank" when needed.

  return { alerts, settings, generatedAt: now.toISOString() };
}
