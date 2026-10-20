/**
 * "Retry payment" on a past-due card membership (2026-10-20).
 *
 *   npx tsx scripts/retry-payment-tests.ts
 *
 * Vancen Small's $175 charge was declined (insufficient funds). The panel's
 * "Retry payment" only showed a message, so it looked broken. It now charges
 * the open Stripe invoice. The REAL route handler is called against the
 * in-memory fake DB and a fake Stripe that records every call.
 *
 * Pins: billing:full only · preview charges nothing · confirm pays the newest
 * OPEN invoice of THIS subscription, on the club's connected account, with an
 * idempotency key · a decline says so, charges nothing, and is audited ·
 * nothing open → refused · offline row → refused · another club's member → 404.
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

const fake = makeFakeDb({ relations: {} });
let CURRENT: unknown = null;
let DENY = false;
const calls: { fn: string; args: unknown[] }[] = [];
let openInvoices: Record<string, unknown>[] = [];
let declineWith: string | null = null;
const fakeStripe = {
  invoices: {
    list: async (...args: unknown[]) => { calls.push({ fn: "invoices.list", args }); return { data: openInvoices }; },
    pay: async (...args: unknown[]) => {
      calls.push({ fn: "invoices.pay", args });
      if (declineWith) throw Object.assign(new Error(declineWith), { type: "StripeCardError" });
      return { id: args[0], status: "paid" };
    },
  },
  subscriptions: { retrieve: async () => { throw new Error("not used"); }, update: async () => { throw new Error("not used"); } },
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
const route = require("../app/api/members/[id]/billing-admin/actions/route.ts") as typeof import("../app/api/members/[id]/billing-admin/actions/route");

fake.seed("club", [{ id: "c1", name: "Club", stripeAccountId: "acct_1" }, { id: "c2", name: "Other", stripeAccountId: "acct_2" }]);
fake.seed("member", [
  { id: "m1", clubId: "c1", firstName: "Vancen", lastName: "Small", deletedAt: null },
  { id: "m2", clubId: "c2", firstName: "Else", lastName: "Where", deletedAt: null },
]);
fake.seed("memberSubscription", [
  { id: "s1", memberId: "m1", status: "past_due", optionLabel: "Monthly Full Membership", stripeSubscriptionId: "sub_1" },
  { id: "s2", memberId: "m1", status: "active", optionLabel: "Cash", stripeSubscriptionId: null },
  { id: "s3", memberId: "m2", status: "past_due", optionLabel: "X", stripeSubscriptionId: "sub_3" },
]);
fake.seed("billingAuditLog", []);

const session = { user: { id: "u1", clubId: "c1", role: "OWNER" } };
async function call(memberId: string, body: Record<string, unknown>) {
  const req = new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, ...body }) });
  const res = await route.POST(req, { params: Promise.resolve({ id: memberId }) });
  return { status: res.status, d: await res.json() };
}
const pays = () => calls.filter((c) => c.fn === "invoices.pay");
const audits = () => (fake.client as unknown as { billingAuditLog: { findMany: (a: unknown) => Promise<{ action: string }[]> } }).billingAuditLog.findMany({});

(async () => {
  CURRENT = session;
  openInvoices = [
    { id: "in_old", created: 100, amount_due: 17500, attempt_count: 1 },
    { id: "in_new", created: 200, amount_due: 18008, attempt_count: 2 },
  ];

  console.log("\nPermission:");
  DENY = true;
  let r = await call("m1", { action: "retry_payment", subscriptionId: "s1", confirmImmediateCharge: true });
  ok(r.status === 403 && pays().length === 0, "without billing:full → 403, nothing charged");
  DENY = false;

  console.log("\nPreview:");
  r = await call("m1", { action: "retry_payment", subscriptionId: "s1" });
  ok(r.status === 200 && r.d.preview?.amount === 180.08, "preview shows the newest open invoice ($180.08)");
  ok(r.d.preview?.attempts === 2, "…and how many times it was declined");
  ok(pays().length === 0, "preview charges nothing");
  const list = calls.find((c) => c.fn === "invoices.list");
  ok((list?.args[0] as { subscription?: string; status?: string })?.subscription === "sub_1" && (list?.args[0] as { status?: string }).status === "open", "only THIS subscription's OPEN invoices are looked at");
  ok((list?.args[1] as { stripeAccount?: string })?.stripeAccount === "acct_1", "on the club's connected account");

  console.log("\nCharge:");
  r = await call("m1", { action: "retry_payment", subscriptionId: "s1", confirmImmediateCharge: true });
  ok(r.status === 200 && /Charged \$180\.08/.test(r.d.message), "confirm → charged, says the amount");
  const p = pays()[0];
  ok(p?.args[0] === "in_new", "pays the newest open invoice");
  ok((p?.args[2] as { idempotencyKey?: string })?.idempotencyKey === "aox-retry-in_new-2", "idempotency key per invoice + attempt (a double-click can't charge twice)");
  ok((await audits()).some((a) => a.action === "PAYMENT_RETRIED"), "audited PAYMENT_RETRIED");
  ok((await fake.client.memberSubscription.findFirst({ where: { id: "s1" } }) as { status: string }).status === "past_due", "no local write — the invoice.paid webhook reactivates it");

  console.log("\nDeclined again:");
  declineWith = "Your card has insufficient funds.";
  const before = pays().length;
  r = await call("m1", { action: "retry_payment", subscriptionId: "s1", confirmImmediateCharge: true });
  ok(r.status === 402 && /insufficient funds/.test(r.d.error) && /nothing was charged/.test(r.d.error), "402 with Stripe's reason and 'nothing was charged'");
  ok(pays().length === before + 1, "one attempt, no loop");
  ok((await audits()).some((a) => a.action === "PAYMENT_RETRY_FAILED"), "audited PAYMENT_RETRY_FAILED");
  declineWith = null;

  console.log("\nRefusals:");
  openInvoices = [];
  r = await call("m1", { action: "retry_payment", subscriptionId: "s1", confirmImmediateCharge: true });
  ok(r.status === 409 && r.d.code === "NOTHING_DUE", "nothing open → NOTHING_DUE, nothing charged");
  r = await call("m1", { action: "retry_payment", subscriptionId: "s2", confirmImmediateCharge: true });
  ok(r.status === 409 && /isn't billed by card/.test(r.d.error), "cash row → refused");
  r = await call("m2", { action: "retry_payment", subscriptionId: "s3", confirmImmediateCharge: true });
  ok(r.status === 404, "another club's member → 404");
  r = await call("m1", { action: "retry_payment", subscriptionId: "s3", confirmImmediateCharge: true });
  ok(r.status === 404, "another member's subscription id → 404");

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
