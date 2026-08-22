/**
 * Pure-function tests for the bulk price change preview model.
 * No DB, no Stripe, no network. Run with:
 *   npx tsx scripts/bulk-price-change-tests.ts
 * Exits non-zero on any failure.
 */
import { makeOption } from "../lib/membershipOptions";
import {
  parseMembershipOptions,
  isUpfrontPeriod,
  periodStartFor,
  computeCredit,
  planPriceChange,
  validateNotice,
  resolveOption,
  directionForRows,
  stripeUnitAmountCents,
  buildPriceChangeEmail,
  isFailureOutcome,
  isMoveFailure,
  type PricedSubscription,
} from "../lib/bulkPriceChange";
import { addBillingPeriod } from "../lib/billingAdmin";
import { resolveCoverage, describeCoverage, MAX_PERIODS_PER_PAYMENT } from "../lib/paidThrough";
import {
  LIFECYCLE_EVENT_KINDS,
  SUBSCRIPTION_EVENT_KIND,
} from "../lib/subscriptionEvents";

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
const S = (from: string, period: string) => periodStartFor(new Date(from), period).toISOString().slice(0, 10);
check("QUARTERLY back 3 months", S("2026-10-09T00:00:00Z", "QUARTERLY") === "2026-07-09");
check("ANNUAL back 1 year", S("2027-01-15T00:00:00Z", "ANNUAL") === "2026-01-15");

// periodStartFor carried the same local-time `setMonth` bug as its forward
// twin, and it produces the days-in-period DENOMINATOR of the unused-time
// credit — so a day of drift here moves the refund figure an owner is shown
// mid-bulk-price-change. Pinned in both directions.
check("QUARTERLY back across the November DST change holds the day",
  S("2026-12-01T00:00:00Z", "QUARTERLY") === "2026-09-01", S("2026-12-01T00:00:00Z", "QUARTERLY"));
check("…and keeps 00:00Z exactly — no stray DST hour",
  periodStartFor(new Date("2026-12-01T00:00:00Z"), "QUARTERLY").toISOString() === "2026-09-01T00:00:00.000Z",
  periodStartFor(new Date("2026-12-01T00:00:00Z"), "QUARTERLY").toISOString());
check("MONTHLY back from Mar 31 clamps to Feb 28, not Mar 3",
  S("2026-03-31T00:00:00Z", "MONTHLY") === "2026-02-28", S("2026-03-31T00:00:00Z", "MONTHLY"));
check("MONTHLY back from Oct 31 is Sep 30",
  S("2026-10-31T00:00:00Z", "MONTHLY") === "2026-09-30", S("2026-10-31T00:00:00Z", "MONTHLY"));
check("ANNUAL back from Feb 29 is Feb 28 the year before",
  S("2028-02-29T00:00:00Z", "ANNUAL") === "2027-02-28", S("2028-02-29T00:00:00Z", "ANNUAL"));
check("WEEKLY back 7 days across DST", S("2026-11-05T00:00:00Z", "WEEKLY") === "2026-10-29", S("2026-11-05T00:00:00Z", "WEEKLY"));

