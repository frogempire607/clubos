// Pure-function tests for lib/billingDataRules.ts — the four billing-data
// questions fixed 2026-09-28: who counts as an active member, what activation
// does to Member.status, which cash memberships are duplicates, and how a
// payment method is named.
//
// Run: npx tsx scripts/billing-data-tests.ts   (no DB, no Stripe)
import {
  LIVE_SUBSCRIPTION_STATUSES,
  isLiveSubscriptionStatus,
  summarizeActiveMembers,
  activeMembersLine,
  nextStatusOnActivation,
  nextMemberStatus,
  findPlanConflict,
  conflictQueueLabel,
  conflictRefusal,
  findDuplicateCashSubscriptions,
  paymentMethodLabel,
  isOffSessionChargeable,
  lastPaidWithFromCharges,
  cardBrandName,
  type PlanSub,
} from "../lib/billingDataRules";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

// ── 1. Active-member count ─────────────────────────────────────────────────
eq("live statuses", [...LIVE_SUBSCRIPTION_STATUSES], ["active", "past_due", "trialing"]);
eq("pending is not live (abandoned checkout)", isLiveSubscriptionStatus("pending"), false);
eq("canceled is not live", isLiveSubscriptionStatus("canceled"), false);
eq("expired is not live", isLiveSubscriptionStatus("expired"), false);
eq("past_due is live", isLiveSubscriptionStatus("past_due"), true);
eq("null is not live", isLiveSubscriptionStatus(null), false);

const rows = [
  { memberId: "a", status: "active" },
  { memberId: "a", status: "active" }, // two memberships, one person
  { memberId: "b", status: "past_due" },
  { memberId: "c", status: "trialing" },
  { memberId: "d", status: "pending" },
  { memberId: "e", status: "canceled" },
];
eq("distinct members vs memberships", summarizeActiveMembers(rows), { activeMembers: 3, memberships: 4 });
eq("empty club", summarizeActiveMembers([]), { activeMembers: 0, memberships: 0 });
eq("line with both", activeMembersLine({ activeMembers: 49, memberships: 53 }), "49 active members · 53 memberships");
eq("line when equal", activeMembersLine({ activeMembers: 5, memberships: 5 }), "5 active members");
eq("line singular", activeMembersLine({ activeMembers: 1, memberships: 1 }), "1 active member");
// The 2026-09-28 shape: 42 status-ACTIVE, 49 holders. Status is not consulted.
const prod = [
  ...Array.from({ length: 45 }, (_, i) => ({ memberId: `m${i}`, status: "active" })),
  ...Array.from({ length: 4 }, (_, i) => ({ memberId: `m${i}`, status: "active" })), // 4 second memberships
  ...Array.from({ length: 4 }, (_, i) => ({ memberId: `p${i}`, status: "past_due" })),
];
eq("production shape 49 · 53", summarizeActiveMembers(prod), { activeMembers: 49, memberships: 53 });

// ── 2. Status transitions ──────────────────────────────────────────────────
eq("activation: PROSPECT → ACTIVE", nextStatusOnActivation("PROSPECT"), "ACTIVE");
eq("activation: INACTIVE → ACTIVE", nextStatusOnActivation("INACTIVE"), "ACTIVE");
eq("activation: ACTIVE stays (no write)", nextStatusOnActivation("ACTIVE"), null);
eq("activation: PAUSED never un-paused", nextStatusOnActivation("PAUSED"), null);
eq("recompute: prospect with membership → ACTIVE", nextMemberStatus("PROSPECT", true), "ACTIVE");
eq("recompute: inactive with membership → ACTIVE", nextMemberStatus("INACTIVE", true), "ACTIVE");
eq("recompute: active with membership → no write", nextMemberStatus("ACTIVE", true), null);
eq("recompute: last membership ended → INACTIVE", nextMemberStatus("ACTIVE", false), "INACTIVE");
eq("recompute: prospect with nothing stays PROSPECT", nextMemberStatus("PROSPECT", false), null);
eq("recompute: inactive with nothing stays", nextMemberStatus("INACTIVE", false), null);
eq("recompute: PAUSED untouched (holds)", nextMemberStatus("PAUSED", true), null);
eq("recompute: PAUSED untouched (none)", nextMemberStatus("PAUSED", false), null);

