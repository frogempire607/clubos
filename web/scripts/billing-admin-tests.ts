/**
 * Targeted tests for the billing control center's critical server-side rules.
 * Pure-function tests only — no DB, no Stripe, no network. Run with:
 *   npx tsx scripts/billing-admin-tests.ts
 * Exits non-zero on any failure.
 */
import {
  deriveReadiness,
  deriveBillingMode,
  deriveBillingState,
  chargeTiming,
  resolveOfferPricing,
  canRemovePaymentMethod,
  pmRef,
  prettyPeriod,
} from "../lib/billingAdmin";
import { diffOffer, type ReactivationOffer } from "../lib/reactivation";
import { baseUrlFromRequest, getAppBaseUrl } from "../lib/baseUrl";
import { PERMISSION_CATALOG, DEFAULT_PERMISSIONS, resolvePermissions, hasPermission } from "../lib/permissions";
import { parseOffer } from "../lib/reactivation";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-07-10T12:00:00Z");
const FUTURE = new Date("2026-07-19T12:00:00Z");
const PAST = new Date("2026-07-01T12:00:00Z");

// ── Readiness derivation ────────────────────────────────────────────────────
console.log("\nderiveReadiness:");
const base = {
  price: 110 as number | null,
  hasPlan: true,
  hasCapturedCard: true,
  offlineIntended: false,
  finalBillingDate: FUTURE as Date | null,
  hasLiveStripeSub: false,
  now: NOW,
};
check("ready when plan+card+future date", deriveReadiness(base).state === "READY");
check("live Stripe sub always leave-alone (Michael L.)",
  deriveReadiness({ ...base, hasLiveStripeSub: true }).state === "LEAVE_ALONE");
check("owner LEAVE_ALONE wins", deriveReadiness({ ...base, migrationGroup: "LEAVE_ALONE" }).state === "LEAVE_ALONE");
check("group C is hold (Titus H.)", deriveReadiness({ ...base, migrationGroup: "C" }).state === "HOLD");
check("future follow-up holds (John D.)", deriveReadiness({ ...base, migrationGroup: "FUTURE_FOLLOW_UP" }).state === "HOLD");
check("free membership ready with no card (Harrison B.)",
  deriveReadiness({ ...base, price: 0, hasCapturedCard: false }).state === "READY");
check("final period paid ready with no card",
  deriveReadiness({ ...base, price: null, hasPlan: false, hasCapturedCard: false, finalPeriodPaid: true }).state === "READY");
check("no plan → waiting on owner (Jackson D.)",
  deriveReadiness({ ...base, price: null, hasPlan: false }).state === "WAITING_OWNER");
check("past date → waiting on owner, must re-date (Mack M.)",
  deriveReadiness({ ...base, finalBillingDate: PAST }).state === "WAITING_OWNER");
check("past-date reason names the past date",
  deriveReadiness({ ...base, finalBillingDate: PAST }).reasons.some((r) => r.includes("past")));
check("no date → waiting on owner",
  deriveReadiness({ ...base, finalBillingDate: null }).state === "WAITING_OWNER");
check("no card → waiting on client (Maximus A.)",
  deriveReadiness({ ...base, hasCapturedCard: false }).state === "WAITING_CLIENT");
check("offline cash member doesn't need a card",
  deriveReadiness({ ...base, hasCapturedCard: false, offlineIntended: true }).state === "READY");
check("sent reactivation → waiting on client",
  deriveReadiness({ ...base, reactivationStatus: "SENT" }).state === "WAITING_CLIENT");
check("completed migration → leave alone",
  deriveReadiness({ ...base, migrationStatus: "COMPLETED" }).state === "LEAVE_ALONE");

check("SENT offer outranks completed migration (John Doe demo case)",
  deriveReadiness({ ...base, migrationStatus: "COMPLETED", reactivationStatus: "SENT" }).state === "WAITING_CLIENT");
check("DRAFT offer waits on owner to send",
  deriveReadiness({ ...base, migrationStatus: "COMPLETED", reactivationStatus: "DRAFT" }).state === "WAITING_OWNER");

