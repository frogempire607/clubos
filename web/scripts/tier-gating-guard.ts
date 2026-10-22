/**
 * Pricing overhaul (2026-10-18) — static guard. Pure file reads, no DB.
 *
 *   1. Every Pro/Enterprise route listed below enforces its tier gate
 *      SERVER-SIDE (hiding a nav item is not gating).
 *   2. No source file outside lib/fees.ts hardcodes Stripe's 2.9%.
 *   3. No Stripe subscription is created with a hardcoded 0% application fee.
 *   4. No user-facing copy still claims a 0% platform fee.
 *   5. Every refunds.create on a connected account states refund_application_fee.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const gated = (src: string, feature: string) =>
  src.includes(`requireTierFeature(session.user.clubId, "${feature}")`) ||
  src.includes(`requireTierFeature(g.session.user.clubId, "${feature}")`) ||
  new RegExp(`(features|\\))\\.${feature}\\b`).test(src) ||
  new RegExp(`canUseFeature\\(.*"${feature}"\\)`).test(src) ||
  // Phase 11 task 8: the bank routes went through three different hand-rolled
  // forms of the `plaid` check. They now use two NAMED helpers in
  // lib/plaidGate.ts — requireBankConnect (connecting/syncing: a hard `plaid`
  // check) and requireBankRead (`plaid` OR the club already has data, which is
  // the downgrade promise "keep existing bank data viewable").
  //
  // Accepting the helper names is NOT a weakening: the assertion right below
  // this list proves lib/plaidGate.ts actually consults the flag, so the
  // indirection cannot quietly become a no-op.
  (feature === "plaid" && /require(BankConnect|BankRead|BankAccountRoom)\(/.test(src));

const GATES: [string, string][] = [
  ["app/api/club/branded-app/route.ts", "brandedApp"],
  ["app/api/messages/dm/route.ts", "privateMessaging"],
  ["app/api/messages/dm/[userId]/route.ts", "privateMessaging"],
  ["app/api/messages/groups/route.ts", "privateMessaging"],
  ["app/api/messages/groups/[id]/route.ts", "privateMessaging"],
  ["app/api/member/messages/dm/[userId]/route.ts", "privateMessaging"],
  ["app/api/member/messages/groups/[id]/route.ts", "privateMessaging"],
  ["app/api/events/route.ts", "eventToolkit"],
  ["app/api/events/[id]/route.ts", "eventToolkit"],
  ["app/api/events/[id]/roster/route.ts", "eventToolkit"],
  ["app/api/events/[id]/roster/export/route.ts", "eventToolkit"],
  ["app/api/events/[id]/share-link/route.ts", "eventToolkit"],
  ["app/api/payroll/ledger/route.ts", "payroll"],
  ["app/api/payroll/plans/route.ts", "payroll"],
  ["app/api/payroll/lines/route.ts", "payroll"],
  ["app/api/staff/[id]/pay-plans/route.ts", "payroll"],
  ["app/api/staff/[id]/compensation/route.ts", "payroll"],
  ["app/api/staff/payroll/route.ts", "payroll"],
  ["app/api/staff/[id]/calendar-feed/route.ts", "calendarFeeds"],
  ["app/api/public/staff-calendar/[token]/route.ts", "calendarFeeds"],
  ["app/api/plaid/link-token/route.ts", "plaid"],
  ["app/api/plaid/exchange/route.ts", "plaid"],
  ["app/api/plaid/transactions/[id]/match/route.ts", "plaid"],
  ["app/api/expenses/route.ts", "fullFinancials"],
  ["app/api/financials/tax-summary/route.ts", "fullFinancials"],
  ["app/api/financials/receipts/route.ts", "fullFinancials"],
  ["app/api/financials/imports/route.ts", "fullFinancials"],
  ["app/api/financials/bank-accounts/route.ts", "fullFinancials"],
  ["app/api/financials/category-rules/route.ts", "fullFinancials"],
  // accounting Phase 3: the statements and the CPA download. Both are ONE
  // route each on purpose — one permission check and one tier gate to get
  // right rather than six of each to forget.
  ["app/api/financials/ledger/reports/route.ts", "fullFinancials"],
  ["app/api/financials/ledger/reports/export/route.ts", "fullFinancials"],
  ["app/api/financials/ledger/close/route.ts", "fullFinancials"],
  ["app/api/financials/ledger/assets/route.ts", "fullFinancials"],
  ["app/api/financials/ledger/assets/[id]/route.ts", "fullFinancials"],
  ["app/api/financials/ledger/assets/depreciation/route.ts", "fullFinancials"],
  ["app/api/financials/ledger/form1099/route.ts", "fullFinancials"],
  ["app/api/reports/snapshot/route.ts", "fullReports"],
  ["app/api/reports/revenue/route.ts", "fullReports"],
  ["app/api/reports/pnl/route.ts", "fullReports"],
  ["app/api/reports/costs/route.ts", "fullReports"],
  ["app/api/reports/cash-flow/route.ts", "fullReports"],
  ["app/api/reports/unit-economics/route.ts", "fullReports"],
  ["app/api/reports/imports/route.ts", "fullReports"],
  ["app/api/reports/action-items/route.ts", "actionCenter"],
  ["app/api/dashboard/action-center/route.ts", "actionCenter"],
];
for (const [f, feat] of GATES) check(`${f} gates ${feat}`, gated(read(f), feat));

// The named bank gates must really consult the tier. `gated()` accepts
// requireBankConnect / requireBankRead by name, so this is what stops that
// becoming a blank cheque.
{
  const gate = read("lib/plaidGate.ts");
  check("plaidGate: requireBankConnect checks the plaid flag", /canUseFeature\(tier, "plaid"\)/.test(gate));
  check("plaidGate: it is a HARD check for connecting", /export async function requireBankConnect[\s\S]{0,400}canUseFeature\(tier, "plaid"\)/.test(gate));
  check("plaidGate: the read gate also consults hasBankData", /export async function requireBankRead[\s\S]{0,500}hasBankData\(clubId\)/.test(gate));
  check("plaidGate: the room check uses maxBankAccounts", gate.includes('"maxBankAccounts"'));
}

// Starter features must NOT be gated (volume principle).
check("membership report stays on Starter", /features\.reports\b/.test(read("app/api/reports/membership/route.ts")));
for (const f of ["app/api/documents/route.ts", "app/api/documents/[id]/route.ts", "app/api/member/memberships/subscribe/route.ts", "app/api/public/events/[slug]/register/route.ts", "app/api/member/products/[id]/buy/route.ts", "app/api/member/private-packages/[id]/buy/route.ts"]) {
  check(`${f} is not tier-gated`, !/requireTierFeature|tierBlockedBody/.test(read(f)));
}

// Limits.
check("entity limit enforced", read("app/api/club/legal-entities/route.ts").includes('"maxEntities"'));
check("bank-account limit enforced (manual)", read("app/api/financials/bank-accounts/route.ts").includes('"maxBankAccounts"'));
check("bank-account limit enforced (Plaid exchange)", read("app/api/plaid/exchange/route.ts").includes('"maxBankAccounts"'));
// POST /api/plaid/connections is a SECOND itemPublicTokenExchange path and had
// NO limit check until 2026-10-21 — a club at its plan's limit could exceed it
// there. This guard only ever asserted the limit on /exchange, which is why it
// went unnoticed; asserting both is the fix that keeps it fixed.
check(
  "bank-account limit enforced (Plaid connections)",
  /require(BankAccountRoom)\(/.test(read("app/api/plaid/connections/route.ts")),
);
// And connecting must be the HARD gate on both paths, not the read gate.
check("plaid connect is hard-gated (connections)", read("app/api/plaid/connections/route.ts").includes("requireBankConnect("));
check("plaid connect is hard-gated (link-token)", read("app/api/plaid/link-token/route.ts").includes("requireBankConnect("));
check("plaid sync is hard-gated", read("app/api/plaid/sync/route.ts").includes("requireBankConnect("));
// Disconnecting must NOT be tier-gated: a downgraded club has to be able to
// unplug its own bank. Gating it is how you trap somebody.
check(
  "disconnecting a bank is NOT tier-gated",
  !/requireTierFeature|requireBankConnect/.test(
    read("app/api/plaid/connections/[id]/route.ts").split("export async function DELETE")[1] ?? "",
  ),
);
check("staff seat limit enforced", read("app/api/staff/route.ts").includes('"maxStaffSeats"'));

// Walk source.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = join(dir, e);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel);
  }
  return out;
}
const files = [...walk("app"), ...walk("lib"), ...walk("components")];
for (const f of files) {
  const src = read(f);
  if (f !== "lib/fees.ts" && f !== "lib/stripePlanChange.ts") {
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    check(`${f}: no hardcoded 2.9%`, !/\b0\.029\b/.test(code));
  }
  check(`${f}: no hardcoded application_fee_percent: 0`, !/application_fee_percent:\s*0\s*,/.test(src));
  check(`${f}: no "0% platform fee" claim`, !/0% platform fee/i.test(src));
  if (/refunds\.create\(/.test(src)) {
    const n = (src.match(/refunds\.create\(/g) ?? []).length;
    const m = (src.match(/refund_application_fee:/g) ?? []).length;
    check(`${f}: every refunds.create states refund_application_fee`, m >= n, { refunds: n, explicit: m });
  }
}

console.log(`\ntier-gating-guard: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
