// Reports Phase 2.5.3 — Costs tab compute layer.
//
// Sources: Expense rows + payroll (via computePayrollTotalForRange) +
// contractor payments. Fixed vs variable is decided in this order per row:
//   1. `Expense.kind` if non-null
//   2. `ExpenseClassificationOverride` per category
//   3. Default-by-category (see DEFAULT_KIND below)
//
// Unusual-increase detection: current period ≥ 1.5× trailing 3-period
// average AND absolute diff ≥ $250 (both conditions must hold).

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import { computePayrollTotalForRange } from "@/lib/payroll";
import { EXPENSE_CATEGORIES, expenseCategoryLabel } from "@/lib/financials";
import type { ResolvedRange } from "@/lib/reportsRange";

export type CostsPayload = {
  range: { key: string; label: string; start: string | null; end: string };
  fixed: { total: number; monthlyAverage: number; percentOfRevenue: number; categories: string[] };
  variable: { total: number; monthlyAverage: number; percentOfRevenue: number; categories: string[] };
  topCategories: Array<{
    rank: number;
    category: string;
    label: string;
    behavior: "FIXED" | "VARIABLE";
    amount: number;
    percentOfRevenue: number;
    deltaPercent: number | null;
    deltaAmount: number | null;
    overridden: boolean;
  }>;
  topVendors: Array<{ vendor: string; amount: number; transactionCount: number }>;
  largestExpenses: Array<{ id: string; date: string; description: string; vendor: string | null; amount: number; href: string }>;
  attention: {
    uncategorized: { count: number; amount: number; href: string };
    missingReceipts: { count: number; amount: number; href: string };
    awaitingReview: { count: number; href: string };
    unusualIncreases: Array<{ category: string; label: string; currentAmount: number; averageAmount: number; percentAbove: number }>;
    recurringSubscriptions: { count: number; monthlyAmount: number; href: string };
    possibleDuplicates: Array<{ ids: string[]; vendor: string; amount: number; date: string }>;
  };
  overrides: Array<{ category: string; treatAs: "FIXED" | "VARIABLE"; updatedById: string | null }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, denom: number) =>
  denom > 0 ? Math.round((num / denom) * 1000) / 10 : 0;

const DEFAULT_KIND: Record<string, "FIXED" | "VARIABLE"> = {
  RENT: "FIXED",
  INSURANCE: "FIXED",
  SOFTWARE: "FIXED",
  UTILITIES: "FIXED",
  PROFESSIONAL: "FIXED",
  PAYROLL: "FIXED",
  CONTRACTOR: "VARIABLE",
  EQUIPMENT: "VARIABLE",
  MARKETING: "VARIABLE",
  TRAVEL: "VARIABLE",
  MEALS: "VARIABLE",
  MAINTENANCE: "VARIABLE",
  FEES: "VARIABLE",
  EVENTS: "VARIABLE",
  OTHER: "VARIABLE",
};

export const COSTS_DEFAULT_KIND = DEFAULT_KIND;

export function resolveBehavior(
  row: { category: string; kind: string | null },
  overrides: Map<string, "FIXED" | "VARIABLE">,
): "FIXED" | "VARIABLE" {
  if (row.kind === "FIXED" || row.kind === "VARIABLE") return row.kind;
  const ov = overrides.get(row.category);
  if (ov) return ov;
  return DEFAULT_KIND[row.category] ?? "VARIABLE";
}

// Unusual-increase check: current amount vs a trailing average. Trigger when
// current ≥ 1.5× avg AND diff ≥ $250 (both must hold). PURE.
export function isUnusualIncrease(current: number, trailingTotals: number[]): {
  triggered: boolean;
  average: number;
  percentAbove: number;
} {
  const positives = trailingTotals.filter((v) => v > 0);
  if (positives.length < 2) return { triggered: false, average: 0, percentAbove: 0 };
  const avg = positives.reduce((s, v) => s + v, 0) / positives.length;
  const triggered = current >= avg * 1.5 && current - avg >= 250;
  const percentAbove = avg > 0 ? Math.round(((current - avg) / avg) * 1000) / 10 : 0;
  return { triggered, average: avg, percentAbove };
}

