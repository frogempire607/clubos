// Reports Phase 2.5.1 — reliability strip data source.
//
// Owner opens Reports, sees a strip that says "your Stripe is up to date,
// your bank sync is 26 hours stale, 12 transactions still need a category,
// no historical import yet." Every section carries the state + evidence +
// deep-link to the exact fix.

import { prisma } from "@/lib/prisma";

export type ReliabilityState =
  | "COMPLETE"
  | "MISSING_BANK_CONNECTION"
  | "AWAITING_CATEGORIZATION"
  | "HISTORICAL_DATA_INCOMPLETE"
  | "CASH_DATA_NOT_INCLUDED"
  | "ESTIMATED"
  | "NEEDS_REVIEW"
  | "STALE";

export type ReliabilitySection = {
  key: "bank" | "stripe" | "cash" | "categorization" | "historical" | "payroll";
  label: string;
  state: ReliabilityState;
  detail: string;
  count: number | null;
  lastUpdatedAt: string | null;
  href: string;
};

export type ReliabilityPayload = {
  sections: ReliabilitySection[];
  attentionCount: number;
  generatedAt: string;
};

// Trivial in-process cache: one entry per club, ~60s TTL. Reports re-fetches
// this on tab switch; we don't want to hammer PG for every render.
const CACHE = new Map<string, { at: number; payload: ReliabilityPayload }>();
const TTL_MS = 60_000;

