/**
 * Phase 6 §6B — "Test Plaid sandbox or mocked transaction flows", and §6A.6,
 * "Do not double count Stripe payments and bank deposits."
 *
 *   npm run test:bank-reconciliation
 *
 * Mocked bank rows through the PURE classifiers in lib/reportsCashFlow.ts. No
 * Plaid credentials, no network, no database — `detectTransferPairs` and
 * `classifyPlaidRow` already carry a "PURE — used by tests and by buildCashFlow"
 * comment, and until now no test used them.
 *
 * ── Why mocked rather than the Plaid sandbox ────────────────────────────────
 *
 * A sandbox test would prove Plaid returns transactions, which is Plaid's
 * problem. What can actually go wrong HERE is arithmetic on rows once they have
 * arrived, and there are two ways to get it wrong:
 *
 *   DOUBLE COUNT   A Stripe payout lands in the bank. The money is already in
 *                  the Transaction table as revenue. Counting the bank deposit
 *                  too reports it twice, and the owner's cash-in is inflated by
 *                  every payout in the range. `PayoutMatch` links the two and
 *                  the matched bank row must be EXCLUDED.
 *
 *   PHANTOM FLOW   Moving $5,000 between the club's own accounts is a debit on
 *                  one and a credit on the other. Counted naively that is
 *                  $5,000 of spending and $5,000 of income that never happened.
 *
 * Both are silent — the totals still look like money. This file pins them.
 *
 * ── Sign convention ─────────────────────────────────────────────────────────
 *
 * Plaid's `amount` is POSITIVE for money leaving the account and NEGATIVE for
 * money arriving. `classifyPlaidRow` follows that: `amt > 0` is direction OUT.
 * Getting this backwards inverts an entire cash-flow statement, so it is
 * asserted directly rather than assumed.
 */
import {
  detectTransferPairs,
  classifyPlaidRow,
  CAPITALIZATION_THRESHOLD,
  TRANSFER_WINDOW_DAYS,
  type PlaidRowLite,
} from "../lib/reportsCashFlow";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
const section = (s: string) => console.log(`\n${s}`);

const D = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
let seq = 0;
function row(p: Partial<PlaidRowLite> & { amount: number; date: Date }): PlaidRowLite {
  seq++;
  return {
    id: p.id ?? `row_${seq}`,
    plaidTransactionId: p.plaidTransactionId ?? `ptx_${seq}`,
    plaidConnectionId: p.plaidConnectionId ?? "bank_A",
    name: p.name ?? "Transaction",
    categoryOverride: p.categoryOverride ?? null,
    markedAsTransfer: p.markedAsTransfer ?? false,
    amount: p.amount,
    date: p.date,
  };
}
const NONE = { transfersDetected: new Set<string>(), matchedBankIds: new Set<string>() };

// ═══════════════════════════════════════════════════════════════════════════
section("DOUBLE COUNT — a Stripe payout that also appears in the bank");
// ═══════════════════════════════════════════════════════════════════════════
{
  // The payout arrives as a bank credit. Its money is already counted as
  // revenue in the Transaction table, so the bank row must be excluded.
  const payout = row({ amount: -4200, date: D("2026-08-01"), plaidTransactionId: "ptx_payout" });
  const matched = classifyPlaidRow(payout, {
    transfersDetected: new Set(),
    matchedBankIds: new Set(["ptx_payout"]),
  });
  check("a MATCHED Stripe payout is excluded, not counted as cash in",
    matched.bucket === "PAYOUT_MATCH", JSON.stringify(matched));

  // Until the matcher links it, the same row IS operating income. That is
  // correct — the alternative is losing real money from the statement — and it
  // is why an unmatched payout is surfaced rather than silently dropped.
  const unmatched = classifyPlaidRow(payout, NONE);
  check("an UNMATCHED payout still counts as cash in, so money is never lost",
    unmatched.bucket === "OPERATING" && unmatched.direction === "IN" && unmatched.amount === 4200,
    JSON.stringify(unmatched));
}
{
  // Matching is keyed on plaidTransactionId, not the row's own id. A payout
  // matched by the wrong key would be double-counted, which is the bug.
  const r = row({ id: "row_x", plaidTransactionId: "ptx_x", amount: -100, date: D("2026-08-01") });
  check("matching keys on plaidTransactionId, not the local row id",
    classifyPlaidRow(r, { transfersDetected: new Set(), matchedBankIds: new Set(["row_x"]) }).bucket !== "PAYOUT_MATCH",
    "a local id in matchedBankIds must NOT exclude the row");
}

