// Save a bulk email as a draft, then reopen it from the Drafts page and
// verify the recipients and content come back.

import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  console.log("start");

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");

  // ── Compose and save ────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard/members`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const boxes = page.locator('table input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 1; i < Math.min(n, 4); i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: /^Email$|Email selected/i }).first().click();
  await page.waitForTimeout(1500);

  await page.fill('input[placeholder="Practice canceled tonight"]', "Draft round trip");
  await page.fill('input[placeholder*="No practice tonight"]', "Preview line survives");
  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: /Save as draft/i }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOT}/D1-saved.png`, fullPage: true });
  const footer = await page.locator("body").innerText();
  console.log(`saved-confirmation present: ${/Saved \d/.test(footer)}`);
  const titleLine = footer.split("\n").find((l) => /Email \d+ member/.test(l));
  console.log(`composer title after save: ${titleLine}`);

  // Close WITHOUT sending — the whole point is that it survives.
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(1000);

  // ── Find it on the Drafts page ──────────────────────────────────────────
  await page.goto(`${BASE}/dashboard/communication/drafts`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT}/D2-list.png`, fullPage: true });
  const list = await page.locator("body").innerText();
  const i = list.indexOf("Drafts");
  console.log("=== DRAFTS LIST ===");
  console.log(list.slice(i, i + 400).trim());

  // ── Reopen it ───────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Open" }).first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOT}/D3-reopened.png`, fullPage: true });
  const reopened = await page.locator("body").innerText();
  const title = reopened.split("\n").find((l) => /Email \d+ member/.test(l));
  console.log("=== REOPENED ===");
  console.log(`title: ${title}`);
  console.log(`marked as draft: ${/· draft/.test(reopened)}`);
  const subjectVal = await page.locator('input[placeholder="Practice canceled tonight"]').inputValue().catch(() => "(not found)");
  const previewVal = await page.locator('input[placeholder*="No practice tonight"]').inputValue().catch(() => "(not found)");
  console.log(`subject restored: "${subjectVal}"`);
  console.log(`preview text restored: "${previewVal}"`);

  console.log(errs.length ? `PAGE ERRORS: ${errs.join(" | ")}` : "no page errors");
  console.log("DONE");
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