export async function computeReliability(clubId: string): Promise<ReliabilityPayload> {
  const cached = CACHE.get(clubId);
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.payload;

  const [
    connectionCount,
    latestBankSync,
    uncategorizedCount,
    historicalConnected,
    lastStripeEvent,
    reviewQueueCount,
  ] = await Promise.all([
    prisma.plaidConnection.count({ where: { clubId, deletedAt: null } }),
    prisma.plaidSyncCursor.findFirst({
      where: { clubId },
      orderBy: { lastSyncedAt: "desc" },
      select: { lastSyncedAt: true, lastSyncError: true },
    }),
    prisma.plaidTransaction.count({
      where: {
        clubId,
        reviewedAt: null,
        categorizedExpenseId: null,
        markedAsTransfer: false,
        excludedFromTax: false,
      },
    }),
    // Historical imports table won't exist until Phase 2.5.9. Feature-detect
    // and degrade gracefully.
    detectHistoricalConnected(clubId),
    prisma.stripeWebhookEvent.findFirst({
      where: { clubId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.stripeReconciliation.count({
      where: { clubId, status: "OPEN" },
    }).catch(() => 0),
  ]);

  const sections: ReliabilitySection[] = [];

  // Bank
  if (connectionCount === 0) {
    sections.push({
      key: "bank",
      label: "Bank",
      state: "MISSING_BANK_CONNECTION",
      detail: "Connect a bank so cash-on-hand and runway show real numbers.",
      count: null,
      lastUpdatedAt: null,
      href: "/dashboard/financials?tab=bank",
    });
  } else {
    const lastSync = latestBankSync?.lastSyncedAt ?? null;
    const staleThresholdMs = 24 * 3600 * 1000;
    if (latestBankSync?.lastSyncError) {
      sections.push({
        key: "bank",
        label: "Bank",
        state: "NEEDS_REVIEW",
        detail: "Last bank sync failed. Reconnect the bank to keep data current.",
        count: null,
        lastUpdatedAt: lastSync?.toISOString() ?? null,
        href: "/dashboard/financials?tab=bank",
      });
    } else if (!lastSync || now - lastSync.getTime() > staleThresholdMs) {
      sections.push({
        key: "bank",
        label: "Bank",
        state: "STALE",
        detail: lastSync
          ? `Last synced ${Math.floor((now - lastSync.getTime()) / 3600000)}h ago.`
          : "Never synced. Click Sync in the Bank tab.",
        count: null,
        lastUpdatedAt: lastSync?.toISOString() ?? null,
        href: "/dashboard/financials?tab=bank",
      });
    } else {
      sections.push({
        key: "bank",
        label: "Bank",
        state: "COMPLETE",
        detail: "Synced within the last 24 hours.",
        count: null,
        lastUpdatedAt: lastSync.toISOString(),
        href: "/dashboard/financials?tab=bank",
      });
    }
  }

  // Stripe
  const stripeLast = lastStripeEvent?.createdAt ?? null;
  const stripeStale = !stripeLast || now - stripeLast.getTime() > 48 * 3600 * 1000;
  if (stripeStale) {
    sections.push({
      key: "stripe",
      label: "Stripe",
      state: "STALE",
      detail: stripeLast
        ? `No Stripe activity in ${Math.floor((now - stripeLast.getTime()) / 86400000)} days.`
        : "No Stripe activity recorded yet.",
      count: null,
      lastUpdatedAt: stripeLast?.toISOString() ?? null,
      href: "/dashboard/settings/billing",
    });
  } else {
    sections.push({
      key: "stripe",
      label: "Stripe",
      state: "COMPLETE",
      detail: "Receiving webhook events.",
      count: null,
      lastUpdatedAt: stripeLast.toISOString(),
      href: "/dashboard/settings/billing",
    });
  }

  // Categorization
  if (uncategorizedCount > 0) {
    sections.push({
      key: "categorization",
      label: "Categorization",
      state: "AWAITING_CATEGORIZATION",
      detail: `${uncategorizedCount} bank transaction${uncategorizedCount === 1 ? "" : "s"} awaiting a category.`,
      count: uncategorizedCount,
      lastUpdatedAt: null,
      href: "/dashboard/financials?tab=bank&filter=needs_review",
    });
  } else {
    sections.push({
      key: "categorization",
      label: "Categorization",
      state: "COMPLETE",
      detail: "All bank transactions categorized.",
      count: 0,
      lastUpdatedAt: null,
      href: "/dashboard/financials?tab=bank",
    });
  }

  // Historical data
  if (!historicalConnected) {
    sections.push({
      key: "historical",
      label: "Historical data",
      state: "HISTORICAL_DATA_INCOMPLETE",
      detail: "No pre-AthletixOS import yet. All-time reports show native data only.",
      count: null,
      lastUpdatedAt: null,
      href: "/dashboard/reports?tab=imports",
    });
  }

  // Reconciliation review queue
  if (reviewQueueCount > 0) {
    sections.push({
      key: "stripe",
      label: "Reconciliation",
      state: "NEEDS_REVIEW",
      detail: `${reviewQueueCount} unmatched Stripe subscription${reviewQueueCount === 1 ? "" : "s"} in the review queue.`,
      count: reviewQueueCount,
      lastUpdatedAt: null,
      href: "/dashboard/financials?tab=stripe",
    });
  }

  const attentionCount = sections.filter((s) => s.state !== "COMPLETE").length;
  const payload: ReliabilityPayload = {
    sections,
    attentionCount,
    generatedAt: new Date().toISOString(),
  };
  CACHE.set(clubId, { at: now, payload });
  return payload;
}

// The historical-imports table (`ImportBatch`) comes online in Phase 2.5.9.
// Detect its presence by trying a cheap count and returning false on any
// error so we don't crash Snapshot pre-2.5.9.
async function detectHistoricalConnected(clubId: string): Promise<boolean> {
  try {
    const p = prisma as unknown as {
      importBatch?: { count: (args: unknown) => Promise<number> };
    };
    if (!p.importBatch) return false;
    const count = await p.importBatch.count({
      where: { clubId, status: "COMPLETED" },
    });
    return count > 0;
  } catch {
    return false;
  }
}

// Test-only: clear the cache so unit tests can control the freshness window.
export function _resetReliabilityCache() {
  CACHE.clear();
}
