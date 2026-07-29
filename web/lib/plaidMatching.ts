// Money-Out matching — the algorithm behind the "Suggested match" pill in
// the Bank tab. Never auto-finalizes; every match must be confirmed by the
// owner.

import type { PrismaClient } from "@prisma/client";

// Amount tolerance for suggested matches (cents).
const AMOUNT_TOLERANCE = 0.01;
// Date window on either side of the PlaidTransaction date.
const DATE_WINDOW_DAYS = 3;

export type MatchCandidate = {
  kind: "expense" | "payroll";
  id: string;
  amount: number;
  date: string;
  label: string;
  score: number; // 0..1
};

// Find likely Expense / payroll matches for one PlaidTransaction.
//
// Plaid convention: positive amount = outflow (money left the account). We
// only ever match expenses to outflows.
export async function suggestExpenseMatches(
  prisma: PrismaClient,
  clubId: string,
  plaidTx: {
    plaidTransactionId: string;
    amount: number; // positive = outflow
    date: Date;
    merchantName: string | null;
    name: string;
  },
  max = 3,
): Promise<MatchCandidate[]> {
  // Never match a MONEY-IN row.
  if (plaidTx.amount <= 0) return [];

  const winStart = new Date(plaidTx.date);
  winStart.setDate(winStart.getDate() - DATE_WINDOW_DAYS);
  const winEnd = new Date(plaidTx.date);
  winEnd.setDate(winEnd.getDate() + DATE_WINDOW_DAYS);

  const rows = await prisma.expense.findMany({
    where: {
      clubId,
      date: { gte: winStart, lte: winEnd },
      matchedPlaidTransactionId: null,
    },
    orderBy: { date: "desc" },
    take: 40,
  });

  const vendorHint = (plaidTx.merchantName || plaidTx.name || "").toLowerCase();

  const candidates: MatchCandidate[] = [];
  for (const r of rows) {
    const localAmt = Number(r.amount);
    if (Math.abs(localAmt - plaidTx.amount) > AMOUNT_TOLERANCE) continue;
    const dayDiff = Math.abs((plaidTx.date.getTime() - r.date.getTime()) / 86400000);
    let score = 1 - Math.min(1, dayDiff / (DATE_WINDOW_DAYS + 1)); // date proximity
    const vend = (r.vendor || r.description || "").toLowerCase();
    if (vend && vendorHint && (vend.includes(vendorHint) || vendorHint.includes(vend))) {
      score += 0.5;
    }
    candidates.push({
      kind: "expense",
      id: r.id,
      amount: localAmt,
      date: r.date.toISOString().slice(0, 10),
      label: r.vendor || r.description,
      score: Math.min(1, score),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, max);
}

// Apply category-rule matching against a single PlaidTransaction. Returns the
// first active rule that matches (order = createdAt ASC), or null.
export async function findCategoryRule(
  prisma: PrismaClient,
  clubId: string,
  plaidTx: { amount: number; merchantName: string | null; name: string },
) {
  const rules = await prisma.transactionCategoryRule.findMany({
    where: { clubId, active: true },
    orderBy: { createdAt: "asc" },
  });
  const vendor = (plaidTx.merchantName || plaidTx.name || "").toLowerCase();
  for (const rule of rules) {
    switch (rule.matchType) {
      case "VENDOR_EXACT":
        if (rule.matchValue && vendor === rule.matchValue.toLowerCase()) return rule;
        break;
      case "VENDOR_CONTAINS":
        if (rule.matchValue && vendor.includes(rule.matchValue.toLowerCase())) return rule;
        break;
      case "DESCRIPTION_CONTAINS":
        if (rule.matchValue && plaidTx.name.toLowerCase().includes(rule.matchValue.toLowerCase())) return rule;
        break;
      case "AMOUNT_EQUALS":
        if (rule.matchValue && Math.abs(Number(rule.matchValue) - plaidTx.amount) < AMOUNT_TOLERANCE) return rule;
        break;
      case "AMOUNT_RANGE":
        if (
          rule.matchMin != null &&
          rule.matchMax != null &&
          plaidTx.amount >= Number(rule.matchMin) &&
          plaidTx.amount <= Number(rule.matchMax)
        ) {
          return rule;
        }
        break;
    }
  }
  return null;
}
