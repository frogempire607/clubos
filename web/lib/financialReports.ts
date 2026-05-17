import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  resolveRevenueCategory,
  revenueCategoryLabel,
  expenseCategoryLabel,
  paymentMethodLabel,
  isCashMethod,
  isCompMethod,
} from "@/lib/financials";

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
    const [txs, expenses, donations] = await Promise.all([
      prisma.transaction.findMany({
        where: { clubId, status: "SUCCEEDED", ...entityWhere, ...txDateWhere(r) },
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
    ]);
    const revenue = txs.reduce((s, t) => s + Number(t.amount), 0);
    const dono = donations.reduce((s, d) => s + Number(d.amount), 0);
    const exp = expenses.reduce((s, e) => s + Number(e.amount), 0);
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
      where: { clubId, status: "SUCCEEDED", ...entityWhere, ...txDateWhere(r) },
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
    const expenses = await prisma.expense.findMany({
      where: { clubId, ...entityWhere, ...dateFilter(r) },
      select: { amount: true, category: true },
    });
    const map: Record<string, number> = {};
    for (const e of expenses) map[e.category || "OTHER"] = (map[e.category || "OTHER"] || 0) + Number(e.amount);
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
        where: { clubId, status: "SUCCEEDED", ...entityWhere, ...txDateWhere(r) },
        select: { amount: true, paymentMethod: true },
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
    let card = 0;
    let comp = 0;
    for (const t of [...txs, ...donations]) {
      if (isCompMethod(t.paymentMethod)) comp += Number(t.amount);
      else if (isCashMethod(t.paymentMethod)) cash += Number(t.amount);
      else card += Number(t.amount);
    }
    const invoiced = pending.reduce((s, p) => s + Number(p.amount), 0);
    return {
      title: "Revenue by channel",
      columns: ["Channel", "Amount"],
      rows: [
        ["Card / online / bank", money(card)],
        ["Cash / check", money(cash)],
        ["Comp / free", money(comp)],
        ["Invoiced (unpaid)", money(invoiced)],
        ["Collected total", money(cash + card)],
      ],
    };
  }

  if (type === "stripe_fees") {
    const txs = await prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...entityWhere, ...txDateWhere(r) },
      select: { amount: true, platformFee: true },
    });
    const gross = txs.reduce((s, t) => s + Number(t.amount), 0);
    const fees = txs.reduce((s, t) => s + Number(t.platformFee || 0), 0);
    return {
      title: "Stripe fees summary",
      columns: ["Line", "Amount"],
      rows: [
        ["Gross processed", money(gross)],
        ["Platform fees recorded", money(fees)],
        ["Net after recorded fees", money(gross - fees)],
        ["Transactions", String(txs.length)],
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
    where: { clubId, status: "SUCCEEDED", category: null, ...entityWhere, ...txDateWhere(r) },
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
