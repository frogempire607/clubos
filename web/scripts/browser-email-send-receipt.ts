// Sends a real bulk email from the Members tab and follows the receipt's
// "View results" link through to the batch page.
//
// SMTP_HOST and RESEND_API_KEY are blank under scripts/dev-browser-test.sh,
// so every row lands SKIPPED/NO_PROVIDER — nothing can be delivered from
// this harness. What is being tested is the path back to the results, which
// is exactly what was missing.

import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  console.log("start");

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/dashboard/members`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // Select the first few members via the row checkboxes.
  const boxes = page.locator('table input[type="checkbox"]');
  const count = await boxes.count();
  console.log(`checkboxes on page: ${count}`);
  for (let i = 1; i < Math.min(count, 4); i++) await boxes.nth(i).check();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOT}/S1-selected.png`, fullPage: true });

  const emailBtn = page.getByRole("button", { name: /^Email$|Email selected/i }).first();
  await emailBtn.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT}/S2-composer.png`, fullPage: true });

  // The composer ships with default blocks (logo + heading), so only a
  // subject is needed to make the send valid.
  await page.fill('input[placeholder="Practice canceled tonight"]', "Harness receipt test");
  await page.waitForTimeout(2500); // recipient preview settles
  await page.screenshot({ path: `${SHOT}/S3-composed.png`, fullPage: true });

  const sendBtn = page.getByRole("button", { name: /Review & send/i }).last();
  await sendBtn.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT}/S3b-review.png`, fullPage: true });
  // The review step has its own confirm button.
  const confirm = page.getByRole("button", { name: /^Send( now)?$|Send \d/i }).last();
  if (await confirm.count()) {
    await confirm.click();
  }
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SHOT}/S4-receipt.png`, fullPage: true });
  const receipt = await page.locator("body").innerText();
  console.log("=== RECEIPT ===");
  console.log(receipt.split("\n").filter((l) => l.trim()).slice(-25).join("\n"));

  const viewResults = page.getByRole("link", { name: "View results" });
  console.log(`View results link present: ${(await viewResults.count()) > 0}`);
  if (await viewResults.count()) {
    await viewResults.first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT}/S5-results.png`, fullPage: true });
    console.log("=== RESULTS PAGE ===");
    console.log((await page.locator("body").innerText()).split("\n").filter((l) => l.trim()).slice(25, 60).join("\n"));
    console.log(`landed on: ${new URL(page.url()).pathname}`);
  }

  console.log(errors.length ? `PAGE ERRORS: ${errors.join(" | ")}` : "no page errors");
  console.log("DONE");
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
