// Crash and self-closing-sheet crawl (2026-11-18). LOCAL ONLY.
//
//   sh scripts/dev-local.sh                      # throwaway Postgres on :55432
//   npx tsx scripts/browser-crash-audit.ts --viewport=desktop --out=/tmp/desktop.json
//   npx tsx scripts/browser-crash-audit.ts --viewport=phone   --out=/tmp/phone.json
//   (optional)  --only=/dashboard/members      one route prefix
//
// Opens every dashboard and member-portal page, then every button on it that
// opens a pop-up or sheet, and records:
//   · console errors, uncaught errors, 5xx answers, the error screen
//   · a sheet that closes or loses typed text without being asked to:
//       typing in it, a tap on its own heading, the window losing and regaining
//       focus, the network coming back, the on-screen keyboard resizing the
//       window, and a text selection dragged out past the edge of the panel
//
// Refuses any address that is not this machine. It clicks every button it
// finds, so it must never be pointed at a real club.

import { chromium, type Page, type Locator } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.AUDIT_BASE ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`REFUSING: ${BASE} is not this machine. This crawl clicks every button.`);
  process.exit(1);
}
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const VIEWPORT = arg("viewport") === "phone" ? "phone" : "desktop";
const OUT = arg("out") ?? `crash-audit-${VIEWPORT}.json`;
const ONLY = arg("only");
const MAX_OPENERS = Number(arg("max") ?? 12);

// Never pressed: these leave the page, sign out, or do something final.
const SKIP = /sign out|log out|delete|remove|archive|refund|charge|pay now|send|publish|cancel membership|disconnect|export|download|print|import|merge|void|approve|deny|decline|check in|upload|theme|dark|light|back$|^×$|^close$/i;

const OVERLAY = '[role="dialog"], div.fixed.inset-0';

type Finding = { route: string; kind: string; where?: string; detail: string };
const findings: Finding[] = [];
const visited: { route: string; openers: number; sheets: number }[] = [];
const skipped: string[] = [];

function add(f: Finding) {
  findings.push(f);
  console.log(`  ✗ [${f.kind}] ${f.route}${f.where ? ` › ${f.where}` : ""} — ${f.detail}`);
}

async function login(page: Page, who: "owner" | "member") {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  if (who === "member") await page.locator("button", { hasText: "Member / Parent" }).first().click();
  await page.locator("input[type=text]").first().fill(who === "owner" ? "frog-empire" : "frog-empire-hall");
  await page.locator('input[type="email"]').fill(who === "owner" ? "owner@local.test" : "shannan@local.test");
  await page.locator('input[type="password"]').fill("localtest123");
  await page.locator("button[type=submit]").last().click();
  // A production build (`dev-local.sh built`) names its session cookie
  // `__Secure-…`, while the route middleware, seeing an http:// address, looks
  // for the plain name — so over plain http on this machine the sign-in sticks
  // for the API and bounces for pages. Give the middleware the same token under
  // the name it reads. Local only; nothing about the app's sign-in changes.
  const ctx = page.context();
  for (let i = 0; i < 120; i++) {
    const c = (await ctx.cookies()).find((x) => x.name.endsWith("next-auth.session-token"));
    if (c) {
      if (c.name.startsWith("__Secure-")) await ctx.addCookies([{ name: "next-auth.session-token", value: c.value, url: BASE, httpOnly: true, sameSite: "Lax" }]);
      break;
    }
    await page.waitForTimeout(250);
  }
  const home = who === "owner" ? "/dashboard" : "/member";
  await page.goto(`${BASE}${home}`);
  await page.waitForURL(who === "owner" ? /\/dashboard/ : /\/member/, { timeout: 90_000 });
}

async function firstId(page: Page, url: string, keys: string[] = []): Promise<string | null> {
  return page.evaluate(async ([u, ks]) => {
    try {
      const r = await fetch(u as string);
      if (!r.ok) return null;
      const d = await r.json();
      let list: unknown = d;
      for (const k of ["members", "items", "staff", "events", "products", "rows", "batches", "bookings", "data", ...(ks as string[])]) {
        if (!Array.isArray(list) && d && Array.isArray(d[k])) list = d[k];
      }
      const row = Array.isArray(list) ? (list[0] as { id?: string } | undefined) : undefined;
      return row?.id ?? null;
    } catch { return null; }
  }, [url, keys] as const);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function overlayCount(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    return Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return s.display !== "none" && s.visibility !== "hidden" && r.width * r.height >= vw * vh * 0.2;
    }).length;
  }, OVERLAY);
}

