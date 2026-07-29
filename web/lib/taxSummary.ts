// Bank-based Tax Summary — the calculation behind Financials → Tax Summary.
//
// Reads from PlaidTransaction (bank ledger) for expenses AND from the
// Transaction table (owner-declared money records) for income NOT already
// visible in the bank feed. Every bucket carries the source it came from
// so the owner can verify.
//
// Core rules (plan §1D):
//   1. A Stripe charge and the bank deposit of its payout are ONE dollar,
//      not two. We count Stripe income from the Transaction table (that's
//      the authoritative source of what Stripe processed) and EXCLUDE any
//      bank credit categorized as `stripe_payout` — those are just Stripe
//      handing us our own money.
//   2. Transfers between the club's own accounts are neither income nor
//      expense. `markedAsTransfer` on the bank row hides it from both sides.
//   3. `excludedFromTax` (bank OR expense) drops a row from the tax roll-up
//      but keeps it visible on the ledger.
//   4. Refunds reduce income in their original category (via Transaction
//      refundedAmount). Chargebacks reduce it too.
//   5. Cash income already recorded in AthletixOS shows up separately —
//      NEVER counted twice with bank if the owner deposits the cash later.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { EXCLUDE_VOID } from "@/lib/paymentSources";

export type TaxRange = { entity?: string | null; from?: Date | null; to?: Date | null };

export type TaxSummary = {
  range: { from: string | null; to: string | null };
  income: {
    stripeGross: number;
    stripeFees: number;
    stripeNet: number;
    stripeRefunded: number;
    // Non-Stripe income the owner recorded in AthletixOS (cash/check/comp
    // shows here). Comp is displayed but excluded from taxable total.
    cashRecorded: number;
    checkRecorded: number;
    compRecorded: number;
    // Money coming INTO the bank that isn't a Stripe payout, isn't a
    // transfer, and isn't excluded — the "other business income" bucket.
    bankOtherIncome: number;
  };
  expenses: {
    categorized: { key: string; amount: number }[];
    total: number;
    // Bank rows the owner has NOT reviewed yet — surfaced so tax numbers
    // are honest about what's still needing categorization.
    needsReview: { count: number; amount: number };
    // Explicitly-excluded rows (owner-drawings, loans, transfers).
    excluded: number;
    transfers: number;
  };
  totals: {
    grossIncome: number;
    refunds: number;
    processingFees: number;
    netIncome: number;
    categorizedExpenses: number;
    estimatedTaxableProfit: number;
  };
  notes: string[];
};

// Category keys we treat as "not income" when applied to bank CREDITS
// (negative-amount PlaidTransactions).
const NON_INCOME_CATEGORIES = new Set([
  "stripe_payout",
  "OWNER_CONTRIBUTION",
  "LOAN_DEPOSIT",
  "TRANSFER",
]);

// Category keys the owner may pick for excluded outflows.
const NON_EXPENSE_CATEGORIES = new Set([
  "OWNER_DRAW",
  "LOAN_REPAYMENT",
  "TRANSFER",
]);

