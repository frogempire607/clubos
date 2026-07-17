/**
 * Event payroll math — pure-function tests (no DB/Stripe). Run:
 *   npx tsx scripts/event-comp-tests.ts
 */
import { collectedRevenue, computePayoutAmount, payoutBasisNote } from "../lib/eventComp";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

const T = (over: Partial<Parameters<typeof collectedRevenue>[0][number]>) => ({
  status: "SUCCEEDED",
  reconciliationStatus: null,
  amount: 100,
  refundedAmount: null,
  stripeFeeAmount: null,
  ...over,
});

console.log("\n— collected revenue —");
{
  const r = collectedRevenue([T({}), T({ amount: 50 })]);
  check("sums succeeded payments", r.gross === 150 && r.net === 150);

  // Pending cash/check, failed and abandoned payments never count.
  const r2 = collectedRevenue([T({}), T({ status: "PENDING" }), T({ status: "FAILED" })]);
  check("pending/failed never count", r2.gross === 100);
  const r3 = collectedRevenue([T({}), T({ reconciliationStatus: "VOID" }), T({ reconciliationStatus: "REVIEW" })]);
  check("VOID and REVIEW (flagged duplicates) excluded", r3.gross === 100);

  // Refunds actually reduce the basis — filtering SUCCEEDED alone is not enough.
  const r4 = collectedRevenue([T({ refundedAmount: 30 })]);
  check("partial refund reduces gross (SUCCEEDED row!)", r4.gross === 70 && r4.refunded === 30);
  const r5 = collectedRevenue([T({ status: "REFUNDED", refundedAmount: 100 })]);
  check("full refund contributes $0", r5.gross === 0);
  const r6 = collectedRevenue([T({ status: "REFUNDED", refundedAmount: null })]);
  check("legacy REFUNDED row with no refundedAmount still zeroes out", r6.gross === 0);
  const r7 = collectedRevenue([T({ refundedAmount: 250 })]);
  check("refund can never exceed the payment (clamped)", r7.gross === 0 && r7.refunded === 100);

  // NO REFUNDS policy: percentages computed as if nothing was clawed back.
  const r8 = collectedRevenue([T({ refundedAmount: 30 }), T({ status: "REFUNDED", refundedAmount: 100 })], { ignoreRefunds: true });
  check("compNoRefunds ignores refunds and chargebacks", r8.gross === 200);

  // Gross = before processing fees; net = gross − known fees. Stripe keeps its
  // fee on refund, so fees always reduce net in full.
  const r9 = collectedRevenue([T({ stripeFeeAmount: 3.2 }), T({ amount: 40 })]);
  check("net subtracts known fees", r9.gross === 140 && r9.net === 136.8);
  const r10 = collectedRevenue([T({ refundedAmount: 100, status: "REFUNDED", stripeFeeAmount: 3.2 })]);
  check("fee still counts on a refunded row (net clamped ≥ 0)", r10.net === 0);
  const r11 = collectedRevenue([T({ amount: "25.50" as unknown as number })]);
  check("Decimal/string amounts coerce", r11.gross === 25.5);
}

console.log("\n— payout math —");
{
  const rev = { gross: 1000, net: 950 };
  check("NONE pays nothing", computePayoutAmount({ compMethod: "NONE" }, rev) === null);
  check("flat pays the flat amount", computePayoutAmount({ compMethod: "FLAT", flatAmount: 150 }, rev) === 150);
  check("flat $0 pays nothing", computePayoutAmount({ compMethod: "FLAT", flatAmount: 0 }, rev) === null);
  check("percent of gross by default", computePayoutAmount({ compMethod: "PERCENT", percent: 10 }, rev) === 100);
  check(
    "percent of net when chosen",
    computePayoutAmount({ compMethod: "PERCENT", percent: 10, basis: "NET_COLLECTED" }, rev) === 95,
  );
  check("percent caps at 100", computePayoutAmount({ compMethod: "PERCENT", percent: 150 }, rev) === 1000);
  check("percent rounds to cents", computePayoutAmount({ compMethod: "PERCENT", percent: 33.33 }, { gross: 100, net: 100 }) === 33.33);
  check("0 percent pays nothing", computePayoutAmount({ compMethod: "PERCENT", percent: 0 }, rev) === null);

  const rev2 = { gross: 500, net: 480, refunded: 50, fees: 20, countedTransactions: 6 };
  const note = payoutBasisNote({ compMethod: "PERCENT", percent: 20, basis: "GROSS_COLLECTED" }, rev2, "Summer Clinic");
  check("payout note names basis + refunds", note.includes("gross collected") && note.includes("$50.00 of refunds"));
  const note2 = payoutBasisNote({ compMethod: "PERCENT", percent: 20 }, rev2, "Summer Clinic", { ignoreRefunds: true });
  check("no-refunds policy is stated on the record", note2.includes("no-refunds policy"));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
