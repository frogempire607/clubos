import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await b.newPage({ viewport: { width: 1280, height: 1100 } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  console.log("start");
  // First load compiles the route; the second is served warm. Clicking
  // before hydration submits the form natively — the tell is a bare
  // "GET /login?" with no credentials POST.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('input[placeholder="apex-wrestling"]', { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([page.waitForURL((u)=>!u.pathname.startsWith("/login"),{timeout:60000}), page.click('button[type="submit"]')]);
  await page.waitForLoadState("networkidle");

  // The stuck approval is visible before archiving.
  await page.goto(`${BASE}/dashboard/members/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const before = await page.locator("body").innerText();
  console.log(`approval for Alex Butler present BEFORE: ${/Alex Butler/.test(before)}`);
  await page.screenshot({ path: `${SHOT}/A1-approvals-before.png`, fullPage: true });

  // Archive via the dialog.
  await page.goto(`${BASE}/dashboard/members/m_alex_dupe`, { waitUntil: "networkidle" }).catch(()=>{});
  await page.goto(`${BASE}/dashboard/members`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.fill('input[placeholder*="Search"], input[type="search"]', "Butler").catch(()=>{});
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Actions for Alex Butler" }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT}/A1b-menu.png`, fullPage: true });
  const menuTxt = await page.locator("body").innerText();
  const mi = menuTxt.indexOf("Actions for");
  console.log("=== MENU TEXT ===");
  console.log(menuTxt.slice(Math.max(0, mi - 200), mi + 500));
  await page.getByText("Archive member", { exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOT}/A2-dialog.png`, fullPage: true });
  const dlg = await page.locator("body").innerText();
  const i = dlg.indexOf("Archive Alex Butler");
  console.log("=== DIALOG ===");
  console.log(dlg.slice(i, i + 700).trim());

  // Typed confirmation gate.
  const btn = page.getByRole("button", { name: "Archive member" });
  console.log(`archive disabled before typing: ${await btn.isDisabled()}`);
  await page.fill('input[placeholder="Alex Butler"]', "Alex Buter");
  await page.waitForTimeout(400);
  console.log(`still disabled on a typo: ${await btn.isDisabled()}`);
  await page.fill('input[placeholder="Alex Butler"]', "Alex Butler");
  await page.waitForTimeout(400);
  console.log(`enabled on exact name: ${!(await btn.isDisabled())}`);
  await btn.click();
  await page.waitForTimeout(3500);
  const after = await page.locator("body").innerText();
  console.log(`toast: ${after.split("\n").find((l)=>/archived/i.test(l)) ?? "(none)"}`);

  // The approval must be gone.
  await page.goto(`${BASE}/dashboard/members/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const post = await page.locator("body").innerText();
  console.log(`approval for Alex Butler present AFTER: ${/Alex Butler/.test(post)}`);
  await page.screenshot({ path: `${SHOT}/A3-approvals-after.png`, fullPage: true });

  console.log(errs.length ? `PAGE ERRORS: ${errs.join(" | ")}` : "no page errors");
  console.log("DONE");
  await b.close();
})();