// The two are inverses on any date that is not a clamped month end.
for (const [end, period] of [["2026-12-01", "QUARTERLY"], ["2026-10-15", "MONTHLY"], ["2027-09-01", "ANNUAL"]] as const) {
  const roundTrip = addBillingPeriod(periodStartFor(new Date(`${end}T00:00:00Z`), period), period);
  check(`${period} round-trips back to ${end}`, roundTrip.toISOString().slice(0, 10) === end, roundTrip.toISOString());
}

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
  option: makeOption({ label: "Monthly", price: 190, billingPeriod: "MONTHLY" }),
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
  option: makeOption({ label: "Upfront", price: 530, billingPeriod: "QUARTERLY" }),
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
//
// Zed carries a QUARTERLY period on a MONTHLY option — Colton Waite's real
// shape, a quarterly lump sitting on a row labelled monthly. He is attributed
// by his stored optionId, which is the only thing that can place him: period
// attribution would refuse, and correctly so.
const SORT_OPT = makeOption({ id: "opt_m", label: "Monthly", price: 100, billingPeriod: "MONTHLY" });
const sorted = planPriceChange({
  membership: { id: "p", name: "P" },
  option: SORT_OPT,
  allOptions: [SORT_OPT],
  newPrice: 90,
  now: NOW,
  subs: [
    mk({ first: "Zed", optionId: "opt_m", optionLabel: "Monthly", price: 100, billingPeriod: "QUARTERLY" }),
    mk({ first: "Yan", optionLabel: "Monthly", price: 100, billingPeriod: "MONTHLY" }),
    mk({ first: "Xav", optionLabel: "Monthly", price: 100, billingPeriod: "MONTHLY", stripeSubscriptionId: "sub_X" }),
  ],
});
check("stripe recurring sorts first", sorted.rows[0].memberName.startsWith("Xav"), sorted.rows.map((r) => r.memberName));
check("upfront sorts last", sorted.rows[sorted.rows.length - 1].memberName.startsWith("Zed"));

// An empty book of business is a legitimate answer, not an error.
const empty = planPriceChange({
  membership: { id: "p", name: "P" },
  option: makeOption({ label: "Monthly", price: 100, billingPeriod: "MONTHLY" }),
  newPrice: 90, now: NOW, subs: [],
});
check("no subscribers → total 0, no throw", empty.summary.total === 0);
check("no subscribers → zero credit totals", empty.summary.totalCreditOwed === 0 && empty.summary.defaultSelectedDelta === 0);

// A member already at the new price is surfaced, not silently included.
const noop = planPriceChange({
  membership: { id: "p", name: "P" },
  option: makeOption({ label: "Monthly", price: 100, billingPeriod: "MONTHLY" }),
  newPrice: 100, now: NOW,
  subs: [mk({ first: "Ida", optionLabel: "Monthly", price: 100, billingPeriod: "MONTHLY" })],
});
check("price unchanged → direction none", noop.direction === "none");
check("price unchanged → nothing pre-selected", noop.summary.defaultSelectedCount === 0);
check("price unchanged → row says so", noop.rows[0].warnings.some((w) => w.includes("Already at the new price")));

// ── Churn contamination guard ───────────────────────────────────────────────
// The reason this test exists: if PRICE_CHANGE ever counts toward the
// subscription-history coverage test, a bulk repricing alone would flip the
// Reports Membership tab from ESTIMATED to COMPLETE for a club whose lifecycle
// log was never backfilled — an honest caveat replaced by a confident wrong
// answer. Keep it out.
console.log("\nLIFECYCLE_EVENT_KINDS (churn contamination guard):");
check("PRICE_CHANGE exists as a kind", SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE === "PRICE_CHANGE");
check(
  "PRICE_CHANGE is NOT a lifecycle kind",
  !LIFECYCLE_EVENT_KINDS.includes(SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE),
);
check("CREATED still counts as lifecycle", LIFECYCLE_EVENT_KINDS.includes(SUBSCRIPTION_EVENT_KIND.CREATED));
check("CANCELED still counts as lifecycle", LIFECYCLE_EVENT_KINDS.includes(SUBSCRIPTION_EVENT_KIND.CANCELED));
check("EXPIRED still counts as lifecycle", LIFECYCLE_EVENT_KINDS.includes(SUBSCRIPTION_EVENT_KIND.EXPIRED));
check("PLAN_CHANGED still counts as lifecycle", LIFECYCLE_EVENT_KINDS.includes(SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED));
check("the 8 lifecycle kinds are all there", LIFECYCLE_EVENT_KINDS.length === 8, LIFECYCLE_EVENT_KINDS.length);

