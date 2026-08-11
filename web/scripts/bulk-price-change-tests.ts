/**
 * Pure-function tests for the bulk price change preview model.
 * No DB, no Stripe, no network. Run with:
 *   npx tsx scripts/bulk-price-change-tests.ts
 * Exits non-zero on any failure.
 */
import {
  parseMembershipOptions,
  isUpfrontPeriod,
  periodStartFor,
  computeCredit,
  planPriceChange,
  type PricedSubscription,
} from "../lib/bulkPriceChange";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-08-11T12:00:00Z");

// ── Option parsing ──────────────────────────────────────────────────────────
console.log("\nparseMembershipOptions:");
const REAL_MSHS = '[{"label":"Monthly","price":190,"billingPeriod":"MONTHLY"},{"label":"Upfront","price":530,"billingPeriod":"QUARTERLY"},{"label":"1 Year","price":2000,"billingPeriod":"ANNUAL"}]';
check("parses the stored JSON *string* shape", parseMembershipOptions(REAL_MSHS).length === 3);
check("parses an already-parsed array too", parseMembershipOptions(JSON.parse(REAL_MSHS)).length === 3);
check("empty string → []", parseMembershipOptions("").length === 0);
check("malformed JSON → [] (never throws)", parseMembershipOptions("{oops").length === 0);
check("null → []", parseMembershipOptions(null).length === 0);
check("drops entries missing label/period/price", parseMembershipOptions('[{"label":"X"},{"label":"Y","price":1,"billingPeriod":"MONTHLY"}]').length === 1);
check("reads the right price", parseMembershipOptions(REAL_MSHS)[0].price === 190);

// ── Period classification ───────────────────────────────────────────────────
console.log("\nisUpfrontPeriod:");
check("MONTHLY is not upfront", isUpfrontPeriod("MONTHLY") === false);
check("WEEKLY is not upfront", isUpfrontPeriod("WEEKLY") === false);
check("QUARTERLY is upfront", isUpfrontPeriod("QUARTERLY") === true);
check("ANNUAL is upfront", isUpfrontPeriod("ANNUAL") === true);
check("null is not upfront", isUpfrontPeriod(null) === false);

console.log("\nperiodStartFor:");
check("QUARTERLY back 3 months", periodStartFor(new Date("2026-10-09T00:00:00Z"), "QUARTERLY").toISOString().slice(0, 10) === "2026-07-09");
check("ANNUAL back 1 year", periodStartFor(new Date("2027-01-15T00:00:00Z"), "ANNUAL").toISOString().slice(0, 10) === "2026-01-15");

// ── Credit math ─────────────────────────────────────────────────────────────
console.log("\ncomputeCredit:");
const base: PricedSubscription = {
  id: "s1", memberId: "m1", optionLabel: "Upfront", price: 530,
  billingPeriod: "QUARTERLY", billingType: "MANUAL", status: "active",
  stripeSubscriptionId: null, stripePriceId: null, stripeStatus: null,
  currentPeriodEnd: null, endDate: null, billingAnchorDate: null,
  startDate: null, effectiveStartDate: null, autoRenew: false,
  discountCode: null, discountAmount: null,
};

const monthly = computeCredit({ ...base, billingPeriod: "MONTHLY" }, 190, 175, NOW);
check("monthly → NOT_APPLICABLE", monthly.kind === "NOT_APPLICABLE" && monthly.amount === null);

const same = computeCredit(base, 530, 530, NOW);
check("no price change → NO_CHANGE", same.kind === "NO_CHANGE");

// THE production case: every offline upfront row has all three date fields
// null or already past. This must NOT fabricate a number.
const noDates = computeCredit(base, 530, 475, NOW);
check("no usable period end → UNKNOWN", noDates.kind === "UNKNOWN");
check("UNKNOWN carries a null amount, never 0", noDates.amount === null, noDates.amount);

const pastAnchor = computeCredit({ ...base, billingAnchorDate: new Date("2026-07-15T00:00:00Z") }, 530, 475, NOW);
check("anchor already in the past → UNKNOWN (not a negative credit)", pastAnchor.kind === "UNKNOWN");

