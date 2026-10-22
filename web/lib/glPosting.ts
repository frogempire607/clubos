// Accounting Phase 2 — WHAT each kind of money posts, as a PURE module.
//
// No prisma, no next, no I/O. lib/glPostingServer.ts does the reading and
// writing and calls these; scripts/gl-posting-tests.ts proves them with no
// database, and the build gate runs those tests with DATABASE_URL pointed at a
// dead address.
//
// Every entry these functions produce goes through lib/ledgerServer.createEntry
// — the Phase 1 service — so the balance rule, the lock date and the
// intercompany rule all still apply. This module decides the LINES; it does not
// get to bypass the ledger.
//
// ── THE TWO RULES THAT MATTER MOST ─────────────────────────────────────────
//
// 1. KEY EVERYTHING ON AN IMMUTABLE ID. Every `sourceId` here is a Stripe
//    charge/invoice/payout id, a Plaid transaction id, or a local row id that
//    never moves between clubs. NEVER memberId: a subscription transferred
//    between siblings puts the money and the subscription on different members,
//    and reconciling through memberId once reported a $545.37 hole that did not
//    exist (CLAUDE.md). The (clubId, sourceType, sourceId) unique index from
//    Phase 1 then makes "posts at most once" structural.
//
// 2. WHEN THE FACTS AREN'T THERE, REFUSE — DON'T GUESS. A charge with no
//    Stripe fee recorded yet cannot be split into net/fee/revenue honestly, so
//    it is SKIPPED with a reason and picked up on the next run once
//    `fillChargeFees` has populated it. A skipped row is visible; a guessed one
//    is a wrong number nobody notices.
import {
  REVENUE_FALLBACK_ACCOUNT,
  accountForExpenseCategory,
  entryTotals,
  revenueAccountForTransaction,
  type DraftLine,
} from "@/lib/ledger";
import {
  PROCESSING_FEE_FIXED_CENTS,
  PROCESSING_FEE_PERCENT,
  quoteCharge,
  type FeePolicy,
} from "@/lib/fees";

/// Source types Phase 2 posts. Each pairs with an immutable `sourceId`; the
/// (clubId, sourceType, sourceId) unique index is the post-once guarantee.
export const POSTING_SOURCE_TYPES = [
  "STRIPE_CHARGE",
  "REFUND",
  "PAYOUT",
  "CASH_DEPOSIT",
  "EXPENSE",
  "BANK_ROW",
] as const;
export type PostingSourceType = (typeof POSTING_SOURCE_TYPES)[number];

/// Why a row was not posted. Every skip is reportable — the backfill script and
/// the Financials UI both show these, because a silently skipped dollar is the
/// failure this phase exists to end.
export type SkipReason =
  | "BEFORE_BOOKS_START"
  | "NO_BOOKS_START_DATE"
  | "ALREADY_POSTED"
  | "AWAITING_STRIPE_FEES"
  | "NOT_CATEGORIZED"
  | "COMPED"
  | "UNVERIFIED_SOURCE"
  | "NOT_MONEY_YET"
  | "VOIDED"
  | "ZERO_AMOUNT"
  | "MATCHED_TO_PAYOUT"
  | "MATCHED_TO_DEPOSIT"
  | "MATCHED_TO_EXPENSE"
  | "TRANSFER"
  | "MISSING_ACCOUNT"
  | "NO_BANK_ACCOUNT"
  | "SUSPECTED_DUPLICATE";

export const SKIP_LABELS: Record<SkipReason, string> = {
  BEFORE_BOOKS_START: "Dated before the club's books start date",
  NO_BOOKS_START_DATE: "The club has no books start date set, so nothing posts automatically",
  ALREADY_POSTED: "Already on the ledger",
  AWAITING_STRIPE_FEES: "Waiting on the Stripe fee and net — reconcile the Stripe tab, then this posts",
  NOT_CATEGORIZED: "Not categorized yet",
  COMPED: "Comped — not revenue, so nothing to post",
  UNVERIFIED_SOURCE: "Card collected outside AthletixOS — a record, not money we can post",
  NOT_MONEY_YET: "Not paid yet",
  VOIDED: "Voided — excluded from revenue, so there is nothing to post",
  ZERO_AMOUNT: "The amount is zero, so there is nothing to post",
  MATCHED_TO_PAYOUT: "Already accounted for as a Stripe payout",
  MATCHED_TO_DEPOSIT: "Already accounted for as a recorded deposit",
  MATCHED_TO_EXPENSE: "Posted through its matched expense instead",
  TRANSFER: "Marked as a transfer between your own accounts",
  MISSING_ACCOUNT: "The chart of accounts is missing an account this needs",
  NO_BANK_ACCOUNT: "That bank or card has no GL account yet",
  SUSPECTED_DUPLICATE:
    "Held for review: this looks like the same transaction as a bank-feed row (same account, same amount, within three days), and posting both would count the money twice",
};

