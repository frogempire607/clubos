/**
 * B11 slice 2 — lib/eventPricingModel. Pure; runs with `npm run test:event-pricing-model`.
 * The derive* cases mirror the SQL backfill in
 * prisma/migrations/20260923000000_event_pricing_model — change one, change both.
 */
import {
  derivePricingModel, deriveSignupAccess, deriveSplitInvoiceWhen, legacyColumnsFor,
  applyExclusions, bundleSanity, quoteSessions, moneySummary, resolveEventWrite,
} from "../lib/eventPricingModel";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

console.log("derivePricingModel (= migration backfill):");
check("variableCostEnabled → SPLIT, whatever the prices say", derivePricingModel({ variableCostEnabled: true, memberPrice: 200 }) === "SPLIT");
check("member price → FIXED", derivePricingModel({ memberPrice: "200.00" }) === "FIXED");
check("only a drop-in fee → FIXED", derivePricingModel({ dropInFee: 20 }) === "FIXED");
check("no prices → FREE", derivePricingModel({}) === "FREE");
check("$0 prices → FREE", derivePricingModel({ memberPrice: 0, nonMemberPrice: "0" }) === "FREE");

console.log("\nderiveSignupAccess (= migration backfill):");
check("purchaseAccess STAFF_ONLY wins over public link", deriveSignupAccess({ purchaseAccess: "STAFF_ONLY", publicRegistration: true }) === "STAFF_ONLY");
check("visibility STAFF_ONLY wins too", deriveSignupAccess({ visibility: "STAFF_ONLY", publicRegistration: true }) === "STAFF_ONLY");
check("publicRegistration → PUBLIC_LINK", deriveSignupAccess({ visibility: "PUBLIC", publicRegistration: true }) === "PUBLIC_LINK");
check("PUBLIC visibility without registration is still MEMBERS (visibility was a listing flag, not access)", deriveSignupAccess({ visibility: "PUBLIC" }) === "MEMBERS");
check("default → MEMBERS", deriveSignupAccess({}) === "MEMBERS");

console.log("\nderiveSplitInvoiceWhen:");
check("not SPLIT → null", deriveSplitInvoiceWhen({ invoiceScheduledAt: new Date() }, "FIXED") === null);
check("SPLIT with a date → ON_DATE", deriveSplitInvoiceWhen({ invoiceScheduledAt: new Date() }, "SPLIT") === "ON_DATE");
check("SPLIT without → AFTER_EVENT", deriveSplitInvoiceWhen({}, "SPLIT") === "AFTER_EVENT");

console.log("\nlegacyColumnsFor round-trips:");
{
  const fixed = legacyColumnsFor({ pricingModel: "FIXED", signupAccess: "PUBLIC_LINK", memberPrice: 200, nonMemberPrice: 225, sellIndividualSessions: true, minSessionPrice: 20 });
  check("FIXED keeps prices, writes dropInFee = lowest session price", fixed.memberPrice === 200 && fixed.dropInFee === 20 && !fixed.variableCostEnabled);
  check("…and derives back to FIXED", derivePricingModel(fixed) === "FIXED");
  check("PUBLIC_LINK → visibility PUBLIC + publicRegistration", fixed.visibility === "PUBLIC" && fixed.publicRegistration && fixed.purchaseAccess === "ANYONE");
  check("…and derives back to PUBLIC_LINK", deriveSignupAccess(fixed) === "PUBLIC_LINK");
  const split = legacyColumnsFor({ pricingModel: "SPLIT", signupAccess: "MEMBERS", memberPrice: 200, splitInvoiceWhen: "ON_DATE", splitInvoiceDate: new Date("2026-10-01T00:00:00Z") });
  check("SPLIT drops member/non-member prices (rule 1)", split.memberPrice === null && split.nonMemberPrice === null && split.variableCostEnabled);
  check("SPLIT ON_DATE writes invoiceScheduledAt", split.invoiceScheduledAt?.toISOString() === "2026-10-01T00:00:00.000Z");
  check("…and derives back to SPLIT / ON_DATE", derivePricingModel(split) === "SPLIT" && deriveSplitInvoiceWhen(split, "SPLIT") === "ON_DATE");
  const staff = legacyColumnsFor({ pricingModel: "FREE", signupAccess: "STAFF_ONLY" });
  check("STAFF_ONLY → both legacy flags, no public registration", staff.visibility === "STAFF_ONLY" && staff.purchaseAccess === "STAFF_ONLY" && !staff.publicRegistration);
  check("MEMBERS → MEMBERS_ONLY visibility", legacyColumnsFor({ pricingModel: "FREE", signupAccess: "MEMBERS" }).visibility === "MEMBERS_ONLY");
  check("FIXED without sellIndividualSessions writes no dropInFee", legacyColumnsFor({ pricingModel: "FIXED", signupAccess: "MEMBERS", memberPrice: 100, minSessionPrice: 20 }).dropInFee === null);
}