// ── Advance-notice gate ─────────────────────────────────────────────────────
console.log("\nvalidateNotice:");
const FUTURE = new Date("2026-09-01T00:00:00Z");
const PAST = new Date("2026-07-01T00:00:00Z");
check("decrease needs no notice", validateNotice({ direction: "decrease", notifyBeforeDate: null, now: NOW }).ok === true);
check("no-change needs no notice", validateNotice({ direction: "none", notifyBeforeDate: null, now: NOW }).ok === true);
const noDate = validateNotice({ direction: "increase", notifyBeforeDate: null, now: NOW });
check("increase without a date is refused", noDate.ok === false);
check("…with a NOTICE_REQUIRED code", noDate.ok === false && noDate.code === "NOTICE_REQUIRED");
const pastDate = validateNotice({ direction: "increase", notifyBeforeDate: PAST, now: NOW });
check("increase with a past date is refused", pastDate.ok === false);
check("…with a NOTICE_IN_PAST code", pastDate.ok === false && pastDate.code === "NOTICE_IN_PAST");
check("increase with a future date is allowed", validateNotice({ direction: "increase", notifyBeforeDate: FUTURE, now: NOW }).ok === true);
check("an unreadable date is refused, not treated as absent",
  validateNotice({ direction: "increase", notifyBeforeDate: new Date("nonsense"), now: NOW }).ok === false);

// ── Fee passthrough on the Stripe amount ────────────────────────────────────
// Frog Empire has passProcessingFees=true. A bare price*100 here would strip
// the 2.9% off every repriced subscription and quietly cut the club's take.
console.log("\nstripeUnitAmountCents:");
check("no passthrough → the bare amount", stripeUnitAmountCents(190, false) === 19000, stripeUnitAmountCents(190, false));
check("passthrough adds the fee", stripeUnitAmountCents(190, true) > 19000, stripeUnitAmountCents(190, true));
check("$190 with passthrough = 19551 cents", stripeUnitAmountCents(190, true) === 19551, stripeUnitAmountCents(190, true));
check("$175 with passthrough = 18008 cents", stripeUnitAmountCents(175, true) === 18008, stripeUnitAmountCents(175, true));
check("$0 stays $0 either way", stripeUnitAmountCents(0, true) === 0 && stripeUnitAmountCents(0, false) === 0);
check("rounds to whole cents", Number.isInteger(stripeUnitAmountCents(190.005, true)));

// ── Outcome classification ──────────────────────────────────────────────────
console.log("\nisFailureOutcome:");
check("UPDATED is not a failure", isFailureOutcome("UPDATED") === false);
check("SKIPPED_ALREADY_AT_PRICE is not a failure", isFailureOutcome("SKIPPED_ALREADY_AT_PRICE") === false);
check("SKIPPED_NOT_FOUND is not a failure", isFailureOutcome("SKIPPED_NOT_FOUND") === false);
check("FAILED_STRIPE is a failure", isFailureOutcome("FAILED_STRIPE") === true);
check("FAILED_STRIPE_UNVERIFIED is a failure", isFailureOutcome("FAILED_STRIPE_UNVERIFIED") === true);
check("FAILED_DB_ROLLED_BACK is a failure", isFailureOutcome("FAILED_DB_ROLLED_BACK") === true);
check("FAILED_DB_ROLLBACK_FAILED is a failure", isFailureOutcome("FAILED_DB_ROLLBACK_FAILED") === true);

// ── The member notification ─────────────────────────────────────────────────
console.log("\nbuildPriceChangeEmail:");
const flat = (bs: unknown[]): string => JSON.stringify(bs);

const decreaseMail = buildPriceChangeEmail({
  clubName: "Frog Empire", memberName: "Ann", planName: "MS/HS", optionLabel: "Monthly",
  billingPeriod: "MONTHLY", fromPrice: 190, toPrice: 175, passProcessingFees: true,
  effectiveDate: FUTURE, channel: "stripe",
  credit: { kind: "NOT_APPLICABLE", amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note: "" },
});
check("a decrease reads as good news", decreaseMail.subject.includes("going down"));
check("shows the old price", flat(decreaseMail.blocks).includes("$190.00"));
check("shows the new price", flat(decreaseMail.blocks).includes("$175.00"));
check("states the effective date", flat(decreaseMail.blocks).includes("September 1, 2026"));
check("fee passthrough is spelled out so $175 vs $180.08 isn't read as a bug",
  flat(decreaseMail.blocks).includes("$180.08"));