/// A draft the server hands to lib/ledgerServer.createEntry, plus the
/// bookkeeping it needs to record alongside.
export type PostingPlan = {
  sourceType: PostingSourceType;
  sourceId: string;
  entryDate: string;
  memo: string;
  legalEntityId: string | null;
  reference: string | null;
  lines: DraftLine[];
};

export type PostingOutcome =
  | { posted: true; plan: PostingPlan }
  | { posted: false; reason: SkipReason; detail?: string };

const skip = (reason: SkipReason, detail?: string): PostingOutcome => ({ posted: false, reason, detail });

/// Account numbers the posting engine needs. Resolved by the server from
/// `systemKey` where one exists and by number otherwise, then handed in — so
/// this module never has to know how accounts are looked up.
export type AccountMap = {
  /// number → account id, for every active account in the club.
  byNumber: Record<string, string>;
  /// systemKey → account id. Preferred over byNumber for system accounts,
  /// because a club may have renumbered them.
  bySystemKey: Record<string, string>;
};

/// Resolve an account id, preferring the system key. Returns null when the
/// chart is missing it, which every caller turns into MISSING_ACCOUNT rather
/// than posting somewhere arbitrary.
export function resolveAccount(map: AccountMap, number: string, systemKey?: string): string | null {
  if (systemKey && map.bySystemKey[systemKey]) return map.bySystemKey[systemKey];
  return map.byNumber[number] ?? null;
}

const STRIPE_CLEARING = { number: "1050", key: "STRIPE_CLEARING" };
const UNDEPOSITED = { number: "1020", key: "UNDEPOSITED_FUNDS" };
const PROCESSING_FEES = { number: "6400" };
const FEES_RECOVERED = { number: "4800" };
const REFUNDS_CONTRA = { number: "4900" };

const money = (cents: number) => (cents / 100).toFixed(2);

// ── Recovering the sticker price from a charged total ───────────────────────

export type StickerSplit = { stickerCents: number; grossUpCents: number; exact: boolean };

/// Split a charged total into the club's sticker price and the fee gross-up the
/// payer absorbed.
///
/// `quoteCharge` (lib/fees.ts) is the one place the gross-up math lives, and it
/// runs forwards: net → total. Rather than re-derive an inverse that could
/// drift from it, this SEARCHES: estimate the net, then ask quoteCharge which
/// candidate actually produces the observed total. That way the split can never
/// disagree with what was charged.
///
/// `exact: false` means no candidate reproduced the total — usually because the
/// club changed its fee policy after the charge. Then the whole amount is
/// treated as the sticker price and nothing is posted to 4800. That is the
/// honest answer: we know what was charged, we no longer know how it was
/// composed, and inventing a gross-up would misstate revenue.
export function splitChargedTotal(totalCents: number, policy: FeePolicy): StickerSplit {
  if (totalCents <= 0) return { stickerCents: 0, grossUpCents: 0, exact: true };
  if (!policy.passProcessing && !policy.passPlatform) {
    // Nothing was added on top, so the total IS the sticker price.
    return { stickerCents: totalCents, grossUpCents: 0, exact: true };
  }

  // Estimate by inverting the forward formula, then verify a small window
  // around it. The window covers the ceil-and-guard rounding quoteCharge does.
  const r = policy.passPlatform ? policy.platformRate : 0;
  const f = policy.passPlatform ? policy.platformFixedCents : 0;
  // The constants come from lib/fees.ts — the one place Stripe's rate lives.
  // A second copy here would drift the moment that one changed, and
  // scripts/tier-gating-guard.ts refuses a hardcoded 0.029 for exactly that
  // reason.
  const pct = (policy.passProcessing ? PROCESSING_FEE_PERCENT : 0) + r;
  const fixed = (policy.passProcessing ? PROCESSING_FEE_FIXED_CENTS : 0) + f;
  const estimate = Math.round(totalCents * (1 - pct) - fixed);

  for (let delta = 0; delta <= 4; delta++) {
    for (const candidate of delta === 0 ? [estimate] : [estimate - delta, estimate + delta]) {
      if (candidate <= 0) continue;
      if (quoteCharge(candidate, policy).totalCents === totalCents) {
        return { stickerCents: candidate, grossUpCents: totalCents - candidate, exact: true };
      }
    }
  }
  return { stickerCents: totalCents, grossUpCents: 0, exact: false };
}

