/**
 * The large-send email queue worker (app/api/cron/email-queue) — exercised.
 *
 *   npx tsx scripts/email-queue-tests.ts
 *
 * Pins the 2026-10-12 fix: queued rows are SENT (no "Transaction already
 * closed"), each exactly once, a rate-limited provider answer is retried,
 * a second run sends nothing again, and a crash mid-dispatch never loses
 * the recipient. Real route + real sendClubEmail; fake Prisma; fake Resend.
 */
import { makeFakeDb, installFakePrisma } from "./fake-prisma";

process.env.CRON_SECRET = "test-secret";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "Club <club@example.test>";

const fake = makeFakeDb({ relations: {}, uniques: { emailSend: [["sendBatchId", "dedupeKey"]] } });
const sent: string[] = [];
let rateLimitOnce = new Set<string>(["b@example.test"]);
let throwFor: string | null = null;
class FakeResend {
  emails = {
    send: async (m: { to: string }) => {
      if (throwFor === m.to) throw new Error("network down");
      if (rateLimitOnce.has(m.to)) {
        rateLimitOnce.delete(m.to);
        return { data: null, error: { name: "rate_limit_exceeded", statusCode: 429, message: "Too many requests. You can only make 10 requests per second." } };
      }
      sent.push(m.to);
      return { data: { id: `msg_${sent.length}` }, error: null };
    },
  };
}
installFakePrisma(fake.client, { resend: { Resend: FakeResend } });

let pass = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${label}`); } else { failures.push(label); console.log(`  ✗ ${label} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

const queued = (id: string, to: string) => ({
  id, clubId: "c1", kind: "MARKETING", status: "QUEUED", recipientEmail: to, recipientUserId: null, recipientMemberId: null,
  subject: "Hello", bodyHtml: "<p>Hi</p>", bodyText: "Hi", bodyJson: null, fromName: "Club", fromEmail: null, replyTo: null,
  personalization: null, sendBatchId: "batch1", dedupeKey: to, idempotencyKey: null, announcementId: null, campaignId: null,
  templateId: null, sentByUserId: "owner", relatedEventId: null, relatedMembershipId: null, queuedAt: new Date("2026-10-12T17:00:00Z"),
  providerMessageId: null, error: null,
});
fake.seed("emailSend", [queued("r1", "a@example.test"), queued("r2", "b@example.test"), queued("r3", "c@example.test")]);

async function drain() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../app/api/cron/email-queue/route.ts") as { GET: (r: Request) => Promise<Response> };
  const realWarn = console.warn, realErr = console.error;
  console.warn = console.error = () => {};
  try {
    const res = await mod.GET(new Request("http://localhost/api/cron/email-queue", { headers: { authorization: "Bearer test-secret" } }));
    return { status: res.status, body: await res.json() };
  } finally {
    console.warn = realWarn; console.error = realErr;
  }
}

async function main() {
  console.log("\nQueued rows are sent, once each");
  const t0 = Date.now();
  const r = await drain();
  eq("the worker answers 200", r.status, 200);
  const rows = fake.table("emailSend");
  eq("every recipient sent exactly once", [...sent].sort(), ["a@example.test", "b@example.test", "c@example.test"]);
  eq("every row is SENT with a provider id (opens/deliveries can be tracked)", rows.map((x) => [x.recipientEmail, x.status, !!x.providerMessageId]).sort(), [
    ["a@example.test", "SENT", true], ["b@example.test", "SENT", true], ["c@example.test", "SENT", true]]);
  eq("one row per recipient — nothing duplicated, nothing left queued", [rows.length, rows.filter((x) => x.status === "QUEUED").length], [3, 0]);
  eq("no 'Transaction already closed' anywhere", rows.some((x) => /Transaction/.test(String(x.error ?? ""))), false);
  eq("the rate-limited recipient was retried, not failed", rows.find((x) => x.recipientEmail === "b@example.test")!.status, "SENT");
  eq("calls are spaced out (≤ 8 a second)", Date.now() - t0 >= 250, true);

  console.log("\nRunning again sends nothing again");
  await drain();
  eq("still exactly three sends", sent.length, 3);

  console.log("\nA crash mid-dispatch never loses the recipient");
  fake.seed("emailSend", [queued("r4", "d@example.test")]);
  rateLimitOnce = new Set();
  throwFor = "d@example.test";
  await drain();
  const d = fake.table("emailSend").filter((x) => x.recipientEmail === "d@example.test");
  eq("…the recipient is still there, marked FAILED with the reason", d.map((x) => [x.status, x.error]), [["FAILED", "network down"]]);

  console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
