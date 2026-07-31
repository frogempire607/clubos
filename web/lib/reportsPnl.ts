// Reports Phase 2.5.4 — Profit & Loss compute layer.
//
// Contract from specs/02 §pnl:
//   {
//     period: "monthly" | "weekly",
//     basis: "cash" | "accrual",
//     columns: [{ key, label, start, end, isPartial }],
//     sections: [{ key, label, lines: [{ key, label, values[], drillHref }], total }],
//     summary: [{ grossIncome, netOperatingIncome, grossProfit, grossMarginPercent,
//                 totalOperatingExpenses, operatingProfit, netProfit, profitMarginPercent }] (one per column),
//     rollingAverage: { label, values[] } | null,
//     accrualCoverage: { supported, unsupportedPurchaseCount } | null,
//     warnings: [{ kind, message, href }]
//   }
//
// Cash basis: recognise on settlement date (txDate ?? createdAt).
// Accrual: recognise ratably across the purchase's service span. Daily
// proration. Purchases with no span fall back to cash and increment
// `unsupportedPurchaseCount`, which the UI surfaces.
// Rounding: money in Decimal (approximated via cents integer here), rounded
// half-up to 2 dp at the boundary; percentages 1 dp; negatives parenthesised
// at render.

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import { computePayrollTotalForRange } from "@/lib/payroll";
import { expenseCategoryLabel } from "@/lib/financials";
import type { ResolvedRange } from "@/lib/reportsRange";

export type PnlPeriod = "monthly" | "weekly";
export type PnlBasis = "cash" | "accrual";

export type PnlColumn = { key: string; label: string; start: Date; end: Date; isPartial: boolean };
export type PnlLine = {
  key: string;
  label: string;
  values: number[]; // one per column, aligned by index
  drillHref: string; // /api/reports/pnl/drill URL sans host
};
export type PnlSection = {
  key: "income" | "cost_of_sales" | "operating_expenses";
  label: string;
  lines: PnlLine[];
  total: { label: string; values: number[] };
};
export type PnlSummaryEntry = {
  grossIncome: number;
  netOperatingIncome: number;
  grossProfit: number;
  grossMarginPercent: number | null;
  totalOperatingExpenses: number;
  operatingProfit: number;
  netProfit: number;
  profitMarginPercent: number | null;
};

export type PnlPayload = {
  period: PnlPeriod;
  basis: PnlBasis;
  columns: Array<{ key: string; label: string; start: string; end: string; isPartial: boolean }>;
  sections: PnlSection[];
  summary: PnlSummaryEntry[];
  rollingAverage: { label: string; values: number[] } | null;
  accrualCoverage: { supported: boolean; unsupportedPurchaseCount: number } | null;
  warnings: Array<{ kind: "PARTIAL_PERIOD" | "ACCRUAL_INCOMPLETE" | "UNCATEGORIZED"; message: string; href: string }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Column builders ─────────────────────────────────────────────────────

// Build up to 6 monthly columns anchored to the range end. Includes the
// current month even if partial. Returns oldest→newest.
export function monthlyColumns(rangeEnd: Date, tz: string): PnlColumn[] {
  const cols: PnlColumn[] = [];
  const now = rangeEnd;
  const cursor = new Date(now);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const isPartial = i === 0 && now < end;
    cols.push({
      key: start.toISOString().slice(0, 7),
      label: start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: tz }),
      start,
      end,
      isPartial,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  cols.reverse();
  return cols;
}

// Build weekly columns: 5 complete weeks + the current partial week if any.
export function weeklyColumns(rangeEnd: Date, tz: string): PnlColumn[] {
  const cols: PnlColumn[] = [];
  const now = rangeEnd;
  // Anchor to the current Monday.
  const monday = new Date(now);
  const dowStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dowMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow = dowMap[dowStr] ?? 0;
  monday.setUTCDate(monday.getUTCDate() - dow);
  monday.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const start = new Date(monday);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    const isPartial = i === 0 && now < end;
    cols.push({
      key: `${start.toISOString().slice(0, 10)}`,
      label: start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz }),
      start,
      end,
      isPartial,
    });
  }
  cols.reverse();
  return cols;
}