// ── A Stripe charge ────────────────────────────────────────────────────────

export type ChargeFacts = {
  /// The LOCAL transaction row id — used only for the memo, never as the key.
  id: string;
  /// The immutable Stripe id this posts under, in preference order:
  /// charge id → payment intent id → invoice id.
  stripeChargeId: string | null;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  /// "YYYY-MM-DD" — the effective accounting date (txDate ?? createdAt).
  date: string;
  /// Total charged, integer cents.
  amountCents: number;
  /// From the Stripe balance transaction. On a connected account `fee` is TOTAL
  /// fees (Stripe's own plus the AthletixOS application fee) and
  /// `net = amount - fee`, so these two always sum back to amountCents.
  feeCents: number | null;
  netCents: number | null;
  /// Revenue classification.
  category: string | null;
  type: string | null;
  legalEntityId: string | null;
  memberName: string | null;
  description: string | null;
  /// VERIFIED | OFFLINE | UNVERIFIED | REVIEW | VOID
  reconciliationStatus: string | null;
  /// STRIPE | CASH | CHECK | EXTERNAL_READER | COMP | MANUAL_ADJUSTMENT
  paymentSource: string | null;
  paymentMethod: string | null;
  status: string;
  /// The GL account of the bank this payment was DEPOSITED to, when it has
  /// been (from `Transaction.glDepositId` → `GlDeposit.accountId`). Null while
  /// the cash or cheque is still in the drawer.
  ///
  /// This is what fixes the Phase 2 rule that let 1020 go negative: a cash
  /// refund made AFTER the deposit comes out of the bank it went into, because
  /// the money is no longer in the drawer to refund from (Julian, Phase 3
  /// decision).
  depositedToAccountId?: string | null;
  /// The fee Stripe gave back (or charged) on the refund, from the refund's
  /// own balance transaction — positive when the club got fee money back.
  ///
  /// NOTHING POPULATES THIS TODAY; see the note on planRefund. The posting
  /// path is here and tested so wiring it up is a one-line change rather than
  /// a re-think.
  refundFeeDeltaCents?: number | null;
};

/// The immutable key a charge posts under. Charge id first because it is the
/// one Stripe guarantees for the money itself.
export function chargeSourceId(t: ChargeFacts): string | null {
  return t.stripeChargeId ?? t.stripePaymentIntentId ?? t.stripeInvoiceId ?? null;
}