check("stripe members are told nothing is needed from them",
  flat(decreaseMail.blocks).includes("Nothing is needed from you"));
check("stripe members are told they were NOT charged or refunded today",
  flat(decreaseMail.blocks).includes("not been charged or refunded"));

const increaseMail = buildPriceChangeEmail({
  clubName: "Frog Empire", memberName: "Ben", planName: "MS/HS", optionLabel: "Monthly",
  billingPeriod: "MONTHLY", fromPrice: 190, toPrice: 210, passProcessingFees: false,
  effectiveDate: FUTURE, channel: "offline",
  credit: { kind: "NOT_APPLICABLE", amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note: "" },
});
check("an increase does not claim to be good news", !increaseMail.subject.includes("going down"));
check("no fee line when the club absorbs fees", !flat(increaseMail.blocks).includes("card processing"));
check("offline members are told nothing was charged or refunded",
  flat(increaseMail.blocks).includes("nothing has been charged or refunded"));

const creditMail = buildPriceChangeEmail({
  clubName: "Frog Empire", memberName: "Eve", planName: "MS/HS", optionLabel: "Upfront",
  billingPeriod: "QUARTERLY", fromPrice: 530, toPrice: 430, passProcessingFees: false,
  effectiveDate: null, channel: "offline",
  credit: { kind: "CREDIT_OWED", amount: 48.91, basis: "currentPeriodEnd", periodEnd: "2026-09-25T12:00:00.000Z", daysRemaining: 45, daysInPeriod: 92, note: "" },
});
check("a computed credit is stated to the member", flat(creditMail.blocks).includes("$48.91"));
check("…and framed as us owing them", flat(creditMail.blocks).includes("we owe you"));
check("no effective date → next billing cycle", flat(creditMail.blocks).includes("next billing cycle"));

const unknownCreditMail = buildPriceChangeEmail({
  clubName: "Frog Empire", memberName: "Fay", planName: "Jr Frogs", optionLabel: "1 Year",
  billingPeriod: "ANNUAL", fromPrice: 750, toPrice: 700, passProcessingFees: false,
  effectiveDate: null, channel: "offline",
  credit: { kind: "UNKNOWN", amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note: "" },
});
check("an uncomputable credit promises the member NOTHING",
  !flat(unknownCreditMail.blocks).includes("we owe you"));

// ── Option resolution: renames, and the ambiguity we refuse to guess through ──
console.log("\nresolveOption:");
const RENAMED = parseMembershipOptions(
  '[{"label":"Monthly","price":175,"billingPeriod":"MONTHLY"},{"label":"3 month Upfront","price":450,"billingPeriod":"QUARTERLY"},{"label":"1 Year Upfront","price":1500,"billingPeriod":"ANNUAL"}]',
);
const okQuarterly = resolveOption(RENAMED, "3 month Upfront", "QUARTERLY");
check("resolves a renamed option by its CURRENT label", okQuarterly.ok === true);
check("…and carries the new price", okQuarterly.ok && okQuarterly.option.price === 450);
check("an old label no longer on the plan is NOT_FOUND",
  resolveOption(RENAMED, "Upfront", "QUARTERLY").ok === false);
const notFound = resolveOption(RENAMED, "Upfront", "QUARTERLY");
check("NOT_FOUND returns the real options so the UI can say what exists",
  !notFound.ok && notFound.code === "NOT_FOUND" && notFound.candidates.length === 3);
check("period alone still identifies the option after a rename",
  RENAMED.filter((o) => o.billingPeriod === "QUARTERLY").length === 1);