// ── Authoritative billing state ────────────────────────────────────────────
console.log("\nderiveBillingState:");
const freeSub = { billingType: "MANUAL", status: "active", stripeStatus: null, price: 0, hasStripe: false };
check("live Stripe sub → ACTIVE_STRIPE",
  deriveBillingState({ sub: { billingType: "RECURRING", status: "active", stripeStatus: "active", price: 110, hasStripe: true }, configuredPrice: 110 }) === "ACTIVE_STRIPE");
check("trialing Stripe sub → SCHEDULED (first charge on a future date)",
  deriveBillingState({ sub: { billingType: "RECURRING", status: "active", stripeStatus: "trialing", price: 110, hasStripe: true }, configuredPrice: 110 }) === "SCHEDULED");
check("SENT offer beats free sub + completed migration (never 'Free' + 'leave alone' while an offer is out)",
  deriveBillingState({ sub: freeSub, configuredPrice: 5, migrationStatus: "COMPLETED", approvalStatus: "APPROVED", openOfferStatus: "SENT" }) === "OFFER_SENT");
check("DRAFT offer → OFFER_DRAFT",
  deriveBillingState({ sub: freeSub, configuredPrice: 5, migrationStatus: "COMPLETED", openOfferStatus: "DRAFT" }) === "OFFER_DRAFT");
check("pending approval → PENDING_APPROVAL",
  deriveBillingState({ sub: null, configuredPrice: 110, approvalStatus: "PENDING_APPROVAL" }) === "PENDING_APPROVAL");
check("paid override over a free sub with no offer → DRAFT_CONFIG, never FREE",
  deriveBillingState({ sub: freeSub, configuredPrice: 5, migrationStatus: "COMPLETED" }) === "DRAFT_CONFIG");
check("genuinely $0 stays FREE",
  deriveBillingState({ sub: freeSub, configuredPrice: 0, migrationStatus: "COMPLETED" }) === "FREE");
check("paid manual sub → MANUAL_OFFLINE",
  deriveBillingState({ sub: { billingType: "MANUAL", status: "active", stripeStatus: null, price: 190, hasStripe: false }, configuredPrice: 190 }) === "MANUAL_OFFLINE");
check("completed with nothing open → LEAVE_ALONE",
  deriveBillingState({ sub: null, configuredPrice: null, migrationStatus: "COMPLETED" }) === "LEAVE_ALONE");
check("imported, unconfigured → INCOMPLETE",
  deriveBillingState({ sub: null, configuredPrice: null, migrationStatus: "IMPORTED" }) === "INCOMPLETE");

// ── Offer immutability / staleness diff ────────────────────────────────────
console.log("\ndiffOffer:");
const offerA: ReactivationOffer = {
  membershipId: "m1", planName: "Jr Frogs", optionLabel: "Monthly", price: 110, billingPeriod: "MONTHLY",
  startDate: "2026-03-11T00:00:00.000Z", firstChargeDate: "2026-07-19T00:00:00.000Z",
  commitmentEndDate: null, paymentMode: "CARD", payerUserId: null,
};
check("identical offers match", diffOffer(offerA, { ...offerA }).length === 0);
check("price edit marks it out of date", diffOffer(offerA, { ...offerA, price: 120 }).join() === "price");
check("date edit marks it out of date (day-level)",
  diffOffer(offerA, { ...offerA, firstChargeDate: "2026-07-20T00:00:00.000Z" }).join() === "first billing date");
check("time-of-day within the same date does NOT invalidate",
  diffOffer(offerA, { ...offerA, firstChargeDate: "2026-07-19T18:30:00.000Z" }).length === 0);
check("plan + frequency changes are both reported",
  diffOffer(offerA, { ...offerA, planName: "MS/HS", billingPeriod: "QUARTERLY" }).length === 2);
check("payer change is reported", diffOffer(offerA, { ...offerA, payerUserId: "u1" }).join() === "responsible payer");
check("start date alone never invalidates (non-deterministic when unset)",
  diffOffer(offerA, { ...offerA, startDate: "2026-04-01T00:00:00.000Z" }).length === 0);

// ── Request-derived base URLs ───────────────────────────────────────────────
console.log("\nbaseUrlFromRequest:");
const mkReq = (headers: Record<string, string>) => new Request("http://internal/", { headers });
check("netlify preview host is trusted (fixes the 404 return/link bug)",
  baseUrlFromRequest(mkReq({ "x-forwarded-host": "deploy-preview-6--athletix-os.netlify.app", "x-forwarded-proto": "https" }))
    === "https://deploy-preview-6--athletix-os.netlify.app");
