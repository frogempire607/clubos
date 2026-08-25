/**
 * ACCEPTANCE TEST — a guardian buys a different membership, herself, from her
 * own portal, after the previous one ended.
 *
 * This is the Shannan Hall case end to end:
 *   · Max's commitment ended weeks ago but his subscription row has no endDate,
 *     so the portal reads him as an active member and closes every option.
 *   · scripts/fix-commitment-end-dates.ts stamps the date and expires the row.
 *   · She then picks a DIFFERENT option — $450 quarterly, not the $175 monthly
 *     that ended — and pays by card.
 *
 *   ./scripts/dev-local.sh
 *   npx tsx scripts/seed-local-browser-test.ts
 *   npx tsx scripts/seed-shannan-buys.ts
 *   npx tsx scripts/browser-shannan-buys.ts
 *
 * NOTE ON STRIPE: dev-local.sh blanks STRIPE_SECRET_KEY, so the Checkout call
 * cannot reach Stripe and is EXPECTED to fail at that last hop. Everything up
 * to and including the amount, the option, the term and the auto-renew default
 * is real and asserted. The hosted page itself is the one thing only Julian can
 * confirm, against the live account.
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { feeBreakdown } from "../lib/fees";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXECUTABLE = process.env.PW_CHROMIUM ??
  "/Users/cubano/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function api(page: Page, path: string, init?: { method?: string; body?: unknown }) {
  return page.evaluate(
    async ([p, m, b]) => {
      const res = await fetch(p as string, {
        method: (m as string) || "GET",
        ...(b ? { headers: { "content-type": "application/json" }, body: b as string } : {}),
      });
      let json: unknown = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    },
    [path, init?.method ?? "GET", init?.body ? JSON.stringify(init.body) : null] as const,
  );
}

const MEMBER = "m_max_local";
const PLAN = "mship_mshs_local";

async function main() {
  // Put the row back into the BROKEN shape, so this test proves the whole arc
  // rather than whatever state the last run left behind.
  await prisma.memberSubscription.deleteMany({ where: { memberId: MEMBER } });
  const endedOn = new Date("2026-08-15T00:00:00.000Z");
  await prisma.member.update({
    where: { id: MEMBER },
    data: { commitmentEndDate: endedOn, status: "ACTIVE", membershipId: PLAN },
  });
  await prisma.memberSubscription.create({
    data: {
      memberId: MEMBER, membershipId: PLAN, optionId: "opt_vavjt5xoqc",
      optionLabel: "Monthly", price: 175, billingPeriod: "MONTHLY",
      billingType: "MANUAL", status: "active", autoRenew: false,
      startDate: new Date("2026-04-17T00:00:00.000Z"),
      endDate: null, currentPeriodEnd: null, paidThroughDate: null,
    },
  });

  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage();
  await login(page, "shannan@local.test");

  // ── 1. the dead end, reproduced ──────────────────────────────────────────
  console.log("\nBefore the correction — what Shannan saw:");
  let list = await api(page, "/api/member/memberships");
  let body = list.json as { activeByMember?: Record<string, unknown[]> } | null;
  check("the portal still reads Max as having an active membership",
    (body?.activeByMember?.[MEMBER] ?? []).length === 1,
    JSON.stringify(body?.activeByMember));

  await page.goto(`${BASE}/member/memberships`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const bodyText = (await page.textContent("body")) ?? "";
  check("the page says it is his current plan", /current plan on this profile/i.test(bodyText));
  // The fix from the previous batch: even in the dead end she can now ASK.
  check("she can at least ASK for a different option (the earlier dead-end fix)",
    /Request this/i.test(bodyText));

  // ── 2. the correction ────────────────────────────────────────────────────
  console.log("\nAfter fix-commitment-end-dates:");
  const { execSync } = await import("child_process");
  execSync(`npx tsx scripts/fix-commitment-end-dates.ts --apply --members "Max Hall"`, {
    cwd: process.cwd(), stdio: "pipe",
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, LC_ALL: "C" },
  });
  const fixed = await prisma.memberSubscription.findFirst({
    where: { memberId: MEMBER }, select: { endDate: true, status: true },
  });
  check("his subscription now carries the end date the club recorded",
    fixed?.endDate?.toISOString().slice(0, 10) === "2026-08-15", String(fixed?.endDate));
  check("and it is expired, not silently still active", fixed?.status === "expired", fixed?.status);

  // ── 3. the options open ──────────────────────────────────────────────────
  list = await api(page, "/api/member/memberships");
  body = list.json as { activeByMember?: Record<string, unknown[]> } | null;
  check("the portal no longer treats him as a member",
    (body?.activeByMember?.[MEMBER] ?? []).length === 0,
    JSON.stringify(body?.activeByMember));

  await page.goto(`${BASE}/member/memberships`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const after = (await page.textContent("body")) ?? "";
  check("every option is offered again", /3 months Upfront/.test(after) && /Monthly Full Membership/.test(after));
  check("the dead-end message is gone", !/current plan on this profile/i.test(after));

  // ── 4. she buys a DIFFERENT option, by card ──────────────────────────────
  console.log("\nShe buys 3 months Upfront ($450 quarterly), not the $175 monthly that ended:");
  const quote = feeBreakdown(450, true);
  check("the fee passthrough makes that $463.05 at checkout",
    quote.total === 463.05, JSON.stringify(quote));

  const buy = await api(page, "/api/member/memberships/subscribe", {
    method: "POST",
    body: { memberId: MEMBER, membershipId: PLAN, optionLabel: "3 months Upfront", paymentMethod: "CARD" },
  });
  // Stripe is unreachable here by design, so a 502/500 at the LAST hop is the
  // expected outcome; what matters is everything the route did first.
  console.log(`     subscribe → ${buy.status} ${JSON.stringify(buy.json).slice(0, 160)}`);

  const created = await prisma.memberSubscription.findFirst({
    where: { memberId: MEMBER, optionLabel: { not: "Monthly" } },
    orderBy: { createdAt: "desc" },
    select: {
      optionId: true, optionLabel: true, price: true, billingPeriod: true,
      minimumTermEndsAt: true, autoRenew: true, status: true, startDate: true,
    },
  });
  check("a subscription row was staged for the NEW option", !!created, "none created");
  if (created) {
    check("it is the quarterly $450 option, not the monthly one that ended",
      Number(created.price) === 450 && created.billingPeriod === "QUARTERLY",
      `${created.price} ${created.billingPeriod}`);
    check("it names the option by id, so a rename can never lose it",
      created.optionId === "opt_078e5udfsb", String(created.optionId));
    check("it is staged pending — nothing counts until Stripe confirms",
      created.status === "pending", created.status);

    // §8.8.1 + the settled semantics.
    const start = created.startDate ?? new Date();
    const expected = new Date(Date.UTC(
      start.getUTCFullYear(), start.getUTCMonth() + 3, start.getUTCDate(),
    ));
    check("it carries a 3-month term from the option",
      !!created.minimumTermEndsAt &&
      Math.abs(created.minimumTermEndsAt.getTime() - expected.getTime()) < 2 * 864e5,
      `${created.minimumTermEndsAt?.toISOString()} vs ~${expected.toISOString()}`);
    check("auto-renew is OFF by default on a committed option",
      created.autoRenew === false, String(created.autoRenew));
  }

  // ── 5. and she can turn auto-renew back on herself, no approval ──────────
  if (created) {
    const subRow = await prisma.memberSubscription.findFirst({
      where: { memberId: MEMBER, price: 450 }, select: { id: true },
    });
    const g = await api(page, `/api/member/subscriptions/${subRow!.id}/auto-renew`);
    const gb = g.json as { autoRenew?: boolean; explanation?: string } | null;
    check("she can see what auto-renew means for this membership",
      g.status === 200 && gb?.autoRenew === false && !!gb?.explanation,
      `${g.status} ${JSON.stringify(gb)}`);
    check("the explanation promises the term is still billed out",
      /still (pay|be billed)/i.test(gb?.explanation ?? ""), gb?.explanation);
  }

  await browser.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
