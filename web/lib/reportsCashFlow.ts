// Reports Phase 2.5.7 — Cash flow tab.
//
// Sources: PlaidTransaction (bank ledger from Phase 1B) + Transaction table
// (source of Stripe revenue, so we don't double-count via bank payouts) +
// PayoutMatch (Stripe→bank link) + Expense (for classification hints).
//
// Classification (per specs/03):
//   Operating   — memberships, events, camps, privates, merch, refunds,
//                  payroll, rent, all normal expenses
//   Investing   — equipment/property above capitalization threshold
//                  (default $2,500; owner-configurable in a future
//                  sub-phase)
//   Financing   — loan proceeds, loan payments, owner contributions,
//                  owner distributions
//   Excluded    — account transfers, matched Stripe payouts
//
// Transfer detection: a matched debit+credit pair within 3 days across two
// connected accounts of the same club.
//
// Forecast: requires ≥3 complete months of history; otherwise `null` and
// the UI hides the section.

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import { computePayrollTotalForRange } from "@/lib/payroll";
import type { ResolvedRange } from "@/lib/reportsRange";

export const CAPITALIZATION_THRESHOLD = 2500;
export const TRANSFER_WINDOW_DAYS = 3;
export const PAYOUT_UNMATCHED_THRESHOLD_DAYS = 10;

const FINANCING_CATEGORIES: Record<string, "LOAN_PROCEEDS" | "LOAN_PAYMENT" | "OWNER_CONTRIBUTION" | "OWNER_DISTRIBUTION"> = {
  LOAN_DEPOSIT: "LOAN_PROCEEDS",
  LOAN_REPAYMENT: "LOAN_PAYMENT",
  OWNER_CONTRIBUTION: "OWNER_CONTRIBUTION",
  OWNER_DRAW: "OWNER_DISTRIBUTION",
};

const INVESTING_CATEGORIES = new Set(["EQUIPMENT", "PROPERTY", "CAPITAL"]);