// ── 3. Duplicates ──────────────────────────────────────────────────────────
const sep21 = new Date("2026-09-21T18:00:00Z");
const sep23 = new Date("2026-09-23T15:00:01Z");
const card = (id: string, memberId: string, membershipId = "mshs"): PlanSub => ({
  id, memberId, membershipId, status: "active", billingType: "RECURRING", stripeSubscriptionId: `sub_${id}`, startedAt: sep21,
});
const cash = (id: string, memberId: string, membershipId = "mshs", status = "active"): PlanSub => ({
  id, memberId, membershipId, status, billingType: "MANUAL", stripeSubscriptionId: null, createdAt: sep23,
});

const hudson = [card("c1", "hudson"), cash("x1", "hudson")];
const wenhuan = [card("c2", "wenhuan"), cash("x2", "wenhuan")];
const wenxuan = [card("c3", "wenxuan"), cash("x3", "wenxuan")];
const otherPlan = [card("c4", "ava", "jrfrogs"), cash("x4", "ava", "mshs")]; // two DIFFERENT plans — legitimate
const cashOnly = [cash("x5", "ben")];
const canceledCard = [{ ...card("c6", "cal"), status: "canceled" }, cash("x6", "cal")];
const expiredCash = [card("c7", "dee"), cash("x7", "dee", "mshs", "expired")];
const pastDueCard = [{ ...card("c8", "eli"), status: "past_due" }, cash("x8", "eli")];
const all = [...hudson, ...wenhuan, ...wenxuan, ...otherPlan, ...cashOnly, ...canceledCard, ...expiredCash, ...pastDueCard];
const dups = findDuplicateCashSubscriptions(all);
eq("exactly the duplicates (incl. past_due card)", dups.map((d) => [d.manual.id, d.card.id]), [["x1", "c1"], ["x2", "c2"], ["x3", "c3"], ["x8", "c8"]]);
eq("never returns a Stripe row as the duplicate", dups.every((d) => d.manual.stripeSubscriptionId === null), true);
eq("the kept row always has a Stripe id", dups.every((d) => !!d.card.stripeSubscriptionId), true);
eq("two MANUAL rows are not a card duplicate", findDuplicateCashSubscriptions([cash("y1", "f"), cash("y2", "f")]).length, 0);
eq("two card rows are never selected", findDuplicateCashSubscriptions([card("z1", "g"), card("z2", "g")]).length, 0);

const conflict = findPlanConflict(hudson, "mshs");
eq("conflict found, card wins", conflict && { id: conflict.subscriptionId, by: conflict.paidBy }, { id: "c1", by: "card" });
eq("no conflict on another plan", findPlanConflict(hudson, "jrfrogs"), null);
eq("no conflict with a canceled row", findPlanConflict([{ ...card("q", "h"), status: "canceled" }], "mshs"), null);
eq("no conflict with a pending checkout", findPlanConflict([{ ...card("q", "h"), status: "pending" }], "mshs"), null);
eq("cash-held plan conflicts as cash", findPlanConflict(cashOnly, "mshs")?.paidBy, "cash");
eq("queue label", conflictQueueLabel(conflict!, "America/New_York"), "Already has this membership (paid by card Sep 21) — decline or keep");
eq("queue label, no date", conflictQueueLabel({ subscriptionId: "s", paidBy: "card", since: null }), "Already has this membership (paid by card) — decline or keep");
eq("queue label respects club timezone", conflictQueueLabel({ subscriptionId: "s", paidBy: "card", since: new Date("2026-09-22T02:00:00Z") }, "America/New_York"), "Already has this membership (paid by card Sep 21) — decline or keep");
eq(
  "refusal names the member, plan and date",
  conflictRefusal("Hudson R.", "MS/HS", conflict!, "America/New_York").startsWith("Hudson R. already has MS/HS (paid by card Sep 21)."),
  true,
);