// Half a quarter left: end 2026-09-25, start 2026-06-25 (92 days), 45 days left.
const halfLeft = computeCredit({ ...base, currentPeriodEnd: new Date("2026-09-25T12:00:00Z") }, 530, 430, NOW);
check("price drop → CREDIT_OWED", halfLeft.kind === "CREDIT_OWED");
check("basis names the field used", halfLeft.basis === "currentPeriodEnd", halfLeft.basis);
check("45 of 92 days remaining", halfLeft.daysRemaining === 45 && halfLeft.daysInPeriod === 92, [halfLeft.daysRemaining, halfLeft.daysInPeriod]);
check("credit = $100 × 45/92 = $48.91", halfLeft.amount === 48.91, halfLeft.amount);

const priceUp = computeCredit({ ...base, currentPeriodEnd: new Date("2026-09-25T12:00:00Z") }, 530, 630, NOW);
check("price rise on a paid period → ADDITIONAL_DUE", priceUp.kind === "ADDITIONAL_DUE");
check("additional due is positive, never a negative credit", (priceUp.amount ?? 0) > 0, priceUp.amount);

// Basis precedence.
const bothDates = computeCredit(
  { ...base, currentPeriodEnd: new Date("2026-09-25T12:00:00Z"), endDate: new Date("2026-12-01T00:00:00Z") },
  530, 430, NOW,
);
check("currentPeriodEnd outranks endDate", bothDates.basis === "currentPeriodEnd");
const endDateOnly = computeCredit({ ...base, endDate: new Date("2026-09-25T12:00:00Z") }, 530, 430, NOW);
check("falls back to endDate", endDateOnly.basis === "endDate");
const anchorOnly = computeCredit({ ...base, billingAnchorDate: new Date("2026-09-25T12:00:00Z") }, 530, 430, NOW);
check("falls back to billingAnchorDate", anchorOnly.basis === "billingAnchorDate");

// ── Plan assembly ───────────────────────────────────────────────────────────
console.log("\nplanPriceChange:");
const mk = (
  over: Partial<PricedSubscription> & { first: string },
): PricedSubscription & { member: { id: string; firstName: string | null; lastName: string | null } } => ({
  ...base,
  id: `sub-${over.first}`,
  memberId: `mem-${over.first}`,
  ...over,
  member: { id: `mem-${over.first}`, firstName: over.first, lastName: "Test" },
});

// Mirrors the real MS/HS monthly population: labels drift between "Monthly"
// and the plan name, prices include a $0 placeholder and a $5 override.
const plan = planPriceChange({
  membership: { id: "plan1", name: "MS/HS" },
  option: { label: "Monthly", price: 190, billingPeriod: "MONTHLY" },
  newPrice: 175,
  now: NOW,
  subs: [
    mk({ first: "Ann", optionLabel: "Monthly", price: 190, billingPeriod: "MONTHLY", billingType: "RECURRING", stripeSubscriptionId: "sub_A", stripeStatus: "active" }),
    mk({ first: "Ben", optionLabel: "MS/HS", price: 190, billingPeriod: "MONTHLY", billingType: "MANUAL" }),
    mk({ first: "Cal", optionLabel: "Monthly", price: 5, billingPeriod: "MONTHLY", billingType: "RECURRING", stripeSubscriptionId: "sub_C", stripeStatus: "active" }),
    mk({ first: "Dee", optionLabel: "MS/HS", price: 0, billingPeriod: "MONTHLY", billingType: "MANUAL" }),
  ],
});

check("finds every row on the plan+period, regardless of stored label", plan.summary.total === 4);
check("the plan-name-labelled row is included", plan.rows.some((r) => r.memberName.startsWith("Ben")));
check("label drift is reported, not hidden", plan.rows.find((r) => r.memberName.startsWith("Ben"))!.labelMatchesOption === false);
check("direction reads as a decrease", plan.direction === "decrease");
check("2 members are on the old sticker price", plan.summary.onListPriceCount === 2, plan.summary.onListPriceCount);
check("2 members carry an override", plan.summary.overrideCount === 2, plan.summary.overrideCount);
check("only the sticker-price rows are pre-selected", plan.summary.defaultSelectedCount === 2, plan.summary.defaultSelectedCount);
check("the $5 override is NOT pre-selected", plan.rows.find((r) => r.memberName.startsWith("Cal"))!.defaultSelected === false);
check("the $0 placeholder is NOT pre-selected", plan.rows.find((r) => r.memberName.startsWith("Dee"))!.defaultSelected === false);
check("overrides carry an explaining warning", plan.rows.find((r) => r.memberName.startsWith("Cal"))!.warnings.some((w) => w.includes("override")));
check("selected delta is 2 × -$15", plan.summary.defaultSelectedDelta === -30, plan.summary.defaultSelectedDelta);
check("stripe/offline split is right", plan.summary.stripeCount === 2 && plan.summary.offlineCount === 2);
check("monthly rows produce no credit", plan.summary.totalCreditOwed === 0 && plan.summary.totalAdditionalDue === 0);
check("channel is decided by stripeSubscriptionId", plan.rows.find((r) => r.memberName.startsWith("Ann"))!.channel === "stripe");
check("a MANUAL row with no stripe id is offline", plan.rows.find((r) => r.memberName.startsWith("Ben"))!.channel === "offline");