/// A Stripe charge:
///   DEBIT  1050 Stripe Clearing        net
///   DEBIT  6400 Payment Processing Fee fees
///   CREDIT revenue                     sticker
///   CREDIT 4800 Processing Fees Recov.  gross-up
///
/// `6400` carries the TOTAL fee, including the AthletixOS platform fee, because
/// `feeCents` comes from the balance transaction's `fee` which is the total.
/// Splitting them would need a fee-detail breakdown we do not store, and the
/// club's books are correct either way — the money left the club. Noted in
/// docs/accounting/plan.md so nobody reads 6400 as Stripe-only.
export function planCharge(t: ChargeFacts, policy: FeePolicy, accounts: AccountMap): PostingOutcome {
  if (t.reconciliationStatus === "VOID") return skip("VOIDED");
  if (t.paymentSource === "COMP") return skip("COMPED");
  if (t.paymentSource === "EXTERNAL_READER" || t.reconciliationStatus === "UNVERIFIED") {
    return skip("UNVERIFIED_SOURCE");
  }
  if (t.status !== "SUCCEEDED" && t.status !== "REFUNDED") return skip("NOT_MONEY_YET", t.status);
  if (t.amountCents <= 0) return skip("ZERO_AMOUNT");

  const isStripe = t.paymentSource === "STRIPE" || t.reconciliationStatus === "VERIFIED";

  const revenueNumber = revenueAccountForTransaction({ category: t.category, type: t.type });
  const revenueId = resolveAccount(accounts, revenueNumber) ?? resolveAccount(accounts, REVENUE_FALLBACK_ACCOUNT);
  if (!revenueId) return skip("MISSING_ACCOUNT", `revenue account ${revenueNumber}`);

  const who = t.memberName ?? t.description ?? "payment";
  const lines: DraftLine[] = [];

  if (isStripe) {
    const sourceId = chargeSourceId(t);
    if (!sourceId) return skip("AWAITING_STRIPE_FEES", "no Stripe id on the row");
    // Refuse rather than guess: without the balance transaction we cannot
    // split net from fees, and inventing either misstates both revenue and
    // expense. `fillChargeFees` populates these; this posts on the next run.
    if (t.feeCents === null || t.netCents === null) return skip("AWAITING_STRIPE_FEES");
    // The identity the whole entry rests on.
    if (t.netCents + t.feeCents !== t.amountCents) {
      return skip(
        "AWAITING_STRIPE_FEES",
        `net ${money(t.netCents)} + fees ${money(t.feeCents)} ≠ charged ${money(t.amountCents)}`,
      );
    }

    const clearingId = resolveAccount(accounts, STRIPE_CLEARING.number, STRIPE_CLEARING.key);
    if (!clearingId) return skip("MISSING_ACCOUNT", "1050 Stripe Clearing");

    const split = splitChargedTotal(t.amountCents, policy);

    lines.push({ accountId: clearingId, debitCents: t.netCents, creditCents: 0, legalEntityId: t.legalEntityId, memo: `Stripe net — ${who}` });
    if (t.feeCents > 0) {
      const feeId = resolveAccount(accounts, PROCESSING_FEES.number);
      if (!feeId) return skip("MISSING_ACCOUNT", "6400 Payment Processing Fees");
      lines.push({ accountId: feeId, debitCents: t.feeCents, creditCents: 0, legalEntityId: t.legalEntityId, memo: "Processing fees" });
    }
    lines.push({ accountId: revenueId, debitCents: 0, creditCents: split.stickerCents, legalEntityId: t.legalEntityId, memo: who, memberId: null });
    if (split.grossUpCents > 0) {
      const recoveredId = resolveAccount(accounts, FEES_RECOVERED.number);
      if (!recoveredId) return skip("MISSING_ACCOUNT", "4800 Processing Fees Recovered");
      lines.push({ accountId: recoveredId, debitCents: 0, creditCents: split.grossUpCents, legalEntityId: t.legalEntityId, memo: "Processing fee passed to the payer" });
    }

    return {
      posted: true,
      plan: {
        sourceType: "STRIPE_CHARGE",
        sourceId,
        entryDate: t.date,
        memo: `Payment — ${who}`,
        legalEntityId: t.legalEntityId,
        reference: t.stripeInvoiceId ?? sourceId,
        lines,
      },
    };
  }

  // Cash / cheque. No fees; the money sits in 1020 Undeposited Funds until a
  // deposit is recorded, because cash in a drawer is not money in the bank.
  if (t.paymentSource === "CASH" || t.paymentSource === "CHECK") {
    const undepositedId = resolveAccount(accounts, UNDEPOSITED.number, UNDEPOSITED.key);
    if (!undepositedId) return skip("MISSING_ACCOUNT", "1020 Undeposited Funds");
    lines.push({ accountId: undepositedId, debitCents: t.amountCents, creditCents: 0, legalEntityId: t.legalEntityId, memo: `${t.paymentSource === "CASH" ? "Cash" : "Cheque"} — ${who}` });
    lines.push({ accountId: revenueId, debitCents: 0, creditCents: t.amountCents, legalEntityId: t.legalEntityId, memo: who });
    return {
      posted: true,
      plan: {
        sourceType: "STRIPE_CHARGE",
        sourceId: `tx:${t.id}`,
        entryDate: t.date,
        memo: `${t.paymentSource === "CASH" ? "Cash" : "Cheque"} payment — ${who}`,
        legalEntityId: t.legalEntityId,
        reference: null,
        lines,
      },
    };
  }

  // MANUAL_ADJUSTMENT / INVOICE and anything else: an unpaid invoice is a
  // receivable, not revenue in hand, and only becomes money when it settles.
  if (t.paymentMethod === "INVOICE") return skip("NOT_MONEY_YET", "unpaid invoice");
  return skip("UNVERIFIED_SOURCE", t.paymentSource ?? "unknown payment source");
}

// ── A refund ───────────────────────────────────────────────────────────────

