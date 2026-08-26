/**
 * The SCREEN, not the API. Drives the billing page the way an owner would:
 * find Drew, click Enrol, pick a plan and option, set the date, submit.
 *
 * The API had 20/0 and was still unusable — there was no button. This is the
 * test that would have caught that.
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

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "frog-empire" }, select: { id: true } });
  await prisma.member.upsert({
    where: { id: "m_drew_local" },
    update: { status: "PROSPECT", membershipId: null },
    create: { id: "m_drew_local", clubId: club!.id, firstName: "Drew", lastName: "Telesky", status: "PROSPECT" },
  });
  await prisma.memberSubscription.deleteMany({ where: { memberId: "m_drew_local" } });
  await prisma.transaction.deleteMany({ where: { memberId: "m_drew_local" } });

  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page: Page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);

  console.log("\nDrew's billing page — before:");
  await page.goto(`${BASE}/dashboard/members/m_drew_local/billing`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  let body = (await page.textContent("body")) ?? "";

  check("the page offers an 'Already paid?' card", /Already paid\?/i.test(body));
  check("the outstanding-payments card no longer renders blank space",
    /No outstanding cash or check payment/i.test(body));
  check("and it points at enrolment rather than dead-ending",
    /enrol them from the billing centre|paid you and have no membership/i.test(body));

  console.log("\nDriving the form as an owner would:");
  await page.click('button:has-text("Enrol")');
  await page.waitForTimeout(900);

  const planSelect = page.locator("select").filter({ hasText: "Choose a plan" }).first();
  await planSelect.selectOption({ label: "MS/HS" });
  await page.waitForTimeout(600);
  body = (await page.textContent("body")) ?? "";
  check("the plan's options are listed with prices",
    /Monthly Full Membership — \$175/.test(body), body.slice(0, 0));

  await page.click('button:has-text("Monthly Full Membership")');
  await page.waitForTimeout(500);

  const amount = page.locator('input[type="number"]').first();
  check("picking an option fills the amount so it cannot be mistyped",
    (await amount.inputValue()) === "175", await amount.inputValue());
  const dateInput = page.locator('input[type="date"]').first();
  const prefilled = await dateInput.inputValue();
  check("and defaults the covered-until date a period out", /^\d{4}-\d{2}-\d{2}$/.test(prefilled), prefilled);

  await dateInput.fill("2026-09-25");
  await page.waitForTimeout(400);
  body = (await page.textContent("body")) ?? "";
  check("the form states what will happen before you commit",
    /goes on/i.test(body) && /September 25, 2026/.test(body), "no preview sentence");
  check("and says plainly that no card billing is armed",
    /No card billing/i.test(body));

  // Mistyped amount must warn, not silently record.
  await amount.fill("100");
  await page.waitForTimeout(400);
  body = (await page.textContent("body")) ?? "";
  check("a mistyped amount warns on screen before submitting",
    /is \$175\.00\. Recording a different figure/i.test(body));
  check("and requires a second, explicit button to record anyway",
    /Record \$100\.00 anyway/i.test(body));
  await amount.fill("175");
  await page.waitForTimeout(300);

  await page.click('button:has-text("Record payment & enrol")');
  await page.waitForTimeout(2500);

  console.log("\nAfter:");
  const sub = await prisma.memberSubscription.findFirst({
    where: { memberId: "m_drew_local" },
    select: { status: true, billingType: true, optionId: true, paidThroughDate: true },
  });
  check("he has a membership", sub?.status === "active" && sub?.billingType === "MANUAL", JSON.stringify(sub));
  check("paid through the date typed on screen",
    sub?.paidThroughDate?.toISOString().slice(0, 10) === "2026-09-25", String(sub?.paidThroughDate));
  const tx = await prisma.transaction.findFirst({
    where: { memberId: "m_drew_local" },
    select: { amount: true, status: true, paymentSource: true, reconciliationStatus: true },
  });
  check("the cash is on the ledger as received",
    Number(tx?.amount) === 175 && tx?.status === "SUCCEEDED" && tx?.reconciliationStatus === "OFFLINE",
    JSON.stringify(tx));

  body = (await page.textContent("body")) ?? "";
  check("and the page confirms it in words", /paid through/i.test(body));

  await prisma.transaction.deleteMany({ where: { memberId: "m_drew_local" } });
  await prisma.memberSubscription.deleteMany({ where: { memberId: "m_drew_local" } });
  await browser.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