// ── The main compute function ──────────────────────────────────────────

// Fixtures shape for computePnl — matches what buildPnl pulls out of Prisma.
// Extracted so unit tests can exercise the calculation logic without a DB.
export type PnlFixtures = {
  txs: Array<{
    id: string;
    amount: unknown; // Decimal-like or number
    refundedAmount?: unknown | null;
    type: string | null;
    category: string | null;
    txDate: Date | null;
    createdAt: Date;
    memberId: string | null;
    eventId?: string | null;
    description?: string | null;
  }>;
  expenses: Array<{
    id: string;
    amount: unknown;
    category: string | null;
    kind: string | null;
    date: Date;
    description?: string;
    vendor?: string | null;
  }>;
  donations: Array<{ id: string; amount: unknown; date: Date; donorName?: string | null }>;
  allSubs: Array<{ id: string; startedAt: Date | null; endDate: Date | null; price: unknown }>;
  payrollPerCol: number[]; // aligned by column index
};

// Pure calculation of the P&L payload from fixtures + columns + basis.
// This is what unit tests exercise. buildPnl is a thin wrapper that fetches.
export function computePnl(
  columns: PnlColumn[],
  basis: PnlBasis,
  data: PnlFixtures,
  period: PnlPeriod,
): PnlPayload {
  const { txs, expenses, donations, allSubs, payrollPerCol } = data;
  const cols = columns.length;
  const zeroCols = () => Array(cols).fill(0) as number[];

  // ── Income accumulator ─────────────────────────────────────────────
  const incomeLineByType = new Map<string, number[]>();
  const incomeSubcolByCategory = new Map<string, number[]>();
  const bucketColumn = (d: Date): number => {
    for (let i = 0; i < cols; i++) {
      if (d >= columns[i].start && d < columns[i].end) return i;
    }
    return -1;
  };

  let unsupportedPurchaseCount = 0;

  for (const t of txs) {
    const amount = Number(t.amount) - Number(t.refundedAmount ?? 0);
    if (amount === 0) continue;
    const type = t.type ?? "OTHER";
    // For accrual, membership-type transactions try to prorate across the
    // subscription's service span. Non-membership types fall back to cash.
    let colIdx = -1;
    let recognized: Array<{ colIdx: number; amount: number }> = [];
    if (basis === "accrual" && (type === "MEMBERSHIP" || type === "SUBSCRIPTION")) {
      const sub = t.memberId ? allSubs.find((s) => s.startedAt && s.endDate) : null;
      if (sub && sub.startedAt && sub.endDate) {
        const start = sub.startedAt.getTime();
        const end = sub.endDate.getTime();
        const totalMs = Math.max(1, end - start);
        for (let i = 0; i < cols; i++) {
          const overlapStart = Math.max(start, columns[i].start.getTime());
          const overlapEnd = Math.min(end, columns[i].end.getTime());
          if (overlapEnd > overlapStart) {
            const share = (overlapEnd - overlapStart) / totalMs;
            recognized.push({ colIdx: i, amount: amount * share });
          }
        }
      } else {
        unsupportedPurchaseCount += 1;
      }
    }
    if (recognized.length === 0) {
      const settledAt = t.txDate ?? t.createdAt;
      colIdx = bucketColumn(settledAt);
      if (colIdx < 0) continue;
      recognized.push({ colIdx, amount });
    }
    const arr = incomeLineByType.get(type) ?? zeroCols();
    for (const rec of recognized) arr[rec.colIdx] += rec.amount;
    incomeLineByType.set(type, arr);
    const catArr = incomeSubcolByCategory.get(t.category ?? "uncategorized") ?? zeroCols();
    for (const rec of recognized) catArr[rec.colIdx] += rec.amount;
    incomeSubcolByCategory.set(t.category ?? "uncategorized", catArr);
  }

  // Donations line.
  {
    const arr = zeroCols();
    for (const d of donations) {
      const colIdx = bucketColumn(d.date);
      if (colIdx < 0) continue;
      arr[colIdx] += Number(d.amount);
    }
    if (arr.some((v) => v !== 0)) incomeLineByType.set("DONATION", arr);
  }

  // ── Expense accumulator ────────────────────────────────────────────
  const costLinesByCategory = new Map<string, number[]>();
  for (const e of expenses) {
    const colIdx = bucketColumn(e.date);
    if (colIdx < 0) continue;
    const cat = e.category ?? "OTHER";
    const arr = costLinesByCategory.get(cat) ?? zeroCols();
    arr[colIdx] += Number(e.amount);
    costLinesByCategory.set(cat, arr);
  }
  // Add payroll as its own category (`PAYROLL`).
  {
    const arr = costLinesByCategory.get("PAYROLL") ?? zeroCols();
    for (let i = 0; i < cols; i++) arr[i] += payrollPerCol[i];
    if (arr.some((v) => v !== 0)) costLinesByCategory.set("PAYROLL", arr);
  }

  // ── Build sections ─────────────────────────────────────────────────
  const incomeLines: PnlLine[] = Array.from(incomeLineByType.entries())
    .map(([type, values]) => ({
      key: `income:${type}`,
      label: incomeTypeLabel(type),
      values: values.map(round2),
      drillHref: `/api/reports/pnl/drill?line=income:${type}`,
    }))
    .sort((a, b) => sumArr(b.values) - sumArr(a.values));
  const incomeTotal = { label: "Total income", values: sumColumns(Array.from(incomeLineByType.values()), cols) };

  // Cost of sales = direct costs of running paid events + payroll for
  // event/private/attendance staff. Right now we don't have that split;
  // treat everything as operating expenses for simplicity. Future: split
  // rent/insurance/software into OpEx and the rest into COGS.
  const costOfSalesLines: PnlLine[] = [];
  const costOfSalesTotal = { label: "Direct costs", values: zeroCols() };

  const opExpenseLines: PnlLine[] = Array.from(costLinesByCategory.entries())
    .map(([cat, values]) => ({
      key: `opex:${cat}`,
      label: expenseCategoryLabel(cat),
      values: values.map(round2),
      drillHref: `/api/reports/pnl/drill?line=opex:${cat}`,
    }))
    .sort((a, b) => sumArr(b.values) - sumArr(a.values));
  const opExpenseTotal = {
    label: "Total operating expenses",
    values: sumColumns(Array.from(costLinesByCategory.values()), cols),
  };

  const sections: PnlSection[] = [
    { key: "income", label: "Income", lines: incomeLines, total: { ...incomeTotal, values: incomeTotal.values.map(round2) } },
    { key: "cost_of_sales", label: "Direct costs", lines: costOfSalesLines, total: costOfSalesTotal },
    { key: "operating_expenses", label: "Operating expenses", lines: opExpenseLines, total: { ...opExpenseTotal, values: opExpenseTotal.values.map(round2) } },
  ];

  // ── Summary per column ─────────────────────────────────────────────
  const summary: PnlSummaryEntry[] = columns.map((_, i) => {
    const grossIncome = incomeTotal.values[i];
    const directCosts = costOfSalesTotal.values[i];
    const grossProfit = grossIncome - directCosts;
    const grossMarginPercent =
      grossIncome > 0 ? Math.round(((grossProfit / grossIncome) * 1000)) / 10 : null;
    const totalOperatingExpenses = opExpenseTotal.values[i];
    const netOperatingIncome = grossIncome;
    const operatingProfit = grossProfit - totalOperatingExpenses;
    const netProfit = operatingProfit;
    const profitMarginPercent =
      grossIncome > 0 ? Math.round(((netProfit / grossIncome) * 1000)) / 10 : null;
    return {
      grossIncome: round2(grossIncome),
      netOperatingIncome: round2(netOperatingIncome),
      grossProfit: round2(grossProfit),
      grossMarginPercent,
      totalOperatingExpenses: round2(totalOperatingExpenses),
      operatingProfit: round2(operatingProfit),
      netProfit: round2(netProfit),
      profitMarginPercent,
    };
  });

  // ── Rolling average (weekly only, 4 completed weeks) ───────────────
  let rollingAverage: PnlPayload["rollingAverage"] = null;
  if (period === "weekly") {
    const complete = columns.map((c, i) => (!c.isPartial ? summary[i].netProfit : null));
    const completeVals = complete.filter((v): v is number => v != null);
    if (completeVals.length >= 4) {
      const last4 = completeVals.slice(-4);
      const avg = last4.reduce((s, v) => s + v, 0) / last4.length;
      rollingAverage = {
        label: "4-week rolling average",
        values: columns.map((_, i) => (complete[i] != null ? round2(avg) : 0)),
      };
    }
  }

  // ── Warnings ───────────────────────────────────────────────────────
  const warnings: PnlPayload["warnings"] = [];
  if (columns.some((c) => c.isPartial)) {
    warnings.push({
      kind: "PARTIAL_PERIOD",
      message: "The current period is not yet complete. It is excluded from the rolling average.",
      href: "/dashboard/reports?tab=pnl",
    });
  }
  if (basis === "accrual" && unsupportedPurchaseCount > 0) {
    warnings.push({
      kind: "ACCRUAL_INCOMPLETE",
      message: `${unsupportedPurchaseCount} purchase${unsupportedPurchaseCount === 1 ? "" : "s"} had no service span and fell back to cash-basis recognition.`,
      href: "/dashboard/financials?tab=in",
    });
  }
  if (incomeLineByType.has("uncategorized") || costLinesByCategory.has("OTHER")) {
    warnings.push({
      kind: "UNCATEGORIZED",
      message: "Some rows fell into an uncategorized bucket. Categorize them for accurate P&L.",
      href: "/dashboard/financials?tab=out&filter=uncategorized",
    });
  }

  return {
    period,
    basis,
    columns: columns.map((c) => ({
      key: c.key,
      label: c.label,
      start: c.start.toISOString(),
      end: c.end.toISOString(),
      isPartial: c.isPartial,
    })),
    sections,
    summary,
    rollingAverage,
    accrualCoverage:
      basis === "accrual"
        ? { supported: allSubs.length > 0, unsupportedPurchaseCount }
        : null,
    warnings,
  };
}