/// Refunds post INCREMENTALLY. `refundedAmount` on a Transaction accumulates as
/// partial refunds and chargebacks land, so the key includes the cumulative
/// total and each entry posts only the delta since the last one. Keying on the
/// transaction alone would post the first refund and silently ignore every
/// later one; keying on the total without subtracting would double-count.
export function planRefund(
  t: ChargeFacts,
  alreadyPostedCents: number,
  refundedTotalCents: number,
  accounts: AccountMap,
): PostingOutcome {
  if (t.reconciliationStatus === "VOID") return skip("VOIDED");
  const delta = refundedTotalCents - alreadyPostedCents;
  if (delta <= 0) return skip("ALREADY_POSTED");

  const base = chargeSourceId(t) ?? `tx:${t.id}`;
  const contraId = resolveAccount(accounts, REFUNDS_CONTRA.number);
  if (!contraId) return skip("MISSING_ACCOUNT", "4900 Refunds & Discounts");

  const isStripe = t.paymentSource === "STRIPE" || t.reconciliationStatus === "VERIFIED";

  // WHERE THE MONEY COMES OUT OF (Julian, Phase 3 decision).
  //
  // Stripe refunds come out of Stripe Clearing, as before. An OFFLINE refund —
  // cash or a cheque — came out of the drawer only while the money was still
  // in the drawer. Once it has been deposited, the drawer is empty and the
  // money leaves the BANK it was deposited into.
  //
  // Phase 2 always used 1020, which let Undeposited Funds go NEGATIVE after a
  // deposit: the ledger then claimed the club was holding minus two hundred
  // dollars of cash, and no bank reconciliation could ever tie out. This is
  // that fix.
  let fromId: string | null;
  let fromLabel: string;
  if (isStripe) {
    fromId = resolveAccount(accounts, STRIPE_CLEARING.number, STRIPE_CLEARING.key);
    fromLabel = STRIPE_CLEARING.number;
  } else if (t.depositedToAccountId) {
    fromId = t.depositedToAccountId;
    fromLabel = "the bank it was deposited to";
  } else {
    fromId = resolveAccount(accounts, UNDEPOSITED.number, UNDEPOSITED.key);
    fromLabel = UNDEPOSITED.number;
  }
  if (!fromId) return skip("MISSING_ACCOUNT", fromLabel);

  const who = t.memberName ?? t.description ?? "payment";

  // THE REFUND FEE (task 10).
  //
  // When Stripe refunds a charge it may also give back part of its fee, and
  // the refund's own balance transaction is what reports it. When that figure
  // is present, the fee movement posts against 6400 Payment Processing Fees:
  // a fee REFUNDED is a credit (the expense is reduced), a fee CHARGED on the
  // refund is a debit.
  //
  // DOCUMENTED LIMITATION: nothing populates `refundFeeDeltaCents` today. The
  // sweep makes no per-refund Stripe call by design — Phase 2 chose a sweep
  // precisely so no money-critical payment path changed — and the figure is
  // not stored anywhere. Filling it needs an additive `Transaction`
  // column written by the `charge.refunded` webhook from
  // `refund.balance_transaction`, which is the follow-up recorded in
  // docs/accounting/plan.md. Until then a refund posts without a fee effect,
  // which is exactly what Phase 2 did, and this path is here and tested so
  // turning it on is one line.
  const feeDelta = t.refundFeeDeltaCents ?? 0;
  const feeId = feeDelta !== 0 ? resolveAccount(accounts, PROCESSING_FEES.number) : null;
  if (feeDelta !== 0 && !feeId) return skip("MISSING_ACCOUNT", PROCESSING_FEES.number);

  const lines: DraftLine[] = [
    { accountId: contraId, debitCents: delta, creditCents: 0, legalEntityId: t.legalEntityId, memo: `Refund — ${who}` },
  ];
  if (feeId && feeDelta > 0) {
    // Stripe gave the fee back: the expense goes down, and the club gets more
    // than the sticker amount back into clearing.
    lines.push({ accountId: feeId, debitCents: 0, creditCents: feeDelta, legalEntityId: t.legalEntityId, memo: "Processing fee refunded" });
    lines.push({ accountId: fromId, debitCents: 0, creditCents: delta - feeDelta, legalEntityId: t.legalEntityId, memo: "Refunded to the payer" });
  } else if (feeId && feeDelta < 0) {
    // Stripe charged a fee ON the refund: the expense goes up.
    lines.push({ accountId: feeId, debitCents: -feeDelta, creditCents: 0, legalEntityId: t.legalEntityId, memo: "Fee charged on the refund" });
    lines.push({ accountId: fromId, debitCents: 0, creditCents: delta - feeDelta, legalEntityId: t.legalEntityId, memo: "Refunded to the payer" });
  } else {
    lines.push({ accountId: fromId, debitCents: 0, creditCents: delta, legalEntityId: t.legalEntityId, memo: "Refunded to the payer" });
  }

  return {
    posted: true,
    plan: {
      // 4900 is contra-revenue and DEBIT-normal, so a refund debits it.
      sourceType: "REFUND",
      sourceId: `${base}:${refundedTotalCents}`,
      entryDate: t.date,
      memo: `Refund — ${who}`,
      legalEntityId: t.legalEntityId,
      reference: base,
      lines,
    },
  };
}

