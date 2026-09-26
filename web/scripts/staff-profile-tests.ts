// B21 staff profile — pure rules. npm run test:staff-profile
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selfRule } from "../lib/staffSelf";
import { to12h, range12h } from "../lib/time12";
import { describeAccessChanges } from "../lib/staffAccess";
import { SAFE_USER_SELECT, SECRET_USER_FIELDS, invitePending } from "../lib/safeUser";
import { canAccessPath, DEFAULT_PERMISSIONS } from "../lib/permissions";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

console.log("\nself rules — staff can never touch their own pay or access");
for (const a of ["edit_pay", "edit_access", "edit_record", "remove"] as const) {
  eq(`STAFF self ${a} → deny`, selfRule("STAFF", "u1", "u1", a), "deny");
}
for (const a of ["view_pay", "view_profile", "edit_hours", "edit_time_off"] as const) {
  eq(`STAFF self ${a} → allow`, selfRule("STAFF", "u1", "u1", a), "allow");
}
eq("STAFF on someone else → falls through to permissions", selfRule("STAFF", "u1", "u2", "edit_pay"), null);
eq("OWNER self → falls through (owners are exempt)", selfRule("OWNER", "u1", "u1", "edit_pay"), null);
eq("missing actor id → not self", selfRule("STAFF", null, "u1", "edit_pay"), null);
eq("empty ids never count as self", selfRule("STAFF", "", "", "edit_pay"), null);

console.log("\nevery pay-writing route checks the self rule");
for (const f of ["app/api/staff/[id]/compensation/route.ts", "app/api/staff/[id]/pay-rates/route.ts"]) {
  const src = readFileSync(join(__dirname, "..", f), "utf8");
  const writers = (src.match(/export async function (PUT|POST|DELETE|PATCH)/g) ?? []).length;
  const guards = (src.match(/"edit_pay"\) === "deny"/g) ?? []).length;
  eq(`${f}: ${writers} write handler(s), each guarded`, guards >= writers && writers > 0, true);
}
{
  const src = readFileSync(join(__dirname, "..", "app/api/staff/[id]/route.ts"), "utf8");
  eq("staff PATCH refuses self", /"edit_record"\) === "deny"/.test(src), true);
  eq("staff DELETE refuses self", /"remove"\) === "deny"/.test(src), true);
}

console.log("\nMy profile is reachable with no permissions at all");
const none = Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).map((k) => [k, "none"]));
eq("STAFF with nothing can open /dashboard/my-profile", canAccessPath("STAFF", none, "/dashboard/my-profile"), true);
eq("…but not another profile under /dashboard/staff", canAccessPath("STAFF", none, "/dashboard/staff/abc"), false);

console.log("\n12-hour times");
eq("18:30", to12h("18:30"), "6:30 PM");
eq("00:05", to12h("00:05"), "12:05 AM");
eq("12:00", to12h("12:00"), "12:00 PM");
eq("same meridiem collapses", range12h("18:30", "20:30"), "6:30 – 8:30 PM");
eq("different meridiem kept", range12h("11:00", "13:00"), "11:00 AM – 1:00 PM");
eq("garbage passes through", to12h("soon"), "soon");
eq("empty", range12h(null, null), "");

console.log("\naccess changes in plain words");
{
  const ch = describeAccessChanges(
    "Sal",
    { levels: { billing: "none", reports: "view" }, billing: { transfer_subscription: false } },
    { levels: { billing: "full", reports: "none" }, billing: { transfer_subscription: true } },
  );
  eq("three changes", ch.length, 3);
  eq("billing sentence", ch.find((c) => c.key === "billing")?.sentence, "Sal will be able to see and edit every member's plans, prices and payment methods.");
  eq("billing is money", ch.find((c) => c.key === "billing")?.money, true);
  eq("reports removal", ch.find((c) => c.key === "reports")?.sentence, "Sal will no longer be able to see reports.");
  eq("log line", ch.find((c) => c.key === "billing")?.logLine, "Changed Billing management from None to Full");
  eq("sub-scope on", ch.find((c) => c.key === "billing.transfer_subscription")?.logLine, "Turned on Billing: move a membership to another athlete in the family");
  eq("no change → nothing", describeAccessChanges("Sal", { levels: { members: "view" } }, { levels: { members: "view" } }).length, 0);
}

console.log("\nsecrets never leave the server");
for (const f of SECRET_USER_FIELDS) eq(`SAFE_USER_SELECT excludes ${f}`, f in SAFE_USER_SELECT, false);
eq("invite pending: token + never logged in", invitePending({ resetToken: "t", lastLoginAt: null }), true);
eq("logged in → not pending", invitePending({ resetToken: "t", lastLoginAt: new Date() }), false);
{
  const src = readFileSync(join(__dirname, "..", "app/api/staff/route.ts"), "utf8");
  const getBody = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  eq("/api/staff GET selects through SAFE_USER_SELECT", getBody.includes("SAFE_USER_SELECT") && !/include:\s*\{\s*staffProfile/.test(getBody), true);
  const postBody = src.slice(src.indexOf("export async function POST"));
  eq("/api/staff POST strips passwordHash/resetToken before responding", postBody.includes("passwordHash: _ph") && postBody.includes("resetToken: _rt"), true);
}

console.log(`\n${fail ? "✗" : "✓"} ${pass}/${pass + fail} passed — staff profile rules`);
process.exit(fail ? 1 : 0);