const DUPE = parseMembershipOptions(
  '[{"label":"Monthly","price":190,"billingPeriod":"MONTHLY"},{"label":"Monthly (sibling)","price":150,"billingPeriod":"MONTHLY"}]',
);
const ambiguous = resolveOption(DUPE, "Monthly", "MONTHLY");
check("two options on one period is AMBIGUOUS_PERIOD, not a guess",
  !ambiguous.ok && ambiguous.code === "AMBIGUOUS_PERIOD");
check("…and hands back both candidates to choose between",
  !ambiguous.ok && ambiguous.candidates.length === 2);

// ── Advance notice keys off the ROWS, not the plan's list price ─────────────
console.log("\ndirectionForRows:");
check("all going down → decrease",
  directionForRows([{ currentPrice: 190, newPrice: 175 }]) === "decrease");
check("all unchanged → none",
  directionForRows([{ currentPrice: 175, newPrice: 175 }]) === "none");
check("a single riser makes the whole run an increase",
  directionForRows([{ currentPrice: 190, newPrice: 175 }, { currentPrice: 0, newPrice: 175 }]) === "increase");
check("empty set → none", directionForRows([]) === "none");
check("THE GAP THIS CLOSES: a $0 comp moved onto the plan price needs notice",
  directionForRows([{ currentPrice: 0, newPrice: 175 }]) === "increase");

// ── "current" mode — the persistent entry point ─────────────────────────────
console.log("\nplanPriceChange (current mode):");
const currentPlan = planPriceChange({
  membership: { id: "plan1", name: "MS/HS" },
  option: makeOption({ label: "Monthly", price: 175, billingPeriod: "MONTHLY" }),
  newPrice: null,
  now: NOW,
  subs: [
    mk({ first: "Ann", optionLabel: "Monthly", price: 190, billingPeriod: "MONTHLY" }),
    mk({ first: "Ben", optionLabel: "MS/HS", price: 190, billingPeriod: "MONTHLY" }),
    mk({ first: "Cal", optionLabel: "Monthly", price: 175, billingPeriod: "MONTHLY" }),
    mk({ first: "Dee", optionLabel: "MS/HS", price: 0, billingPeriod: "MONTHLY" }),
  ],
});
check("mode is reported as current", currentPlan.mode === "current");
check("target IS the plan's saved price", currentPlan.option.newPrice === 175);
check("old and new are the same figure in this mode", currentPlan.option.oldPrice === 175);
check("plan-level direction is none — the list price is not moving", currentPlan.direction === "none");
check("NOBODY is pre-selected in current mode", currentPlan.summary.defaultSelectedCount === 0);
check("everyone on the plan is still listed", currentPlan.summary.total === 4);
check("the member already at the price shows no delta",
  currentPlan.rows.find((r) => r.memberName.startsWith("Cal"))!.delta === 0);
check("the stranded members show the delta that would apply",
  currentPlan.rows.find((r) => r.memberName.startsWith("Ann"))!.delta === -15);
check("the $0 comp shows as an increase for that family",
  currentPlan.rows.find((r) => r.memberName.startsWith("Dee"))!.delta === 175);
check("a note explains why nothing is pre-selected",
  currentPlan.notes.some((n) => n.includes("Nobody is pre-selected")));
check("renaming is called out as irrelevant to matching",
  currentPlan.notes.some((n) => n.includes("renaming an option never changes")));
check("selected-row direction over the stranded set is an increase (the comp)",
  directionForRows(currentPlan.rows.map((r) => ({ currentPrice: r.currentPrice, newPrice: r.newPrice }))) === "increase");

// Proposed mode is unchanged by any of this.
console.log("\nplanPriceChange (proposed mode still pre-selects):");
const proposed = planPriceChange({
  membership: { id: "plan1", name: "MS/HS" },
  option: makeOption({ label: "Monthly", price: 190, billingPeriod: "MONTHLY" }),
  newPrice: 175,
  now: NOW,
  subs: [
    mk({ first: "Ann", optionLabel: "Monthly", price: 190, billingPeriod: "MONTHLY" }),
    mk({ first: "Cal", optionLabel: "Monthly", price: 5, billingPeriod: "MONTHLY" }),
  ],
});
check("mode is proposed", proposed.mode === "proposed");
check("sticker-price members are still pre-selected", proposed.summary.defaultSelectedCount === 1);
check("overrides still are not", proposed.rows.find((r) => r.memberName.startsWith("Cal"))!.defaultSelected === false);

