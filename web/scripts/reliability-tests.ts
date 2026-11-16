/**
 * One payment counts once, one email goes once, one approval grants once.
 *
 *   npx tsx scripts/reliability-tests.ts
 *
 * No database, no network. Pure helpers are exercised directly; the routes
 * that must CLAIM before they write are checked in source, because the bug in
 * each was an ordering one (read → write everything → close) that no unit of
 * arithmetic would catch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, type Transaction } from "@prisma/client";
import { QUEUE_PICKUP_GRACE_MS, isPickable, queuePickupCutoff, queuePickupWhere } from "../lib/emailQueue";
import { createTransactionOnce, isUniqueViolation } from "../lib/transactionOnce";
import { createSingleFlight } from "../lib/singleFlight";

const ROOT = join(__dirname, "..");
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const before = (hay: string, a: string, b: string) => hay.indexOf(a) >= 0 && hay.indexOf(b) >= 0 && hay.indexOf(a) < hay.indexOf(b);

async function main() {
  // Relative dates only — nothing here depends on today's calendar date.
  const now = new Date(Date.now());
  const ago = (ms: number) => new Date(now.getTime() - ms);

  console.log("\n§1 the email worker leaves a send in progress alone");
  check("a row queued a second ago is NOT pickable (an inline send may be mid-delivery)", !isPickable(ago(1000), now));
  check("a row queued just inside the grace period is NOT pickable", !isPickable(ago(QUEUE_PICKUP_GRACE_MS - 1000), now));
  check("a row exactly at the cutoff is NOT pickable (strictly older only)", !isPickable(ago(QUEUE_PICKUP_GRACE_MS), now));
  check("a row older than the grace period IS pickable (a send that died is recovered)", isPickable(ago(QUEUE_PICKUP_GRACE_MS + 1000), now));
  check("a row queued in the future (clock skew) is never pickable", !isPickable(new Date(now.getTime() + 60_000), now));
  check("the grace period outlasts the slowest inline send, and is not so long a blast stalls", QUEUE_PICKUP_GRACE_MS >= 60_000 && QUEUE_PICKUP_GRACE_MS <= 10 * 60_000);
  {
    const w = queuePickupWhere(now);
    check("the worker's filter is QUEUED and strictly older than the cutoff", w.status === "QUEUED" && w.queuedAt.lt.getTime() === queuePickupCutoff(now).getTime());
  }
  {
    const cron = code("app/api/cron/email-queue/route.ts");
    check("the worker selects with the pickup filter", /where:\s*pickup\b/.test(cron) && /const pickup = queuePickupWhere\(/.test(cron));
    check("the worker's CLAIM re-checks the filter (not just status)", /deleteMany\(\{ where: \{ id: row\.id, \.\.\.queuePickupWhere\(/.test(cron));
    check("no bare `status: \"QUEUED\"` selection is left in the worker", !/where:\s*\{\s*status:\s*"QUEUED"\s*\}/.test(cron));
    const send = code("lib/sendClubEmail.ts");
    check("recording a send's outcome can never throw on a missing row", !/prisma\.emailSend\.update\(/.test(send) && /settleEmailSend\(row\.id/.test(send));
  }

  console.log("\n§2 a Stripe payment is recorded once, and the retry carries on");
  {
    const row = (pi: string | null) => ({ id: `tx_${pi ?? "none"}`, stripePaymentIntentId: pi }) as unknown as Transaction;
    const store = new Map<string, Transaction>();
    let creates = 0;
    const db = {
      transaction: {
        async findUnique({ where }: { where: { stripePaymentIntentId: string } }) { return store.get(where.stripePaymentIntentId) ?? null; },
        async create({ data }: { data: Prisma.TransactionUncheckedCreateInput }) {
          creates++;
          const pi = (data.stripePaymentIntentId as string | undefined) ?? null;
          if (pi && store.has(pi)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
          const t = row(pi);
          if (pi) store.set(pi, t);
          return t;
        },
      },
    };
    const data = (pi?: string) => ({ clubId: "c", amount: 10, status: "SUCCEEDED", stripePaymentIntentId: pi }) as unknown as Prisma.TransactionUncheckedCreateInput;

    const first = await createTransactionOnce({ data: data("pi_1") }, db);
    check("first delivery creates the row", first.created && first.tx.id === "tx_pi_1" && creates === 1);
    const retry = await createTransactionOnce({ data: data("pi_1") }, db);
    check("a retry returns the SAME row and does not insert again", !retry.created && retry.tx.id === "tx_pi_1" && creates === 1);

    // Race: the read misses, the other delivery inserts, our create collides.
    let raceReads = 0;
    const racing = {
      transaction: {
        async findUnique({ where }: { where: { stripePaymentIntentId: string } }) { raceReads++; return raceReads === 1 ? null : row(where.stripePaymentIntentId); },
        async create(): Promise<Transaction> { throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }); },
      },
    };
    const raced = await createTransactionOnce({ data: data("pi_2") }, racing);
    check("two deliveries racing: the loser picks up the winner's row instead of failing", !raced.created && raced.tx.id === "tx_pi_2");

    const other = { transaction: { async findUnique() { return null; }, async create(): Promise<Transaction> { throw new Error("database is down"); } } };
    const err = await createTransactionOnce({ data: data("pi_3") }, other).then(() => null, (e) => (e as Error).message);
    check("any other failure is still thrown (nothing is silently swallowed)", err === "database is down");

    const before2 = creates;
    const a = await createTransactionOnce({ data: data(undefined) }, db);
    const b = await createTransactionOnce({ data: data(undefined) }, db);
    check("with no PaymentIntent there is nothing to dedupe on — a plain create", a.created && b.created && creates === before2 + 2);

    check("isUniqueViolation recognises P2002 only", isUniqueViolation(new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "t" })) && !isUniqueViolation(new Prisma.PrismaClientKnownRequestError("x", { code: "P2025", clientVersion: "t" })) && !isUniqueViolation(new Error("x")));
  }
  {
    const hook = code("app/api/stripe/webhook/route.ts");
    check("the webhook has room to finish (maxDuration)", /export const maxDuration = 60;/.test(hook));
    check("webhook emails are awaited, never fired and forgotten", !/^\s*safeAsync\(/m.test(hook) && (hook.match(/await safeAsync\(/g) ?? []).length >= 5);
    check("checkout payments go through createTransactionOnce", (hook.match(/createTransactionOnce\(\{/g) ?? []).length >= 5);
    for (const d of ["Membership purchase:", "Event booking:", "Class registration:", "Private package:", "Event registration:"]) {
      const at = hook.indexOf(d);
      const head = hook.slice(Math.max(0, at - 700), at);
      check(`"${d}" is recorded with createTransactionOnce`, at > 0 && head.lastIndexOf("createTransactionOnce({") > head.lastIndexOf("prisma.transaction.create({"));
    }
  }

  console.log("\n§3 recording cash claims the payment before anything else is written");
  {
    const src = code("app/api/members/[id]/offline-payment/route.ts");
    const post = src.slice(src.indexOf("export async function POST"));
    check("the PENDING row is claimed with a conditional write", /prisma\.transaction\.updateMany\(\{\s*where: \{ id: tx\.id, clubId, status: "PENDING" \}/.test(post));
    check("a lost claim answers 409 and stops", /claimed\.count === 0[\s\S]{0,200}status: 409/.test(post));
    check("the claim comes before any membership write", before(post, "claimed.count === 0", "prisma.memberSubscription.update("));
    check("the claim comes before the paid-through date is extended", before(post, "claimed.count === 0", "paidThroughDate: coverage.end"));
  }

  console.log("\n§4 an approval grants once");
  for (const [rel, grant] of [
    ["app/api/approvals/private-package-purchase/route.ts", "prisma.privateCreditLedger.create("],
    ["app/api/approvals/membership-purchase/route.ts", "prisma.memberSubscription.create("],
  ] as const) {
    const src = code(rel);
    const claim = 'where: { id: approval.id, status: "PENDING" }';
    check(`${rel}: the request is claimed before the grant`, before(src, claim, grant));
    check(`${rel}: a lost claim answers 409`, /claimed\.count === 0[\s\S]{0,160}status: 409/.test(src));
    check(`${rel}: a failed grant puts the request back in the queue`, /status: "APPROVED" \},\s*data: \{ status: "PENDING"/.test(src));
    check(`${rel}: nothing closes the request AFTER the grant any more`, !/await close\("APPROVED"\)/.test(src));
  }

  console.log("\n§5 a double tap does one thing");
  {
    const seen: string[][] = [];
    const flight = createSingleFlight((busy) => seen.push(busy));
    let runs = 0;
    const slow = () => new Promise<string>((r) => setTimeout(() => { runs++; r("done"); }, 15));
    // Both calls are made in the same tick — before anything could re-render.
    const [a, b] = await Promise.all([flight.run("paid:1", slow), flight.run("paid:1", slow)]);
    check("two taps in the same instant run the action once", runs === 1 && a === "done" && b === undefined, `runs=${runs}`);
    check("the key is released afterwards", !flight.isBusy("paid:1") && flight.busyKeys().length === 0);
    await flight.run("paid:1", slow);
    check("a later tap works again", runs === 2);
    const [c, d] = await Promise.all([flight.run("paid:1", slow), flight.run("paid:2", slow)]);
    check("different rows do not block each other", c === "done" && d === "done" && runs === 4);
    const err = await flight.run("boom", async () => { throw new Error("refused"); }).then(() => null, (e) => (e as Error).message);
    check("a failure is passed on and the key is still released", err === "refused" && !flight.isBusy("boom"));
    check("listeners saw busy then idle", seen.some((b) => b.includes("paid:1")) && seen[seen.length - 1].length === 0);
  }
  for (const [rel, key] of [
    ["app/dashboard/financials/page.tsx", "`paid:${id}`"],
    ["app/dashboard/staff/payouts/page.tsx", "`payout:${id}`"],
    ["app/dashboard/announcements/page.tsx", "`ann:${a.id}`"],
    ["app/dashboard/events/page.tsx", "`dup:${id}`"],
    ["components/staff/StaffProfile.tsx", '"setup-link"'],
  ] as const) {
    check(`${rel}: the action runs through flight.run(${key})`, code(rel).includes(`flight.run(${key}`));
  }

  console.log(`\n${"─".repeat(70)}`);
  if (failed) {
    console.log(`✗ ${failed} reliability check(s) failed\n`);
    process.exit(1);
  }
  console.log("✓ reliability tests passed\n");
}
main();
