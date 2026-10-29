/**
 * Coach pays for a team · the payer's wallet · "Paid by" (2026-10-29).
 *
 *   npx tsx scripts/team-payer-tests.ts
 *
 * Jason Reynolds (a coach) pays for eight athletes; his card was saved once,
 * on Owen Burhans. Stripe customers were per athlete, so nobody else could
 * use it, and the sibling discount grouped families by whoever pays — so the
 * whole team counted as brothers.
 *
 * Pure rules first, then the REAL route handlers against the in-memory fake
 * DB and a fake Stripe:
 *   · umbrellaPayer / walletSources / siblingFamilyKey / isCoachRelationship
 *   · use_family_card: only the same payer's cards; never a live card
 *     membership; nothing charged; the athlete points at that customer + card
 *   · set_payer: any account in the club; sets several athletes at once;
 *     "coach" relabels only their own guardian links; club-scoped
 *   · GET /payer: multi-word search, linked athletes, billing:full only
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { siblingFamilyKey, isCoachRelationship } from "../lib/membershipSiblingDiscount";
import { pmRef } from "../lib/billingAdmin";

// ── Routes ──────────────────────────────────────────────────────────────────
const fake = makeFakeDb({
  relations: {
    member: { guardianLinks: { model: "memberGuardianUser", kind: "many", fk: "memberId" } },
  },
});
let CURRENT: unknown = null;
let DENY = false;
const PMS: Record<string, { id: string; type: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } }[]> = {
  cus_owen: [{ id: "pm_jason", type: "card", card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2029 } }, { id: "pm_cashapp", type: "cashapp" }],
  cus_other: [{ id: "pm_other", type: "card", card: { brand: "visa", last4: "1111", exp_month: 1, exp_year: 2030 } }],
};
const fakeStripe = {
  customers: {
    listPaymentMethods: async (cus: string) => ({ data: PMS[cus] ?? [] }),
    retrieve: async (id: string) => ({ id, invoice_settings: { default_payment_method: null } }),
  },
  subscriptions: { list: async () => ({ data: [] }) },
};
installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => CURRENT, default: {} },
  "@/lib/auth": { authOptions: {} },
  "@/lib/stripe": { stripe: fakeStripe },
  "@/lib/apiGuard": {
    requirePermissionLive: async () => (DENY ? new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) : null),
    requirePermission: () => null,
  },
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require("../app/api/members/[id]/billing-admin/actions/route.ts") as typeof import("../app/api/members/[id]/billing-admin/actions/route");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const payerRoute = require("../app/api/members/[id]/payer/route.ts") as typeof import("../app/api/members/[id]/payer/route");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const W = require("../lib/payerWallet.ts") as typeof import("../lib/payerWallet");
const { umbrellaPayer, walletSources } = W;

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

console.log("\numbrellaPayer:");
ok(umbrellaPayer({ responsiblePayerUserId: "coach", userId: null, isMinor: true, primaryGuardianUserId: "mom" }) === "coach", "Paid by wins over the guardian");
ok(umbrellaPayer({ responsiblePayerUserId: null, userId: "teen", isMinor: true, primaryGuardianUserId: "mom" }) === "mom", "a minor with their own login: the guardian pays");
ok(umbrellaPayer({ responsiblePayerUserId: null, userId: "adult", isMinor: false, primaryGuardianUserId: "mom" }) === "adult", "an adult pays for themself");
ok(umbrellaPayer({ responsiblePayerUserId: null, userId: null, isMinor: true, primaryGuardianUserId: null }) === null, "nobody to name → null");

console.log("\nwalletSources:");
const ws = walletSources("cus_jack", [
  { id: "o", name: "Owen", customerId: "cus_owen" }, { id: "h", name: "Hunter", customerId: "cus_owen" },
  { id: "l", name: "Lucas", customerId: "cus_l" }, { id: "k", name: "Kaden", customerId: "cus_jack" }, { id: "n", name: "None", customerId: null },
]);
ok(ws.sources[0].customerId === "cus_owen" && ws.sources[0].members.length === 2, "grouped by customer, most-shared first");
ok(ws.sources.length === 2 && !ws.sources.some((x) => x.customerId === "cus_jack"), "the athlete's own customer is not a source");
ok(ws.sharedWith.length === 1 && ws.sharedWith[0].name === "Kaden", "…it's reported as 'shared with'");

console.log("\nsiblingFamilyKey:");
const base = { memberUserId: null, memberResponsiblePayerUserId: null, guardianUserIds: ["mom"], coachUserIds: [] as string[], primaryFamilyGuardian: "mom" };
ok(siblingFamilyKey({ ...base, payerUserId: "mom" }) === "mom", "a parent who pays: unchanged");
ok(siblingFamilyKey({ ...base, payerUserId: null }) === "mom", "nobody named: the primary guardian, unchanged");
ok(siblingFamilyKey({ ...base, payerUserId: "coach", memberResponsiblePayerUserId: "coach" }) === "mom", "coach set as Paid by (not a guardian) → the athlete's own family");
ok(siblingFamilyKey({ ...base, guardianUserIds: [], primaryFamilyGuardian: null, payerUserId: "coach", memberResponsiblePayerUserId: "coach" }) === null, "…no family guardian → a family of one (no sibling discount)");
ok(siblingFamilyKey({ ...base, guardianUserIds: ["coach"], coachUserIds: ["coach"], primaryFamilyGuardian: null, payerUserId: "coach" }) === null, "coach linked as a guardian but labelled Coach → not family");
ok(siblingFamilyKey({ ...base, guardianUserIds: ["dad"], primaryFamilyGuardian: "dad", payerUserId: "dad", memberResponsiblePayerUserId: "dad" }) === "dad", "Paid by a guardian parent stays family");
ok(siblingFamilyKey({ ...base, payerUserId: "michael" }) === "michael", "a subscription payer from a transfer (not Paid by) keeps the old behaviour");
ok(isCoachRelationship("Coach") && isCoachRelationship("team payer") && !isCoachRelationship("Parent") && !isCoachRelationship(null), "isCoachRelationship");



const M = (id: string, first: string, extra: Record<string, unknown> = {}) => ({
  id, clubId: "c1", firstName: first, lastName: "X", isMinor: true, userId: null, responsiblePayerUserId: null,
  stripeSetupCustomerId: null, stripeCustomerId: null, stripeSetupPaymentMethodId: null, deletedAt: null, ...extra,
});
fake.seed("club", [{ id: "c1", name: "Club", stripeAccountId: "acct_1" }]);
fake.seed("user", [
  { id: "u_jason", clubId: "c1", firstName: "Jason", lastName: "Reynolds", email: "jreynolds@homercentral.org", deletedAt: null },
  { id: "u_mom", clubId: "c1", firstName: "Mary", lastName: "Burhans", email: "mary@x.com", deletedAt: null },
  { id: "u_far", clubId: "c2", firstName: "Jason", lastName: "Elsewhere", email: "j@other.com", deletedAt: null },
]);
fake.seed("member", [
  M("owen", "Owen", { stripeSetupCustomerId: "cus_owen", stripeSetupPaymentMethodId: "pm_jason" }),
  M("jack", "Jack"),
  M("hunter", "Hunter"),
  M("lucas", "Lucas", { responsiblePayerUserId: "u_other", stripeSetupCustomerId: "cus_other" }),
  { ...M("far", "Far"), clubId: "c2" },
]);
fake.seed("memberGuardianUser", [
  { id: "g1", clubId: "c1", memberId: "owen", userId: "u_jason", status: "CONFIRMED", isPrimary: true, relationship: "Parent", createdAt: new Date("2026-01-01") },
  { id: "g2", clubId: "c1", memberId: "jack", userId: "u_jason", status: "CONFIRMED", isPrimary: true, relationship: null, createdAt: new Date("2026-01-01") },
  { id: "g3", clubId: "c1", memberId: "hunter", userId: "u_jason", status: "CONFIRMED", isPrimary: true, relationship: "Parent", createdAt: new Date("2026-01-01") },
  { id: "g4", clubId: "c1", memberId: "hunter", userId: "u_mom", status: "CONFIRMED", isPrimary: false, relationship: "Mother", createdAt: new Date("2026-02-01") },
]);
fake.seed("memberSubscription", []);
fake.seed("billingAuditLog", []);

const session = { user: { id: "staff", clubId: "c1", role: "OWNER" } };
async function act(memberId: string, body: Record<string, unknown>) {
  const req = new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, ...body }) });
  const res = await actions.POST(req, { params: Promise.resolve({ id: memberId }) });
  return { status: res.status, d: await res.json() };
}
async function getPayer(memberId: string, qs: string) {
  const res = await payerRoute.GET(new Request(`http://x/api?${qs}`), { params: Promise.resolve({ id: memberId }) });
  return { status: res.status, d: await res.json() };
}
const member = async (id: string) => (await fake.client.member.findFirst({ where: { id } })) as Record<string, unknown>;
const audits = async (action: string) => ((await fake.client.billingAuditLog.findMany({})) as { action: string }[]).filter((a) => a.action === action);

(async () => {
  CURRENT = session;

  console.log("\nfamilyWallet (Jason is Jack's guardian, no Paid by yet):");
  const w = await W.familyWallet("c1", "jack");
  ok(w?.payerUserId === "u_jason" && w.payerName === "Jason Reynolds", "Jack's umbrella is Jason");
  ok(w?.sources.length === 1 && w.sources[0].customerId === "cus_owen", "Jason's card on Owen is in Jack's wallet");
  ok(!w?.sources.some((x) => x.customerId === "cus_other"), "another payer's card is not");

  console.log("\nuse_family_card:");
  DENY = true;
  let r = await act("jack", { action: "use_family_card", sourceMemberId: "owen", paymentMethodRef: pmRef("pm_jason") });
  ok(r.status === 403, "billing:full only");
  DENY = false;
  r = await act("jack", { action: "use_family_card", sourceMemberId: "lucas", paymentMethodRef: pmRef("pm_other") });
  ok(r.status === 409 && r.d.code === "NOT_SAME_PAYER", "someone else's card → refused");
  r = await act("jack", { action: "use_family_card", sourceMemberId: "owen", paymentMethodRef: pmRef("pm_nope") });
  ok(r.status === 404 && r.d.code === "PM_GONE", "a card that's gone → 404");
  r = await act("jack", { action: "use_family_card", sourceMemberId: "owen", paymentMethodRef: pmRef("pm_cashapp") });
  ok(r.status === 409 && r.d.code === "NOT_CHARGEABLE", "a method that can't be charged automatically → refused");
  r = await act("jack", { action: "use_family_card", sourceMemberId: "owen", paymentMethodRef: pmRef("pm_jason") });
  ok(r.status === 200 && /Visa/.test(r.d.message) && /Nothing was charged/.test(r.d.message), "Jason's Visa becomes Jack's card on file, nothing charged");
  const jack = await member("jack");
  ok(jack.stripeSetupCustomerId === "cus_owen" && jack.stripeSetupPaymentMethodId === "pm_jason", "Jack now points at Owen's customer + that card");
  ok((await audits("FAMILY_CARD_LINKED")).length === 1, "audited");
  const w2 = await W.familyWallet("c1", "jack");
  ok(w2?.sharedWith.some((x) => x.name.startsWith("Owen")) && w2.sources.length === 0, "Jack's wallet now reads 'shared with Owen'");

  await fake.client.memberSubscription.create({ data: { id: "s_h", memberId: "hunter", status: "active", optionLabel: "Monthly", stripeSubscriptionId: "sub_h" } });
  r = await act("hunter", { action: "use_family_card", sourceMemberId: "owen", paymentMethodRef: pmRef("pm_jason") });
  ok(r.status === 409 && r.d.code === "LIVE_CARD_MEMBERSHIP", "a running card membership keeps its own card → refused");

  console.log("\nset_payer:");
  r = await act("jack", { action: "set_payer", payerUserId: "u_far" });
  ok(r.status === 400, "an account in another club → refused");
  r = await act("jack", { action: "set_payer", payerUserId: "u_jason", alsoMemberIds: ["far"] });
  ok(r.status === 404, "an athlete in another club → refused, nothing written");
  ok((await member("jack")).responsiblePayerUserId === null, "…and Jack wasn't changed");
  r = await act("jack", { action: "set_payer", payerUserId: "u_jason", alsoMemberIds: ["owen", "hunter"], payerIsCoach: true });
  ok(r.status === 200 && /3 athletes/.test(r.d.message) && /siblings/.test(r.d.message), "Jason pays for Jack, Owen and Hunter in one step");
  ok((await member("owen")).responsiblePayerUserId === "u_jason" && (await member("hunter")).responsiblePayerUserId === "u_jason", "Paid by written on all three");
  const links = (await fake.client.memberGuardianUser.findMany({})) as { id: string; relationship: string | null }[];
  ok(links.find((l) => l.id === "g1")?.relationship === "Coach" && links.find((l) => l.id === "g2")?.relationship === "Coach", "Jason's own guardian links relabelled Coach");
  ok(links.find((l) => l.id === "g4")?.relationship === "Mother", "the mother's link is untouched");
  ok((await audits("PAYER_SET")).length === 3, "one audit row per athlete");
  r = await act("jack", { action: "set_payer", payerUserId: null });
  ok(r.status === 200 && (await member("jack")).responsiblePayerUserId === null, "clear → back to implied");

  console.log("\nGET /payer:");
  r = await getPayer("jack", "q=jason%20reynolds");
  ok(r.status === 200 && r.d.results.length === 1 && r.d.results[0].name === "Jason Reynolds", "'jason reynolds' finds him, never the other club's Jason");
  r = await getPayer("jack", "q=j");
  ok(r.d.results.length === 0, "one letter → nothing");
  r = await getPayer("jack", "forUserId=u_jason");
  ok(r.status === 200 && r.d.athletes.length === 2 && r.d.isCoachHere === true, "lists the others he's linked to / pays for; knows he's Jack's coach");
  DENY = true;
  r = await getPayer("jack", "q=jason");
  ok(r.status === 403, "billing:full only");
  DENY = false;

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
