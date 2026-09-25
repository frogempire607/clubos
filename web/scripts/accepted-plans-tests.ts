/**
 * B7 — option-aware "Accepted Memberships". No database.
 *
 *   npm run test:accepted-plans
 *
 * Fixture: Frog Empire's MS/HS after the collapse — six options on one plan —
 * and a class that accepts only some of them.
 */
import {
  acceptedPlansFrom,
  acceptedIdsOf,
  subscriptionAccepted,
  pricingRowFor,
  removePlanFromPricing,
} from "../lib/acceptedPlans";
import { resolveSessionCoverage, shouldWarn, type CoverageSubscription } from "../lib/entitlements";
import { makeOption, type MembershipOption } from "../lib/membershipOptions";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const MSHS = "plan_mshs";
const FULL = makeOption({ id: "opt_full", label: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY" });
const TWO = makeOption({ id: "opt_2day", label: "Monthly 2 days (Tue/Thu)", price: 110, billingPeriod: "MONTHLY", entitlement: { kind: "DAYS", days: [2, 4] } });
const THREE = makeOption({ id: "opt_3mo", label: "3 Months", price: 160, billingPeriod: "MONTHLY", contractMonths: 3 });
const TWELVE = makeOption({ id: "opt_12mo", label: "12 months", price: 150, billingPeriod: "MONTHLY", contractMonths: 12 });
const OPTS: MembershipOption[] = [FULL, TWO, THREE, TWELVE];
const ALL_IDS = OPTS.map((o) => o.id!);

// ── parsing ──
console.log("parse");
eq("legacy row = every option", acceptedPlansFrom([{ type: "membership", membershipId: MSHS }]), [{ membershipId: MSHS, optionIds: null }]);
eq("empty optionIds = every option", acceptedPlansFrom([{ type: "membership", membershipId: MSHS, optionIds: [] }]), [{ membershipId: MSHS, optionIds: null }]);
eq("subset kept", acceptedPlansFrom([{ type: "membership", membershipId: MSHS, optionIds: ["opt_full", "opt_full", "opt_3mo"] }]), [{ membershipId: MSHS, optionIds: ["opt_full", "opt_3mo"] }]);
eq("price rows ignored", acceptedPlansFrom([{ type: "dropin", price: 25 }, { type: "member", price: 10 }]), []);
eq("junk ignored", acceptedPlansFrom([null, { type: "membership" }, { type: "membership", membershipId: 5 }, "x"]), []);
eq("not an array", acceptedPlansFrom(null), []);
eq("same plan twice, all wins", acceptedPlansFrom([{ type: "membership", membershipId: MSHS, optionIds: ["opt_full"] }, { type: "membership", membershipId: MSHS }]), [{ membershipId: MSHS, optionIds: null }]);
eq("same plan twice, subsets union", acceptedPlansFrom([{ type: "membership", membershipId: MSHS, optionIds: ["opt_full"] }, { type: "membership", membershipId: MSHS, optionIds: ["opt_3mo"] }]), [{ membershipId: MSHS, optionIds: ["opt_full", "opt_3mo"] }]);
eq("ids helper", acceptedIdsOf(acceptedPlansFrom([{ type: "membership", membershipId: "a" }, { type: "membership", membershipId: "b", optionIds: ["x"] }])), ["a", "b"]);

// ── acceptance ──
console.log("accept");
const onlyFull = acceptedPlansFrom([{ type: "membership", membershipId: MSHS, optionIds: ["opt_full", "opt_3mo", "opt_12mo"] }]);
const every = acceptedPlansFrom([{ type: "membership", membershipId: MSHS }]);
eq("whole plan accepts the 2-day option", subscriptionAccepted(every, { membershipId: MSHS, optionId: "opt_2day" }, OPTS), { accepted: true, how: "PLAN" });
eq("subset accepts full", subscriptionAccepted(onlyFull, { membershipId: MSHS, optionId: "opt_full" }, OPTS), { accepted: true, how: "OPTION" });
eq("subset refuses 2-day", subscriptionAccepted(onlyFull, { membershipId: MSHS, optionId: "opt_2day" }, OPTS), { accepted: false, why: "OPTION_NOT_ACCEPTED", optionLabel: "Monthly 2 days (Tue/Thu)" });
eq("inferred by period+price (Blake: no optionId, $160)", subscriptionAccepted(onlyFull, { membershipId: MSHS, optionId: null, billingPeriod: "MONTHLY", price: "160.00" }, OPTS), { accepted: true, how: "OPTION" });
eq("inferred refusal ($110 with no optionId)", subscriptionAccepted(onlyFull, { membershipId: MSHS, optionId: null, billingPeriod: "MONTHLY", price: 110 }, OPTS).accepted, false);
eq("unidentified option fails OPEN", subscriptionAccepted(onlyFull, { membershipId: MSHS, optionId: null, billingPeriod: "MONTHLY", price: 99 }, OPTS), { accepted: true, how: "UNIDENTIFIED" });
eq("deleted optionId fails OPEN", subscriptionAccepted(onlyFull, { membershipId: MSHS, optionId: "opt_gone" }, OPTS), { accepted: true, how: "UNIDENTIFIED" });
eq("other plan = not accepted", subscriptionAccepted(onlyFull, { membershipId: "plan_jr", optionId: "x" }, OPTS), { accepted: false, why: "PLAN_NOT_ACCEPTED", optionLabel: null });

// ── editor row ──
console.log("editor row");
eq("all chosen → plain row (future options included)", pricingRowFor(MSHS, ALL_IDS, ALL_IDS), { type: "membership", membershipId: MSHS });
eq("null → plain row", pricingRowFor(MSHS, null, ALL_IDS), { type: "membership", membershipId: MSHS });
eq("subset → optionIds", pricingRowFor(MSHS, ["opt_full", "opt_3mo"], ALL_IDS), { type: "membership", membershipId: MSHS, optionIds: ["opt_full", "opt_3mo"] });
eq("stale ids dropped", pricingRowFor(MSHS, ["opt_full", "opt_gone"], ALL_IDS), { type: "membership", membershipId: MSHS, optionIds: ["opt_full"] });

// ── removal (collapse Step 8) ──
console.log("remove plan");
const po = [{ type: "dropin", price: 25 }, { type: "membership", membershipId: MSHS }, { type: "membership", membershipId: "plan_commit" }];
eq("removes only that plan", removePlanFromPricing(po, "plan_commit"), { next: [{ type: "dropin", price: 25 }, { type: "membership", membershipId: MSHS }], removed: 1 });
eq("absent plan → no-op", removePlanFromPricing(po, "nope").removed, 0);

// ── through the coverage resolver ──
console.log("coverage");
const sub = (over: Partial<CoverageSubscription>): CoverageSubscription => ({
  id: "s", membershipId: MSHS, status: "active", optionId: "opt_full", optionLabel: null, billingPeriod: "MONTHLY", price: 175, endDate: null,
  plan: { id: MSHS, name: "MS/HS", options: OPTS }, ...over,
});
const DROP = { amount: 25, source: "dropin" as const };
const run = (s: CoverageSubscription, plans: ReturnType<typeof acceptedPlansFrom> | undefined, weekday: number) =>
  resolveSessionCoverage({ subscriptions: [s], acceptedMembershipIds: [MSHS], acceptedPlans: plans, sessionWeekday: weekday, dropIn: DROP });

eq("full on Monday, subset class → COVERED", run(sub({}), onlyFull, 1).reason, "COVERED");
const v2 = run(sub({ optionId: "opt_2day", price: 110 }), onlyFull, 2);
eq("2-day on Tuesday, subset class → OPTION_NOT_ACCEPTED", v2.reason, "OPTION_NOT_ACCEPTED");
eq("… not covered", v2.covered, false);
eq("… warns", shouldWarn(v2), true);
eq("… names the option and drop-in", v2.message, "Monthly 2 days (Tue/Thu) (MS/HS) isn't included in this class. Drop-in $25.");
eq("2-day on Tuesday, whole-plan class → COVERED (unchanged)", run(sub({ optionId: "opt_2day", price: 110 }), every, 2).reason, "COVERED");
eq("2-day on Monday, whole-plan class → DAY_NOT_INCLUDED (unchanged)", run(sub({ optionId: "opt_2day", price: 110 }), every, 1).reason, "DAY_NOT_INCLUDED");
eq("no acceptedPlans passed → old behaviour", run(sub({ optionId: "opt_2day", price: 110 }), undefined, 2).reason, "COVERED");
eq("unidentified on subset class → OPTION_UNIDENTIFIED (open)", run(sub({ optionId: null, price: 99 }), onlyFull, 1).covered, true);
// Two subs, one accepted — any covering one wins.
const both = resolveSessionCoverage({
  subscriptions: [sub({ id: "a", optionId: "opt_2day", price: 110 }), sub({ id: "b", optionId: "opt_12mo", price: 150 })],
  acceptedMembershipIds: [MSHS], acceptedPlans: onlyFull, sessionWeekday: 2, dropIn: DROP,
});
eq("second sub on an accepted option covers", both.reason, "COVERED");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
