// Walks the deliberate-free (comp) control in the billing centre.
//
// Four cases: an already-comped $0 row, an unmarked $0 row that must flip
// the member to active when marked, a $0 MANUAL row that counts either way,
// and a priced row where the control must not appear at all.

import { chromium, type Page } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";

async function subsCard(page: Page): Promise<string> {
  const card = page.locator("text=Membership history (subscriptions)").locator("xpath=ancestor::*[3]").first();
  return (await card.innerText()).trim();
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
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

  const visit = async (id: string, shot: string) => {
    await page.goto(`${BASE}/dashboard/members/${id}/billing`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${SHOT}/${shot}.png`, fullPage: true });
    return subsCard(page);
  };

  console.log("=== Fern ($0, already comped) ===");
  console.log(await visit("m_comp_fern", "C1-fern"));

  console.log("=== Ivan ($175, control must be absent) ===");
  console.log(await visit("m_comp_ivan", "C2-ivan"));

  console.log("=== Hana ($0 MANUAL) ===");
  console.log(await visit("m_comp_hana", "C3-hana"));

  console.log("=== Gus ($0, unmarked) — before ===");
  console.log(await visit("m_comp_gus", "C4-gus-before"));

  // Mark Gus as comped. The reason prompt is a window.prompt.
  page.once("dialog", (d) => d.accept("Coach's kid"));
  await page.getByRole("button", { name: "Mark as comped" }).first().click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${SHOT}/C5-gus-after.png`, fullPage: true });
  console.log("=== Gus — after marking ===");
  console.log(await subsCard(page));
  const banner = await page.locator("body").innerText();
  const line = banner.split("\n").find((l) => /comp|active|inactive/i.test(l) && l.length < 120);
  console.log(`banner: ${line ?? "(none found)"}`);

  // Roster must agree — the whole point is that the stored status moved.
  await page.goto(`${BASE}/dashboard/members?q=Comptest`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOT}/C6-roster.png`, fullPage: true });
  const roster = await page.locator("body").innerText();
  console.log("=== roster (Comptest) ===");
  console.log(roster.split("\n").filter((l) => /Comptest|Active|Inactive/i.test(l)).slice(0, 20).join("\n"));

  // And back off again.
  await page.goto(`${BASE}/dashboard/members/m_comp_gus/billing`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2200);
  page.once("dialog", (d) => d.accept("Marked in error"));
  await page.getByRole("button", { name: "Remove comp" }).first().click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${SHOT}/C7-gus-removed.png`, fullPage: true });
  console.log("=== Gus — after removing ===");
  console.log(await subsCard(page));

  console.log(errors.length ? `PAGE ERRORS: ${errors.join(" | ")}` : "no page errors");
  console.log("DONE");
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
