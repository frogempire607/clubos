// Playwright walk of the email batch results screens.
//
// Harness discipline learned the hard way:
//  - wait for networkidle + a settle delay before clicking the login
//    form, or React hasn't hydrated and the click submits natively
//    (tell: a bare `GET /login?` with no credentials POST).
//  - assert on rendered content, never on the URL.
//  - never page.evaluate(fetch) right after a navigation — it hangs.

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
  // The login inputs are controlled and unnamed — select by type/placeholder.
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");

  // ---- list ------------------------------------------------------------
  await page.goto(`${BASE}/dashboard/communication/results`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const listText = await page.locator("body").innerText();
  console.log("=== LIST ===");
  console.log(listText.split("\n").filter((l) => l.trim()).slice(0, 40).join("\n"));
  await page.screenshot({ path: `${SHOT}/R1-list.png`, fullPage: true });

  // ---- clean batch -----------------------------------------------------
  for (const [batch, shot] of [
    ["batch-clean", "R2-clean"],
    ["batch-problems", "R3-problems"],
    ["batch-draining", "R4-draining"],
    ["batch-untracked", "R5-untracked"],
  ] as const) {
    await page.goto(`${BASE}/dashboard/communication/results/${batch}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const t = await page.locator("body").innerText();
    console.log(`=== ${batch} ===`);
    console.log(t.split("\n").filter((l) => l.trim()).slice(0, 45).join("\n"));
    await page.screenshot({ path: `${SHOT}/${shot}.png`, fullPage: true });
  }

  // ---- unknown batch 404s cleanly, not a crash -------------------------
  await page.goto(`${BASE}/dashboard/communication/results/batch-does-not-exist`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  console.log("=== UNKNOWN BATCH ===");
  console.log((await page.locator("body").innerText()).trim().slice(0, 200));

  console.log(errors.length ? `PAGE ERRORS: ${errors.join(" | ")}` : "no page errors");
  console.log("DONE");
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
