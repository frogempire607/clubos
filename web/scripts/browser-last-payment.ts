/**
 * Item 3: "Last payment" must come from the transaction ledger, not from the
 * Stripe reconciliation snapshot.
 *
 * Reproduces Orson Chorba's shape exactly: a real, VERIFIED membership
 * Transaction on the member, and a NULL stripeSnapshot because the reconciler
 * has never run on him. Before this change his profile showed nothing.
 *
 *   ./scripts/dev-local.sh
 *   npx tsx scripts/seed-local-browser-test.ts && npx tsx scripts/seed-shannan-buys.ts
 *   npx tsx scripts/browser-last-payment.ts
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXECUTABLE = process.env.PW_CHROMIUM ??
  "/Users/cubano/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const prisma = new PrismaClient();

let pass = 0; const failures: string[] = [];
function check(l: string, ok: boolean, d?: string) {
  if (ok) { pass++; console.log(`  ✓ ${l}`); return; }
  failures.push(d ? `${l} — ${d}` : l); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`);
}

async function api(page: Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p as string);
    return { status: r.status, json: await r.json().catch(() => null) };
  }, path);
}

const MEMBER = "m_max_local";
const PLAN = "mship_mshs_local";

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "frog-empire" }, select: { id: true } });
  if (!club) throw new Error("Seed the club first.");

  // Orson's shape: live card subscription, snapshot NEVER populated.
  await prisma.memberSubscription.deleteMany({ where: { memberId: MEMBER } });
  const sub = await prisma.memberSubscription.create({
    data: {
      memberId: MEMBER, membershipId: PLAN, optionId: "opt_vavjt5xoqc",
      optionLabel: "Monthly", price: 175, billingPeriod: "MONTHLY",
      billingType: "RECURRING", status: "active", autoRenew: true,
      startDate: new Date("2026-07-13T00:00:00Z"),
      stripeSubscriptionId: "sub_lastpayment_fixture",
      stripeSnapshot: undefined,       // ← the whole point
      currentPeriodEnd: null, paidThroughDate: null,
    },
    select: { id: true },
  });
  await prisma.transaction.deleteMany({ where: { memberId: MEMBER } });
  await prisma.transaction.create({
    data: {
      clubId: club.id, memberId: MEMBER, amount: 195.51, type: "MEMBERSHIP",
      category: "memberships", status: "SUCCEEDED", paymentSource: "STRIPE",
      reconciliationStatus: "VERIFIED", stripeInvoiceId: "in_lastpayment_fixture",
      description: "Membership renewal: Monthly",
      createdAt: new Date("2026-07-24T01:01:33Z"),
    },
  });

  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "shannan@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);

  console.log("\nWith a real Transaction and a NULL Stripe snapshot:");
  const r = await api(page, "/api/member/billing");
  const people = (r.json as { people?: Array<Record<string, unknown>> } | null)?.people ?? [];
  const max = people.find((p) => p.memberId === MEMBER) as
    | { lastPayment?: { amount: number; paidAt: string } | null } | undefined;

  check("the API returns a last payment at all", !!max?.lastPayment,
    JSON.stringify(max?.lastPayment));
  check("the amount is the one in the ledger, $195.51",
    max?.lastPayment?.amount === 195.51, String(max?.lastPayment?.amount));
  check("dated from the transaction, not from a snapshot",
    (max?.lastPayment?.paidAt ?? "").startsWith("2026-07-24"), max?.lastPayment?.paidAt);

  await page.goto(`${BASE}/member/profile`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const text = (await page.textContent("body")) ?? "";
  check("and it actually renders on the profile", /195\.51/.test(text));

  // A VOIDed row is not money and must not surface as the last payment.
  await prisma.transaction.updateMany({
    where: { memberId: MEMBER }, data: { reconciliationStatus: "VOID" },
  });
  const r2 = await api(page, "/api/member/billing");
  const max2 = (((r2.json as { people?: Array<Record<string, unknown>> } | null)?.people ?? [])
    .find((p) => p.memberId === MEMBER)) as { lastPayment?: unknown } | undefined;
  check("a VOID transaction is not shown as a payment", max2?.lastPayment == null,
    JSON.stringify(max2?.lastPayment));

  await prisma.transaction.deleteMany({ where: { memberId: MEMBER } });
  await prisma.memberSubscription.deleteMany({ where: { id: sub.id } });
  await browser.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
