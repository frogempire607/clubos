import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import {
  resolveRevenueCategory,
  revenueCategoryLabel,
  expenseCategoryLabel,
  isCashMethod,
} from "@/lib/financials";
import type { Prisma } from "@prisma/client";

// GET /api/financials/summary?entity=&from=&to=
// Entity-aware "Money In / Money Out" dashboard. Permission-gated on
// `finances` view — NOT tier-gated (core money tracking on every plan).
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? new Date(fromStr) : null;
  const to = toStr ? new Date(toStr) : null;

  const entityWhere = entity && entity !== "all" ? { legalEntityId: entity } : {};
  const inRange = (d: Date | null) =>
    (!from || d! >= from) && (!to || d! <= to);

  // Transactions: report on txDate when set (manual entries), else createdAt.
  const txDateFilter: Prisma.TransactionWhereInput =
    from || to
      ? {
          OR: [
            { txDate: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
            { txDate: null, createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
          ],
        }
      : {};

  const [transactions, expenses, donations, contractorPayments, entities] = await Promise.all([
    prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...entityWhere, ...txDateFilter },
      select: {
        id: true, amount: true, platformFee: true, type: true, category: true,
        paymentMethod: true, description: true, manual: true, txDate: true, createdAt: true,
      },
    }),
    prisma.expense.findMany({
      where: {
        clubId,
        ...entityWhere,
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: { id: true, amount: true, category: true, paymentMethod: true, receiptUrl: true },
    }),
    prisma.donation.findMany({
      where: {
        clubId,
        ...entityWhere,
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: { id: true, amount: true, paymentMethod: true, restricted: true, sponsorship: true },
    }),
    prisma.contractorPayment.findMany({
      where: {
        clubId,
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: { amount: true },
    }),
    prisma.legalEntity.findMany({
      where: { clubId },
      select: { id: true, name: true, entityType: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);

  let moneyIn = 0;
  let stripeFees = 0;
  let cashIn = 0;
  let cardIn = 0;
  let uncategorized = 0;
  let unpaidCount = 0;
  let unpaidTotal = 0;
  const revenueByCategory: Record<string, number> = {};
  const topSourcesMap: Record<string, number> = {};

  for (const t of transactions) {
    const amt = Number(t.amount);
    moneyIn += amt;
    stripeFees += Number(t.platformFee || 0);
    if (isCashMethod(t.paymentMethod)) cashIn += amt;
    else cardIn += amt;
    const cat = resolveRevenueCategory(t);
    if (!cat) uncategorized++;
    const key = cat ?? "uncategorized";
    revenueByCategory[key] = (revenueByCategory[key] || 0) + amt;
    const src = revenueCategoryLabel(cat);
    topSourcesMap[src] = (topSourcesMap[src] || 0) + amt;
  }

  // Manual invoices still awaiting payment (recorded as PENDING manual tx).
  const pendingInvoices = await prisma.transaction.findMany({
    where: { clubId, manual: true, status: "PENDING", ...entityWhere },
    select: { amount: true, txDate: true, createdAt: true },
  });
  for (const p of pendingInvoices) {
    if (!from && !to) { unpaidCount++; unpaidTotal += Number(p.amount); continue; }
    const d = p.txDate ?? p.createdAt;
    if (inRange(d)) { unpaidCount++; unpaidTotal += Number(p.amount); }
  }

  let moneyOut = 0;
  let receiptsMissing = 0;
  const expensesByCategory: Record<string, number> = {};
  for (const e of expenses) {
    const amt = Number(e.amount);
    moneyOut += amt;
    if (!e.receiptUrl) receiptsMissing++;
    const k = e.category || "OTHER";
    expensesByCategory[k] = (expensesByCategory[k] || 0) + amt;
  }

  const donationsTotal = donations.reduce((s, d) => s + Number(d.amount), 0);
  const restrictedTotal = donations.filter((d) => d.restricted).reduce((s, d) => s + Number(d.amount), 0);
  const sponsorshipTotal = donations.filter((d) => d.sponsorship).reduce((s, d) => s + Number(d.amount), 0);
  const donationsCash = donations.filter((d) => isCashMethod(d.paymentMethod)).reduce((s, d) => s + Number(d.amount), 0);
  const contractorTotal = contractorPayments.reduce((s, c) => s + Number(c.amount), 0);

  // Donations are money in too (separate from Stripe transactions).
  moneyIn += donationsTotal;
  cashIn += donationsCash;
  cardIn += donationsTotal - donationsCash;

  const topSources = Object.entries(topSourcesMap)
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  return NextResponse.json({
    entities,
    money: {
      moneyIn,
      moneyOut,
      net: moneyIn - moneyOut,
      cashIn,
      cardIn,
      stripeFees,
      donationsTotal,
      contractorTotal,
    },
    nonprofit: { donationsTotal, restrictedTotal, unrestrictedTotal: donationsTotal - restrictedTotal, sponsorshipTotal },
    needsReview: { uncategorized, receiptsMissing, unpaidInvoices: { count: unpaidCount, total: unpaidTotal } },
    revenueByCategory: Object.entries(revenueByCategory)
      .map(([key, amount]) => ({ key, label: revenueCategoryLabel(key === "uncategorized" ? null : key), amount }))
      .sort((a, b) => b.amount - a.amount),
    expensesByCategory: Object.entries(expensesByCategory)
      .map(([key, amount]) => ({ key, label: expenseCategoryLabel(key), amount }))
      .sort((a, b) => b.amount - a.amount),
    topSources,
  });
}