/** Is the field we typed in still the same element, still holding the text? */
async function probeAlive(page: Page): Promise<{ sheet: boolean; field: boolean; text: boolean }> {
  return page.evaluate(() => {
    const f = document.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-audit-probe]");
    const sheet = !!document.querySelector("[data-audit-sheet]");
    return { sheet, field: !!f, text: !!f && f.value.includes("zq7") };
  });
}

async function probeSheet(page: Page, route: string, where: string, before: number) {
  // Tag the newest overlay so "it went away" means that element, not any dialog.
  const tagged = await page.evaluate((sel) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height >= window.innerWidth * window.innerHeight * 0.2;
    });
    const el = all[all.length - 1];
    if (!el) return false;
    el.setAttribute("data-audit-sheet", "1");
    return true;
  }, OVERLAY);
  if (!tagged) return;
  const sheet = page.locator("[data-audit-sheet]");
  const opened = Math.max(await overlayCount(page), before + 1);
  const check = async (step: string): Promise<boolean> => {
    const a = await probeAlive(page);
    // Something NEW on top (a "Discard changes?" question) — counted against
    // what was there once this sheet had opened, since one sheet can be two
    // matching elements (its full-screen container and its dialog panel).
    const extra = (await overlayCount(page)) > opened;
    if (!a.sheet) { add({ route, where, kind: "sheet-closed", detail: `closed by: ${step}` }); return false; }
    if (hasField && !a.field) { add({ route, where, kind: "field-remounted", detail: `the field was rebuilt (typed text lost) by: ${step}` }); return false; }
    if (hasField && !a.text) { add({ route, where, kind: "text-lost", detail: `typed text was replaced by: ${step}` }); return false; }
    if (extra && step.startsWith("drag")) { add({ route, where, kind: "drag-release-closes", detail: "a selection dragged past the panel edge asked to close the sheet" }); return false; }
    return true;
  };

  // 1. typing
  const field = sheet.locator('input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=search], input[type=number], textarea').locator("visible=true").first();
  let hasField = false;
  if (await field.count()) {
    const editable = await field.isEditable().catch(() => false);
    if (editable) {
      const numeric = (await field.getAttribute("type")) === "number";
      await field.evaluate((el) => el.setAttribute("data-audit-probe", "1"));
      await field.click({ timeout: 3000 }).catch(() => undefined);
      if (!numeric) {
        for (const ch of "zq7") {
          await page.keyboard.type(ch, { delay: 40 });
          const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-audit-probe") ?? false);
          if (!focused) { add({ route, where, kind: "focus-lost", detail: `the field lost focus after typing "${ch}"` }); break; }
        }
        hasField = true;
        if (!(await check("typing"))) return;
      }
    }
  }

  // 2. a tap on the sheet's own heading / padding
  const heading = sheet.locator("h1, h2, h3").locator("visible=true").first();
  if (await heading.count()) {
    await heading.click({ timeout: 2000, force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    if (!(await check("a tap on the sheet's own heading"))) return;
  }

  // 3. background events
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
  await page.waitForTimeout(1300);
  if (!(await check("the window losing and regaining focus"))) return;
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await page.waitForTimeout(700);
  if (!(await check("the network coming back"))) return;
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) });
  await page.waitForTimeout(450);
  const afterResize = await check("the keyboard resizing the window");
  await page.setViewportSize(vp);
  if (!afterResize) return;

  // 4. a selection dragged out past the panel (mouse only)
  if (VIEWPORT === "desktop" && hasField) {
    const box = await page.locator("[data-audit-probe]").boundingBox();
    if (box) {
      const y = box.y + box.height / 2;
      for (const [x, yy] of [[3, y], [vp.width - 3, y], [vp.width / 2, 3]] as const) {
        const inside = await page.evaluate(([px, py]) => {
          const el = document.elementFromPoint(px, py);
          const sheetEl = document.querySelector("[data-audit-sheet]");
          // "outside" = the overlay element itself (its backdrop), not a child panel
          return !(el && sheetEl && (el === sheetEl || !sheetEl.contains(el) || el.parentElement === sheetEl && getComputedStyle(el).position === "absolute"));
        }, [x, yy] as const);
        if (inside) continue;
        await page.mouse.move(box.x + box.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(x, yy, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(350);
        if (!(await check("drag-select released outside the panel"))) return;
        break;
      }
    }
  }
}

async function auditRoute(page: Page, route: string, state: { errors: string[] }) {
  console.log(`\n${route}`);
  state.errors.length = 0;
  const open = async () => {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await settle(page);
  };
  try { await open(); } catch (e) { add({ route, kind: "load-failed", detail: String(e).slice(0, 160) }); return; }
  if (!page.url().includes(route.split("?")[0])) { skipped.push(`${route} → redirected to ${page.url().replace(BASE, "")}`); return; }

  const crashed = async (where?: string) => {
    const body = await page.locator("body").innerText().catch(() => "");
    if (/This screen ran into a problem|Application error: a client-side exception/.test(body)) { add({ route, where, kind: "error-screen", detail: "the error screen is showing" }); return true; }
    if (await page.locator("nextjs-portal").count() && /Unhandled Runtime Error/.test(await page.locator("nextjs-portal").innerText().catch(() => ""))) {
      add({ route, where, kind: "runtime-error", detail: (await page.locator("nextjs-portal").innerText()).replace(/\s+/g, " ").slice(0, 220) });
      return true;
    }
    return false;
  };
  const flushErrors = (where?: string) => {
    for (const e of new Set(state.errors)) add({ route, where, kind: "console-error", detail: e });
    state.errors.length = 0;
  };
  await crashed();
  flushErrors();

  const scope = route.startsWith("/dashboard") ? "[data-page]" : "main";
  const candidates = async (): Promise<Locator> => page.locator(`${scope} button, ${scope} [role=button]`).locator("visible=true");
  const labels = await (await candidates()).evaluateAll((els) => els.map((e) => ((e.getAttribute("aria-label") ?? "") + " " + (e.textContent ?? "")).replace(/\s+/g, " ").trim().slice(0, 50)));
  // One button per label: forty rows each with an "Edit" open the same sheet.
  const seen = new Set<string>();
  const todo = labels.map((l, i) => ({ l, i })).filter(({ l }) => {
    if (!l || SKIP.test(l) || seen.has(l)) return false;
    seen.add(l);
    return true;
  }).slice(0, MAX_OPENERS);
  let sheets = 0;
  let dirty = false;
  for (const { l, i } of todo) {
    try {
      if (dirty) { await open(); dirty = false; }
      const btn = (await candidates()).nth(i);
      if (!(await btn.count()) || !(await btn.isEnabled().catch(() => false))) continue;
      const before = await overlayCount(page);
      await btn.click({ timeout: 1500 });
      await page.waitForTimeout(550);
      dirty = true;
      if (await crashed(l)) { flushErrors(l); continue; }
      if (!page.url().includes(route.split("?")[0])) continue;
      if ((await overlayCount(page)) > before) {
        sheets++;
        await probeSheet(page, route, l, before);
        await crashed(l);
      } else {
        dirty = (await (await candidates()).count()) !== labels.length;
      }
      flushErrors(l);
    } catch (e) {
      dirty = true;
      const msg = String(e);
      if (!/Timeout|intercepts pointer events|not attached|Target closed/.test(msg)) add({ route, where: l, kind: "probe-error", detail: msg.slice(0, 160) });
    }
  }
  visited.push({ route, openers: todo.length, sheets });
}

async function run(who: "owner" | "member", routes: string[]) {
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext(
    VIEWPORT === "phone"
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 800 } },
  );
  const page = await ctx.newPage();
  const state = { errors: [] as string[] };
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // A 4xx on a resource is an answer, not a crash; 5xx is recorded below.
    if (/Failed to load resource.*\b4\d\d\b|Download the React DevTools|favicon/.test(t)) return;
    state.errors.push(t.replace(/\s+/g, " ").slice(0, 260));
  });
  page.on("pageerror", (e) => state.errors.push(`UNCAUGHT ${e.message}`.slice(0, 260)));
  page.on("response", (r) => { if (r.status() >= 500) state.errors.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`.slice(0, 200)); });
  page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
  await login(page, who);

  const ids: Record<string, string | null> = who === "owner"
    ? {
        member: await firstId(page, "/api/members"),
        staff: await firstId(page, "/api/staff"),
        event: await firstId(page, "/api/events"),
        product: await firstId(page, "/api/products"),
        batch: "batch_local",
        campaign: await firstId(page, "/api/campaigns", ["campaigns"]),
      }
    : {
        member: "m_titus",
        event: await firstId(page, "/api/member/events"),
        product: await firstId(page, "/api/member/products"),
      };
  for (const raw of routes) {
    if (ONLY && !raw.startsWith(ONLY)) continue;
    let route = raw;
    const need = [...raw.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const missing = need.find((k) => !ids[k]);
    if (missing) { skipped.push(`${raw} (no local ${missing} to open)`); continue; }
    for (const k of need) route = route.replace(`{${k}}`, ids[k]!);
    await auditRoute(page, route, state);
  }
  await browser.close();
}

const DASHBOARD = [
  "/dashboard", "/dashboard/members", "/dashboard/members/{member}", "/dashboard/members/{member}?edit=1", "/dashboard/members/{member}?tab=memberships",
  "/dashboard/members/{member}?tab=family", "/dashboard/members/{member}/billing", "/dashboard/members/approvals", "/dashboard/members/duplicates",
  "/dashboard/members/migration", "/dashboard/members/roster", "/dashboard/announcements", "/dashboard/attendance", "/dashboard/calendar",
  "/dashboard/check-in", "/dashboard/classes", "/dashboard/communication/audiences", "/dashboard/communication/campaigns",
  "/dashboard/communication/campaigns/{campaign}", "/dashboard/communication/drafts", "/dashboard/communication/results",
  "/dashboard/communication/templates", "/dashboard/communication/unsubscribes", "/dashboard/custom-fields", "/dashboard/documents",
  "/dashboard/events", "/dashboard/events/{event}/roster", "/dashboard/events/bundles", "/dashboard/financials", "/dashboard/front-desk",
  "/dashboard/help", "/dashboard/memberships", "/dashboard/messages", "/dashboard/more", "/dashboard/my-account", "/dashboard/my-profile",
  "/dashboard/preview", "/dashboard/privates", "/dashboard/products", "/dashboard/products/{product}/tags", "/dashboard/products/bookings",
  "/dashboard/products/inventory", "/dashboard/purchase-options", "/dashboard/reports", "/dashboard/reports/imports",
  "/dashboard/reports/imports/{batch}", "/dashboard/schedule", "/dashboard/settings", "/dashboard/settings/billing", "/dashboard/settings/branded-app",
  "/dashboard/settings/club", "/dashboard/settings/diagnostics", "/dashboard/settings/email", "/dashboard/settings/member-form", "/dashboard/staff",
  "/dashboard/staff/{staff}", "/dashboard/staff/availability", "/dashboard/staff/contractors", "/dashboard/staff/payouts", "/dashboard/staff/payroll",
  "/dashboard/staff/payroll/plans", "/dashboard/staff/schedule",
];
const MEMBER = [
  "/member", "/member/announcements", "/member/bookings", "/member/club", "/member/documents", "/member/events", "/member/events/{event}",
  "/member/family/{member}", "/member/memberships", "/member/messages", "/member/privates", "/member/products", "/member/products/{product}",
  "/member/profile", "/member/schedule", "/member/shop", "/member/staff",
];

async function main() {
  console.log(`Crash audit — ${VIEWPORT} — ${BASE}`);
  if (!ONLY || ONLY.startsWith("/dashboard")) await run("owner", DASHBOARD);
  if (!ONLY || ONLY.startsWith("/member")) await run("member", MEMBER);
  writeFileSync(OUT, JSON.stringify({ viewport: VIEWPORT, at: new Date().toISOString(), visited, skipped, findings }, null, 2));
  const sheets = visited.reduce((n, v) => n + v.sheets, 0);
  console.log(`\n${visited.length} pages, ${sheets} sheets opened, ${findings.length} findings, ${skipped.length} skipped → ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
