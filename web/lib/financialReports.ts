import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import {
  resolveRevenueCategory,
  revenueCategoryLabel,
  expenseCategoryLabel,
  paymentMethodLabel,
  isCashMethod,
  isCompMethod,
} from "@/lib/financials";
import { computePayrollTotalForRange } from "@/lib/payroll";

export const REPORT_TYPES = [
  "pnl",
  "revenue_by_category",
  "expenses_by_category",
  "donations",
  "contractors",
  "cash_vs_card",
  "stripe_fees",
  "missing_receipts",
  "uncategorized",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_LABELS: Record<ReportType, string> = {
  pnl: "Profit & Loss",
  revenue_by_category: "Revenue by category",
  expenses_by_category: "Expenses by category",
  donations: "Donations summary",
  contractors: "Contractor / guest coach payments",
  cash_vs_card: "Cash vs card revenue",
  stripe_fees: "Stripe fees summary",
  missing_receipts: "Receipts missing",
  uncategorized: "Uncategorized transactions",
};

export type ReportResult = { title: string; columns: string[]; rows: (string | number)[][] };

type Range = { entity?: string | null; from?: Date | null; to?: Date | null };

function txDateWhere(r: Range): Prisma.TransactionWhereInput {
  if (!r.from && !r.to) return {};
  return {
    OR: [
      { txDate: { not: null, ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } },
      { txDate: null, createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } },
    ],
  };
}
function dateRange(r: Range): { gte?: Date; lte?: Date } | undefined {
  if (!r.from && !r.to) return undefined;
  return { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) };
}
// Spread helper: `...dateFilter(r)` → `{ date: { gte, lte } }` or `{}`.
function dateFilter(r: Range): { date?: { gte?: Date; lte?: Date } } {
  const dr = dateRange(r);
  return dr ? { date: dr } : {};
}
const money = (n: number) => Number(n).toFixed(2);

