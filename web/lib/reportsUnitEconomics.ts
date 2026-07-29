// Reports Phase 2.5.6 — Unit economics tab.
//
// Owner-first framing: this is the SECONDARY tab where ratios (CAC, LTV,
// break-even, margins) live. Snapshot and Membership answer the primary
// questions with plain-English numbers first.
//
// Non-negotiables from specs/03:
// - Non-positive contribution margin returns `null` + message. Never divide
//   by a negative and print a nonsense number.
// - Every estimated field carries `isEstimate: true`.
// - CAC returns `null` when no marketing spend recorded.
// - LTV:CAC returns `null` when either input is null.
// - Zero-athlete-count returns `null` for every per-athlete figure — never NaN.

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import { computePayrollTotalForRange } from "@/lib/payroll";
import type { ResolvedRange } from "@/lib/reportsRange";

export type UnitEconomicsPayload = {
  range: { key: string; label: string; start: string | null; end: string };
  athleteCount: number;
  perAthlete: {
    revenue: number | null;
    cost: number | null;
    grossProfit: number | null;
    operatingProfit: number | null;
    marginPercent: number | null;
  };
  margins: {
    grossMarginPercent: number | null;
    operatingMarginPercent: number | null;
  };
  breakEven: {
    athletes: number | null;
    currentAthletes: number;
    gap: number | null;
    formula: {
      label: string;
      monthlyFixedCosts: number;
      contributionMarginPerAthlete: number | null;
    };
    isEstimate: true;
    message: string | null;
  };
  acquisition: {
    cac: number | null;
    ltv: number | null;
    ltvToCacRatio: number | null;
    isEstimate: true;
    caveats: string[];
  };
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundPct = (n: number) => Math.round(n * 1000) / 10;

function txDateWhere(r: ResolvedRange) {
  if (!r.start) return {};
  return {
    OR: [
      { txDate: { not: null, gte: r.start, lt: r.end } },
      { txDate: null, createdAt: { gte: r.start, lt: r.end } },
    ],
  };
}

export async function buildUnitEconomics(clubId: string, r: ResolvedRange): Promise<UnitEconomicsPayload> {
  const [txs, expenses, payroll, athleteCount, newMembers, marketingExpenses] = await Promise.all([
    prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...txDateWhere(r) },
      select: { amount: true, refundedAmount: true, type: true },
    }),
    prisma.expense.findMany({
      where: r.start ? { clubId, date: { gte: r.start, lt: r.end } } : { clubId },
      select: { amount: true, category: true, kind: true },
    }),
    computePayrollTotalForRange(clubId, r.start ?? null, r.end),
    prisma.member.count({
      where: { clubId, deletedAt: null, status: "ACTIVE" },
    }),
    // Members joined in range = new-athlete count for CAC.
    r.start
      ? prisma.member.count({
          where: {
            clubId,
            deletedAt: null,
            joinedAt: { gte: r.start, lt: r.end },
          },
        })
      : Promise.resolve(0),
    prisma.expense.findMany({
      where: {
        clubId,
        category: "MARKETING",
        ...(r.start ? { date: { gte: r.start, lt: r.end } } : {}),
      },
      select: { amount: true },
    }),
  ]);

  const revenue = txs.reduce((s, t) => s + Number(t.amount) - Number(t.refundedAmount ?? 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0) + payroll;

  // Fixed vs variable split for break-even.
  // A row is FIXED if `kind='FIXED'` OR `kind IS NULL AND category IS RENT/INSURANCE/SOFTWARE/PROFESSIONAL/UTILITIES/PAYROLL`.
  const FIXED_CATEGORIES = new Set(["RENT", "INSURANCE", "SOFTWARE", "PROFESSIONAL", "UTILITIES", "PAYROLL"]);
  let fixedCosts = payroll; // Payroll is fixed by default.
  let variableCosts = 0;
  for (const e of expenses) {
    const amt = Number(e.amount);
    const isFixed =
      e.kind === "FIXED" || (e.kind == null && FIXED_CATEGORIES.has(e.category));
    if (isFixed) fixedCosts += amt;
    else variableCosts += amt;
  }
  const grossProfit = revenue - variableCosts;
  const operatingProfit = revenue - totalExpenses;

  // Per-athlete figures — null if no athletes.
  const perAthlete: UnitEconomicsPayload["perAthlete"] = athleteCount > 0
    ? {
        revenue: round2(revenue / athleteCount),
        cost: round2(totalExpenses / athleteCount),
        grossProfit: round2(grossProfit / athleteCount),
        operatingProfit: round2(operatingProfit / athleteCount),
        marginPercent: revenue > 0 ? roundPct(operatingProfit / revenue) : null,
      }
    : {
        revenue: null,
        cost: null,
        grossProfit: null,
        operatingProfit: null,
        marginPercent: null,
      };

  const margins = {
    grossMarginPercent: revenue > 0 ? roundPct(grossProfit / revenue) : null,
    operatingMarginPercent: revenue > 0 ? roundPct(operatingProfit / revenue) : null,
  };

  // Break-even.
  // contributionMarginPerAthlete = revenuePerAthlete - variableCostPerAthlete
  const variableCostPerAthlete = athleteCount > 0 ? variableCosts / athleteCount : null;
  const revenuePerAthlete = perAthlete.revenue;
  const contribution =
    revenuePerAthlete != null && variableCostPerAthlete != null
      ? revenuePerAthlete - variableCostPerAthlete
      : null;

  // Range length in months.
  const rangeMs = r.start ? r.end.getTime() - r.start.getTime() : 30 * 86400000;
  const months = Math.max(1, rangeMs / (30 * 86400000));
  const monthlyFixedCosts = fixedCosts / months;

  let breakEven: UnitEconomicsPayload["breakEven"];
  if (contribution == null) {
    breakEven = {
      athletes: null,
      currentAthletes: athleteCount,
      gap: null,
      formula: {
        label: "Break-even = ceil(monthly fixed costs ÷ contribution margin per athlete)",
        monthlyFixedCosts: round2(monthlyFixedCosts),
        contributionMarginPerAthlete: null,
      },
      isEstimate: true,
      message: "Add active athletes to compute break-even.",
    };
  } else if (contribution <= 0) {
    breakEven = {
      athletes: null,
      currentAthletes: athleteCount,
      gap: null,
      formula: {
        label: "Break-even = ceil(monthly fixed costs ÷ contribution margin per athlete)",
        monthlyFixedCosts: round2(monthlyFixedCosts),
        contributionMarginPerAthlete: round2(contribution),
      },
      isEstimate: true,
      message:
        "Your variable cost per athlete is higher than your revenue per athlete — every additional athlete currently loses money.",
    };
  } else {
    const bev = Math.ceil(monthlyFixedCosts / contribution);
    breakEven = {
      athletes: bev,
      currentAthletes: athleteCount,
      gap: athleteCount - bev,
      formula: {
        label: "Break-even = ceil(monthly fixed costs ÷ contribution margin per athlete)",
        monthlyFixedCosts: round2(monthlyFixedCosts),
        contributionMarginPerAthlete: round2(contribution),
      },
      isEstimate: true,
      message: null,
    };
  }

  // Acquisition.
  const marketingSpend = marketingExpenses.reduce((s, e) => s + Number(e.amount), 0);
  const cac =
    marketingSpend > 0 && newMembers > 0 ? round2(marketingSpend / newMembers) : null;
  const caveats: string[] = [];
  if (marketingSpend <= 0) caveats.push("No marketing spend recorded in this range — CAC is null.");
  if (marketingSpend > 0 && newMembers === 0) caveats.push("Marketing spend recorded but no new members joined — CAC not meaningful.");
  // LTV = avgMonthlyRevenuePerAthlete × avgMembershipDurationMonths × grossMarginPercent
  // avgMembershipDurationMonths ships with subscription-event history (Phase 4.5).
  // For MVP we return null and note the caveat.
  const ltv: number | null = null;
  const ltvToCacRatio = ltv != null && cac != null && cac > 0 ? round2(ltv / cac) : null;
  if (ltv == null) caveats.push("LTV precision ships with the subscription-event history in Phase 4.5.");
  if (newMembers > 0 && marketingSpend > 0) {
    caveats.push(`${newMembers} new member${newMembers === 1 ? "" : "s"} in range. CAC directionally useful; per-source attribution requires acquisition-source tagging.`);
  }

  return {
    range: {
      key: r.key,
      label: r.label,
      start: r.start?.toISOString() ?? null,
      end: r.end.toISOString(),
    },
    athleteCount,
    perAthlete,
    margins,
    breakEven,
    acquisition: {
      cac,
      ltv,
      ltvToCacRatio,
      isEstimate: true,
      caveats,
    },
  };
}
