// Accounting Phase 2 — automatic posting and reconciliation, proven.
//
//   npm run test:gl-posting     (and it GATES the build)
//
// No database, no network. Everything under test is a pure function, which is
// why lib/glPosting.ts and lib/glReconcile.ts exist separately from their
// *Server counterparts.
//
// The source-grep section at the end is not decoration: "posts at most once",
// "never key on memberId" and "every write goes through the Phase 1 ledger" are
// properties of the SOURCE, not of any one function, so this is the only place
// the build can check them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SKIP_LABELS,
  booksGate,
  chargeSourceId,
  planBalances,
  planBankRow,
  planCharge,
  planDeposit,
  planExpense,
  planPayout,
  planRefund,
  resolveAccount,
  splitChargedTotal,
  type AccountMap,
  type ChargeFacts,
  type PostingOutcome,
} from "../lib/glPosting";
import {
  canFinish,
  differenceOf,
  finishBlockedReason,
  monthEnd,
  monthStart,
  signedBalanceOf,
  summarise,
} from "../lib/glReconcile";
import { entryTotals, formatCents } from "../lib/ledger";
import { feePolicyFor, quoteCharge } from "../lib/fees";
import { TIER_FEATURES, canUseFeature } from "../lib/tier";

const ROOT = join(__dirname, "..");
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, name: string, detail?: string) => {
  if (cond) pass++;
  else fails.push(detail ? `${name} — ${detail}` : name);
};
const eq = <T,>(actual: T, expected: T, name: string) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

// A chart with every account the posting engine reaches for.
const ACCOUNTS: AccountMap = {
  byNumber: {
    "1000": "a_bank",
    "1001": "a_bank_checking",
    "1020": "a_undeposited",
    "1050": "a_clearing",
    "1100": "a_ar",
    "2100": "a_cards",
    "4000": "a_rev_member",
    "4200": "a_rev_event",
    "4400": "a_rev_merch",
    "4800": "a_fees_recovered",
    "4900": "a_refunds",
    "4950": "a_other_income",
    "6000": "a_rent",
    "6250": "a_equipment",
    "6400": "a_proc_fees",
    "6600": "a_professional",
    "6900": "a_misc",
    "4600": "a_rev_sponsor",
  },
  bySystemKey: {
    STRIPE_CLEARING: "a_clearing",
    UNDEPOSITED_FUNDS: "a_undeposited",
    DUE_TO: "a_dueto",
    DUE_FROM: "a_duefrom",
  },
};

const PASS_BOTH = feePolicyFor({ passProcessingFees: true, passPlatformFee: true, tier: "pro" });
const PASS_PROC = feePolicyFor({ passProcessingFees: true, passPlatformFee: false, tier: "pro" });
const ABSORB = feePolicyFor({ passProcessingFees: false, passPlatformFee: false, tier: "pro" });

const charge = (p: Partial<ChargeFacts> = {}): ChargeFacts => ({
  id: "tx1",
  stripeChargeId: "ch_1",
  stripePaymentIntentId: "pi_1",
  stripeInvoiceId: "in_1",
  date: "2026-10-15",
  amountCents: 10330,
  feeCents: 330,
  netCents: 10000,
  category: "memberships",
  type: "MEMBERSHIP",
  legalEntityId: "e1",
  memberName: "Kid A",
  description: null,
  reconciliationStatus: "VERIFIED",
  paymentSource: "STRIPE",
  paymentMethod: "CARD",
  status: "SUCCEEDED",
  ...p,
});

const planOf = (o: PostingOutcome) => (o.posted ? o.plan : null);

// ── 1. Recovering the sticker price ────────────────────────────────────────
console.log("\n[1] sticker vs gross-up");

// The round trip that matters: for any net, quoteCharge gives a total, and
// splitChargedTotal must recover that same net from it.
for (const policy of [PASS_BOTH, PASS_PROC]) {
  for (const net of [500, 1000, 2500, 10000, 54537, 150000, 1, 99]) {
    const total = quoteCharge(net, policy).totalCents;
    const split = splitChargedTotal(total, policy);
    ok(
      split.exact && split.stickerCents === net && split.grossUpCents === total - net,
      `1.0 round trip: net ${net} → total ${total} → sticker`,
      JSON.stringify(split),
    );
  }
}
eq(splitChargedTotal(10000, ABSORB), { stickerCents: 10000, grossUpCents: 0, exact: true }, "1.1 nothing passed → the total IS the sticker");
eq(splitChargedTotal(0, PASS_BOTH), { stickerCents: 0, grossUpCents: 0, exact: true }, "1.2 zero is zero");
// A total that no net produces under the CURRENT policy — the club changed it
// after the charge. Then we do NOT invent a gross-up.
{
  const odd = splitChargedTotal(12345, PASS_BOTH);
  ok(
    odd.exact ? odd.stickerCents + odd.grossUpCents === 12345 : odd.stickerCents === 12345 && odd.grossUpCents === 0,
    "1.3 an unreproducible total keeps the whole amount as revenue rather than guessing a gross-up",
    JSON.stringify(odd),
  );
}