export async function computeBankBasedTaxSummary(
  clubId: string,
  r: TaxRange,
): Promise<TaxSummary> {
  const entityWhereTx = r.entity && r.entity !== "all" ? { legalEntityId: r.entity } : {};
  const dateWhereTx: Prisma.TransactionWhereInput =
    r.from || r.to
      ? {
          OR: [
            {
              txDate: {
                not: null,
                ...(r.from ? { gte: r.from } : {}),
                ...(r.to ? { lte: r.to } : {}),
              },
            },
            {
              txDate: null,
              createdAt: {
                ...(r.from ? { gte: r.from } : {}),
                ...(r.to ? { lte: r.to } : {}),
              },
            },
          ],
        }
      : {};

  const [txs, plaidRows] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        ...entityWhereTx,
        ...dateWhereTx,
      },
      select: {
        amount: true,
        stripeFeeAmount: true,
        refundedAmount: true,
        paymentSource: true,
        paymentMethod: true,
      },
    }),
    prisma.plaidTransaction.findMany({
      where: {
        clubId,
        ...(r.from || r.to
          ? {
              date: {
                ...(r.from ? { gte: r.from } : {}),
                ...(r.to ? { lte: r.to } : {}),
              },
            }
          : {}),
      },
      select: {
        amount: true,
        categoryOverride: true,
        categorizedExpenseId: true,
        markedAsTransfer: true,
        excludedFromTax: true,
        reviewedAt: true,
      },
    }),
  ]);

  // ── Stripe income (authoritative from Transaction table) ──────────────
  let stripeGross = 0;
  let stripeFees = 0;
  let stripeRefunded = 0;
  let cashRecorded = 0;
  let checkRecorded = 0;
  let compRecorded = 0;
  for (const t of txs) {
    const amt = Number(t.amount);
    const refunded = Number(t.refundedAmount || 0);
    switch (t.paymentSource) {
      case "STRIPE":
        stripeGross += amt;
        stripeFees += Number(t.stripeFeeAmount || 0);
        stripeRefunded += refunded;
        break;
      case "CASH":
        cashRecorded += amt - refunded;
        break;
      case "CHECK":
        checkRecorded += amt - refunded;
        break;
      case "COMP":
        compRecorded += amt;
        break;
      // EXTERNAL_READER and MANUAL_ADJUSTMENT are neither Stripe-verified
      // nor cash the owner recorded — surfaced through the Cash & Offline
      // tab, not counted as taxable income here.
      default:
        break;
    }
  }

  // ── Bank rows: outflows → expenses; inflows → other business income ──
  let bankOtherIncome = 0;
  let bankExpensesRaw = 0;
  let bankExcluded = 0;
  let bankTransfers = 0;
  let bankNeedsReviewCount = 0;
  let bankNeedsReviewAmount = 0;
  const expensesByCategory = new Map<string, number>();

  for (const p of plaidRows) {
    const amt = Number(p.amount); // positive = outflow, negative = inflow
    const cat = p.categoryOverride || "";

    if (p.markedAsTransfer || cat === "TRANSFER" || NON_INCOME_CATEGORIES.has(cat) || NON_EXPENSE_CATEGORIES.has(cat)) {
      if (p.markedAsTransfer || cat === "TRANSFER") bankTransfers += Math.abs(amt);
      continue;
    }
    if (p.excludedFromTax) {
      bankExcluded += Math.abs(amt);
      continue;
    }

    if (amt < 0) {
      // Money in — the only kind of bank credit that counts as income here
      // is the "other business income" bucket. Stripe payouts must be
      // categorized as `stripe_payout` (or marked-as-transfer) by the owner
      // to avoid double-counting — until they are, they surface in "needs
      // review" so the number is honest.
      if (!cat) {
        bankNeedsReviewCount += 1;
        bankNeedsReviewAmount += Math.abs(amt);
        continue;
      }
      bankOtherIncome += Math.abs(amt);
      continue;
    }

    // Money out.
    if (!cat && !p.reviewedAt && !p.categorizedExpenseId) {
      bankNeedsReviewCount += 1;
      bankNeedsReviewAmount += amt;
      continue;
    }
    const key = cat || "OTHER";
    expensesByCategory.set(key, (expensesByCategory.get(key) || 0) + amt);
    bankExpensesRaw += amt;
  }

  const categorized = Array.from(expensesByCategory.entries())
    .map(([key, amount]) => ({ key, amount }))
    .sort((a, b) => b.amount - a.amount);

  const stripeNet = stripeGross - stripeFees - stripeRefunded;
  const grossIncome = stripeGross + cashRecorded + checkRecorded + bankOtherIncome;
  const refunds = stripeRefunded;
  const processingFees = stripeFees;
  const netIncome = grossIncome - refunds - processingFees;
  const categorizedExpenses = bankExpensesRaw;
  const estimatedTaxableProfit = netIncome - categorizedExpenses;

  const notes: string[] = [
    "Bank-based Tax Summary — Stripe income counted once, bank Stripe payouts must be marked to avoid double-counting.",
  ];
  if (bankNeedsReviewCount > 0) {
    notes.push(
      `${bankNeedsReviewCount} bank transaction(s) still need categorization. Review them in the Bank tab so this summary is complete.`,
    );
  }
  notes.push("Estimated taxable profit is an organizational summary, not tax advice.");

  return {
    range: {
      from: r.from ? r.from.toISOString().slice(0, 10) : null,
      to: r.to ? r.to.toISOString().slice(0, 10) : null,
    },
    income: {
      stripeGross,
      stripeFees,
      stripeNet,
      stripeRefunded,
      cashRecorded,
      checkRecorded,
      compRecorded,
      bankOtherIncome,
    },
    expenses: {
      categorized,
      total: bankExpensesRaw,
      needsReview: { count: bankNeedsReviewCount, amount: bankNeedsReviewAmount },
      excluded: bankExcluded,
      transfers: bankTransfers,
    },
    totals: {
      grossIncome,
      refunds,
      processingFees,
      netIncome,
      categorizedExpenses,
      estimatedTaxableProfit,
    },
    notes,
  };
}