export async function buildReport(
  clubId: string,
  type: ReportType,
  r: Range,
): Promise<ReportResult> {
  const entityWhere = r.entity && r.entity !== "all" ? { legalEntityId: r.entity } : {};

  if (type === "pnl") {
    const [txs, expenses, donations, payrollTotal] = await Promise.all([
      prisma.transaction.findMany({
        where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...entityWhere, ...txDateWhere(r) },
        select: { amount: true },
      }),
      prisma.expense.findMany({
        where: { clubId, ...entityWhere, ...dateFilter(r) },
        select: { amount: true },
      }),
      prisma.donation.findMany({
        where: { clubId, ...entityWhere, ...dateFilter(r) },
        select: { amount: true },
      }),
      computePayrollTotalForRange(clubId, r.from ?? null, r.to ?? new Date()),
    ]);
    const revenue = txs.reduce((s, t) => s + Number(t.amount), 0);
    const dono = donations.reduce((s, d) => s + Number(d.amount), 0);
    const exp = expenses.reduce((s, e) => s + Number(e.amount), 0) + payrollTotal;
    return {
      title: "Profit & Loss",
      columns: ["Line", "Amount"],
      rows: [
        ["Revenue (payments)", money(revenue)],
        ["Donations", money(dono)],
        ["Total income", money(revenue + dono)],
        ["Total expenses", money(exp)],
        ["Net income", money(revenue + dono - exp)],
      ],
    };
  }

  if (type === "revenue_by_category") {
    const txs = await prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...entityWhere, ...txDateWhere(r) },
      select: { amount: true, type: true, category: true },
    });
    const map: Record<string, number> = {};
    for (const t of txs) {
      const key = resolveRevenueCategory(t) ?? "uncategorized";
      map[key] = (map[key] || 0) + Number(t.amount);
    }
    return {
      title: "Revenue by category",
      columns: ["Category", "Amount"],
      rows: Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [revenueCategoryLabel(k === "uncategorized" ? null : k), money(v)]),
    };
  }

  if (type === "expenses_by_category") {
    const [expenses, payrollTotal] = await Promise.all([
      prisma.expense.findMany({
      where: { clubId, ...entityWhere, ...dateFilter(r) },
      select: { amount: true, category: true },
      }),
      computePayrollTotalForRange(clubId, r.from ?? null, r.to ?? new Date()),
    ]);
    const map: Record<string, number> = {};
    for (const e of expenses) map[e.category || "OTHER"] = (map[e.category || "OTHER"] || 0) + Number(e.amount);
    if (payrollTotal > 0) map.PAYROLL = (map.PAYROLL || 0) + payrollTotal;
    return {
      title: "Expenses by category",
      columns: ["Category", "Amount"],
      rows: Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [expenseCategoryLabel(k), money(v)]),
    };
  }

  if (type === "donations") {
    const donations = await prisma.donation.findMany({
      where: { clubId, ...entityWhere, ...dateFilter(r) },
      orderBy: { date: "desc" },
      include: { legalEntity: { select: { name: true } } },
    });
    return {
      title: "Donations summary",
      columns: ["Date", "Donor", "Email", "Amount", "Fund", "Restricted", "Sponsorship", "Method", "Entity", "Receipt"],
      rows: donations.map((d) => [
        d.date.toISOString().slice(0, 10),
        d.donorName,
        d.donorEmail ?? "",
        money(Number(d.amount)),
        d.fund ?? "",
        d.restricted ? "Yes" : "No",
        d.sponsorship ? "Yes" : "No",
        paymentMethodLabel(d.paymentMethod),
        d.legalEntity?.name ?? "",
        d.receiptUrl ? "Yes" : "No",
      ]),
    };
  }

  if (type === "contractors") {
    const payments = await prisma.contractorPayment.findMany({
      where: { clubId, ...dateFilter(r) },
      orderBy: { date: "desc" },
      include: { contractor: { select: { name: true, email: true, role: true } } },
    });
    return {
      title: "Contractor / guest coach payments",
      columns: ["Date", "Contractor", "Role", "Email", "Amount", "Service", "Notes"],
      rows: payments.map((p) => [
        p.date.toISOString().slice(0, 10),
        p.contractor.name,
        p.contractor.role ?? "",
        p.contractor.email ?? "",
        money(Number(p.amount)),
        p.service ?? "",
        p.notes ?? "",
      ]),
    };
  }

  if (type === "cash_vs_card") {
    const [txs, pending, donations] = await Promise.all([
      prisma.transaction.findMany({
        where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...entityWhere, ...txDateWhere(r) },
        select: { amount: true, paymentMethod: true, paymentSource: true },
      }),
      prisma.transaction.findMany({
        where: { clubId, status: "PENDING", manual: true, ...entityWhere, ...txDateWhere(r) },
        select: { amount: true },
      }),
      prisma.donation.findMany({
        where: { clubId, ...entityWhere, ...dateFilter(r) },
        select: { amount: true, paymentMethod: true },
      }),
    ]);
    let cash = 0;
    let check = 0;
    let card = 0;
    let externalReader = 0; // UNVERIFIED external card records — never "card"
    let comp = 0;
    for (const t of txs) {
      const source = (t as { paymentSource?: string | null }).paymentSource ?? null;
      if (isCompMethod(t.paymentMethod)) comp += Number(t.amount);
      else if (source === "EXTERNAL_READER") externalReader += Number(t.amount);
      else if (source === "CHECK" || t.paymentMethod === "CHECK") check += Number(t.amount);
      else if (isCashMethod(t.paymentMethod)) cash += Number(t.amount);
      else card += Number(t.amount);
    }
    for (const d of donations) {
      if (isCompMethod(d.paymentMethod)) comp += Number(d.amount);
      else if (isCashMethod(d.paymentMethod)) cash += Number(d.amount);
      else card += Number(d.amount);
    }
    const invoiced = pending.reduce((s, p) => s + Number(p.amount), 0);
    return {
      title: "Revenue by channel",
      columns: ["Channel", "Amount"],
      rows: [
        ["Verified card (Stripe)", money(card)],
        ["Cash", money(cash)],
        ["Check", money(check)],
        ["External reader (record only — unverified)", money(externalReader)],
        ["Comp / free", money(comp)],
        ["Invoiced (unpaid)", money(invoiced)],
        ["Collected total", money(cash + check + card + externalReader)],
      ],
    };
  }

  if (type === "stripe_fees") {
    // Exact Stripe fees only — from balance transactions, never computed
    // locally. Rows without fee data are counted so the owner knows the
    // number is incomplete rather than silently wrong.
    const txs = await prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", paymentSource: "STRIPE", ...EXCLUDE_VOID, ...entityWhere, ...txDateWhere(r) },
      select: { amount: true, platformFee: true, stripeFeeAmount: true, netAmount: true },
    });
    const gross = txs.reduce((s, t) => s + Number(t.amount), 0);
    const stripeFees = txs.reduce((s, t) => s + Number(t.stripeFeeAmount || 0), 0);
    const platformFees = txs.reduce((s, t) => s + Number(t.platformFee || 0), 0);
    const missingFeeData = txs.filter((t) => t.stripeFeeAmount == null).length;
    return {
      title: "Stripe fees summary",
      columns: ["Line", "Amount"],
      rows: [
        ["Gross processed (Stripe)", money(gross)],
        ["Stripe processing fees (exact)", money(stripeFees)],
        ["AthletixOS platform fees", money(platformFees)],
        ["Net after fees", money(gross - stripeFees - platformFees)],
        ["Transactions", String(txs.length)],
        ["Missing fee data (run reconciliation)", String(missingFeeData)],
      ],
    };
  }

  if (type === "missing_receipts") {
    const expenses = await prisma.expense.findMany({
      where: { clubId, receiptUrl: null, ...entityWhere, ...dateFilter(r) },
      orderBy: { date: "desc" },
      include: { legalEntity: { select: { name: true } } },
    });
    return {
      title: "Receipts missing",
      columns: ["Date", "Description", "Vendor", "Amount", "Category", "Entity"],
      rows: expenses.map((e) => [
        e.date.toISOString().slice(0, 10),
        e.description,
        e.vendor ?? "",
        money(Number(e.amount)),
        expenseCategoryLabel(e.category),
        e.legalEntity?.name ?? "",
      ]),
    };
  }

  // uncategorized
  const txs = await prisma.transaction.findMany({
    where: { clubId, status: "SUCCEEDED", category: null, ...EXCLUDE_VOID, ...entityWhere, ...txDateWhere(r) },
    orderBy: { createdAt: "desc" },
    include: { member: { select: { firstName: true, lastName: true } } },
  });
  const rows = txs
    .filter((t) => !resolveRevenueCategory(t))
    .map((t) => [
      (t.txDate ?? t.createdAt).toISOString().slice(0, 10),
      t.description ?? "",
      t.member ? `${t.member.firstName} ${t.member.lastName}` : (t.source ?? ""),
      money(Number(t.amount)),
      t.type ?? "",
    ]);
  return {
    title: "Uncategorized transactions",
    columns: ["Date", "Description", "Payer / source", "Amount", "Type"],
    rows,
  };
}

export function reportToCsv(res: ReportResult): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [res.columns, ...res.rows].map((row) => row.map(esc).join(",")).join("\n");
}
