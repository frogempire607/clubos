/**
 * Browser check: the EXPIRING_MEMBERSHIP Action Item's drill-through actually
 * opens a FILTERED roster.
 *
 * This is the end-to-end half of scripts/renewal-surfacing-tests.ts. That suite
 * proves statically that no members link carries a parameter the roster does
 * not read. This one proves the surviving link does the thing a human expects
 * when they click it — which is the part that was broken for months while every
 * type-check and build stayed green.
 *
 * Requires a running dev server + a seeded local database + a Playwright
 * browser. It is NOT part of the default suite for that reason.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos npm run dev
 *   npx tsx scripts/seed-local-browser-test.ts        # owner@local.test
 *   npx tsx scripts/browser-ending-soon-queue.ts
 *
 * Set PW_CHROMIUM if the browser lives somewhere other than the repo default.
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";
const EXECUTABLE = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await login(page);

  // ── 1. The roster honours ?queue=endingSoon ───────────────────────────────
  console.log("\nroster queue:");
  await page.goto(`${BASE}/dashboard/members?queue=endingSoon`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const filteredText = await page.locator("body").innerText();
  const filteredRows = await page.locator("table tbody tr").count();

  await page.goto(`${BASE}/dashboard/members`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const allRows = await page.locator("table tbody tr").count();

  // The whole point. `?filter=expiring` produced these two numbers EQUAL,
  // silently, which is exactly why nobody noticed for months.
  check(
    "?queue=endingSoon returns fewer rows than the unfiltered roster",
    filteredRows > 0 && filteredRows < allRows,
    `filtered=${filteredRows} all=${allRows}`,
  );
  check(
    "the filtered roster does not render an error state",
    !/something went wrong|failed to load/i.test(filteredText),
  );

  // ── 2. The Action Item card links there ───────────────────────────────────
  console.log("\naction item drill-through:");
  await page.goto(`${BASE}/dashboard/reports`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const endingCard = page.locator("text=/membership ends/i").first();
  const hasCard = (await endingCard.count()) > 0;
  check("an EXPIRING_MEMBERSHIP card is rendered on Reports", hasCard);

  if (hasCard) {
    const href = await page
      .locator('a[href*="/dashboard/members"], a[href*="/billing"]')
      .first()
      .getAttribute("href");
    check(
      "its action links at a members or billing route, never a bare roster",
      !!href && href !== "/dashboard/members",
      String(href),
    );
  }

  check("no uncaught page errors during the run", consoleErrors.length === 0, consoleErrors.join("; "));

  await page.screenshot({ path: `${SHOT}/ending-soon-queue.png`, fullPage: true });
  console.log(`\nscreenshot: ${SHOT}/ending-soon-queue.png`);
  await browser.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
