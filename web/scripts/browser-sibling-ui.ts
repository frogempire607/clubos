// Does the schedule UI let a guardian book the SAME session for a second
// child after booking the first? Checks the actual button state per athlete.
//
//   npx tsx scripts/browser-sibling-ui.ts

import { chromium, type Page } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = "/tmp/claude-0/-home-user-clubos/3016b3c6-0246-508b-9641-e7e724ddb0ba/scratchpad";
const SESSION = "cs_mshs_tomorrow";

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.locator("button", { hasText: "Member / Parent" }).first().click();
  await page.locator('input[placeholder="apex-wrestling"]').fill("frog-empire");
  await page.locator('input[type="email"]').fill("michael@local.test");
  await page.locator('input[type="password"]').fill("localtest123");
  await page.locator("button[type=submit], button:has-text('Sign in')").last().click();
  await page.waitForURL(/\/member(\/|$|\?)/, { timeout: 30_000 });
}

/** Open the tomorrow 7pm class detail and report what the CTA offers. */
async function ctaFor(page: Page, who: string) {
  await page.goto(`${BASE}/member/schedule`);
  await page.waitForLoadState("networkidle");

  const chip = page.locator("button", { hasText: new RegExp(`^${who} `) }).first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForTimeout(1500);
  }

  // The 7pm session is tomorrow; open its card.
  const card = page.locator("text=/7pm MS\\/HS Preseason/").last();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(1200);
  }

  const state = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"))
      .map((b) => ({ text: (b.textContent ?? "").trim(), disabled: (b as HTMLButtonElement).disabled }))
      .filter((b) => /book|booked|register|cancel|purchase|sign up/i.test(b.text) && b.text.length < 40);
    const body = document.body.textContent ?? "";
    return {
      buttons: btns,
      saysBooked: /you'?re booked|already booked|booked\b/i.test(body),
    };
  });
  await page.screenshot({ path: `${SHOT}/ui-${who}.png`, fullPage: true });
  return state;
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  await login(page);

  // Clean slate for this session.
  await page.evaluate(async (sid) => {
    await fetch("/api/member/classes/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sid, memberId: "__none__" }),
    }).catch(() => {});
  }, SESSION);

  console.log("=== BEFORE any booking ===");
  console.log("  Rory   :", JSON.stringify(await ctaFor(page, "Rory")));
  console.log("  Cameron:", JSON.stringify(await ctaFor(page, "Cameron")));

  // Book Rory through the API the page uses.
  const booked = await page.evaluate(async (sid) => {
    const r = await fetch("/api/member/classes/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sid, memberId: "m_sibling" }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, SESSION);
  console.log("\nbooked Rory:", JSON.stringify(booked));

  console.log("\n=== AFTER Rory is booked ===");
  console.log("  Rory   :", JSON.stringify(await ctaFor(page, "Rory")));
  console.log("  Cameron:", JSON.stringify(await ctaFor(page, "Cameron")));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