// buildPnl fetches the fixtures from Prisma and delegates to computePnl.
export async function buildPnl(
  clubId: string,
  r: ResolvedRange,
  period: PnlPeriod,
  basis: PnlBasis,
): Promise<PnlPayload> {
  const columns = period === "monthly" ? monthlyColumns(r.end, r.timezone) : weeklyColumns(r.end, r.timezone);
  const firstStart = columns[0].start;
  const lastEnd = columns[columns.length - 1].end;

  const [txs, expenses, donations, allSubs] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        OR: [
          { txDate: { not: null, gte: firstStart, lt: lastEnd } },
          { txDate: null, createdAt: { gte: firstStart, lt: lastEnd } },
        ],
      },
      select: {
        id: true, amount: true, refundedAmount: true, type: true, category: true,
        txDate: true, createdAt: true, memberId: true, eventId: true, description: true,
      },
    }),
    prisma.expense.findMany({
      where: { clubId, date: { gte: firstStart, lt: lastEnd } },
      select: { id: true, amount: true, category: true, kind: true, date: true, description: true, vendor: true },
    }),
    prisma.donation.findMany({
      where: { clubId, date: { gte: firstStart, lt: lastEnd } },
      select: { id: true, amount: true, date: true, donorName: true },
    }),
    basis === "accrual"
      ? prisma.memberSubscription.findMany({
          where: { member: { clubId } },
          select: { id: true, startedAt: true, endDate: true, price: true },
        })
      : Promise.resolve([]),
  ]);

  const payrollPerCol = await Promise.all(
    columns.map((c) => computePayrollTotalForRange(clubId, c.start, c.end)),
  );

  return computePnl(columns, basis, { txs, expenses, donations, allSubs, payrollPerCol }, period);
}