// Trailing 3 complete periods same length as `r` — used for unusual-increase
// detection.
export function trailingPeriods(r: ResolvedRange): Array<{ start: Date; end: Date }> {
  if (!r.start) return [];
  const len = r.end.getTime() - r.start.getTime();
  const periods: Array<{ start: Date; end: Date }> = [];
  let cursor = r.start.getTime();
  for (let i = 0; i < 3; i++) {
    const end = new Date(cursor);
    const start = new Date(cursor - len);
    periods.push({ start, end });
    cursor -= len;
  }
  return periods;
}

export async function buildCosts(clubId: string, r: ResolvedRange): Promise<CostsPayload> {
  const [expenses, txsForRevenue, overridesRaw, contractorPayments, allExpenses] = await Promise.all([
    prisma.expense.findMany({
      where: r.start ? { clubId, date: { gte: r.start, lt: r.end } } : { clubId },
      select: {
        id: true, description: true, amount: true, category: true, kind: true, date: true,
        isRecurring: true, vendor: true, receiptUrl: true,
      },
    }),
    prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...txDateWhere(r) },
      select: { amount: true, refundedAmount: true },
    }),
    prisma.expenseClassificationOverride.findMany({
      where: { clubId },
      select: { category: true, treatAs: true, updatedById: true },
    }),
    prisma.contractorPayment.findMany({
      where: r.start
        ? { contractor: { clubId }, date: { gte: r.start, lt: r.end } }
        : { contractor: { clubId } },
      select: { id: true, amount: true, date: true, contractor: { select: { name: true } } },
    }),
    // For unusual-increase detection: pull the trailing 3 periods for
    // category totals.
    prisma.expense.findMany({
      where: r.start
        ? {
            clubId,
            date: {
              gte: new Date(r.start.getTime() - 3 * (r.end.getTime() - r.start.getTime())),
              lt: r.end,
            },
          }
        : { clubId },
      select: { amount: true, category: true, date: true, kind: true },
    }),
  ]);

  const overrides = new Map(overridesRaw.map((o) => [o.category, o.treatAs as "FIXED" | "VARIABLE"]));
  const revenue =
    txsForRevenue.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0);
  const payroll = await computePayrollTotalForRange(clubId, r.start ?? null, r.end);

  // Combine expense rows with payroll (as one bucket) and contractor
  // payments (as another bucket) so top-categories is honest.
  type Row = { id: string; description: string; amount: number; category: string; kind: string | null; date: Date; vendor: string | null; receiptUrl: string | null; isRecurring: boolean };
  const rows: Row[] = expenses.map((e) => ({
    id: e.id, description: e.description, amount: Number(e.amount), category: e.category,
    kind: e.kind, date: e.date, vendor: e.vendor, receiptUrl: e.receiptUrl,
    isRecurring: e.isRecurring,
  }));
  if (payroll > 0) {
    rows.push({
      id: "payroll:auto",
      description: "Staff payroll",
      amount: payroll,
      category: "PAYROLL",
      kind: null,
      date: r.end,
      vendor: null,
      receiptUrl: null,
      isRecurring: false,
    });
  }
  for (const cp of contractorPayments) {
    rows.push({
      id: cp.id,
      description: `Contractor payment — ${cp.contractor.name}`,
      amount: Number(cp.amount),
      category: "CONTRACTOR",
      kind: "VARIABLE",
      date: cp.date,
      vendor: cp.contractor.name,
      receiptUrl: null,
      isRecurring: false,
    });
  }

  // Split fixed / variable.
  let fixedTotal = 0;
  let variableTotal = 0;
  const fixedCategories = new Set<string>();
  const variableCategories = new Set<string>();
  for (const row of rows) {
    const behavior = resolveBehavior(row, overrides);
    if (behavior === "FIXED") {
      fixedTotal += row.amount;
      fixedCategories.add(row.category);
    } else {
      variableTotal += row.amount;
      variableCategories.add(row.category);
    }
  }

  // Range length in months, minimum 1 (a partial month still divides by 1).
  const rangeMs = r.start ? r.end.getTime() - r.start.getTime() : 30 * 86400000;
  const rangeMonths = Math.max(1, rangeMs / (30 * 86400000));

  // Category totals (current + previous trailing periods for delta / unusual).
  const currentByCategory = new Map<string, number>();
  for (const row of rows) {
    currentByCategory.set(row.category, (currentByCategory.get(row.category) ?? 0) + row.amount);
  }
  const periods = trailingPeriods(r);
  const previousByCategory: Array<Map<string, number>> = periods.map(() => new Map<string, number>());
  for (const row of allExpenses) {
    const amt = Number(row.amount);
    const rowDate = new Date(row.date);
    // Find which trailing bucket it falls in (skip if in current).
    for (let i = 0; i < periods.length; i++) {
      const { start, end } = periods[i];
      if (rowDate >= start && rowDate < end && (i > 0 || rowDate < r.start!)) {
        previousByCategory[i].set(row.category, (previousByCategory[i].get(row.category) ?? 0) + amt);
      }
    }
  }

  // topCategories with delta vs previous period (index 0 is immediate prior).
  const topCategoriesUnsorted = Array.from(currentByCategory.entries()).map(([category, amount]) => {
    const prior = periods[0] ? previousByCategory[0].get(category) : undefined;
    const deltaAmount = prior != null ? amount - prior : null;
    const deltaPercent =
      prior != null && prior > 0 ? Math.round(((amount - prior) / prior) * 1000) / 10 : null;
    const overridden = overrides.has(category);
    const behavior = resolveBehavior({ category, kind: null }, overrides);
    return {
      category,
      label: expenseCategoryLabel(category),
      behavior,
      amount: round2(amount),
      percentOfRevenue: pct(amount, revenue),
      deltaPercent,
      deltaAmount: deltaAmount != null ? round2(deltaAmount) : null,
      overridden,
    };
  });
  topCategoriesUnsorted.sort((a, b) => b.amount - a.amount);
  const topCategories = topCategoriesUnsorted.slice(0, 10).map((c, i) => ({ rank: i + 1, ...c }));

  // Top vendors.
  const vendorMap = new Map<string, { amount: number; count: number }>();
  for (const row of rows) {
    if (!row.vendor) continue;
    const existing = vendorMap.get(row.vendor) ?? { amount: 0, count: 0 };
    existing.amount += row.amount;
    existing.count += 1;
    vendorMap.set(row.vendor, existing);
  }
  const topVendors = Array.from(vendorMap.entries())
    .map(([vendor, v]) => ({ vendor, amount: round2(v.amount), transactionCount: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Largest single expenses.
  const largestExpenses = rows
    .filter((row) => row.id !== "payroll:auto")
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((row) => ({
      id: row.id,
      date: row.date.toISOString().slice(0, 10),
      description: row.description,
      vendor: row.vendor,
      amount: round2(row.amount),
      href: `/dashboard/financials?tab=out&edit=${row.id}`,
    }));

  // Attention.
  const uncategorizedRows = rows.filter((row) => !row.category || row.category === "OTHER");
  const missingReceiptRows = rows.filter((row) => row.category !== "PAYROLL" && !row.receiptUrl && row.id !== "payroll:auto");
  const recurringRows = rows.filter((row) => row.isRecurring);

  // Unusual increases: category totals in the current range against the
  // trailing 3 same-length periods average. Fire when current ≥ 1.5× avg
  // AND diff ≥ $250.
  const unusualIncreases: CostsPayload["attention"]["unusualIncreases"] = [];
  for (const [category, currentAmount] of currentByCategory) {
    const trailingTotals = previousByCategory
      .map((m) => m.get(category) ?? 0)
      .filter((v) => v > 0);
    if (trailingTotals.length < 2) continue;
    const avg = trailingTotals.reduce((s, v) => s + v, 0) / trailingTotals.length;
    if (currentAmount >= avg * 1.5 && currentAmount - avg >= 250) {
      unusualIncreases.push({
        category,
        label: expenseCategoryLabel(category),
        currentAmount: round2(currentAmount),
        averageAmount: round2(avg),
        percentAbove: Math.round(((currentAmount - avg) / avg) * 1000) / 10,
      });
    }
  }

  // Possible duplicates: same vendor + same amount within 2 days.
  const dupGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.vendor) continue;
    const key = `${row.vendor}::${row.amount.toFixed(2)}`;
    const arr = dupGroups.get(key) ?? [];
    arr.push(row);
    dupGroups.set(key, arr);
  }
  const possibleDuplicates: CostsPayload["attention"]["possibleDuplicates"] = [];
  for (const [_, group] of dupGroups) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.date.getTime() - b.date.getTime());
    for (let i = 0; i < group.length - 1; i++) {
      const a = group[i];
      const b = group[i + 1];
      if (Math.abs(a.date.getTime() - b.date.getTime()) <= 2 * 86400000) {
        possibleDuplicates.push({
          ids: [a.id, b.id],
          vendor: a.vendor ?? "Unknown",
          amount: round2(a.amount),
          date: a.date.toISOString().slice(0, 10),
        });
      }
    }
  }

  return {
    range: {
      key: r.key,
      label: r.label,
      start: r.start?.toISOString() ?? null,
      end: r.end.toISOString(),
    },
    fixed: {
      total: round2(fixedTotal),
      monthlyAverage: round2(fixedTotal / rangeMonths),
      percentOfRevenue: pct(fixedTotal, revenue),
      categories: Array.from(fixedCategories).map(expenseCategoryLabel),
    },
    variable: {
      total: round2(variableTotal),
      monthlyAverage: round2(variableTotal / rangeMonths),
      percentOfRevenue: pct(variableTotal, revenue),
      categories: Array.from(variableCategories).map(expenseCategoryLabel),
    },
    topCategories,
    topVendors,
    largestExpenses,
    attention: {
      uncategorized: {
        count: uncategorizedRows.length,
        amount: round2(uncategorizedRows.reduce((s, r) => s + r.amount, 0)),
        href: "/dashboard/financials?tab=out&filter=uncategorized",
      },
      missingReceipts: {
        count: missingReceiptRows.length,
        amount: round2(missingReceiptRows.reduce((s, r) => s + r.amount, 0)),
        href: "/dashboard/financials?tab=out&filter=missing_receipts",
      },
      awaitingReview: {
        count: 0,
        href: "/dashboard/financials?tab=bank&filter=needs_review",
      },
      unusualIncreases,
      recurringSubscriptions: {
        count: recurringRows.length,
        monthlyAmount: round2(
          recurringRows.reduce((s, r) => s + r.amount, 0) / rangeMonths,
        ),
        href: "/dashboard/financials?tab=out&filter=recurring",
      },
      possibleDuplicates,
    },
    overrides: overridesRaw.map((o) => ({
      category: o.category,
      treatAs: o.treatAs as "FIXED" | "VARIABLE",
      updatedById: o.updatedById,
    })),
  };
}

function txDateWhere(r: ResolvedRange) {
  if (!r.start) return {};
  return {
    OR: [
      { txDate: { not: null, gte: r.start, lt: r.end } },
      { txDate: null, createdAt: { gte: r.start, lt: r.end } },
    ],
  };
}

export const EXPENSE_CATEGORY_KEYS = EXPENSE_CATEGORIES.map((c) => c.key);