check("plain Host header works too",
  baseUrlFromRequest(mkReq({ host: "branch--athletix-os.netlify.app" })) === "https://branch--athletix-os.netlify.app");
check("unknown host falls back to configured base (host-header-injection safe)",
  !baseUrlFromRequest(mkReq({ "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" })).includes("evil"));
check("no headers falls back to configured base",
  baseUrlFromRequest(mkReq({})) === getAppBaseUrl());
check("localhost stays http",
  baseUrlFromRequest(mkReq({ host: "127.0.0.1:3000" })) === "http://127.0.0.1:3000");

// ── Billing mode ────────────────────────────────────────────────────────────
console.log("\nderiveBillingMode:");
check("stripe recurring", deriveBillingMode({ sub: { billingType: "RECURRING", status: "active", price: 110, stripeSubscriptionId: "x" } }) === "STRIPE_RECURRING");
check("manual", deriveBillingMode({ sub: { billingType: "MANUAL", status: "active", price: 190, stripeSubscriptionId: null } }) === "MANUAL");
check("free", deriveBillingMode({ sub: { billingType: "MANUAL", status: "active", price: 0, stripeSubscriptionId: null } }) === "FREE");
check("canceled", deriveBillingMode({ sub: { billingType: "MANUAL", status: "canceled", price: 190, stripeSubscriptionId: null } }) === "CANCELED");
check("pending approval", deriveBillingMode({ sub: null, approvalStatus: "PENDING_APPROVAL" }) === "PENDING_APPROVAL");
check("pending activation", deriveBillingMode({ sub: null, migrationStatus: "INVITED" }) === "PENDING_ACTIVATION");
check("incomplete", deriveBillingMode({ sub: null, migrationStatus: "IMPORTED" }) === "INCOMPLETE");
check("none", deriveBillingMode({ sub: null }) === "NONE");

// ── Charge timing ───────────────────────────────────────────────────────────
console.log("\nchargeTiming:");
check("future date is not immediate", chargeTiming(FUTURE, NOW).immediate === false);
check("past date is immediate", chargeTiming(PAST, NOW).immediate === true);
check("today/now is immediate", chargeTiming(NOW, NOW).immediate === true);
check("null date is immediate", chargeTiming(null, NOW).immediate === true);
check("future label carries the date", chargeTiming(FUTURE, NOW).label.includes("July"));
check("immediate label is explicit", chargeTiming(PAST, NOW).label.includes("immediately"));

// ── Pricing precedence ──────────────────────────────────────────────────────
console.log("\nresolveOfferPricing:");
const legacyOnly = resolveOfferPricing(
  { legacyMembershipName: "Jr Frogs", legacyMembershipPrice: "110", legacyBillingFrequency: "MONTHLY" },
  null,
);
check("legacy snapshot fallback", legacyOnly.planName === "Jr Frogs" && legacyOnly.price === 110 && legacyOnly.period === "MONTHLY");
const planFirst = resolveOfferPricing(
  { legacyMembershipPrice: "999" },
  { name: "MS/HS", options: JSON.stringify([{ label: "Monthly", price: 190, billingPeriod: "MONTHLY" }]) },
);
check("plan option[0] beats legacy", planFirst.price === 190 && planFirst.planName === "MS/HS" && planFirst.optionLabel === "Monthly");
const selected = resolveOfferPricing(
  {
    migrationSelectedOption: { label: "Quarterly", price: 300, billingPeriod: "QUARTERLY" },
  },
  { name: "Jr Frogs", options: JSON.stringify([{ label: "Monthly", price: 110, billingPeriod: "MONTHLY" }]) },
);
check("member-selected option beats plan default", selected.price === 300 && selected.period === "QUARTERLY");
const overridden = resolveOfferPricing(
  {
    migrationSelectedOption: { label: "Quarterly", price: 300, billingPeriod: "QUARTERLY" },
    migrationPriceOverride: "250",
  },
  { name: "Jr Frogs", options: JSON.stringify([{ label: "Monthly", price: 110, billingPeriod: "MONTHLY" }]) },
);
check("owner override always wins", overridden.price === 250 && overridden.period === "QUARTERLY");
const freeOverride = resolveOfferPricing({ legacyMembershipPrice: "190", migrationPriceOverride: 0 }, null);
check("$0 override marks free", freeOverride.price === 0);
check("bad options JSON degrades to legacy",
  resolveOfferPricing({ legacyMembershipPrice: "50" }, { name: "X", options: "{not json" }).price === 50);