// ── Drill support ──────────────────────────────────────────────────────

export type DrillRow = {
  id: string;
  date: string;
  description: string;
  counterparty: string | null;
  amount: number;
  source: string;
  href: string;
};

// Parse a drill line key back into `{ section, subKey }` — used by
// /api/reports/pnl/drill/route.ts.
export function parseDrillLine(line: string): { section: "income" | "opex" | "unknown"; key: string } {
  const [prefix, rest] = line.split(":", 2);
  if (prefix === "income") return { section: "income", key: rest ?? "" };
  if (prefix === "opex") return { section: "opex", key: rest ?? "" };
  return { section: "unknown", key: line };
}

// Fetch drill rows for a given line + range. Used by
// /api/reports/pnl/drill/route.ts.
export async function fetchDrill(
  clubId: string,
  line: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ line: { key: string; label: string }; total: number; transactions: DrillRow[] }> {
  const parsed = parseDrillLine(line);
  if (parsed.section === "income") {
    const rows = await prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        type: parsed.key,
        OR: [
          { txDate: { not: null, gte: windowStart, lt: windowEnd } },
          { txDate: null, createdAt: { gte: windowStart, lt: windowEnd } },
        ],
      },
      include: { member: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
      take: 250,
    });
    const total = rows.reduce((s, r) => s + Number(r.amount) - Number(r.refundedAmount ?? 0), 0);
    return {
      line: { key: line, label: incomeTypeLabel(parsed.key) },
      total: round2(total),
      transactions: rows.map((r) => ({
        id: r.id,
        date: (r.txDate ?? r.createdAt).toISOString().slice(0, 10),
        description: r.description ?? incomeTypeLabel(r.type),
        counterparty: r.member ? `${r.member.firstName} ${r.member.lastName}`.trim() : null,
        amount: round2(Number(r.amount) - Number(r.refundedAmount ?? 0)),
        source: r.paymentSource ?? "OTHER",
        href: `/dashboard/financials?tab=stripe`,
      })),
    };
  }
  if (parsed.section === "opex") {
    const rows = await prisma.expense.findMany({
      where: {
        clubId,
        category: parsed.key,
        date: { gte: windowStart, lt: windowEnd },
      },
      orderBy: { date: "desc" },
      take: 250,
    });
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    return {
      line: { key: line, label: expenseCategoryLabel(parsed.key) },
      total: round2(total),
      transactions: rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        description: r.description,
        counterparty: r.vendor,
        amount: round2(Number(r.amount)),
        source: "expense",
        href: `/dashboard/financials?tab=out&edit=${r.id}`,
      })),
    };
  }
  return { line: { key: line, label: line }, total: 0, transactions: [] };
}

