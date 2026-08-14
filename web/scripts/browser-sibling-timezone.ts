// Browser reproduction of the two 2026-08-14 booking blockers.
//
//   npx tsx scripts/browser-sibling-timezone.ts
//
// Signs in as the guardian of two children on the accepted plan and:
//   1. reads what the schedule DISPLAYS for the class times, then tries to
//      book a class that is an hour away in club-local time;
//   2. books the same session for BOTH siblings.

import { chromium, type Page } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = "/tmp/claude-0/-home-user-clubos/3016b3c6-0246-508b-9641-e7e724ddb0ba/scratchpad";

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  // Tab labels run the title and subtitle together ("Member / ParentAthletes…").
  await page.locator("button", { hasText: "Member / Parent" }).first().click();
  await page.locator('input[placeholder="apex-wrestling"]').fill("frog-empire");
  await page.locator('input[type="email"]').fill("michael@local.test");
  await page.locator('input[type="password"]').fill("localtest123");
  await page.locator("button[type=submit], button:has-text('Sign in')").last().click();
  await page.waitForURL(/\/member(\/|$|\?)/, { timeout: 30_000 });
}

/** Book via the same endpoint the page calls, in the page's session. */
async function book(page: Page, classSessionId: string, memberId: string) {
  return page.evaluate(
    async ([sid, mid]) => {
      const r = await fetch("/api/member/classes/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classSessionId: sid, memberId: mid }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [classSessionId, memberId],
  );
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await login(page);

  // ── What the member actually SEES ────────────────────────────────────────
  await page.goto(`${BASE}/member/schedule`);
  await page.waitForLoadState("networkidle");
  const shown = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent ?? "").trim();
      if (/MS\/HS Preseason/.test(t) && t.length < 200 && el.children.length <= 3) out.push(t.replace(/\s+/g, " "));
    });
    return Array.from(new Set(out)).slice(0, 4);
  });
  console.log("=== WHAT THE SCHEDULE DISPLAYS ===");
  shown.forEach((s) => console.log("  " + s));
  await page.screenshot({ path: `${SHOT}/tz-schedule.png`, fullPage: true });

  // ── BUG 1: a class an hour away, in club-local time ──────────────────────
  console.log("\n=== BUG 1: booking a class 1 hour out (club-local) ===");
  const soon = await book(page, "cs_mshs_soon", "m_sibling");
  console.log(`  status ${soon.status}:`, JSON.stringify(soon.body));

  // ── BUG 2, server path: same session, two siblings ───────────────────────
  console.log("\n=== BUG 2a: same session for two siblings (API) ===");
  const first = await book(page, "cs_mshs_tomorrow", "m_sibling");
  console.log(`  Rory   → status ${first.status}:`, JSON.stringify(first.body));
  const second = await book(page, "cs_mshs_tomorrow", "m_import_unreviewed");
  console.log(`  Cameron→ status ${second.status}:`, JSON.stringify(second.body));

  // ── BUG 2, the way a parent actually does it: through the UI ─────────────
  console.log("\n=== BUG 2b: same session for two siblings (UI clicks) ===");
  await page.evaluate(async () => {
    // start clean so the UI test isn't reading 2a's rows
    await fetch("/api/__noop").catch(() => {});
  });
  await page.goto(`${BASE}/member/schedule`);
  await page.waitForLoadState("networkidle");

  const switcher = await page.evaluate(() => {
    const names: string[] = [];
    document.querySelectorAll("button").forEach((b) => {
      const t = (b.textContent ?? "").trim();
      if (/Rory|Cameron/.test(t) && t.length < 40) names.push(t);
    });
    return Array.from(new Set(names));
  });
  console.log("  athlete switcher offers:", JSON.stringify(switcher));

  for (const who of ["Rory", "Cameron"]) {
    const chip = page.locator("button", { hasText: new RegExp(`^${who}`) }).first();
    if (await chip.count()) {
      await chip.click();
      await page.waitForTimeout(1200);
    }
    const label = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find(
        (e) => /MS\/HS Preseason/.test(e.textContent ?? "") && e.children.length === 0,
      );
      return el?.textContent?.trim() ?? "(class row not found)";
    });
    console.log(`  ${who}: switcher active, sees "${label}"`);
    await page.screenshot({ path: `${SHOT}/sibling-${who}.png`, fullPage: true });
  }

  console.log("\npage errors:", errors.length ? errors : "none");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