// ── 2. A Stripe charge ─────────────────────────────────────────────────────
console.log("\n[2] a Stripe charge");

{
  const o = planCharge(charge(), PASS_BOTH, ACCOUNTS);
  const plan = planOf(o);
  ok(!!plan, "2.0 a verified charge posts", JSON.stringify(o));
  ok(planBalances(plan!), "2.1 and it balances");
  eq(plan!.sourceType, "STRIPE_CHARGE", "2.2 source type");
  eq(plan!.sourceId, "ch_1", "2.3 keyed on the Stripe CHARGE id, the id Stripe guarantees for the money");

  const t = entryTotals(plan!.lines);
  eq(t.debitCents, 10330, "2.4 debits equal the amount charged");
  eq(t.creditCents, 10330, "2.5 so do credits");

  const byAccount = (id: string) => plan!.lines.filter((l) => l.accountId === id);
  eq(byAccount("a_clearing")[0]?.debitCents, 10000, "2.6 the NET lands in 1050 Stripe Clearing");
  eq(byAccount("a_proc_fees")[0]?.debitCents, 330, "2.7 the fees land in 6400");
  ok((byAccount("a_rev_member")[0]?.creditCents ?? 0) > 0, "2.8 revenue is credited");
  ok((byAccount("a_fees_recovered")[0]?.creditCents ?? 0) > 0, "2.9 and the gross-up goes to 4800");
  eq(
    (byAccount("a_rev_member")[0]?.creditCents ?? 0) + (byAccount("a_fees_recovered")[0]?.creditCents ?? 0),
    10330,
    "2.10 sticker + gross-up = what was charged",
  );
}

