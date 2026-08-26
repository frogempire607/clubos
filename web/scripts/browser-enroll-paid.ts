/**
 * ACCEPTANCE — "this family already paid me; enrol them from here."
 *
 * Two real cases:
 *   DREW TELESKY   paid a month in cash, has NO subscription and NO transaction.
 *                  Previously the offline-payment card rendered nothing on his
 *                  page and the receipt endpoint 404s with nothing to settle.
 *   DAKOTA M.      paid through 2026-08-24, Stripe deleted her subscription on
 *                  08-07, and her row still points at it with canceledAt set.
 *                  She must end up billable WITHOUT being charged for the month
 *                  she already paid.
 *
 *   ./scripts/dev-local.sh
 *   npx tsx scripts/seed-local-browser-test.ts && npx tsx scripts/seed-shannan-buys.ts
 *   npx tsx scripts/browser-enroll-paid.ts
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
async function api(page: Page, path: string, init?: { method?: string; body?: unknown }) {
  return page.evaluate(async ([p, m, b]) => {
    const res = await fetch(p as string, {
      method: (m as string) || "GET",
      ...(b ? { headers: { "content-type": "application/json" }, body: b as string } : {}),
    });
    let json: unknown = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }, [path, init?.method ?? "GET", init?.body ? JSON.stringify(init.body) : null] as const);
}

const PLAN = "mship_mshs_local";
const OPT_MONTHLY = "opt_vavjt5xoqc";      // Monthly Full Membership $175
const OPT_QUARTER = "opt_078e5udfsb";      // 3 months Upfront $450

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "frog-empire" }, select: { id: true } });
  if (!club) throw new Error("Seed the club first.");
  const clubId = club.id;

  // ── Drew: nothing at all ────────────────────────────────────────────────
  await prisma.member.upsert({
    where: { id: "m_drew_local" },
    update: { status: "PROSPECT", membershipId: null },
    create: { id: "m_drew_local", clubId, firstName: "Drew", lastName: "Telesky", status: "PROSPECT" },
  });
  await prisma.memberSubscription.deleteMany({ where: { memberId: "m_drew_local" } });
  await prisma.transaction.deleteMany({ where: { memberId: "m_drew_local" } });

  // ── Dakota: paid through 08-24, Stripe sub deleted, row contradicts itself
  await prisma.member.upsert({
    where: { id: "m_dakota_local" },
    update: { status: "ACTIVE" },
    create: { id: "m_dakota_local", clubId, firstName: "Dakota", lastName: "Mastrantonio", status: "ACTIVE" },
  });
  await prisma.memberSubscription.deleteMany({ where: { memberId: "m_dakota_local" } });
  await prisma.transaction.deleteMany({ where: { memberId: "m_dakota_local" } });
  await prisma.memberSubscription.create({
    data: {
      memberId: "m_dakota_local", membershipId: PLAN, optionId: OPT_MONTHLY,
      optionLabel: "Monthly", price: 175, billingPeriod: "MONTHLY",
      billingType: "RECURRING", status: "active", autoRenew: true,
      startDate: new Date("2026-07-17T00:00:00Z"),
      stripeSubscriptionId: "sub_deleted_by_stripe",
      canceledAt: new Date("2026-08-07T12:47:13Z"),   // ← the contradiction
      paidThroughDate: null, currentPeriodEnd: null,
    },
  });

  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);

  // ── The old quiet failure ───────────────────────────────────────────────
  console.log("\nThe failure that lost Drew's month:");
  const settle = await api(page, `/api/members/m_drew_local/offline-payment`, {
    method: "POST", body: { transactionId: "nope", method: "CASH" },
  });
  check("the receipt endpoint still refuses when there is nothing to settle",
    settle.status === 404, `${settle.status}`);
  const pend = await api(page, `/api/members/m_drew_local/offline-payment`);
  check("and reports zero outstanding rows, which is what blanked the card",
    ((pend.json as { pending?: unknown[] })?.pending ?? []).length === 0);

  // ── DREW ────────────────────────────────────────────────────────────────
  console.log("\nDrew — paid a month cash, no membership:");
  const wrongAmount = await api(page, `/api/members/m_drew_local/enroll-paid`, {
    method: "POST", body: {
      confirm: true, membershipId: PLAN, optionId: OPT_MONTHLY,
      amountReceived: 100, method: "CASH", coversUntil: "2026-09-25",
    },
  });
  check("a figure that disagrees with the option is refused, not recorded",
    wrongAmount.status === 400 && (wrongAmount.json as { code?: string })?.code === "AMOUNT_MISMATCH",
    `${wrongAmount.status} ${JSON.stringify(wrongAmount.json)}`);

  const drew = await api(page, `/api/members/m_drew_local/enroll-paid`, {
    method: "POST", body: {
      confirm: true, membershipId: PLAN, optionId: OPT_MONTHLY,
      amountReceived: 175, method: "CASH", reference: "receipt 0042",
      coversUntil: "2026-09-25", startCardBilling: false,
    },
  });
  check("enrolling him succeeds in one call", drew.status === 200,
    `${drew.status} ${JSON.stringify(drew.json).slice(0, 140)}`);

  const drewSub = await prisma.memberSubscription.findFirst({
    where: { memberId: "m_drew_local" },
    select: { status: true, billingType: true, optionId: true, price: true,
              paidThroughDate: true, currentPeriodEnd: true, minimumTermEndsAt: true },
  });
  check("he has a membership", drewSub?.status === "active" && drewSub?.billingType === "MANUAL");
  check("named by option id, not label", drewSub?.optionId === OPT_MONTHLY);
  check("paid through the date the cash bought",
    drewSub?.paidThroughDate?.toISOString().slice(0, 10) === "2026-09-25",
    String(drewSub?.paidThroughDate));

  const drewTx = await prisma.transaction.findFirst({
    where: { memberId: "m_drew_local" },
    select: { amount: true, status: true, paymentSource: true, reconciliationStatus: true,
              manual: true, coversEnd: true, type: true },
  });
  check("the cash is recorded as RECEIVED, not owed",
    drewTx?.status === "SUCCEEDED" && Number(drewTx?.amount) === 175, JSON.stringify(drewTx));
  check("as offline money that cannot blend into card revenue",
    drewTx?.paymentSource === "CASH" && drewTx?.reconciliationStatus === "OFFLINE" && drewTx?.manual === true);
  check("and it records what period it bought",
    drewTx?.coversEnd?.toISOString().slice(0, 10) === "2026-09-25", String(drewTx?.coversEnd));

  const drewMember = await prisma.member.findUnique({
    where: { id: "m_drew_local" }, select: { status: true, membershipId: true },
  });
  check("he reads as a member, not a prospect",
    drewMember?.status === "ACTIVE" && drewMember?.membershipId === PLAN,
    JSON.stringify(drewMember));

  // ── DAKOTA ──────────────────────────────────────────────────────────────
  console.log("\nDakota — paid through 2026-08-24, Stripe deleted her subscription:");
  const dak = await api(page, `/api/members/m_dakota_local/enroll-paid`, {
    method: "POST", body: {
      confirm: true, membershipId: PLAN, optionId: OPT_MONTHLY,
      amountReceived: 175, method: "CASH",
      coversUntil: "2026-08-24", startCardBilling: true,
    },
  });
  check("she enrols even though her row pointed at a dead Stripe subscription",
    dak.status === 200, `${dak.status} ${JSON.stringify(dak.json).slice(0, 160)}`);

  const dakSub = await prisma.memberSubscription.findFirst({
    where: { memberId: "m_dakota_local" },
    select: { status: true, canceledAt: true, stripeSubscriptionId: true,
              paidThroughDate: true, billingType: true },
  });
  check("the stale pointer to the deleted subscription is cleared",
    dakSub?.stripeSubscriptionId === null || dakSub?.stripeSubscriptionId !== "sub_deleted_by_stripe",
    String(dakSub?.stripeSubscriptionId));
  check("and the row no longer says active AND canceled at once",
    dakSub?.canceledAt === null, String(dakSub?.canceledAt));
  check("paid through 2026-08-24 — the period the money actually bought",
    dakSub?.paidThroughDate?.toISOString().slice(0, 10) === "2026-08-24",
    String(dakSub?.paidThroughDate));
  check("only ONE subscription row exists for her, not a second stacked on top",
    (await prisma.memberSubscription.count({ where: { memberId: "m_dakota_local" } })) === 1);

  // Card billing was requested; Stripe is unreachable on the rig by design, so
  // it must report the failure rather than silently claim success.
  const cardMsg = (dak.json as { cardBilling?: { started: boolean; message: string | null } })?.cardBilling;
  check("card billing reports honestly rather than claiming success it cannot have",
    cardMsg?.started === false && !!cardMsg?.message, JSON.stringify(cardMsg));
  check("and the enrolment itself still stands — the money is not thrown away",
    dakSub?.status === "active" && dakSub?.billingType === "MANUAL");

  // ── The double-bill guard ───────────────────────────────────────────────
  console.log("\nThe guard that matters:");
  await prisma.memberSubscription.updateMany({
    where: { memberId: "m_dakota_local" },
    data: { stripeSubscriptionId: "sub_live_and_charging", status: "active" },
  });
  const again = await api(page, `/api/members/m_dakota_local/enroll-paid`, {
    method: "POST", body: {
      confirm: true, membershipId: PLAN, optionId: OPT_QUARTER,
      amountReceived: 450, method: "CHECK", coversUntil: "2026-11-24",
    },
  });
  check("enrolling over LIVE card billing is refused — that is the double-bill",
    again.status === 409 && (again.json as { code?: string })?.code === "LIVE_CARD_BILLING",
    `${again.status} ${JSON.stringify(again.json).slice(0, 120)}`);
  check("confirm:true is required", (await api(page, `/api/members/m_drew_local/enroll-paid`, {
    method: "POST", body: { membershipId: PLAN, optionId: OPT_MONTHLY, amountReceived: 175,
                            method: "CASH", coversUntil: "2026-09-25" } })).status === 400);

  await prisma.transaction.deleteMany({ where: { memberId: { in: ["m_drew_local", "m_dakota_local"] } } });
  await prisma.memberSubscription.deleteMany({ where: { memberId: { in: ["m_drew_local", "m_dakota_local"] } } });
  await browser.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