// ── Helpers ────────────────────────────────────────────────────────────

function sumArr(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0);
}

function sumColumns(arrays: number[][], cols: number): number[] {
  const out = Array(cols).fill(0) as number[];
  for (const arr of arrays) {
    for (let i = 0; i < cols; i++) out[i] += arr[i] ?? 0;
  }
  return out;
}

function incomeTypeLabel(t: string): string {
  const map: Record<string, string> = {
    MEMBERSHIP: "Memberships",
    SUBSCRIPTION: "Subscriptions",
    CLASS: "Class drop-ins",
    EVENT: "Events",
    PRIVATE: "Private lessons",
    PRODUCT: "Products",
    DONATION: "Donations",
    CHARGE: "One-time charges",
    MANUAL: "Manual payments",
    INVOICE: "Manual invoices",
    OTHER: "Other income",
  };
  return map[t] ?? t;
}

// ── CSV export ─────────────────────────────────────────────────────────

export function pnlToCsv(pnl: PnlPayload): string {
  const rows: string[][] = [];
  rows.push(["Line", ...pnl.columns.map((c) => c.label)]);
  for (const section of pnl.sections) {
    rows.push([`# ${section.label}`, ...pnl.columns.map(() => "")]);
    for (const line of section.lines) {
      rows.push([line.label, ...line.values.map((v) => v.toFixed(2))]);
    }
    rows.push([section.total.label, ...section.total.values.map((v) => v.toFixed(2))]);
  }
  rows.push([
    "Net profit",
    ...pnl.summary.map((s) => s.netProfit.toFixed(2)),
  ]);
  if (pnl.rollingAverage) {
    rows.push([pnl.rollingAverage.label, ...pnl.rollingAverage.values.map((v) => v.toFixed(2))]);
  }
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}