// ── A Stripe payout ────────────────────────────────────────────────────────

export type PayoutFacts = {
  stripePayoutId: string;
  /// "YYYY-MM-DD" — the arrival date, which is when the bank sees it.
  date: string;
  amountCents: number;
  legalEntityId: string | null;
};

/// A payout moves money the club already earned out of Stripe and into the
/// bank. It is NOT income — the income posted when the charge did. Getting this
/// wrong is the classic double-count, which is why the bank row that mirrors
/// this payout is skipped (MATCHED_TO_PAYOUT) rather than posted again.
///
///   DEBIT  the bank's GL account   amount
///   CREDIT 1050 Stripe Clearing    amount
export function planPayout(p: PayoutFacts, bankAccountId: string | null, accounts: AccountMap): PostingOutcome {
  if (p.amountCents <= 0) return skip("ZERO_AMOUNT");
  if (!bankAccountId) return skip("NO_BANK_ACCOUNT");
  const clearingId = resolveAccount(accounts, STRIPE_CLEARING.number, STRIPE_CLEARING.key);
  if (!clearingId) return skip("MISSING_ACCOUNT", "1050 Stripe Clearing");

  return {
    posted: true,
    plan: {
      sourceType: "PAYOUT",
      sourceId: p.stripePayoutId,
      entryDate: p.date,
      memo: "Stripe payout to the bank",
      legalEntityId: p.legalEntityId,
      reference: p.stripePayoutId,
      lines: [
        { accountId: bankAccountId, debitCents: p.amountCents, creditCents: 0, legalEntityId: p.legalEntityId, memo: "Stripe payout" },
        { accountId: clearingId, debitCents: 0, creditCents: p.amountCents, legalEntityId: p.legalEntityId, memo: "Paid out of Stripe" },
      ],
    },
  };
}

// ── A recorded cash deposit ────────────────────────────────────────────────

/// The other half of 1020. Cash and cheques sit in Undeposited Funds from the
/// moment they are recorded; this moves a batch of them into the bank, which is
/// what happens when somebody walks the drawer to the bank.
///
///   DEBIT  the bank's GL account      amount
///   CREDIT 1020 Undeposited Funds     amount
export function planDeposit(
  depositId: string,
  date: string,
  amountCents: number,
  bankAccountId: string,
  legalEntityId: string | null,
  accounts: AccountMap,
): PostingOutcome {
  if (amountCents <= 0) return skip("ZERO_AMOUNT");
  const undepositedId = resolveAccount(accounts, UNDEPOSITED.number, UNDEPOSITED.key);
  if (!undepositedId) return skip("MISSING_ACCOUNT", "1020 Undeposited Funds");

  return {
    posted: true,
    plan: {
      sourceType: "CASH_DEPOSIT",
      sourceId: depositId,
      entryDate: date,
      memo: "Cash and cheques deposited",
      legalEntityId,
      reference: null,
      lines: [
        { accountId: bankAccountId, debitCents: amountCents, creditCents: 0, legalEntityId, memo: "Deposit" },
        { accountId: undepositedId, debitCents: 0, creditCents: amountCents, legalEntityId, memo: "Out of undeposited funds" },
      ],
    },
  };
}

// ── An expense ─────────────────────────────────────────────────────────────

export type ExpenseFacts = {
  id: string;
  date: string;
  amountCents: number;
  /// lib/financials EXPENSE_CATEGORIES key.
  category: string | null;
  vendor: string | null;
  description: string;
  program: string | null;
  legalEntityId: string | null;
  /// The GL account the money came out of — a bank or card. Resolved by the
  /// server from the expense's bank/card; null falls back to 1000.
  paidFromAccountId: string | null;
};

///   DEBIT  the expense account        amount
///   CREDIT the bank or card account   amount
///
/// An uncategorized expense is SKIPPED, never posted to a catch-all: the spec
/// is explicit that uncategorized rows never post, and a guessed category is
/// worse than a visible gap.
export function planExpense(e: ExpenseFacts, accounts: AccountMap): PostingOutcome {
  if (e.amountCents <= 0) return skip("ZERO_AMOUNT");
  if (!e.category) return skip("NOT_CATEGORIZED");

  const expenseNumber = accountForExpenseCategory(e.category);
  const expenseId = resolveAccount(accounts, expenseNumber);
  if (!expenseId) return skip("MISSING_ACCOUNT", `expense account ${expenseNumber}`);

  const paidFrom = e.paidFromAccountId ?? resolveAccount(accounts, "1000");
  if (!paidFrom) return skip("MISSING_ACCOUNT", "1000 Operating Checking");

  const what = e.vendor ? `${e.vendor} — ${e.description}` : e.description;
  return {
    posted: true,
    plan: {
      sourceType: "EXPENSE",
      sourceId: e.id,
      entryDate: e.date,
      memo: what.slice(0, 300),
      legalEntityId: e.legalEntityId,
      reference: null,
      lines: [
        { accountId: expenseId, debitCents: e.amountCents, creditCents: 0, legalEntityId: e.legalEntityId, program: e.program, memo: what.slice(0, 200) },
        { accountId: paidFrom, debitCents: 0, creditCents: e.amountCents, legalEntityId: e.legalEntityId, program: e.program, memo: e.vendor ?? null },
      ],
    },
  };
}

