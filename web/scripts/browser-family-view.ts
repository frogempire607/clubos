// Browser test for Phase 7.1 — the family-wide view, driven as Shannan Hall.
//
//   npx tsx scripts/browser-family-view.ts
//
// Answers the question the Halls actually asked: after booking a second child
// into a class, is the FIRST child's booking still visible without switching
// profiles? Before 7.1 the answer was no — both bookings existed server-side,
// but every surface filtered to one athlete.

import { chromium, type Page } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = "/tmp/claude-0/-home-user-clubos/3016b3c6-0246-508b-9641-e7e724ddb0ba/scratchpad";
const SESSION = "cs_hall_tomorrow";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.locator("button", { hasText: "Member / Parent" }).first().click();
  await page.locator('input[placeholder="apex-wrestling"]').fill("frog-empire-hall");
  await page.locator('input[type="email"]').fill("shannan@local.test");
  await page.locator('input[type="password"]').fill("localtest123");
  await page.locator("button[type=submit], button:has-text('Sign in')").last().click();
  await page.waitForURL(/\/member(\/|$|\?)/, { timeout: 30_000 });
}

/** Read the family feed straight from the API the page uses. */
async function feed(page: Page, memberId: string) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/member/schedule?memberId=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    return r.ok ? await r.json() : null;
  }, memberId);
}

async function book(page: Page, memberId: string) {
  return page.evaluate(
    async ([sid, mid]) => {
      const r = await fetch("/api/member/classes/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classSessionId: sid, memberId: mid }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [SESSION, memberId] as const,
  );
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  await login(page);
  console.log("Signed in as Shannan Hall (guardian of Titus + Max)\n");

  // ── The switcher offers the family scope ───────────────────────────────────
  await page.goto(`${BASE}/member/schedule`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOT}/fam-01-schedule.png`, fullPage: true });

  const allChip = page.locator("button", { hasText: "All athletes" });
  check("switcher offers 'All athletes'", (await allChip.count()) > 0);

  const scope = await page.evaluate(() => localStorage.getItem("athletixos-active-profile"));
  check("a two-child guardian DEFAULTS to family scope", scope === "__family__", `got ${scope}`);

  // ── The feed carries a per-athlete verdict ────────────────────────────────
  const famBefore = await feed(page, "__family__");
  const itemBefore = famBefore?.items?.find((i: { id: string }) => i.id === SESSION);
  check("family feed returns the class", !!itemBefore);
  check(
    "the class carries BOTH athletes",
    itemBefore?.athletes?.length === 2,
    `athletes=${JSON.stringify(itemBefore?.athletes?.map((a: { firstName: string }) => a.firstName))}`,
  );
  check(
    "neither child is booked yet",
    (itemBefore?.athletes ?? []).every((a: { bookingStatus: string | null }) => !a.bookingStatus),
  );
  check(
    "both children can book (same plan covers it)",
    (itemBefore?.athletes ?? []).every((a: { canBook: boolean }) => a.canBook),
  );

  // ── Book Titus, then Max — the exact sequence Shannan ran ─────────────────
  const t = await book(page, "m_titus");
  check("Titus books", t.status === 200 && !!(t.body.coveredByMembership || t.body.attendanceRecordId));

  const afterTitus = await feed(page, "__family__");
  const midItem = afterTitus?.items?.find((i: { id: string }) => i.id === SESSION);
  const titusMid = midItem?.athletes?.find((a: { memberId: string }) => a.memberId === "m_titus");
  const maxMid = midItem?.athletes?.find((a: { memberId: string }) => a.memberId === "m_max");
  check("Titus reads as booked", !!titusMid?.bookingStatus);
  check("Max still reads as bookable — not blocked by his sibling", maxMid?.canBook === true);

  const m = await book(page, "m_max");
  check("Max books", m.status === 200 && !!(m.body.coveredByMembership || m.body.attendanceRecordId));

  // ── THE REGRESSION: both must still be visible together ──────────────────
  const after = await feed(page, "__family__");
  const item = after?.items?.find((i: { id: string }) => i.id === SESSION);
  const booked = (item?.athletes ?? []).filter((a: { bookingStatus: string | null }) => a.bookingStatus);
  check(
    "BOTH children show as booked in one feed (the Hall bug)",
    booked.length === 2,
    `booked=${JSON.stringify(booked.map((a: { firstName: string }) => a.firstName))}`,
  );

  // ── And in the UI, without switching profiles ────────────────────────────
  await page.goto(`${BASE}/member/schedule?tab=bookings`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOT}/fam-02-bookings.png`, fullPage: true });

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check("bookings list names Titus", /Titus/.test(body));
  check("bookings list names Max", /Max/.test(body));
  check(
    "both siblings appear on the SAME screen",
    /Titus/.test(body) && /Max/.test(body),
  );

  await page.goto(`${BASE}/member/schedule`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  const schedBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(
    "the schedule row names both booked athletes",
    /Booked\s*—\s*(Titus\s*&\s*Max|Max\s*&\s*Titus)/.test(schedBody),
    schedBody.match(/Booked[^·\n]{0,40}/)?.[0] ?? "no 'Booked —' row found",
  );
  await page.screenshot({ path: `${SHOT}/fam-03-schedule-booked.png`, fullPage: true });

  // ── Per-child scope survives: the switcher still narrows to one athlete ──
  const solo = await feed(page, "m_titus");
  check("per-child scope still works", solo?.contextMember?.id === "m_titus");
  check("per-child scope is not family scope", solo?.familyScope === false);

  await page.goto(`${BASE}/member/schedule?tab=bookings`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  // The desktop rail; the mobile chip with the same label is hidden at this width.
  await page.getByRole("button", { name: "Switch to Titus Hall" }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOT}/fam-04-titus-only.png`, fullPage: true });
  const soloBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  // "Max Hall" still appears in the rail; the BOOKINGS TABLE must not list him.
  const table = await page
    .locator("table")
    .first()
    .innerText()
    .catch(() => "");
  check("switching to Titus scopes the table to Titus", /Titus|MS\/HS/.test(table));
  check("...and Max's row is gone from it", !/\bMax\b/.test(table), table.replace(/\s+/g, " ").slice(0, 120));
  check("the per-child note names the child", /Every reservation for Titus/.test(soloBody));

  await browser.close();

  console.log(`\n${"─".repeat(58)}`);
  if (failures) {
    console.log(`✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("✓ all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