// ═══════════════════════════════════════════════════════════════════════════
section("PHANTOM FLOW — money moved between the club's own accounts");
// ═══════════════════════════════════════════════════════════════════════════
{
  const out = row({ amount: 5000, date: D("2026-08-01"), plaidConnectionId: "bank_A" });
  const inn = row({ amount: -5000, date: D("2026-08-02"), plaidConnectionId: "bank_B" });
  const res = detectTransferPairs([out, inn]);
  check("a matching debit and credit across two banks are both excluded",
    res.transfersDetected.has(out.id) && res.transfersDetected.has(inn.id),
    JSON.stringify([...res.transfersDetected]));
  check("the pair is counted once, not twice",
    res.accountTransfers.count === 1 && res.accountTransfers.amount === 5000,
    JSON.stringify(res.accountTransfers));
}
{
  // Same account: a debit and credit of equal size on ONE connection is two
  // real events, not a transfer. Treating them as a pair would erase a genuine
  // expense and a genuine deposit.
  const a = row({ amount: 5000, date: D("2026-08-01"), plaidConnectionId: "bank_A" });
  const b = row({ amount: -5000, date: D("2026-08-01"), plaidConnectionId: "bank_A" });
  const res = detectTransferPairs([a, b]);
  check("equal amounts on the SAME account are not a transfer",
    res.transfersDetected.size === 0, JSON.stringify([...res.transfersDetected]));
}
{
  const out = row({ amount: 5000, date: D("2026-08-01"), plaidConnectionId: "bank_A" });
  const inn = row({ amount: -4999, date: D("2026-08-01"), plaidConnectionId: "bank_B" });
  check("amounts that do not offset are not a transfer",
    detectTransferPairs([out, inn]).transfersDetected.size === 0);
}
{
  // The window is TRANSFER_WINDOW_DAYS. A same-size payment to a vendor weeks
  // later must not be swallowed as a transfer.
  const mk = (days: number) => [
    row({ amount: 5000, date: D("2026-08-01"), plaidConnectionId: "bank_A" }),
    row({ amount: -5000, date: new Date(D("2026-08-01").getTime() + days * 86400000), plaidConnectionId: "bank_B" }),
  ];
  check(`${TRANSFER_WINDOW_DAYS} days apart is still a transfer`,
    detectTransferPairs(mk(TRANSFER_WINDOW_DAYS)).transfersDetected.size === 2);
  check(`${TRANSFER_WINDOW_DAYS + 1} days apart is NOT`,
    detectTransferPairs(mk(TRANSFER_WINDOW_DAYS + 1)).transfersDetected.size === 0);
}
{
  // A human can force it. That override must survive with no partner row.
  const solo = row({ amount: 900, date: D("2026-08-01"), markedAsTransfer: true });
  check("a manually marked transfer is excluded even with no matching pair",
    detectTransferPairs([solo]).transfersDetected.has(solo.id));
  check("and classifyPlaidRow honours the manual mark on its own",
    classifyPlaidRow(solo, NONE).bucket === "TRANSFER");
}

// ═══════════════════════════════════════════════════════════════════════════
section("SIGN CONVENTION — positive is money OUT");
// ═══════════════════════════════════════════════════════════════════════════
{
  const spend = classifyPlaidRow(row({ amount: 250, date: D("2026-08-01") }), NONE);
  const earn = classifyPlaidRow(row({ amount: -250, date: D("2026-08-01") }), NONE);
  check("a positive Plaid amount is money OUT",
    spend.bucket === "OPERATING" && spend.direction === "OUT" && spend.amount === 250,
    JSON.stringify(spend));
  check("a negative Plaid amount is money IN",
    earn.bucket === "OPERATING" && earn.direction === "IN" && earn.amount === 250,
    JSON.stringify(earn));
}