console.log("\napplyExclusions:");
{
  const base = { pricingModel: "FIXED" as const, signupAccess: "MEMBERS" as const, paymentMethods: ["CARD", "AUTO_CARD", "CASH"] as ("CARD" | "AUTO_CARD" | "CASH" | "CHECK")[], chargeOnApproval: false, requiresCoachApproval: false };
  check("FIXED keeps methods", applyExclusions(base).paymentMethods.length === 3);
  check("SPLIT locks all methods (rule 2)", applyExclusions({ ...base, pricingModel: "SPLIT" }).paymentMethods.length === 0);
  check("…with the split reason", (applyExclusions({ ...base, pricingModel: "SPLIT" }).paymentMethodsLocked ?? "").includes("split"));
  check("FREE locks all methods (rule 2)", (applyExclusions({ ...base, pricingModel: "FREE" }).paymentMethodsLocked ?? "").includes("free"));
  const approve = applyExclusions({ ...base, requiresCoachApproval: true, chargeOnApproval: true });
  check("chargeOnApproval drops CARD (rule 3)", !approve.paymentMethods.includes("CARD") && approve.paymentMethods.includes("AUTO_CARD"));
  check("…names the reason", (approve.cardDisabledReason ?? "").includes("charge on approve"));
  check("…and the conflict panel speaks", (approve.conflict ?? "").includes("One rule"));
  check("chargeOnApproval without approval does nothing", applyExclusions({ ...base, chargeOnApproval: true }).cardDisabledReason === null);
  check("STAFF_ONLY locks the public link (rule 4)", applyExclusions({ ...base, signupAccess: "STAFF_ONLY" }).publicLinkLocked !== null);
  check("duplicates collapse", applyExclusions({ ...base, paymentMethods: ["CASH", "CASH"] }).paymentMethods.length === 1);
}

console.log("\nbundleSanity (rule 5):");
check("cheaper à la carte is called out", bundleSanity([100, 120], 275).kind === "CHEAPER_A_LA_CARTE");
check("…with the handoff's sentence", (bundleSanity([100, 120], 275) as { sentence: string }).sentence === "à la carte totals $220, which is $55 cheaper than the $275 whole-event price — nobody has a reason to buy the bundle");
check("a real saving is a SAVING", bundleSanity([100, 100, 100], 275).kind === "SAVING");
check("no session prices → NONE", bundleSanity([null, undefined], 275).kind === "NONE");
check("no whole-event price → NONE", bundleSanity([50], null).kind === "NONE");