// ── 4. Payment-method labels ───────────────────────────────────────────────
eq("visa", paymentMethodLabel({ type: "card", card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2027 } }), "Visa •••• 4242 · exp 08/27");
eq("amex", paymentMethodLabel({ type: "card", card: { brand: "amex", last4: "0005", exp_month: 12, exp_year: 2030 } }), "American Express •••• 0005 · exp 12/30");
eq("card, no exp", paymentMethodLabel({ type: "card", card: { brand: "mastercard", last4: "4444" } }), "Mastercard •••• 4444");
eq("card via Apple Pay", paymentMethodLabel({ type: "card", card: { brand: "visa", last4: "1111", exp_month: 1, exp_year: 2029, wallet: { type: "apple_pay" } } }), "Visa •••• 1111 · exp 01/29 (Apple Pay)");
eq("cash app with tag", paymentMethodLabel({ type: "cashapp", cashapp: { cashtag: "$blaked" } }), "Cash App Pay ($blaked)");
eq("cash app tag without $", paymentMethodLabel({ type: "cashapp", cashapp: { cashtag: "blaked" } }), "Cash App Pay ($blaked)");
eq("cash app, no tag", paymentMethodLabel({ type: "cashapp", cashapp: { cashtag: null } }), "Cash App Pay");
eq("link with email", paymentMethodLabel({ type: "link", link: { email: "pat@example.com" } }), "Link (pat@example.com)");
eq("link falls back to billing email", paymentMethodLabel({ type: "link", billing_details: { email: "pat@x.com" } }), "Link (pat@x.com)");
eq("link bare", paymentMethodLabel({ type: "link" }), "Link");
eq("bank", paymentMethodLabel({ type: "us_bank_account", us_bank_account: { bank_name: "CHASE", last4: "6789" } }), "Bank account •••• 6789");
eq("paypal", paymentMethodLabel({ type: "paypal", paypal: { payer_email: "a@b.co" } }), "PayPal (a@b.co)");
eq("amazon pay", paymentMethodLabel({ type: "amazon_pay" }), "Amazon Pay");
eq("unknown type title-cased", paymentMethodLabel({ type: "klarna" }), "Klarna");
eq("brand fallback", cardBrandName(null), "Card");

eq("card chargeable off-session", isOffSessionChargeable({ type: "card" }), true);
eq("link chargeable off-session", isOffSessionChargeable({ type: "link" }), true);
eq("bank chargeable off-session", isOffSessionChargeable({ type: "us_bank_account" }), true);
eq("cash app NOT auto-picked", isOffSessionChargeable({ type: "cashapp" }), false);
eq("paypal NOT auto-picked", isOffSessionChargeable({ type: "paypal" }), false);

// Last paid with — newest SUCCEEDED charge wins, failures and order ignored.
const charges = [
  { status: "failed", created: 300, amount: 17500, payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } } },
  { status: "succeeded", created: 200, amount: 17500, payment_method_details: { type: "cashapp", cashapp: { cashtag: "$blaked" } } },
  { status: "succeeded", created: 100, amount: 17500, payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } } },
];
eq("last paid with = newest success", lastPaidWithFromCharges(charges), {
  type: "cashapp", label: "Cash App Pay ($blaked)", at: new Date(200 * 1000).toISOString(), amount: 175,
});
eq("last paid with — unsorted input", lastPaidWithFromCharges([...charges].reverse())?.type, "cashapp");
eq("last paid with — nothing succeeded", lastPaidWithFromCharges([charges[0]]), null);
eq("last paid with — none", lastPaidWithFromCharges([]), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