// ── Payment-method removal safety ───────────────────────────────────────────
console.log("\ncanRemovePaymentMethod:");
check("blocked: backs live sub, no replacement",
  canRemovePaymentMethod({ backsLiveSubscription: true, backsPendingActivation: false, otherValidMethodExists: false }).allowed === false);
check("blocked: backs live sub EVEN WITH replacement (must make-default first)",
  canRemovePaymentMethod({ backsLiveSubscription: true, backsPendingActivation: false, otherValidMethodExists: true }).allowed === false);
check("blocked: backs pending activation, no replacement",
  canRemovePaymentMethod({ backsLiveSubscription: false, backsPendingActivation: true, otherValidMethodExists: false }).allowed === false);
check("blocked: backs pending activation with replacement (make-default first)",
  canRemovePaymentMethod({ backsLiveSubscription: false, backsPendingActivation: true, otherValidMethodExists: true }).allowed === false);
check("allowed: backs nothing",
  canRemovePaymentMethod({ backsLiveSubscription: false, backsPendingActivation: false, otherValidMethodExists: false }).allowed === true);
check("blocked reasons are actionable",
  (canRemovePaymentMethod({ backsLiveSubscription: true, backsPendingActivation: false, otherValidMethodExists: true }).reason || "").includes("default"));

// ── Opaque payment-method refs ──────────────────────────────────────────────
console.log("\npmRef:");
check("deterministic", pmRef("pm_123abc") === pmRef("pm_123abc"));
check("distinct per pm", pmRef("pm_123abc") !== pmRef("pm_456def"));
check("does not leak the raw id", !pmRef("pm_123abc").includes("pm_") && pmRef("pm_123abc").length === 16);

// ── Permission model ────────────────────────────────────────────────────────
console.log("\nbilling permission:");
const billingEntry = PERMISSION_CATALOG.find((p) => p.key === "billing");
check("catalog has billing key", !!billingEntry);
check("billing levels are none/view/full", JSON.stringify(billingEntry?.levels) === JSON.stringify(["none", "view", "full"]));
check("default is none (no coach gets financial control silently)", DEFAULT_PERMISSIONS.billing === "none");
check("legacy stored perms resolve billing to none", resolvePermissions({ members: "edit" }).billing === "none");
check("staff without billing blocked", hasPermission({ members: "full" }, "billing", "view") === false);
check("staff with billing:view can view but not manage",
  hasPermission({ billing: "view" }, "billing", "view") === true && hasPermission({ billing: "view" }, "billing", "full") === false);
check("staff with billing:full can manage", hasPermission({ billing: "full" }, "billing", "full") === true);

// ── Offer parsing (server-side re-read safety) ─────────────────────────────
console.log("\nparseOffer:");
check("rejects junk", parseOffer("junk") === null && parseOffer({ planName: 5 }) === null);
const parsed = parseOffer({
  membershipId: "m1", planName: "Jr Frogs", optionLabel: "Monthly", price: 110, billingPeriod: "MONTHLY",
  startDate: "2026-07-01T00:00:00.000Z", firstChargeDate: "2026-07-19T00:00:00.000Z",
  commitmentEndDate: null, paymentMode: "CARD", payerUserId: null,
});
check("round-trips a valid offer", parsed?.price === 110 && parsed?.firstChargeDate === "2026-07-19T00:00:00.000Z");
check("unknown paymentMode coerces to CARD (never silently free)",
  parseOffer({ planName: "X", price: 10, paymentMode: "WHATEVER" })?.paymentMode === "CARD");

// ── prettyPeriod ────────────────────────────────────────────────────────────
console.log("\nprettyPeriod:");
check("monthly", prettyPeriod("MONTHLY") === "monthly");
check("quarterly", prettyPeriod("QUARTERLY") === "quarterly");
check("annual", prettyPeriod("ANNUAL") === "yearly");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
