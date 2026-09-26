// Membership option descriptions + derived facts shown on Book → Memberships. PURE.
//   npm run test:option-facts
import { makeOption, optionFacts, parseOptions, serializeOptions } from "../lib/membershipOptions";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const full = makeOption({ id: "a", label: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY", contractMonths: 1, autoRenewDefault: false });
const two = makeOption({ id: "b", label: "Monthly 2 days (Tue/Thu)", price: 110, billingPeriod: "MONTHLY", contractMonths: 1, autoRenewDefault: false, entitlement: { kind: "DAYS", days: [2, 4] } });
const three = makeOption({ id: "c", label: "3 Months", price: 160, billingPeriod: "MONTHLY", contractMonths: 3, autoRenewDefault: false });
const upfront = makeOption({ id: "d", label: "3 months Upfront", price: 450, billingPeriod: "QUARTERLY", contractMonths: 3, autoRenewDefault: false });
const open = makeOption({ id: "e", label: "Monthly", price: 110, billingPeriod: "MONTHLY" });

eq("full: 1-month, ends unless renewed", optionFacts(full), ["1-month commitment", "Ends after that unless you renew"]);
eq("Tue/Thu names the days", optionFacts(two)[0].endsWith(" only"), true);
eq("3 months commitment", optionFacts(three), ["3-month commitment", "Ends after that unless you renew"]);
eq("upfront quarter", optionFacts(upfront), ["Paid up front for 3 months", "Ends after that unless you renew"]);
eq("no term, auto-renew default → cancel anytime", optionFacts(open), ["No minimum — cancel anytime"]);
eq("plan term inherited", optionFacts(open, { contractMonths: 12, autoRenewDefault: true }), ["12-month commitment", "Renews automatically after that"]);
eq("one-time: no renewal talk", optionFacts(makeOption({ label: "Camp", price: 200, billingPeriod: "ONE_TIME" })), []);

const withDesc = [{ ...full, description: "  All practices, every day we're open.  " }, two];
const round = parseOptions(serializeOptions(withDesc));
eq("description round-trips (trimmed)", round[0].description, "All practices, every day we're open.");
eq("no description stays absent in storage", JSON.parse(serializeOptions([two]))[0].description, undefined);
eq("description capped at 600", parseOptions(JSON.stringify([{ label: "x", price: 1, billingPeriod: "MONTHLY", description: "y".repeat(900) }]))[0].description?.length, 600);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