// ── A categorized bank row ─────────────────────────────────────────────────

export type BankRowFacts = {
  /// The Plaid transaction id — immutable, and the key this posts under.
  plaidTransactionId: string;
  date: string;
  /// PLAID CONVENTION: a POSITIVE amount is money LEAVING a depository
  /// account. This is the opposite of what most people expect and getting it
  /// backwards flips every entry, so it is named explicitly here and asserted
  /// in the tests.
  amountCents: number;
  name: string;
  categoryOverride: string | null;
  legalEntityId: string | null;
  markedAsTransfer: boolean;
  excludedFromTax: boolean;
  reviewedAt: boolean;
  /// Set when this row already posted some other way.
  matchedExpenseId: string | null;
  matchedPayout: boolean;
  matchedDeposit: boolean;
  /// The GL account for the bank or card this row belongs to.
  bankAccountId: string | null;
  /// Task 9. Set on the QUICKBOOKS-imported row when it looks like the same
  /// transaction as a live Plaid row: same bank account, same amount, dates
  /// within three days. The imported row is then HELD — it never posts until
  /// somebody decides, because posting both counts the money twice.
  suspectedDuplicateOf?: string | null;
  /// Set when somebody has looked at the pair and said they are different
  /// transactions after all, which releases the hold.
  duplicateDismissed?: boolean;
};

/// A categorized bank row that nothing else already accounts for.
///
/// THE DOUBLE-COUNT GUARD lives here, and it is the single most important rule
/// in this module. A bank deposit that mirrors a Stripe payout, or a recorded
/// cash deposit, has ALREADY been posted — once as the original charge and once
/// as the transfer into the bank. Posting it a third time as income would
/// inflate revenue by the full amount and the books would still balance, which
/// is what makes it dangerous.
export function planBankRow(r: BankRowFacts, accounts: AccountMap): PostingOutcome {
  if (r.markedAsTransfer) return skip("TRANSFER");
  if (r.matchedPayout) return skip("MATCHED_TO_PAYOUT");
  if (r.matchedDeposit) return skip("MATCHED_TO_DEPOSIT");
  if (r.matchedExpenseId) return skip("MATCHED_TO_EXPENSE");
  // Task 9's guard, BEFORE the categorisation check: a held duplicate must
  // stay held even once somebody categorises it, or categorising would be the
  // thing that double-counts the money.
  if (r.suspectedDuplicateOf && !r.duplicateDismissed) return skip("SUSPECTED_DUPLICATE");
  if (!r.categoryOverride) return skip("NOT_CATEGORIZED");
  if (r.amountCents === 0) return skip("ZERO_AMOUNT");
  if (!r.bankAccountId) return skip("NO_BANK_ACCOUNT");

  const outflow = r.amountCents > 0; // Plaid: positive = money out
  const magnitude = Math.abs(r.amountCents);

  if (outflow) {
    const expenseNumber = accountForExpenseCategory(r.categoryOverride);
    const expenseId = resolveAccount(accounts, expenseNumber);
    if (!expenseId) return skip("MISSING_ACCOUNT", `expense account ${expenseNumber}`);
    return {
      posted: true,
      plan: {
        sourceType: "BANK_ROW",
        sourceId: r.plaidTransactionId,
        entryDate: r.date,
        memo: r.name.slice(0, 300),
        legalEntityId: r.legalEntityId,
        reference: null,
        lines: [
          { accountId: expenseId, debitCents: magnitude, creditCents: 0, legalEntityId: r.legalEntityId, memo: r.name.slice(0, 200) },
          { accountId: r.bankAccountId, debitCents: 0, creditCents: magnitude, legalEntityId: r.legalEntityId, memo: null },
        ],
      },
    };
  }

  // Money in that is not a payout, not a deposit and not matched to anything:
  // income the club received straight into the bank.
  const revenueId =
    resolveAccount(accounts, revenueAccountForTransaction({ category: r.categoryOverride, type: null })) ??
    resolveAccount(accounts, REVENUE_FALLBACK_ACCOUNT);
  if (!revenueId) return skip("MISSING_ACCOUNT", "a revenue account");
  return {
    posted: true,
    plan: {
      sourceType: "BANK_ROW",
      sourceId: r.plaidTransactionId,
      entryDate: r.date,
      memo: r.name.slice(0, 300),
      legalEntityId: r.legalEntityId,
      reference: null,
      lines: [
        { accountId: r.bankAccountId, debitCents: magnitude, creditCents: 0, legalEntityId: r.legalEntityId, memo: r.name.slice(0, 200) },
        { accountId: revenueId, debitCents: 0, creditCents: magnitude, legalEntityId: r.legalEntityId, memo: null },
      ],
    },
  };
}

