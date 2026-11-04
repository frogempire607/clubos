/**
 * Coach pays for a team · cards belong to PEOPLE · "Paid by" (2026-10-29 → 2026-11-03).
 *
 *   npx tsx scripts/team-payer-tests.ts
 *
 * Jason Reynolds (a coach) pays memberships for his team; his card was saved
 * once, on Owen. Thaeden's MOM's card is on file for Thaeden — and after
 * Thaeden was added to "Paid by Jason", her card showed on every one of
 * Jason's athletes. Now a card has an owner (a person) and an athlete is only
 * offered the cards of the people who pay for them.
 *
 * Pure rules, then the REAL handlers against the fake DB and a fake Stripe:
 *   · legacyCardOwner / payersFor / ownerOfCustomer / siblingFamilyKey / liveSubBelongsTo
 *   · walletsFor: Jason's card on his team; mom's card ONLY on Thaeden
 *   · use_family_card: only a payer's card; never another family's; stamps the owner
 *   · payment-methods/setup: the card goes to the chosen person's wallet;
 *     the athlete's card on file only changes when it's empty or theirs
 *   · set_payer + GET /payer
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";
import { siblingFamilyKey, isCoachRelationship } from "../lib/membershipSiblingDiscount";
import { pmRef } from "../lib/billingAdmin";

const fake = makeFakeDb({ relations: { member: { guardianLinks: { model: "memberGuardianUser", kind: "many", fk: "memberId" } } } });
let CURRENT: unknown = null;
let DENY = false;
type PM = { id: string; type: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } };
const card = (id: string, last4: string): PM => ({ id, type: "card", card: { brand: "mastercard", last4, exp_month: 3, exp_year: 2030 } });
const PMS: Record<string, PM[]> = {
  cus_jason: [card("pm_jason", "8793"), { id: "pm_cashapp", type: "cashapp" }],
  cus_mom: [card("pm_mom", "1234")],
  cus_other: [card("pm_other", "1111")],
};
const META: Record<string, Record<string, string>> = { cus_mom: {}, cus_jason: {}, cus_other: {} };
const checkouts: Record<string, unknown>[] = [];
const subsCreated: Record<string, unknown>[] = [];
let newCus = 0;
const fakeStripe = {
  customers: {
    listPaymentMethods: async (cus: string) => ({ data: PMS[cus] ?? [] }),
    retrieve: async (id: string) => ({ id, metadata: META[id] ?? {}, invoice_settings: { default_payment_method: null } }),
    update: async (id: string, p: { metadata?: Record<string, string> }) => { META[id] = { ...(META[id] ?? {}), ...(p.metadata ?? {}) }; return { id }; },
    create: async (p: { metadata?: Record<string, string> }) => { const id = `cus_new${++newCus}`; META[id] = { ...(p.metadata ?? {}) }; PMS[id] = []; return { id }; },
  },
  // Owen's membership already lives on Jason's customer — it must NOT block the next athlete.
  subscriptions: {
    list: async (p: { customer: string }) => ({ data: p.customer === "cus_jason" ? [{ id: "sub_owen", status: "active", metadata: { memberId: "owen" } }] : [] }),
    create: async (p: Record<string, unknown>) => { subsCreated.push(p); return { id: `sub_new${subsCreated.length}`, status: "trialing", current_period_end: 1796083200, trial_end: 1796083200, items: { data: [] }, latest_invoice: null, metadata: p.metadata }; },
  },
  paymentMethods: {
    retrieve: async (id: string) => { const c = Object.keys(PMS).find((k) => PMS[k].some((x) => x.id === id)); return { ...(PMS[c!]?.find((x) => x.id === id) ?? { id, type: "card" }), customer: c ?? null }; },
    list: async (p: { customer: string }) => ({ data: PMS[p.customer] ?? [] }),
  },
  products: { create: async () => ({ id: "prod_1" }), retrieve: async () => ({ id: "prod_1", active: true }) },
  prices: { create: async () => ({ id: "price_1" }) },
  checkout: { sessions: { create: async (p: Record<string, unknown>) => { checkouts.push(p); return { url: "https://stripe.test/setup" }; } } },
};
installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => CURRENT, default: {} },
  "@/lib/auth": { authOptions: {} },
  // The real module (fee helpers, intervals…) with only the client swapped.
  "@/lib/stripe": new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "stripe") return fakeStripe;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require("../lib/stripe.ts") as Record<string, unknown>)[prop];
    },
  }),
  // The portal's "who am I acting for": the member asked for, as long as it exists (authorization is tested elsewhere).
  "@/lib/memberContext": {
    resolveFamilyContext: async (_u: string, clubId: string, _e: string, memberId?: string) => {
      const context = memberId ? await fake.client.member.findFirst({ where: { id: memberId, clubId } }) : null;
      return { context };
    },
  },
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
const setupRoute = require("../app/api/members/[id]/payment-methods/setup/route.ts") as typeof import("../app/api/members/[id]/payment-methods/setup/route");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const portalSetup = require("../app/api/member/payment-method/setup/route.ts") as typeof import("../app/api/member/payment-method/setup/route");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const W = require("../lib/payerWallet.ts") as typeof import("../lib/payerWallet");

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

console.log("\nlegacyCardOwner (unstamped cards):");
const minor = { isMinor: true, userId: null, responsiblePayerUserId: "jason" };
ok(W.legacyCardOwner(minor, [{ userId: "jason", relationship: "Coach" }]) === "jason", "Owen: only the coach → the coach's card");
ok(W.legacyCardOwner(minor, [{ userId: "mom", relationship: "Parent" }, { userId: "jason", relationship: "Coach" }]) === "mom", "Thaeden: mom is family → mom's card, even though Jason pays");
ok(W.legacyCardOwner({ isMinor: false, userId: "adult", responsiblePayerUserId: null }, []) === "adult", "an adult's own card");

console.log("\npayersFor:");
const tp = W.payersFor(minor, [{ userId: "mom", relationship: "Parent" }, { userId: "jason", relationship: "Coach" }]);
ok(tp.length === 2 && tp[0].userId === "jason" && tp[0].roles.includes("MEMBERSHIPS") && tp[1].userId === "mom" && tp[1].roles.includes("GUARDIAN"), "Thaeden: Jason (memberships) and mom (guardian)");
ok(W.payersFor({ isMinor: true, userId: null, responsiblePayerUserId: null }, [{ userId: "jason", relationship: "Coach" }]).length === 0, "a coach link alone isn't a payer");
ok(W.ownerOfCustomer("x", ["a", "a"]) === "x" && W.ownerOfCustomer(null, ["a", "b", "a"]) === "a" && W.ownerOfCustomer(null, [null]) === null, "ownerOfCustomer: stamp wins, else the majority");

console.log("\nsiblingFamilyKey:");
const base = { memberUserId: null, memberResponsiblePayerUserId: null, guardianUserIds: ["mom"], coachUserIds: [] as string[], primaryFamilyGuardian: "mom" };
ok(siblingFamilyKey({ ...base, payerUserId: "mom" }) === "mom", "a parent who pays: unchanged");
ok(siblingFamilyKey({ ...base, payerUserId: null }) === "mom", "nobody named: the primary guardian");
ok(siblingFamilyKey({ ...base, payerUserId: "coach", memberResponsiblePayerUserId: "coach" }) === "mom", "coach as Paid by → the athlete's own family");
ok(siblingFamilyKey({ ...base, guardianUserIds: ["coach"], coachUserIds: ["coach"], primaryFamilyGuardian: null, payerUserId: "coach" }) === null, "coach-labelled guardian → not family");
ok(siblingFamilyKey({ ...base, payerUserId: "michael" }) === "michael", "a transfer's subscription payer keeps the old behaviour");
ok(isCoachRelationship("Coach") && !isCoachRelationship("Parent") && !isCoachRelationship(null), "isCoachRelationship");

console.log("\nliveSubBelongsTo (shared customers):");
ok(actions.liveSubBelongsTo({ memberId: "jack" }, "jack") && !actions.liveSubBelongsTo({ memberId: "owen" }, "jack"), "Owen's subscription on Jason's card doesn't block Jack");
ok(actions.liveSubBelongsTo({}, "jack") && actions.liveSubBelongsTo(null, "jack"), "no member metadata → counted (fail closed)");

// ── World ───────────────────────────────────────────────────────────────────
const M = (id: string, first: string, extra: Record<string, unknown> = {}) => ({
  id, clubId: "c1", firstName: first, lastName: "X", email: null, guardianEmail: null, isMinor: true, userId: null, responsiblePayerUserId: null,
  stripeSetupCustomerId: null, stripeCustomerId: null, stripeSetupPaymentMethodId: null, deletedAt: null, ...extra,
});
fake.seed("club", [{ id: "c1", name: "Club", stripeAccountId: "acct_1", stripeChargesEnabled: true }]);
fake.seed("user", [
  { id: "u_jason", clubId: "c1", firstName: "Jason", lastName: "Reynolds", email: "jreynolds@homercentral.org", deletedAt: null },
  { id: "u_mom", clubId: "c1", firstName: "Erin", lastName: "McGuinness", email: "erin@x.com", deletedAt: null },
  { id: "u_dad", clubId: "c1", firstName: "Dan", lastName: "Brown", email: "dan@x.com", deletedAt: null },
  { id: "u_other", clubId: "c1", firstName: "Olive", lastName: "Other", email: "o@x.com", deletedAt: null },
  { id: "u_far", clubId: "c2", firstName: "Jason", lastName: "Elsewhere", email: "j@other.com", deletedAt: null },
]);
fake.seed("member", [
  M("owen", "Owen", { lastName: "Burhans", responsiblePayerUserId: "u_jason", stripeSetupCustomerId: "cus_jason", stripeSetupPaymentMethodId: "pm_jason" }),
  M("jack", "Jack", { lastName: "Brown", responsiblePayerUserId: "u_jason" }),
  M("braiden", "Braiden", { lastName: "Murray", responsiblePayerUserId: "u_jason" }),
  M("thaeden", "Thaeden", { lastName: "McGuinness", responsiblePayerUserId: "u_jason", stripeSetupCustomerId: "cus_mom", stripeSetupPaymentMethodId: "pm_mom" }),
  M("lucas", "Lucas", { lastName: "Other", responsiblePayerUserId: "u_other", stripeSetupCustomerId: "cus_other", stripeSetupPaymentMethodId: "pm_other" }),
  { ...M("far", "Far"), clubId: "c2" },
  // For Assign → Charge to: a team kid with no card, and Thaeden's twin on mom's card.
  M("kaden", "Kaden", { lastName: "Bush", responsiblePayerUserId: "u_jason", requestedPaymentMethod: "CARD", migrationMembershipId: "plan_ms", migrationSelectedOption: { id: "opt_2day" }, migrationFinalBillingDate: new Date("2026-12-01T12:00:00Z") }),
  M("tess", "Tess", { lastName: "McGuinness", responsiblePayerUserId: "u_jason", requestedPaymentMethod: "CARD", migrationMembershipId: "plan_ms", migrationSelectedOption: { id: "opt_2day" }, migrationFinalBillingDate: new Date("2026-12-01T12:00:00Z"), stripeSetupCustomerId: "cus_mom", stripeSetupPaymentMethodId: "pm_mom" }),
]);
fake.seed("membership", [{ id: "plan_ms", clubId: "c1", name: "MS/HS", deletedAt: null, contractMonths: null, autoRenewDefault: true, stripeProductId: "prod_1", stripePriceIds: {},
  options: [{ id: "opt_2day", label: "Monthly 2 days (Tue/Thu)", price: 110, billingPeriod: "MONTHLY", contractMonths: 1, autoRenewDefault: false }] }]);
const L = (id: string, memberId: string, userId: string, relationship: string | null, isPrimary = true, at = "2026-07-01") =>
  ({ id, clubId: "c1", memberId, userId, status: "CONFIRMED", isPrimary, relationship, createdAt: new Date(at) });
fake.seed("memberGuardianUser", [
  L("g_owen", "owen", "u_jason", "Coach"), L("g_jack", "jack", "u_jason", null), L("g_braiden", "braiden", "u_jason", "Coach"),
  L("g_th_mom", "thaeden", "u_mom", "Parent", true), L("g_th_j", "thaeden", "u_jason", "Coach", false, "2026-10-01"),
  L("g_kaden", "kaden", "u_jason", "Coach"),
  L("g_tess_mom", "tess", "u_mom", "Parent", true), L("g_tess_j", "tess", "u_jason", "Coach", false, "2026-10-01"),
]);
fake.seed("memberSubscription", [{ id: "s_th", memberId: "thaeden", status: "active", optionLabel: "Monthly 2 days (Tue/Thu)", stripeSubscriptionId: "sub_th" }]);
fake.seed("billingAuditLog", []);

const session = { user: { id: "staff", clubId: "c1", role: "OWNER" } };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function act(memberId: string, body: Record<string, unknown>) {
  const res = await actions.POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, ...body }) }), params(memberId));
  return { status: res.status, d: await res.json() };
}
async function setup(memberId: string, body: Record<string, unknown>) {
  const res = await setupRoute.POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(memberId));
  return { status: res.status, d: await res.json() };
}
async function getPayer(memberId: string, qs: string) {
  const res = await payerRoute.GET(new Request(`http://x/api?${qs}`), params(memberId));
  return { status: res.status, d: await res.json() };
}
const member = async (id: string) => (await fake.client.member.findFirst({ where: { id } })) as Record<string, unknown>;
const audits = async (action: string) => ((await fake.client.billingAuditLog.findMany({})) as { action: string }[]).filter((a) => a.action === action);
const custIds = (w: Awaited<ReturnType<typeof W.walletsFor>>) => (w?.wallets ?? []).flatMap((x) => x.customers.map((c) => c.customerId));

(async () => {
  CURRENT = session;

  console.log("\nwalletsFor — whose cards each athlete is offered:");
  const wj = await W.walletsFor("c1", "jack", "acct_1");
  ok(wj?.wallets.length === 1 && wj.wallets[0].ownerName === "Jason Reynolds", "Jack: only Jason pays for him");
  ok(custIds(wj).includes("cus_jason"), "…Jason's card (saved on Owen) is offered");
  ok(!custIds(wj).includes("cus_mom"), "…Thaeden's MOM's card is NOT — the bug Julian saw");
  const wt = await W.walletsFor("c1", "thaeden", "acct_1");
  const tJ = wt?.wallets.find((x) => x.ownerUserId === "u_jason"), tM = wt?.wallets.find((x) => x.ownerUserId === "u_mom");
  ok(!!tJ && tJ.customers.some((c) => c.customerId === "cus_jason"), "Thaeden: Jason's card, for memberships");
  ok(!!tM && tM.customers.some((c) => c.customerId === "cus_mom") && wt?.onFile?.ownerUserId === "u_mom", "Thaeden: his mom's card, and it's the one on file");
  const wl = await W.walletsFor("c1", "lucas", "acct_1");
  ok(!custIds(wl).includes("cus_jason") && !custIds(wl).includes("cus_mom"), "another family sees neither");

  console.log("\nuse_family_card (Use as card on file):");
  DENY = true;
  let r = await act("jack", { action: "use_family_card", ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_jason") });
  ok(r.status === 403, "billing:full only");
  DENY = false;
  r = await act("jack", { action: "use_family_card", ownerUserId: "u_mom", paymentMethodRef: pmRef("pm_mom") });
  ok(r.status === 409 && r.d.code === "NOT_A_PAYER", "Jack can't use Thaeden's mom's card");
  r = await act("jack", { action: "use_family_card", ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_cashapp") });
  ok(r.status === 409 && r.d.code === "NOT_CHARGEABLE", "a method that can't be charged automatically → refused");
  r = await act("jack", { action: "use_family_card", ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_gone") });
  ok(r.status === 404 && r.d.code === "PM_GONE", "a card that's gone → 404");
  r = await act("jack", { action: "use_family_card", ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_jason") });
  ok(r.status === 200 && /Jason Reynolds's .*8793.* is now Jack's card on file\. Nothing was charged/.test(r.d.message), "Jason's Mastercard becomes Jack's card on file, nothing charged");
  const jack = await member("jack");
  ok(jack.stripeSetupCustomerId === "cus_jason" && jack.stripeSetupPaymentMethodId === "pm_jason", "Jack points at Jason's customer + card");
  ok(META.cus_jason[W.OWNER_META] === "u_jason", "Jason's customer is now stamped as his");
  ok((await audits("FAMILY_CARD_LINKED")).length === 1, "audited");
  r = await act("thaeden", { action: "use_family_card", ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_jason") });
  ok(r.status === 409 && r.d.code === "LIVE_CARD_MEMBERSHIP" && /Charge to/.test(r.d.error), "Thaeden's running membership keeps mom's card; told to use Charge to next time");

  console.log("\nAdd card → the owner's wallet:");
  r = await setup("thaeden", { intent: "ADD", ownerUserId: "u_jason" });
  let co = checkouts.at(-1) as { customer: string; metadata: Record<string, string> };
  ok(r.status === 200 && r.d.intent === "WALLET" && co.customer === "cus_jason", "Jason adds a card on Thaeden → Jason's wallet; mom's stays on file");
  ok((await member("thaeden")).stripeSetupCustomerId === "cus_mom", "…Thaeden's card on file is untouched");
  r = await setup("thaeden", { intent: "ADD", ownerUserId: "u_mom" });
  co = checkouts.at(-1) as typeof co;
  ok(r.status === 200 && r.d.intent === "ADD" && co.customer === "cus_mom", "mom adds a card on Thaeden → her own customer, on file");
  r = await setup("braiden", { intent: "ADD" });
  co = checkouts.at(-1) as typeof co;
  ok(r.status === 200 && r.d.intent === "ADD" && co.customer === "cus_jason", "Braiden (no card yet): defaults to Jason, joins his wallet");
  await fake.client.memberGuardianUser.create({ data: L("g_jack_dad", "jack", "u_dad", "Father", false, "2026-11-01") });
  r = await setup("jack", { intent: "ADD", ownerUserId: "u_dad" });
  co = checkouts.at(-1) as typeof co;
  ok(r.status === 200 && r.d.intent === "WALLET" && co.customer.startsWith("cus_new"), "Jack's dad joins: his card gets its OWN customer — never Jason's");
  ok(META[co.customer][W.OWNER_META] === "u_dad", "…stamped as the dad's");
  ok((await member("jack")).stripeSetupCustomerId === "cus_jason", "…and Jack's card on file stays Jason's until staff picks the dad's");
  const wo = await W.walletsFor("c1", "owen", "acct_1");
  ok(!custIds(wo).some((c) => c.startsWith("cus_new")), "Owen (not the dad's kid) never sees the dad's card");
  r = await setup("jack", { intent: "ADD", ownerUserId: "u_far" });
  ok(r.status === 409 && r.d.code === "NOT_A_PAYER", "someone who doesn't pay for Jack → refused");

  console.log("\nParent portal: a parent saves a card for their own kid:");
  CURRENT = { user: { id: "u_dad", clubId: "c1", role: "MEMBER" } };
  let pr = await portalSetup.POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: "jack" }) }));
  let pco = checkouts.at(-1) as { customer: string };
  ok(pr.status === 200 && pco.customer !== "cus_jason" && META[pco.customer]?.[W.OWNER_META] === "u_dad", "Jack's dad → his OWN customer, never Jason's");
  CURRENT = { user: { id: "u_mom", clubId: "c1", role: "MEMBER" } };
  pr = await portalSetup.POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: "tess" }) }));
  pco = checkouts.at(-1) as typeof pco;
  ok(pr.status === 200 && pco.customer === "cus_mom", "Tess's mom → her existing customer (same wallet as Thaeden's)");
  CURRENT = session;

  console.log("\nAssign by card → Charge to:");
  r = await act("kaden", { action: "activate_card", chargeCard: { ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_jason") } });
  let sc = subsCreated.at(-1) as { customer?: string; default_payment_method?: string; metadata?: Record<string, string> } | undefined;
  ok(r.status === 200, `Kaden (no card of his own) → membership on Jason's card: ${r.status} ${JSON.stringify(r.d).slice(0, 300)}`);
  ok(sc?.customer === "cus_jason" && sc?.default_payment_method === "pm_jason" && sc?.metadata?.memberId === "kaden", "…the Stripe subscription is on Jason's customer + card, tagged Kaden");
  ok(!/already/i.test(JSON.stringify(r.d)), "…Owen's membership on the same customer didn't block it");
  const kSub = (await fake.client.memberSubscription.findFirst({ where: { memberId: "kaden" } })) as Record<string, unknown> | null;
  ok(kSub?.payerUserId === "u_jason", "…the membership records Jason as the payer");
  ok((await member("kaden")).stripeSetupPaymentMethodId == null, "…and Kaden's card on file is still empty (nothing written)");
  r = await act("tess", { action: "activate_card", chargeCard: { ownerUserId: "u_jason", paymentMethodRef: pmRef("pm_jason") } });
  sc = subsCreated.at(-1) as typeof sc;
  ok(r.status === 200 && sc?.customer === "cus_jason" && sc?.default_payment_method === "pm_jason", "Tess: membership on Jason's card…");
  const tess = await member("tess");
  ok(tess.stripeSetupCustomerId === "cus_mom" && tess.stripeSetupPaymentMethodId === "pm_mom", "…while mom's card stays on file for everything else");
  r = await act("kaden", { action: "activate_card", chargeCard: { ownerUserId: "u_mom", paymentMethodRef: pmRef("pm_mom") } });
  ok(r.status === 409 && (r.d.code === "NOT_A_PAYER" || r.d.code === "ALREADY_SUBSCRIBED"), "Kaden can never be charged on Tess's mom's card");

  console.log("\nset_payer:");
  r = await act("jack", { action: "set_payer", payerUserId: "u_far" });
  ok(r.status === 400, "an account in another club → refused");
  r = await act("jack", { action: "set_payer", payerUserId: "u_jason", alsoMemberIds: ["far"] });
  ok(r.status === 404, "an athlete in another club → refused, nothing written");
  r = await act("jack", { action: "set_payer", payerUserId: "u_jason", alsoMemberIds: ["owen", "braiden"], payerIsCoach: true });
  ok(r.status === 200 && /3 athletes/.test(r.d.message) && /siblings/.test(r.d.message), "Jason pays for three in one step, as coach");
  const links = (await fake.client.memberGuardianUser.findMany({})) as { id: string; relationship: string | null }[];
  ok(links.find((l) => l.id === "g_jack")?.relationship === "Coach" && links.find((l) => l.id === "g_jack_dad")?.relationship === "Father", "Jason's link relabelled Coach; the dad's untouched");
  r = await act("braiden", { action: "set_payer", payerUserId: null });
  ok(r.status === 200 && (await member("braiden")).responsiblePayerUserId === null, "clear → back to implied");

  console.log("\nGET /payer:");
  r = await getPayer("jack", "q=jason%20reynolds");
  ok(r.status === 200 && r.d.results.length === 1 && r.d.results[0].name === "Jason Reynolds", "'jason reynolds' finds him, never the other club's Jason");
  r = await getPayer("jack", "forUserId=u_jason");
  ok(r.status === 200 && r.d.isCoachHere === true && r.d.looksLikeTeam === true, "knows he's Jack's coach and spans several families");
  DENY = true;
  r = await getPayer("jack", "q=jason");
  ok(r.status === 403, "billing:full only");
  DENY = false;

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