// ═══════════════════════════════════════════════════════════════════════════
section("CLASSIFICATION — operating vs investing vs financing");
// ═══════════════════════════════════════════════════════════════════════════
{
  const big = classifyPlaidRow(row({ amount: CAPITALIZATION_THRESHOLD, date: D("2026-08-01") }), NONE);
  check(`an uncategorised spend at the $${CAPITALIZATION_THRESHOLD} threshold is INVESTING`,
    big.bucket === "INVESTING", JSON.stringify(big));
  const justUnder = classifyPlaidRow(row({ amount: CAPITALIZATION_THRESHOLD - 1, date: D("2026-08-01") }), NONE);
  check("a dollar under the threshold is still OPERATING",
    justUnder.bucket === "OPERATING", JSON.stringify(justUnder));
  // The threshold applies to SPENDING. A large deposit is income, not an asset
  // purchase — reading the magnitude without the sign would bury real revenue
  // in the investing section.
  const bigIn = classifyPlaidRow(row({ amount: -(CAPITALIZATION_THRESHOLD + 1000), date: D("2026-08-01") }), NONE);
  check("a large DEPOSIT is operating income, not investing",
    bigIn.bucket === "OPERATING" && bigIn.direction === "IN", JSON.stringify(bigIn));
}
{
  // An explicit category always beats the threshold, in both directions.
  const smallEquip = classifyPlaidRow(
    row({ amount: 40, date: D("2026-08-01"), categoryOverride: "EQUIPMENT" }), NONE);
  check("an EQUIPMENT override is investing even below the threshold",
    smallEquip.bucket === "INVESTING", JSON.stringify(smallEquip));
  const bigRent = classifyPlaidRow(
    row({ amount: 9000, date: D("2026-08-01"), categoryOverride: "RENT" }), NONE);
  check("a categorised operating cost stays operating however large",
    bigRent.bucket === "OPERATING", JSON.stringify(bigRent));
}
{
  const cases: Array<[string, string]> = [
    ["LOAN_DEPOSIT", "LOAN_PROCEEDS"],
    ["LOAN_REPAYMENT", "LOAN_PAYMENT"],
    ["OWNER_CONTRIBUTION", "OWNER_CONTRIBUTION"],
    ["OWNER_DRAW", "OWNER_DISTRIBUTION"],
  ];
  for (const [cat, kind] of cases) {
    const c = classifyPlaidRow(row({ amount: 1000, date: D("2026-08-01"), categoryOverride: cat }), NONE);
    check(`${cat} classifies as financing/${kind}`,
      c.bucket === "FINANCING" && c.kind === kind, JSON.stringify(c));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section("PRECEDENCE — a row can qualify for more than one bucket");
// ═══════════════════════════════════════════════════════════════════════════
{
  // A transfer that is ALSO a matched payout, and a transfer carrying a
  // financing category. Exclusion has to win, or the money is counted.
  const r = row({ amount: 5000, date: D("2026-08-01"), plaidTransactionId: "ptx_both",
                  categoryOverride: "LOAN_DEPOSIT" });
  const asTransfer = classifyPlaidRow(r, { transfersDetected: new Set([r.id]), matchedBankIds: new Set() });
  check("TRANSFER beats a financing category — exclusion wins",
    asTransfer.bucket === "TRANSFER", JSON.stringify(asTransfer));
  const asPayout = classifyPlaidRow(r, { transfersDetected: new Set(), matchedBankIds: new Set(["ptx_both"]) });
  check("PAYOUT_MATCH beats a financing category — exclusion wins",
    asPayout.bucket === "PAYOUT_MATCH", JSON.stringify(asPayout));
}

// ═══════════════════════════════════════════════════════════════════════════
section("EDGE CASES");
// ═══════════════════════════════════════════════════════════════════════════
{
  check("no rows yields no transfers", detectTransferPairs([]).accountTransfers.count === 0);
  // A zero-amount row is filtered before pairing; without that, every pair of
  // zero rows across two banks would offset and be reported as a transfer.
  const z = [row({ amount: 0, date: D("2026-08-01"), plaidConnectionId: "bank_A" }),
             row({ amount: 0, date: D("2026-08-01"), plaidConnectionId: "bank_B" })];
  check("zero-amount rows do not pair with each other",
    detectTransferPairs(z).transfersDetected.size === 0,
    JSON.stringify([...detectTransferPairs(z).transfersDetected]));
}
{
  // Three banks, one real transfer plus an unrelated expense of the same size
  // on a third account. Only the genuine pair should be excluded — over-eager
  // pairing would erase a real cost.
  const a = row({ amount: 750, date: D("2026-08-01"), plaidConnectionId: "bank_A" });
  const b = row({ amount: -750, date: D("2026-08-01"), plaidConnectionId: "bank_B" });
  const c = row({ amount: 750, date: D("2026-08-01"), plaidConnectionId: "bank_C", name: "Mat repair" });
  const res = detectTransferPairs([a, b, c]);
  check("an unrelated same-size expense on a third account survives",
    !res.transfersDetected.has(c.id), JSON.stringify([...res.transfersDetected]));
}

{
  // Two REAL transfers of the same size on the same day must both be found —
  // one-to-one pairing must not stop at the first.
  const a1 = row({ amount: 300, date: D("2026-08-05"), plaidConnectionId: "bank_A" });
  const b1 = row({ amount: -300, date: D("2026-08-05"), plaidConnectionId: "bank_B" });
  const a2 = row({ amount: 300, date: D("2026-08-05"), plaidConnectionId: "bank_A" });
  const b2 = row({ amount: -300, date: D("2026-08-05"), plaidConnectionId: "bank_B" });
  const res = detectTransferPairs([a1, b1, a2, b2]);
  check("two genuine same-size transfers are both detected",
    res.transfersDetected.size === 4, JSON.stringify([...res.transfersDetected]));
  check("and counted as two pairs, not collapsed into one",
    res.accountTransfers.count === 2 && res.accountTransfers.amount === 600,
    JSON.stringify(res.accountTransfers));
}
{
  // The excluded-row count and the reported pair count must agree, or the
  // summary line contradicts the statement it summarises.
  const a = row({ amount: 750, date: D("2026-08-01"), plaidConnectionId: "bank_A" });
  const b = row({ amount: -750, date: D("2026-08-01"), plaidConnectionId: "bank_B" });
  const c = row({ amount: 750, date: D("2026-08-01"), plaidConnectionId: "bank_C" });
  const res = detectTransferPairs([a, b, c]);
  check("rows excluded == pairs reported x 2",
    res.transfersDetected.size === res.accountTransfers.count * 2,
    `${res.transfersDetected.size} rows vs ${res.accountTransfers.count} pairs`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