// ── Task 9: the QuickBooks ↔ bank-feed duplicate guard ─────────────────────
//
// A club that imported QuickBooks history AND has a live bank feed can hold
// two rows for the same transaction: one the importer created
// (`source: "QUICKBOOKS"`) and one the feed delivered (`source: "PLAID"`).
//
// The existing importer already guards the common case — it only CREATES rows
// dated before the feed's coverage begins, and deliberately SKIPS an unmatched
// row inside coverage. But coverage is derived from the earliest Plaid row per
// account, so a feed that back-fills, an account reconnected later, or a
// manual connection with no `feedStarts` all leave room for an overlap. Once
// both rows exist, the Phase 2 sweep would post both and the month would be
// out by the amount.
//
// So: same bank account, same amount, dates within three days ⇒ the IMPORTED
// row is held. Never the feed row — the feed is the bank's own record and the
// one a reconciliation has to tie to.

export const DUPLICATE_WINDOW_DAYS = 3;

export type DuplicateCandidate = {
  /// The imported row, which is the one that gets held.
  importedId: string;
  /// The bank-feed row it looks like.
  feedId: string;
  daysApart: number;
};

export type DuplicateRow = {
  plaidTransactionId: string;
  /// `${plaidConnectionId}|${accountId}` — the composite that identifies a
  /// bank account, because PlaidTransaction has no BankAccount relation.
  accountKey: string;
  date: string;
  amountCents: number;
  source: string;
};

function dayGap(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/// Pair imported rows with feed rows that look like the same transaction.
///
/// Each feed row is claimed at most once, nearest date first. Without that, two
/// imported rows of the same amount would both be held against one feed row and
/// a genuine second payment would never post.
export function detectBankDuplicates(rows: DuplicateRow[]): DuplicateCandidate[] {
  const imported = rows.filter((r) => r.source === "QUICKBOOKS");
  const feed = rows.filter((r) => r.source === "PLAID");
  if (imported.length === 0 || feed.length === 0) return [];

  const claimed = new Set<string>();
  const out: DuplicateCandidate[] = [];

  for (const imp of imported) {
    const matches = feed
      .filter(
        (f) =>
          !claimed.has(f.plaidTransactionId) &&
          f.accountKey === imp.accountKey &&
          f.amountCents === imp.amountCents &&
          dayGap(f.date, imp.date) <= DUPLICATE_WINDOW_DAYS,
      )
      .sort((a, b) => dayGap(a.date, imp.date) - dayGap(b.date, imp.date));
    const hit = matches[0];
    if (!hit) continue;
    claimed.add(hit.plaidTransactionId);
    out.push({
      importedId: imp.plaidTransactionId,
      feedId: hit.plaidTransactionId,
      daysApart: dayGap(hit.date, imp.date),
    });
  }
  return out;
}

// ── Books start date ───────────────────────────────────────────────────────

/// Nothing posts automatically before the club's books start date, and NULL
/// means "not configured" — never "post everything".
///
/// A source record dated earlier is REFUSED with a reason, not silently
/// dropped, so the backfill script and the UI can both say how many rows were
/// held back and why. Silence here is what lets imported history get
/// double-counted without anybody noticing.
export function booksGate(entryDate: string, booksStartDate: string | null | undefined): SkipReason | null {
  if (!booksStartDate) return "NO_BOOKS_START_DATE";
  if (entryDate < booksStartDate) return "BEFORE_BOOKS_START";
  return null;
}

/// Every plan must balance before it reaches the ledger service. The service
/// checks again and refuses — this is the earlier, cheaper check that keeps a
/// bad plan out of a transaction, and it is what the tests assert on.
export function planBalances(plan: PostingPlan): boolean {
  return entryTotals(plan.lines).balanced && plan.lines.length >= 2;
}