// Upfront rows: never pre-selected, sorted last.
const upfrontPlan = planPriceChange({
  membership: { id: "plan1", name: "MS/HS" },
  option: { label: "Upfront", price: 530, billingPeriod: "QUARTERLY" },
  newPrice: 430,
  now: NOW,
  subs: [
    mk({ first: "Eve", optionLabel: "Upfront", price: 530, billingPeriod: "QUARTERLY", currentPeriodEnd: new Date("2026-09-25T12:00:00Z") }),
    mk({ first: "Fay", optionLabel: "Jr Frogs", price: 530, billingPeriod: "QUARTERLY" }),
  ],
});
check("upfront rows are flagged upfront", upfrontPlan.rows.every((r) => r.upfront));
check("upfront rows are NEVER pre-selected even on the sticker price", upfrontPlan.summary.defaultSelectedCount === 0);
check("credit totals only sum computable rows", upfrontPlan.summary.totalCreditOwed === 48.91, upfrontPlan.summary.totalCreditOwed);
check("uncomputable rows are counted, not silently zeroed", upfrontPlan.summary.unknownCreditCount === 1);
check("a note calls out the uncomputable rows", upfrontPlan.notes.some((n) => n.includes("no stored period end")));
check("notes always state nothing was written", upfrontPlan.notes.some((n) => n.includes("Nothing has been written")));

// Sorting: recurring before upfront, stripe before offline.
const sorted = planPriceChange({
  membership: { id: "p", name: "P" },
  option: { label: "Monthly", price: 100, billingPeriod: "MONTHLY" },
  newPrice: 90,
  now: NOW,
  subs: [
    mk({ first: "Zed", optionLabel: "Monthly", price: 100, billingPeriod: "QUARTERLY" }),
    mk({ first: "Yan", optionLabel: "Monthly", price: 100, billingPeriod: "MONTHLY" }),
    mk({ first: "Xav", optionLabel: "Monthly", price: 100, billingPeriod: "MONTHLY", stripeSubscriptionId: "sub_X" }),
  ],
});
check("stripe recurring sorts first", sorted.rows[0].memberName.startsWith("Xav"), sorted.rows.map((r) => r.memberName));
check("upfront sorts last", sorted.rows[sorted.rows.length - 1].memberName.startsWith("Zed"));

// An empty book of business is a legitimate answer, not an error.
const empty = planPriceChange({
  membership: { id: "p", name: "P" },
  option: { label: "Monthly", price: 100, billingPeriod: "MONTHLY" },
  newPrice: 90, now: NOW, subs: [],
});
check("no subscribers → total 0, no throw", empty.summary.total === 0);
check("no subscribers → zero credit totals", empty.summary.totalCreditOwed === 0 && empty.summary.defaultSelectedDelta === 0);

// A member already at the new price is surfaced, not silently included.
const noop = planPriceChange({
  membership: { id: "p", name: "P" },
  option: { label: "Monthly", price: 100, billingPeriod: "MONTHLY" },
  newPrice: 100, now: NOW,
  subs: [mk({ first: "Ida", optionLabel: "Monthly", price: 100, billingPeriod: "MONTHLY" })],
});
check("price unchanged → direction none", noop.direction === "none");
check("price unchanged → nothing pre-selected", noop.summary.defaultSelectedCount === 0);
check("price unchanged → row says so", noop.rows[0].warnings.some((w) => w.includes("Already at the new price")));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