export type CashFlowPayload = {
  range: { key: string; label: string; start: string | null; end: string };
  beginningCash: number | null;
  cashReceived: number;
  cashSpent: number;
  netMovement: number;
  endingCash: number | null;
  operating: { inflows: number; outflows: number };
  investing: Array<{ label: string; amount: number }>;
  financing: Array<{ label: string; amount: number; kind: "LOAN_PROCEEDS" | "LOAN_PAYMENT" | "OWNER_CONTRIBUTION" | "OWNER_DISTRIBUTION" }>;
  excluded: {
    accountTransfers: { count: number; amount: number };
    matchedStripePayouts: { count: number; amount: number };
  };
  forecast: {
    expectedMembershipRevenue: number;
    expectedRecurringRevenue: number;
    upcomingPayroll: number;
    upcomingRecurringExpenses: number;
    expectedStripePayouts: number;
    projectedMonthEndCash: number | null;
    estimatedRunwayMonths: number | null;
    breakEvenProgress: number | null;
    isEstimate: true;
    basis: string;
  } | null;
  reliability: "COMPLETE" | "ESTIMATED";
  reliabilityNotes: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function bankDateWhere(r: ResolvedRange) {
  if (!r.start) return {};
  return { date: { gte: r.start, lt: r.end } };
}

export async function buildCashFlow(clubId: string, r: ResolvedRange): Promise<CashFlowPayload> {
  const [plaidRows, payoutMatches, connections, expenses, payroll] = await Promise.all([
    prisma.plaidTransaction.findMany({
      where: { clubId, ...bankDateWhere(r) },
      select: {
        id: true, plaidTransactionId: true, plaidConnectionId: true, amount: true,
        date: true, name: true, merchantName: true,
        categoryOverride: true, markedAsTransfer: true, excludedFromTax: true,
        categorizedExpenseId: true,
      },
    }),
    prisma.payoutMatch.findMany({
      where: r.start
        ? { clubId, arrivalDate: { gte: r.start, lt: r.end } }
        : { clubId },
      select: { id: true, amount: true, arrivalDate: true, bankTransactionId: true },
    }),
    prisma.plaidConnection.count({ where: { clubId, deletedAt: null } }),
    prisma.expense.findMany({
      where: r.start ? { clubId, date: { gte: r.start, lt: r.end } } : { clubId },
      select: { id: true, amount: true, category: true, description: true, isRecurring: true, matchedPlaidTransactionId: true },
    }),
    computePayrollTotalForRange(clubId, r.start ?? null, r.end),
  ]);

  const matchedBankIds = new Set(payoutMatches.map((p) => p.bankTransactionId).filter((v): v is string => !!v));

  // Transfer detection: for each connection, find matched debit/credit pairs
  // within TRANSFER_WINDOW_DAYS.
  const transfersDetected = new Set<string>();
  const transferPairAmountByGroup = new Map<string, number>();
  {
    const byConn = new Map<string, typeof plaidRows>();
    for (const row of plaidRows) {
      const arr = byConn.get(row.plaidConnectionId) ?? [];
      arr.push(row);
      byConn.set(row.plaidConnectionId, arr);
    }
    // For each debit (positive amount = outflow), look for a credit
    // (negative amount) with the same |amount| within window across
    // ANY other connection.
    const otherConnRows = plaidRows.filter((r) => r.amount);
    for (const debit of otherConnRows) {
      if (Number(debit.amount) <= 0) continue;
      if (debit.markedAsTransfer) transfersDetected.add(debit.id);
      for (const credit of otherConnRows) {
        if (credit.id === debit.id) continue;
        if (Number(credit.amount) >= 0) continue;
        if (credit.plaidConnectionId === debit.plaidConnectionId) continue;
        if (Math.abs(Number(debit.amount) + Number(credit.amount)) > 0.01) continue;
        const daysApart = Math.abs(debit.date.getTime() - credit.date.getTime()) / 86400000;
        if (daysApart > TRANSFER_WINDOW_DAYS) continue;
        transfersDetected.add(debit.id);
        transfersDetected.add(credit.id);
        const groupKey = `${Math.min(debit.date.getTime(), credit.date.getTime())}:${Number(debit.amount).toFixed(2)}`;
        transferPairAmountByGroup.set(groupKey, Math.abs(Number(debit.amount)));
      }
    }
  }

  // Excluded totals.
  const matchedPayoutTotal = payoutMatches
    .filter((p) => p.bankTransactionId != null)
    .reduce((s, p) => s + Number(p.amount), 0);
  const accountTransferAmount = Array.from(transferPairAmountByGroup.values()).reduce((s, v) => s + v, 0);
  const excluded = {
    accountTransfers: { count: transferPairAmountByGroup.size, amount: round2(accountTransferAmount) },
    matchedStripePayouts: { count: matchedBankIds.size, amount: round2(matchedPayoutTotal) },
  };

  // Classify remaining rows into operating / investing / financing / excluded.
  let cashReceived = 0;
  let cashSpent = 0;
  const investing: Map<string, number> = new Map();
  const financing: Map<string, { amount: number; kind: CashFlowPayload["financing"][number]["kind"] }> = new Map();
  let opInflows = 0;
  let opOutflows = 0;
  for (const row of plaidRows) {
    if (transfersDetected.has(row.id) || row.markedAsTransfer) continue;
    if (matchedBankIds.has(row.plaidTransactionId)) continue;
    const amt = Number(row.amount);
    const cat = row.categoryOverride;

    // Financing?
    const finKind = cat && FINANCING_CATEGORIES[cat] ? FINANCING_CATEGORIES[cat] : null;
    if (finKind) {
      const label = row.name;
      const existing = financing.get(label) ?? { amount: 0, kind: finKind };
      existing.amount += amt;
      financing.set(label, existing);
      continue;
    }

    // Investing?
    if (cat && INVESTING_CATEGORIES.has(cat)) {
      const label = row.name;
      investing.set(label, (investing.get(label) ?? 0) + amt);
      continue;
    }
    // Large capital purchase without category — still investing if above
    // capitalization threshold.
    if (!cat && Math.abs(amt) >= CAPITALIZATION_THRESHOLD && amt > 0) {
      investing.set(row.name, (investing.get(row.name) ?? 0) + amt);
      continue;
    }

    // Operating.
    if (amt > 0) {
      opOutflows += amt;
      cashSpent += amt;
    } else {
      opInflows += Math.abs(amt);
      cashReceived += Math.abs(amt);
    }
  }

  // Payroll (from AthletixOS payroll module) always counted as operating
  // outflow — even without a bank row.
  if (payroll > 0) {
    opOutflows += payroll;
    cashSpent += payroll;
  }

  const netMovement = cashReceived - cashSpent;
  const investingArr = Array.from(investing.entries())
    .map(([label, amount]) => ({ label, amount: round2(amount) }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const financingArr = Array.from(financing.entries())
    .map(([label, v]) => ({ label, amount: round2(v.amount), kind: v.kind }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // Forecast — needs ≥3 complete months of bank history. When we don't have
  // that, return null.
  const earliestCursor = await prisma.plaidSyncCursor.findFirst({
    where: { clubId },
    orderBy: { earliestAvailableDate: "asc" },
    select: { earliestAvailableDate: true },
  });
  const hasEnoughHistory =
    earliestCursor?.earliestAvailableDate != null &&
    new Date().getTime() - earliestCursor.earliestAvailableDate.getTime() >= 90 * 86400000;

  let forecast: CashFlowPayload["forecast"] = null;
  if (hasEnoughHistory && connections > 0) {
    const in30d = new Date();
    in30d.setDate(in30d.getDate() + 30);
    const [activeSubs, upcomingPayrollRuns] = await Promise.all([
      prisma.memberSubscription.findMany({
        where: { status: "active", member: { clubId, deletedAt: null } },
        select: { price: true, billingPeriod: true },
      }),
      Promise.resolve(0), // Payroll runs projection — needs `next-run` field; punt for MVP.
    ]);
    const monthlyRecurring = activeSubs.reduce((s, sub) => {
      const p = Number(sub.price ?? 0);
      const bp = (sub.billingPeriod ?? "MONTHLY").toUpperCase();
      switch (bp) {
        case "YEARLY":
        case "ANNUAL":
          return s + p / 12;
        case "QUARTERLY":
          return s + p / 3;
        case "WEEKLY":
          return s + (p * 52) / 12;
        case "BIWEEKLY":
        case "BI_WEEKLY":
          return s + (p * 26) / 12;
        default:
          return s + p;
      }
    }, 0);

    // Upcoming recurring expenses: expenses tagged isRecurring, averaged.
    const recurringExp = expenses.filter((e) => e.isRecurring);
    const monthlyRecurringExp =
      recurringExp.length > 0
        ? recurringExp.reduce((s, e) => s + Number(e.amount), 0) / Math.max(1, 3)
        : 0;
    void upcomingPayrollRuns;
    forecast = {
      expectedMembershipRevenue: round2(monthlyRecurring),
      expectedRecurringRevenue: round2(monthlyRecurring),
      upcomingPayroll: round2(payroll / Math.max(1, monthsInRange(r))),
      upcomingRecurringExpenses: round2(monthlyRecurringExp),
      expectedStripePayouts: 0,
      projectedMonthEndCash: null, // Requires live balance query — future sub-phase.
      estimatedRunwayMonths: null,
      breakEvenProgress: null,
      isEstimate: true,
      basis: "Based on trailing 90-day history and current recurring subscriptions",
    };
  }

  return {
    range: {
      key: r.key,
      label: r.label,
      start: r.start?.toISOString() ?? null,
      end: r.end.toISOString(),
    },
    beginningCash: null, // Requires live account balance snapshot at start.
    cashReceived: round2(cashReceived),
    cashSpent: round2(cashSpent),
    netMovement: round2(netMovement),
    endingCash: null,
    operating: { inflows: round2(opInflows), outflows: round2(opOutflows) },
    investing: investingArr,
    financing: financingArr,
    excluded,
    forecast,
    reliability: "ESTIMATED",
    reliabilityNotes: [
      "Beginning + ending cash require live bank balances — surfaced on Snapshot when a bank is connected.",
      excluded.matchedStripePayouts.count > 0
        ? `${excluded.matchedStripePayouts.count} Stripe payout${excluded.matchedStripePayouts.count === 1 ? "" : "s"} excluded to avoid double-counting.`
        : "No Stripe payouts matched to bank rows yet — the sync will populate this over time.",
    ],
  };
}

function monthsInRange(r: ResolvedRange): number {
  if (!r.start) return 12;
  return Math.max(1, (r.end.getTime() - r.start.getTime()) / (30 * 86400000));
}