// Fee facts missing → REFUSE, don't guess. This is the rule that keeps revenue
// and expense from both being wrong.
eq(
  (planCharge(charge({ feeCents: null }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason,
  "AWAITING_STRIPE_FEES",
  "2.11 a charge with no Stripe fee yet is held back, not guessed",
);
eq(
  (planCharge(charge({ netCents: null }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason,
  "AWAITING_STRIPE_FEES",
  "2.12 …same with no net",
);
// The identity the entry rests on. If it doesn't hold, the data is wrong and
// posting it would balance but misstate every line.
eq(
  (planCharge(charge({ netCents: 9000, feeCents: 330 }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason,
  "AWAITING_STRIPE_FEES",
  "2.13 net + fees ≠ charged is refused",
);

eq((planCharge(charge({ reconciliationStatus: "VOID" }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason, "VOIDED", "2.14 a VOID row never posts");
eq((planCharge(charge({ paymentSource: "COMP" }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason, "COMPED", "2.15 a comp is not revenue");
eq(
  (planCharge(charge({ paymentSource: "EXTERNAL_READER", reconciliationStatus: "UNVERIFIED" }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason,
  "UNVERIFIED_SOURCE",
  "2.16 a card collected outside AthletixOS is a record, not postable money",
);
eq((planCharge(charge({ status: "PENDING" }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason, "NOT_MONEY_YET", "2.17 a pending payment is not money yet");
eq((planCharge(charge({ amountCents: 0 }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason, "ZERO_AMOUNT", "2.18 zero is skipped");
eq(
  (planCharge(charge({ paymentSource: "MANUAL_ADJUSTMENT", reconciliationStatus: "OFFLINE", paymentMethod: "INVOICE" }), PASS_BOTH, ACCOUNTS) as { reason: string }).reason,
  "NOT_MONEY_YET",
  "2.19 an unpaid invoice is a receivable, not revenue in hand",
);

// Cash and cheques: 1020, no fees.
for (const [src, label] of [["CASH", "cash"], ["CHECK", "cheque"]] as const) {
  const o = planCharge(
    charge({ paymentSource: src, reconciliationStatus: "OFFLINE", stripeChargeId: null, stripePaymentIntentId: null, stripeInvoiceId: null, feeCents: null, netCents: null, amountCents: 5000 }),
    PASS_BOTH,
    ACCOUNTS,
  );
  const plan = planOf(o);
  ok(!!plan, `2.20.${label} ${label} posts`, JSON.stringify(o));
  ok(planBalances(plan!), `2.21.${label} and balances`);
  eq(plan!.lines.find((l) => l.debitCents > 0)?.accountId, "a_undeposited", `2.22.${label} it debits 1020 Undeposited Funds, NOT the bank`);
  eq(plan!.sourceId, "tx:tx1", `2.23.${label} keyed on the local row id (there is no Stripe id)`);
}

// Revenue classification follows Julian's settled rule.
eq(planOf(planCharge(charge({ category: "events", type: "EVENT" }), ABSORB, ACCOUNTS))!.lines.find((l) => l.creditCents > 0)?.accountId, "a_rev_event", "2.24 events → 4200");
eq(
  planOf(planCharge(charge({ category: "cash_payment", type: "PRODUCT", paymentSource: "STRIPE" }), ABSORB, ACCOUNTS))!.lines.find((l) => l.creditCents > 0)?.accountId,
  "a_rev_merch",
  "2.25 cash_payment + PRODUCT → 4400, i.e. mapped by what was sold",
);
eq(
  planOf(planCharge(charge({ category: "cash_payment", type: "CHARGE" }), ABSORB, ACCOUNTS))!.lines.find((l) => l.creditCents > 0)?.accountId,
  "a_other_income",
  "2.26 cash_payment with nothing to go on → 4950",
);

// ── 3. Refunds post incrementally ──────────────────────────────────────────
console.log("\n[3] refunds");

{
  const t = charge();
  const first = planOf(planRefund(t, 0, 2500, ACCOUNTS));
  ok(!!first, "3.0 a refund posts");
  ok(planBalances(first!), "3.1 and balances");
  eq(first!.sourceId, "ch_1:2500", "3.2 the key carries the CUMULATIVE refunded total");
  eq(first!.lines.find((l) => l.debitCents > 0)?.accountId, "a_refunds", "3.3 it DEBITS 4900 (contra-revenue is debit-normal)");
  eq(first!.lines.find((l) => l.creditCents > 0)?.accountId, "a_clearing", "3.4 and credits Stripe Clearing — money leaving");
  eq(first!.lines.find((l) => l.debitCents > 0)?.debitCents, 2500, "3.5 for the refunded amount");

  // A second, larger refund posts only the DELTA. Keying on the transaction
  // alone would ignore it; keying on the total without subtracting would
  // double-count.
  const second = planOf(planRefund(t, 2500, 4000, ACCOUNTS));
  eq(second!.sourceId, "ch_1:4000", "3.6 a bigger refund gets its own key");
  eq(second!.lines.find((l) => l.debitCents > 0)?.debitCents, 1500, "3.7 and posts ONLY the delta (4000 − 2500)");
  eq(
    (planRefund(t, 4000, 4000, ACCOUNTS) as { reason: string }).reason,
    "ALREADY_POSTED",
    "3.8 re-running the same total posts nothing",
  );
  eq((planRefund(t, 5000, 4000, ACCOUNTS) as { reason: string }).reason, "ALREADY_POSTED", "3.9 a shrinking total posts nothing either");

  // A cash refund comes out of 1020, not Stripe.
  const cashRefund = planOf(planRefund(charge({ paymentSource: "CASH", reconciliationStatus: "OFFLINE" }), 0, 1000, ACCOUNTS));
  eq(cashRefund!.lines.find((l) => l.creditCents > 0)?.accountId, "a_undeposited", "3.10 a cash refund comes out of 1020");
}

// ── 4. Payouts and deposits — transfers, never income ──────────────────────
console.log("\n[4] payouts and deposits");

{
  const p = planOf(planPayout({ stripePayoutId: "po_1", date: "2026-10-20", amountCents: 50000, legalEntityId: "e1" }, "a_bank_checking", ACCOUNTS));
  ok(!!p, "4.0 a payout posts");
  ok(planBalances(p!), "4.1 and balances");
  eq(p!.sourceId, "po_1", "4.2 keyed on the Stripe payout id");
  eq(p!.lines.find((l) => l.debitCents > 0)?.accountId, "a_bank_checking", "4.3 it DEBITS the bank");
  eq(p!.lines.find((l) => l.creditCents > 0)?.accountId, "a_clearing", "4.4 and CREDITS Stripe Clearing");
  // The critical property: a payout touches no revenue account at all. The
  // income posted when the charge did.
  ok(
    !p!.lines.some((l) => ["a_rev_member", "a_rev_event", "a_rev_merch", "a_other_income"].includes(l.accountId)),
    "4.5 a payout touches NO revenue account — it is a transfer, not income",
  );
  eq((planPayout({ stripePayoutId: "po_2", date: "2026-10-20", amountCents: 100, legalEntityId: null }, null, ACCOUNTS) as { reason: string }).reason, "NO_BANK_ACCOUNT", "4.6 no bank GL account → held back");

  const d = planOf(planDeposit("dep_1", "2026-10-22", 7500, "a_bank_checking", "e1", ACCOUNTS));
  ok(!!d && planBalances(d), "4.7 a deposit posts and balances");
  eq(d!.lines.find((l) => l.debitCents > 0)?.accountId, "a_bank_checking", "4.8 it debits the bank");
  eq(d!.lines.find((l) => l.creditCents > 0)?.accountId, "a_undeposited", "4.9 and credits 1020 — out of undeposited funds");
  ok(
    !d!.lines.some((l) => ["a_rev_member", "a_rev_event", "a_other_income"].includes(l.accountId)),
    "4.10 a deposit touches NO revenue account either",
  );
}

// ── 5. Expenses ────────────────────────────────────────────────────────────
console.log("\n[5] expenses");

{
  const e = planOf(
    planExpense(
      { id: "ex1", date: "2026-10-05", amountCents: 250000, category: "RENT", vendor: "Landlord", description: "October rent", program: "Competition team", legalEntityId: "e1", paidFromAccountId: "a_bank_checking" },
      ACCOUNTS,
    ),
  );
  ok(!!e && planBalances(e), "5.0 an expense posts and balances");
  eq(e!.sourceId, "ex1", "5.1 keyed on the expense id");
  eq(e!.lines.find((l) => l.debitCents > 0)?.accountId, "a_rent", "5.2 RENT → 6000");
  eq(e!.lines.find((l) => l.creditCents > 0)?.accountId, "a_bank_checking", "5.3 credited to the account it was paid from");
  ok(e!.lines.every((l) => l.program === "Competition team"), "5.4 the program tag is carried onto BOTH lines");

  eq(
    (planExpense({ id: "ex2", date: "2026-10-05", amountCents: 100, category: null, vendor: null, description: "?", program: null, legalEntityId: null, paidFromAccountId: null }, ACCOUNTS) as { reason: string }).reason,
    "NOT_CATEGORIZED",
    "5.5 an uncategorized expense never posts",
  );
  // No bank named → falls back to 1000, rather than refusing to post a real
  // expense over a missing pointer.
  eq(
    planOf(planExpense({ id: "ex3", date: "2026-10-05", amountCents: 100, category: "OTHER", vendor: null, description: "x", program: null, legalEntityId: null, paidFromAccountId: null }, ACCOUNTS))!.lines.find((l) => l.creditCents > 0)?.accountId,
    "a_bank",
    "5.6 with no bank named it falls back to 1000",
  );
}

// ── 6. Bank rows and the DOUBLE-COUNT GUARD ────────────────────────────────
console.log("\n[6] bank rows and the double-count guard");

const bankRow = (p: Partial<Parameters<typeof planBankRow>[0]> = {}) => ({
  plaidTransactionId: "plaid_1",
  date: "2026-10-18",
  amountCents: 12000,
  name: "ACME SUPPLIES",
  categoryOverride: "EQUIPMENT",
  legalEntityId: "e1",
  markedAsTransfer: false,
  excludedFromTax: false,
  reviewedAt: true,
  matchedExpenseId: null,
  matchedPayout: false,
  matchedDeposit: false,
  bankAccountId: "a_bank_checking",
  ...p,
});

{
  // PLAID'S SIGN CONVENTION: positive = money OUT of a depository account.
  // Getting this backwards flips every entry, so it is asserted explicitly.
  const out = planOf(planBankRow(bankRow({ amountCents: 12000, categoryOverride: "EQUIPMENT" }), ACCOUNTS));
  ok(!!out && planBalances(out), "6.0 an outflow posts and balances");
  ok((out!.lines.find((l) => l.debitCents > 0)?.accountId ?? "") !== "a_bank_checking", "6.1 a POSITIVE Plaid amount is money OUT: the bank is credited, not debited");
  eq(out!.lines.find((l) => l.creditCents > 0)?.accountId, "a_bank_checking", "6.2 …the bank is the credit side");

  const inflow = planOf(planBankRow(bankRow({ amountCents: -30000, categoryOverride: "sponsorships" }), ACCOUNTS));
  ok(!!inflow && planBalances(inflow), "6.3 an inflow posts and balances");
  eq(inflow!.lines.find((l) => l.debitCents > 0)?.accountId, "a_bank_checking", "6.4 a NEGATIVE amount is money IN: the bank is debited");

  // THE GUARD. Each of these would otherwise post income a second or third
  // time, and the books would still balance — which is what makes it dangerous.
  eq((planBankRow(bankRow({ matchedPayout: true }), ACCOUNTS) as { reason: string }).reason, "MATCHED_TO_PAYOUT", "6.5 a bank row matched to a Stripe payout does NOT post again");
  eq((planBankRow(bankRow({ matchedDeposit: true }), ACCOUNTS) as { reason: string }).reason, "MATCHED_TO_DEPOSIT", "6.6 nor one matched to a recorded deposit");
  eq((planBankRow(bankRow({ matchedExpenseId: "ex1" }), ACCOUNTS) as { reason: string }).reason, "MATCHED_TO_EXPENSE", "6.7 nor one already posted through its expense");
  eq((planBankRow(bankRow({ markedAsTransfer: true }), ACCOUNTS) as { reason: string }).reason, "TRANSFER", "6.8 nor a transfer between the club's own accounts");
  eq((planBankRow(bankRow({ categoryOverride: null }), ACCOUNTS) as { reason: string }).reason, "NOT_CATEGORIZED", "6.9 an uncategorized bank row never posts");
  eq((planBankRow(bankRow({ bankAccountId: null }), ACCOUNTS) as { reason: string }).reason, "NO_BANK_ACCOUNT", "6.10 a bank with no GL account is held back, not posted somewhere arbitrary");
  // A chart missing the account a category maps to holds the row back rather
  // than posting it somewhere arbitrary. (This one found a gap in this very
  // fixture, which is the behaviour working.)
  const thin: typeof ACCOUNTS = { byNumber: { "1000": "a_bank" }, bySystemKey: {} };
  eq(
    (planBankRow(bankRow({ categoryOverride: "EQUIPMENT" }), thin) as { reason: string }).reason,
    "MISSING_ACCOUNT",
    "6.12 a chart missing the mapped account holds the row back",
  );
  eq((planBankRow(bankRow({ amountCents: 0 }), ACCOUNTS) as { reason: string }).reason, "ZERO_AMOUNT", "6.11 zero is skipped");
}

// ── 7. The books start date ────────────────────────────────────────────────
console.log("\n[7] the books start date");

eq(booksGate("2026-10-15", "2026-10-01"), null, "7.0 on/after the start date → posts");
eq(booksGate("2026-10-01", "2026-10-01"), null, "7.1 the start date itself posts (inclusive)");
eq(booksGate("2026-09-30", "2026-10-01"), "BEFORE_BOOKS_START", "7.2 the day before is REFUSED, not silently dropped");
// The rule that prevents double-counting imported history.
eq(booksGate("2026-10-15", null), "NO_BOOKS_START_DATE", "7.3 NO start date means nothing posts — never 'post everything'");
eq(booksGate("2026-10-15", undefined), "NO_BOOKS_START_DATE", "7.4 undefined behaves the same");
ok(!!SKIP_LABELS.BEFORE_BOOKS_START && !!SKIP_LABELS.NO_BOOKS_START_DATE, "7.5 both have an owner-readable label");
ok(Object.values(SKIP_LABELS).every((v) => v.length > 8), "7.6 every skip reason has a real explanation, not a code");

// ── 8. THE TEST MONTH (the acceptance scenario) ────────────────────────────
// "A charge with passProcessingFees, a refund, a payout, a cash deposit and a
// categorized expense. Every entry is balanced, nothing double-posts on a
// re-run, and the matched bank deposit doesn't post twice."
console.log("\n[8] a whole test month");

{
  const plans: { label: string; o: PostingOutcome }[] = [
    { label: "card charge with fees passed", o: planCharge(charge({ amountCents: quoteCharge(10000, PASS_BOTH).totalCents, feeCents: 330, netCents: quoteCharge(10000, PASS_BOTH).totalCents - 330 }), PASS_BOTH, ACCOUNTS) },
    { label: "refund", o: planRefund(charge(), 0, 2500, ACCOUNTS) },
    { label: "payout", o: planPayout({ stripePayoutId: "po_m", date: "2026-10-28", amountCents: 50000, legalEntityId: "e1" }, "a_bank_checking", ACCOUNTS) },
    { label: "cash deposit", o: planDeposit("dep_m", "2026-10-29", 7500, "a_bank_checking", "e1", ACCOUNTS) },
    { label: "categorized expense", o: planExpense({ id: "ex_m", date: "2026-10-03", amountCents: 250000, category: "RENT", vendor: "Landlord", description: "Rent", program: null, legalEntityId: "e1", paidFromAccountId: "a_bank_checking" }, ACCOUNTS) },
  ];

  for (const { label, o } of plans) {
    const plan = planOf(o);
    ok(!!plan, `8.0.${label} ${label} posts`, JSON.stringify(o));
    if (plan) {
      ok(planBalances(plan), `8.1.${label} and it BALANCES`);
      ok(plan.lines.length >= 2, `8.2.${label} with at least two lines`);
      ok(!!plan.sourceId && plan.sourceId.length > 0, `8.3.${label} and an immutable key`);
    }
  }

  // Nothing double-posts on a re-run: every key is distinct, and re-planning
  // the same facts yields the same key — which the (clubId, sourceType,
  // sourceId) unique index then rejects.
  const keys = plans.map((p) => planOf(p.o)!).map((p) => `${p.sourceType}:${p.sourceId}`);
  eq(new Set(keys).size, keys.length, "8.4 every entry in the month has a DISTINCT (sourceType, sourceId)");
  const again = planOf(planCharge(charge(), PASS_BOTH, ACCOUNTS))!;
  const once = planOf(planCharge(charge(), PASS_BOTH, ACCOUNTS))!;
  eq(again.sourceId, once.sourceId, "8.5 re-planning the same charge yields the SAME key, so the unique index stops the second write");

  // And the matched bank deposit does not post twice.
  eq(
    (planBankRow(bankRow({ plaidTransactionId: "plaid_dep", amountCents: -7500, matchedDeposit: true }), ACCOUNTS) as { reason: string }).reason,
    "MATCHED_TO_DEPOSIT",
    "8.6 the bank row mirroring that deposit does NOT post again",
  );
  eq(
    (planBankRow(bankRow({ plaidTransactionId: "plaid_po", amountCents: -50000, matchedPayout: true }), ACCOUNTS) as { reason: string }).reason,
    "MATCHED_TO_PAYOUT",
    "8.7 nor the one mirroring the payout",
  );
}

// ── 9. Reconciliation arithmetic ───────────────────────────────────────────
console.log("\n[9] reconciliation");

eq(signedBalanceOf("DEBIT", 10000, 0), 10000, "9.0 a debit raises a checking account");
eq(signedBalanceOf("DEBIT", 0, 10000), -10000, "9.1 a credit lowers it");
// The card case, which is the one people get backwards.
eq(signedBalanceOf("CREDIT", 0, 5000), 5000, "9.2 a $50 purchase on a CARD raises what you owe");
eq(signedBalanceOf("CREDIT", 5000, 0), -5000, "9.3 and paying the card down lowers it");

eq(differenceOf(10000, 10000), 0, "9.4 matching numbers → zero difference");
eq(differenceOf(10000, 9900), 100, "9.5 a dollar out reads as +100");
ok(canFinish("OPEN", 0), "9.6 an open reconciliation at zero can finish");
ok(!canFinish("OPEN", 1), "9.7 one cent out CANNOT finish — no tolerance");
ok(!canFinish("OPEN", -1), "9.8 in either direction");
ok(!canFinish("FINISHED", 0), "9.9 an already-finished one cannot finish again");
ok(finishBlockedReason("OPEN", 0) === null, "9.10 no reason when it's balanced");
ok((finishBlockedReason("OPEN", 250) ?? "").includes("2.50"), "9.11 the reason names the exact gap");
ok((finishBlockedReason("FINISHED", 0) ?? "").length > 0, "9.12 and says so when already reconciled");

eq(monthStart("2026-10-15"), "2026-10-01", "9.13 month start");
eq(monthEnd("2026-10-15"), "2026-10-31", "9.14 month end");
eq(monthEnd("2026-02-15"), "2026-02-28", "9.15 February in a non-leap year");
eq(monthEnd("2024-02-10"), "2024-02-29", "9.16 and in a leap year");
eq(monthEnd("2026-12-01"), "2026-12-31", "9.17 December doesn't roll into next year");

{
  const lines = [
    { cleared: true, signedCents: 10000 },
    { cleared: true, signedCents: -2500 },
    { cleared: false, signedCents: 9999 },
  ];
  const s = summarise(lines, 5000, 12500);
  eq(s.clearedBalanceCents, 12500, "9.18 cleared balance = opening + cleared lines only");
  eq(s.differenceCents, 0, "9.19 and it ties out");
  ok(s.balanced, "9.20 so it is balanced");
  eq(s.clearedCount, 2, "9.21 two cleared");
  eq(s.unclearedCount, 1, "9.22 one outstanding");
  // An uncleared line must NOT move the cleared balance — that is the whole
  // point of ticking.
  eq(summarise(lines, 5000, 12500).clearedBalanceCents, summarise(lines.slice(0, 2), 5000, 12500).clearedBalanceCents, "9.23 an uncleared line does not affect the cleared balance");
}

// ── 10. Tier gating ────────────────────────────────────────────────────────
console.log("\n[10] tier gating");

ok(!canUseFeature("starter", "plaid"), "10.0 STARTER can never connect a bank");
ok(canUseFeature("pro", "plaid"), "10.1 PRO can");
ok(canUseFeature("enterprise", "plaid"), "10.2 ENTERPRISE can");
ok(!canUseFeature("growth", "plaid"), "10.3 the legacy tier normalizes to starter → no bank");
ok(!canUseFeature(null, "plaid"), "10.4 an unset tier fails closed");
ok(!canUseFeature("starter", "fullFinancials"), "10.5 and Starter has no full financials");
eq(TIER_FEATURES.starter.maxBankAccounts, 1, "10.6 Starter's bank-account limit is 1");
eq(TIER_FEATURES.pro.maxBankAccounts, 2, "10.7 Pro's is 2");
eq(TIER_FEATURES.enterprise.maxBankAccounts, null, "10.8 Enterprise is unlimited");

// ── 11. Source guarantees ──────────────────────────────────────────────────
console.log("\n[11] source guarantees");

const posting = readFileSync(join(ROOT, "lib/glPosting.ts"), "utf8");
const postingServer = readFileSync(join(ROOT, "lib/glPostingServer.ts"), "utf8");
const reconcile = readFileSync(join(ROOT, "lib/glReconcile.ts"), "utf8");
const reconcileServer = readFileSync(join(ROOT, "lib/glReconcileServer.ts"), "utf8");

// 11.0 The pure modules must stay pure, or these tests stop being runnable
// without a database — and the build runs them against a dead address.
for (const [name, src] of [["glPosting", posting], ["glReconcile", reconcile]] as const) {
  ok(!/from ["']@\/lib\/prisma["']/.test(src), `11.0.${name} lib/${name}.ts does not import prisma`);
  ok(!/from ["']@prisma\/client["']/.test(src), `11.1.${name} nor the Prisma client`);
  ok(!/from ["']next/.test(src), `11.2.${name} nor next`);
}

// 11.3 EVERY write goes through the Phase 1 ledger service. The posting server
// must never insert a journal entry or line itself — that would be a second
// posting path with its own, slightly different, rules.
ok(/createEntry\(/.test(postingServer), "11.3 the posting server posts via the Phase 1 createEntry");
ok(
  !/\b(prisma|tx)\.glJournalEntry\.(create|createMany|upsert)\(/.test(postingServer),
  "11.4 and never creates a journal ENTRY directly",
);
ok(
  !/\b(prisma|tx)\.glJournalLine\.(create|createMany|upsert)\(/.test(postingServer),
  "11.5 nor a journal LINE directly",
);

// 11.6 Never key money on memberId. A subscription transferred between
// siblings puts the money and the subscription on different members; keying on
// memberId once reported a $545.37 hole that did not exist (CLAUDE.md).
ok(!/sourceId:\s*[^,\n]*memberId/.test(postingServer), "11.6 nothing is keyed on memberId");
ok(!/sourceId:\s*[^,\n]*memberId/.test(posting), "11.7 …in the rules either");
// Every sourceId in the rules must come from an immutable id.
const sourceIds = [...posting.matchAll(/sourceType:\s*"(\w+)"[\s\S]{0,200}?sourceId:\s*([^,\n]+)/g)];
ok(sourceIds.length >= 5, `11.8 found the source keys (${sourceIds.length})`);
for (const [, type, expr] of sourceIds) {
  ok(
    /stripePayoutId|depositId|\be\.id\b|r\.plaidTransactionId|sourceId|base|`tx:\$\{t\.id\}`/.test(expr),
    `11.9.${type} ${type} is keyed on an immutable id`,
    expr.trim(),
  );
}

// 11.10 Tenant scope: every gl_* / money query in both servers carries clubId.
function argsOf(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return "";
}
for (const [name, src] of [["glPostingServer", postingServer], ["glReconcileServer", reconcileServer]] as const) {
  const calls = [...src.matchAll(/\b(?:prisma|tx)\.(\w+)\.(\w+)\(/g)];
  let unscoped = 0;
  for (const m of calls) {
    const args = argsOf(src, m.index! + m[0].length - 1);
    let scoped = /clubId/.test(args);
    if (!scoped && /\bwhere\b\s*[,}]/.test(args)) {
      const before = src.slice(0, m.index!);
      const decl = before.lastIndexOf("const where");
      if (decl >= 0) {
        const semi = src.indexOf(";", decl);
        scoped = semi > decl && /clubId/.test(src.slice(decl, semi));
      }
    }
    // A findFirstOrThrow by an id this function just created inside the same
    // transaction is the one shape that cannot carry clubId meaningfully;
    // there are none today, so no exemption is granted.
    if (!scoped) {
      unscoped++;
      fails.push(`11.10 ${name}: ${m[1]}.${m[2]}() is not club-scoped`);
    }
  }
  ok(unscoped === 0, `11.10.${name} every query carries clubId (${calls.length} checked)`);
}

// 11.11 The migration: additive, FK-aware RLS, and it sorts last.
const migration = readFileSync(join(ROOT, "prisma/migrations/20261021000000_gl_auto_posting_reconcile/migration.sql"), "utf8");
ok(!/\bDROP TABLE\b/i.test(migration), "11.11 the migration drops no table");
ok(!/\bDROP COLUMN\b/i.test(migration), "11.12 nor a column");
ok(!/ALTER COLUMN[\s\S]{0,40}TYPE/i.test(migration), "11.13 and retypes nothing");
ok(!/\bRENAME\b/i.test(migration), "11.14 and renames nothing");
// payout_matches was one of the 27 tables with no policy; Phase 2 is what
// starts writing to it, so it gets one first.
ok(/ALTER TABLE "payout_matches" ENABLE ROW LEVEL SECURITY/.test(migration), "11.15 payout_matches gets RLS — Phase 2's first task");
ok(/CREATE POLICY tenant_isolation ON "payout_matches"/.test(migration), "11.16 …with a tenant policy");
for (const t of ["gl_reconciliations", "gl_deposits"]) {
  ok(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`).test(migration), `11.17.${t} ${t} is created`);
  ok(new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`).test(migration), `11.18.${t} with RLS enabled`);
  // FK-AWARE, per the hole Phase 1's harness found: a clubId-only policy is not
  // enough on a table with an FK to another tenant table, because Postgres FK
  // checks bypass RLS.
  const policy = migration.slice(migration.indexOf(`CREATE POLICY tenant_isolation ON "${t}"`));
  ok(
    /EXISTS \(SELECT 1 FROM "gl_accounts" a[\s\S]{0,160}a\."clubId" = app\.current_club_id\(\)\)/.test(policy.slice(0, 900)),
    `11.19.${t} and its gl_accounts FK is verified to be in the same club`,
  );
}
// The Phase 1 tables that GAINED an FK must have their policies widened too.
ok(
  /CREATE POLICY tenant_isolation ON "gl_journal_lines"[\s\S]{0,1400}"reconciliationId" IS NULL/.test(migration),
  "11.20 gl_journal_lines' policy now verifies its new reconciliationId FK",
);
ok(
  /CREATE POLICY tenant_isolation ON "receipts"[\s\S]{0,700}"glEntryId" IS NULL/.test(migration),
  "11.21 receipts' policy verifies its new glEntryId FK",
);
ok(
  /CREATE POLICY tenant_isolation ON "bank_accounts"[\s\S]{0,900}"glAccountId" IS NULL/.test(migration),
  "11.22 bank_accounts' policy verifies its new glAccountId FK",
);
ok(/GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_reconciliations", "gl_deposits" TO athletix_app/.test(migration), "11.23 the app role is granted CRUD on both");
// booksStartDate must have NO default — a default would mean "post everything".
ok(/"booksStartDate" DATE;/.test(migration), "11.24 booksStartDate is added with NO default");

const migrationDirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d)).sort();
// This asserted "sorts LAST", which was only true while Phase 2 was the newest
// migration — Phase 3's folder broke it the moment it was created, exactly as
// Phase 1's equivalent assertion broke here (see ledger-tests 9.29). The real
// invariant, and the only one `migrate deploy` cares about, is that it sorts
// AFTER everything that precedes it; anything else and deploy warns about
// out-of-order folders.
{
  const mine = "20261021000000_gl_auto_posting_reconcile";
  ok(migrationDirs.includes(mine), "11.25 the migration folder is on disk");
  const before = migrationDirs.slice(0, migrationDirs.indexOf(mine));
  ok(
    before.every((d) => d < mine),
    "11.25b and it sorts after every migration that precedes it",
    before.filter((d) => d >= mine).join(", "),
  );
}

// 11.26 Every new route is gated, with a visible permission check.
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const newRoutes = ["books-start", "post", "deposits", "reconcile"].map((r) =>
  join(ROOT, "app/api/financials/ledger", r, "route.ts"),
);
for (const f of newRoutes) {
  const src = readFileSync(f, "utf8");
  const rel = f.replace(ROOT + "/", "");
  ok(/if \(!session\) return/.test(src), `11.26.${rel} narrows session explicitly first`);
  ok(
    /requirePermissionLive\(session, "finances"/.test(src) || /requireOwnerLive\(session\)/.test(src),
    `11.27.${rel} has a VISIBLE permission check`,
  );
  ok(/requireTierFeature\(session\.user\.clubId, "fullFinancials"\)/.test(src), `11.28.${rel} checks the tier server-side`);
}
// The books start date is owner-only, like the lock date: it decides which
// periods the books may touch.
const booksRoute = readFileSync(join(ROOT, "app/api/financials/ledger/books-start/route.ts"), "utf8");
ok(/requireOwnerLive\(session\)/.test(booksRoute), "11.29 changing the books start date is OWNER ONLY");
ok(/requirePermissionLive\(session, "finances", "view"\)/.test(booksRoute), "11.30 but reading it stays finances:view");

// 11.31 No route writes a gl_* table directly.
const offenders: string[] = [];
for (const f of walk(join(ROOT, "app"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bprisma\.(gl[A-Z]\w*)\.(\w+)\(/g)) {
    const [, model, method] = m;
    const isRead = /^(find|count|aggregate|groupBy)/.test(method);
    if (!isRead) offenders.push(`${f.replace(ROOT + "/", "")}: ${model}.${method}()`);
  }
}
ok(offenders.length === 0, "11.31 no route writes a gl_* table directly", offenders.join(", "));

// 11.32 There is no Plaid WEBHOOK in this codebase, so the session-based gates
// are complete. If one is ever added it will be the only sessionless Plaid
// entry point and will need its own gate — this assertion is what will fail
// and say so.
const plaidWebhooks = walk(join(ROOT, "app/api")).filter(
  (f) => /webhook/i.test(f) && /plaid/i.test(readFileSync(f, "utf8")),
);
ok(
  plaidWebhooks.length === 0,
  "11.32 there is no Plaid webhook route — so gating the session-bearing routes covers every Plaid entry point. " +
    "If this fails, a webhook was added and needs its own tier gate.",
  plaidWebhooks.join(", "),
);

// 11.33 The backfill script's safety rails.
const backfill = readFileSync(join(ROOT, "scripts/backfill-gl-postings.ts"), "utf8");
ok(/APPLY && allow\.size === 0/.test(backfill), "11.33 the backfill refuses --apply without --clubs");
ok(/process\.exit\(1\)/.test(backfill), "11.34 and exits non-zero");
ok(/postPendingForClub\(/.test(backfill), "11.35 it reuses the app's posting function, not a parallel copy");
ok(/booksStartDate/.test(backfill), "11.36 and skips clubs with no books start date");

// 11.34 payrollRange (B37) must compose in UTC, with no local-time setter.
const payrollCalc = readFileSync(join(ROOT, "lib/payrollCalc.ts"), "utf8");
const rangeFn = payrollCalc.slice(payrollCalc.indexOf("export function payrollRange"), payrollCalc.indexOf("export function payrollRange") + 700);
ok(/T00:00:00\.000Z/.test(rangeFn) && /T23:59:59\.999Z/.test(rangeFn), "11.37 payrollRange composes the range in UTC explicitly");
ok(!/setHours|setMinutes|setDate\(/.test(rangeFn), "11.38 and uses NO local-time setter (that was the B37 bug)");

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`\n${fails.length ? "✗" : "✓"} gl-posting: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
void formatCents;
void resolveAccount;
void chargeSourceId;
