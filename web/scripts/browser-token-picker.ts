import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await b.newPage({ viewport: { width: 1280, height: 1100 } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  console.log("start");
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([page.waitForURL((u)=>!u.pathname.startsWith("/login"),{timeout:60000}), page.click('button[type="submit"]')]);
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/dashboard/members`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const boxes = page.locator('table input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 1; i < Math.min(n, 3); i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: /^Email$|Email selected/i }).first().click();
  await page.waitForTimeout(1600);

  // Open the subject-level picker.
  await page.getByRole("button", { name: "Insert field" }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOT}/T1-picker-open.png`, fullPage: true });
  const menu = await page.locator('[role="menu"]').first().innerText();
  console.log("=== PICKER ===");
  console.log(menu.split("\n").filter((l)=>l.trim()).join("\n"));

  // Insert a recipient token into the subject.
  await page.getByRole("menuitem", { name: /Athlete first name/ }).click();
  await page.waitForTimeout(700);
  const subj = await page.locator('input[placeholder="Practice canceled tonight"]').inputValue();
  console.log(`subject after insert: "${subj}"`);

  // Now insert a CONTEXT token and confirm the composer calls it out.
  await page.getByRole("button", { name: "Insert field" }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: /Event name/ }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT}/T2-context-warned.png`, fullPage: true });
  const body = await page.locator("body").innerText();
  const hint = body.split("\n").filter((l)=>/Personalization \(|blank in this send|Athlete first name|Event name/.test(l));
  console.log("=== HINT ===");
  console.log(hint.join("\n"));
  console.log(errs.length ? `PAGE ERRORS: ${errs.join(" | ")}` : "no page errors");
  console.log("DONE");
  await b.close();
})();