// ── Memo in the notification ────────────────────────────────────────────────
console.log("\nbuildPriceChangeEmail (memo):");
const memoMail = buildPriceChangeEmail({
  clubName: "Frog Empire", memberName: "Colton", planName: "MS/HS", optionLabel: "Monthly",
  billingPeriod: "MONTHLY", fromPrice: 190, toPrice: 175, passProcessingFees: false,
  effectiveDate: null, channel: "offline",
  credit: { kind: "NOT_APPLICABLE", amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note: "" },
  memo: "We've lowered the fall rate for everyone in the MS/HS group.",
});
check("the memo reaches the email body", flat(memoMail.blocks).includes("lowered the fall rate"));
check("memo sits ABOVE the price lines", flat(memoMail.blocks).indexOf("lowered the fall rate") < flat(memoMail.blocks).indexOf("You pay today"));
const noMemoMail = buildPriceChangeEmail({
  clubName: "Frog Empire", memberName: "Colton", planName: "MS/HS", optionLabel: "Monthly",
  billingPeriod: "MONTHLY", fromPrice: 190, toPrice: 175, passProcessingFees: false,
  effectiveDate: null, channel: "offline",
  credit: { kind: "NOT_APPLICABLE", amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note: "" },
});
check("no memo → no stray empty paragraph", noMemoMail.blocks.length === memoMail.blocks.length - 1);
const blankMemo = buildPriceChangeEmail({
  clubName: "F", memberName: "C", planName: "P", optionLabel: "Monthly",
  billingPeriod: "MONTHLY", fromPrice: 190, toPrice: 175, passProcessingFees: false,
  effectiveDate: null, channel: "offline",
  credit: { kind: "NOT_APPLICABLE", amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note: "" },
  memo: "   ",
});
check("whitespace-only memo is dropped", blankMemo.blocks.length === noMemoMail.blocks.length);
check("offline members still get a full notice with the new price",
  flat(memoMail.blocks).includes("$175.00") && flat(memoMail.blocks).includes("nothing has been charged or refunded"));

// ── Moving a subscription: who is allowed ───────────────────────────────────
console.log("\ncanChangeOption:");
const movePlan = planPriceChange({
  membership: { id: "plan1", name: "MS/HS" },
  option: makeOption({ label: "Monthly", price: 190, billingPeriod: "MONTHLY" }),
  newPrice: 175, now: NOW,
  subs: [
    mk({ first: "Cash", optionLabel: "MS/HS", price: 530, billingPeriod: "MONTHLY", billingType: "MANUAL" }),
    mk({ first: "Card", optionLabel: "Monthly", price: 190, billingPeriod: "MONTHLY", stripeSubscriptionId: "sub_X", stripeStatus: "active" }),
  ],
});
const cashRow = movePlan.rows.find((r) => r.memberName.startsWith("Cash"))!;
const cardRow = movePlan.rows.find((r) => r.memberName.startsWith("Card"))!;
check("offline rows can be moved", cashRow.canChangeOption === true);
check("offline rows carry no block reason", cashRow.changeBlockedReason === null);
check("Stripe rows cannot be moved", cardRow.canChangeOption === false);
check("…and say why, naming the re-anchor risk",
  (cardRow.changeBlockedReason ?? "").includes("re-anchor"));
check("…and point at the billing centre",
  (cardRow.changeBlockedReason ?? "").includes("billing centre"));