console.log("\nquoteSessions:");
{
  const sessions = [
    { id: "s1", price: 20, startsAt: "2030-01-01T10:00:00Z" },
    { id: "s2", price: "25.50", startsAt: "2030-01-02T10:00:00Z" },
    { id: "s3", price: null, startsAt: "2030-01-03T10:00:00Z" },
    { id: "old", price: 20, startsAt: "2020-01-01T10:00:00Z" },
  ];
  const on = { pricingModel: "FIXED" as const, sellIndividualSessions: true, sessions };
  const q = quoteSessions({ ...on, requestedIds: ["s2", "s1", "s1"] });
  check("two sessions total in cents, ids in event order, deduped", q.ok && q.cents === 4550 && q.sessionIds.join(",") === "s1,s2");
  check("label says how many", q.ok && q.label === "2 sessions");
  check("single session label", quoteSessions({ ...on, requestedIds: ["s1"] }).ok && (quoteSessions({ ...on, requestedIds: ["s1"] }) as { label: string }).label === "Single session");
  check("unpriced session refused", !quoteSessions({ ...on, requestedIds: ["s3"] }).ok);
  check("unknown session refused", !quoteSessions({ ...on, requestedIds: ["nope"] }).ok);
  check("started session refused", !quoteSessions({ ...on, requestedIds: ["old"] }).ok);
  check("empty pick refused", !quoteSessions({ ...on, requestedIds: [] }).ok);
  check("not sold individually refused", !quoteSessions({ ...on, sellIndividualSessions: false, requestedIds: ["s1"] }).ok);
  check("SPLIT refused", !quoteSessions({ ...on, pricingModel: "SPLIT", requestedIds: ["s1"] }).ok);
}

console.log("\nmoneySummary:");
check("FREE", moneySummary({ pricingModel: "FREE" }) === "Free — nobody is charged");
check("FIXED with sessions", moneySummary({ pricingModel: "FIXED", memberPrice: 200, nonMemberPrice: 225, sellIndividualSessions: true, sessionPrices: [20, 30] }) === "Member $200 · Non-member $225 · sessions from $20");
check("SPLIT after event", moneySummary({ pricingModel: "SPLIT", splitTotal: 500, splitExpectedSignups: 12 }) === "Split $500 ≈ $41.67 each · invoiced after the event");

console.log("\nresolveEventWrite — both vocabularies land on every save:");
{
  const fromNew = resolveEventWrite({ pricingModel: "FIXED", signupAccess: "PUBLIC_LINK", memberPrice: 200, nonMemberPrice: 225, sellIndividualSessions: true, sessionPrices: [30, 20, null] });
  check("new → legacy: dropInFee = lowest session price, publicRegistration on", fromNew.dropInFee === 20 && fromNew.publicRegistration && fromNew.visibility === "PUBLIC");
  const fromOld = resolveEventWrite({ memberPrice: 150, dropInFee: 25, visibility: "PUBLIC", publicRegistration: true });
  check("legacy → new: FIXED, sells sessions, PUBLIC_LINK", fromOld.pricingModel === "FIXED" && fromOld.sellIndividualSessions && fromOld.signupAccess === "PUBLIC_LINK");
  const oldSplit = resolveEventWrite({ variableCostEnabled: true, invoiceScheduledAt: new Date("2026-11-01T00:00:00Z"), visibility: "MEMBERS_ONLY" });
  check("legacy split → SPLIT / ON_DATE / MEMBERS", oldSplit.pricingModel === "SPLIT" && oldSplit.splitInvoiceWhen === "ON_DATE" && oldSplit.signupAccess === "MEMBERS");
  const newSplit = resolveEventWrite({ pricingModel: "SPLIT", signupAccess: "STAFF_ONLY", memberPrice: 999, sellIndividualSessions: true });
  check("new SPLIT ignores prices and session selling (rule 1)", newSplit.memberPrice === null && !newSplit.sellIndividualSessions && newSplit.variableCostEnabled && newSplit.splitInvoiceWhen === "AFTER_EVENT");
  check("new SPLIT STAFF_ONLY → legacy staff flags", newSplit.purchaseAccess === "STAFF_ONLY" && newSplit.visibility === "STAFF_ONLY");
}

console.log(`\n=== FINAL: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
