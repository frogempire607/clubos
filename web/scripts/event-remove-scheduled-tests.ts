/**
 * Removing an event registrant whose card charge is SCHEDULED (2026-11-12).
 *
 *   npx tsx scripts/event-remove-scheduled-tests.ts
 *
 * Lincoln Martinez, Finger Lakes Duals: $85 scheduled for Nov 14. The remove
 * dialog said "Cancel the scheduled charge before removing them" — a button
 * that never existed. A scheduled charge hasn't happened yet (no Stripe
 * PaymentIntent until it runs), so removing now cancels it. Once a charge has
 * started, removing is refused. The REAL DELETE handler, fake DB.
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

const fake = makeFakeDb({ relations: { eventRegistration: { event: { model: "event", kind: "one", fk: "eventId" } } } });
let CURRENT: unknown = { user: { id: "owner", clubId: "c1", role: "OWNER" } };
installFakePrisma(fake.client, {
  "next-auth": { getServerSession: async () => CURRENT, default: {} },
  "@/lib/auth": { authOptions: {} },
  "@/lib/apiGuard": { requirePermission: () => null, requirePermissionLive: async () => null },
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("../app/api/events/[id]/registrations/[regId]/route.ts") as typeof import("../app/api/events/[id]/registrations/[regId]/route");

const R = (id: string, o: Record<string, unknown> = {}) => ({
  id, clubId: "c1", eventId: "e1", memberId: `m_${id}`, name: id, status: "SCHEDULED", amountDue: 85, amountPaid: null,
  scheduledChargeAt: new Date("2026-11-14T12:00:00Z"), stripePaymentIntentId: null, transactionId: null, paymentUrl: null, ...o,
});
fake.seed("event", [{ id: "e1", clubId: "c1", name: "Finger Lakes Duals" }]);
fake.seed("eventRegistration", [R("lincoln"), R("started", { stripePaymentIntentId: "pi_1" }), R("paid", { status: "PAID", amountPaid: 85 })]);
fake.seed("booking", [{ id: "b1", eventId: "e1", memberId: "m_lincoln" }]);
fake.seed("billingAuditLog", []);

const del = async (regId: string) => {
  const res = await route.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: "e1", regId }) });
  return { status: res.status, d: await res.json() };
};
const reg = async (id: string) => (await fake.client.eventRegistration.findFirst({ where: { id } })) as Record<string, unknown>;

(async () => {
  console.log("\nScheduled, not charged yet:");
  let r = await del("lincoln");
  ok(r.status === 200 && r.d.status === "CANCELED", "Lincoln is removed");
  const l = await reg("lincoln");
  ok(l.status === "CANCELED" && l.scheduledChargeAt === null && l.amountDue === null, "…the scheduled charge is gone (status, date and amount cleared)");
  ok(((await fake.client.booking.findMany({})) as unknown[]).length === 0, "…and he's off the attendee roster");

  console.log("\nA charge already started:");
  r = await del("started");
  ok(r.status === 409 && /already being processed/.test(r.d.error), "refused — wait, then refund");
  ok((await reg("started")).status === "SCHEDULED", "…nothing changed");

  console.log("\nAlready paid:");
  r = await del("paid");
  ok(r.status === 409 && /Refund them first/.test(r.d.error), "still refused — refund first");

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
