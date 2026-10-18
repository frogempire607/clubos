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
  new RegExp(`canUseFeature\\(.*"${feature}"\\)`).test(src);

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

// Starter features must NOT be gated (volume principle).
check("membership report stays on Starter", /features\.reports\b/.test(read("app/api/reports/membership/route.ts")));
for (const f of ["app/api/documents/route.ts", "app/api/documents/[id]/route.ts", "app/api/member/memberships/subscribe/route.ts", "app/api/public/events/[slug]/register/route.ts", "app/api/member/products/[id]/buy/route.ts", "app/api/member/private-packages/[id]/buy/route.ts"]) {
  check(`${f} is not tier-gated`, !/requireTierFeature|tierBlockedBody/.test(read(f)));
}

// Limits.
check("entity limit enforced", read("app/api/club/legal-entities/route.ts").includes('"maxEntities"'));
check("bank-account limit enforced (manual)", read("app/api/financials/bank-accounts/route.ts").includes('"maxBankAccounts"'));
check("bank-account limit enforced (Plaid)", read("app/api/plaid/exchange/route.ts").includes('"maxBankAccounts"'));
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