check("REFUSED_STRIPE is a move failure", isMoveFailure("REFUSED_STRIPE") === true);
check("MOVED is not", isMoveFailure("MOVED") === false);
check("SKIPPED_NOT_FOUND is not a failure", isMoveFailure("SKIPPED_NOT_FOUND") === false);
// Colton's exact shape: a quarterly price sitting on a monthly row.
check("a $530 monthly row is flagged as off the plan price",
  cashRow.warnings.some((w) => w.includes("$530.00")));

// ── paidThroughDate coverage ────────────────────────────────────────────────
console.log("\nresolveCoverage:");
const NOWC = new Date("2026-08-13T12:00:00Z");
const d = (c: { start: Date; end: Date; firstPeriodEnd: Date }) =>
  [c.start.toISOString().slice(0, 10), c.firstPeriodEnd.toISOString().slice(0, 10), c.end.toISOString().slice(0, 10)];

const single = resolveCoverage({
  paidThroughDate: null, currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  startDate: null, billingPeriod: "QUARTERLY", periods: 1, now: NOWC,
});
check("one quarter continues from the current period end", d(single)[0] === "2026-09-01");
check("…and ends one quarter later", d(single)[2] === "2026-12-01");
check("firstPeriodEnd equals end for a single period", d(single)[1] === d(single)[2]);
check("basis names the field used", single.basis === "currentPeriodEnd");

// THE case Julian named: two quarters handed over at once.
const twoQuarters = resolveCoverage({
  paidThroughDate: null, currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  startDate: null, billingPeriod: "QUARTERLY", periods: 2, now: NOWC,
});
check("two quarters reach six months out", d(twoQuarters)[2] === "2027-03-01");
check("but the CURRENT period still ends in three",
  d(twoQuarters)[1] === "2026-12-01");
check("firstPeriodEnd < end when prepaying", twoQuarters.firstPeriodEnd < twoQuarters.end);

// Two single payments must land where one double payment lands.
const first = resolveCoverage({
  paidThroughDate: null, currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  startDate: null, billingPeriod: "QUARTERLY", periods: 1, now: NOWC,
});
const second = resolveCoverage({
  paidThroughDate: first.end, currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  startDate: null, billingPeriod: "QUARTERLY", periods: 1, now: NOWC,
});
check("two single payments == one double payment", second.end.getTime() === twoQuarters.end.getTime());

// A lapsed member buys forward from today, not retroactively.
const lapsed = resolveCoverage({
  paidThroughDate: new Date("2026-05-01T00:00:00Z"), currentPeriodEnd: null,
  startDate: null, billingPeriod: "MONTHLY", periods: 1, now: NOWC,
});
check("coverage never starts in the past", lapsed.start.getTime() === NOWC.getTime());
check("…and says the anchor was assumed", lapsed.anchorAssumed === true);
check("a lapse is not silently backdated", lapsed.end.toISOString().slice(0, 10) === "2026-09-13");

const nothing = resolveCoverage({
  paidThroughDate: null, currentPeriodEnd: null, startDate: null,
  billingPeriod: "MONTHLY", periods: 1, now: NOWC,
});
check("no anchor at all falls back to now, flagged", nothing.basis === "now" && nothing.anchorAssumed === true);
check("periods are clamped to a sane maximum",
  resolveCoverage({ paidThroughDate: null, currentPeriodEnd: null, startDate: null, billingPeriod: "MONTHLY", periods: 999, now: NOWC }).periods === MAX_PERIODS_PER_PAYMENT);
check("zero or negative periods become one",
  resolveCoverage({ paidThroughDate: null, currentPeriodEnd: null, startDate: null, billingPeriod: "MONTHLY", periods: 0, now: NOWC }).periods === 1);

console.log("\ndescribeCoverage:");
check("a single quarter reads naturally", describeCoverage(single, "QUARTERLY").includes("1 quarter — paid through December 1, 2026"));
check("two quarters STATE the count, not just the date",
  describeCoverage(twoQuarters, "QUARTERLY").includes("2 quarters"));
check("an assumed anchor is disclosed", describeCoverage(lapsed, "MONTHLY").includes("nothing was on record"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
