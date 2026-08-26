/**
 * "Click the card, see the people."
 *
 * Reproduces the Girls Only / Girls Jr Frogs inversion exactly: one plan whose
 * members hold live SUBSCRIPTIONS but whose Member.membershipId points
 * elsewhere, and one plan with the opposite — stale pointers and nobody live.
 * The old count read the pointer, so it got both backwards.
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXECUTABLE = process.env.PW_CHROMIUM ??
  "/Users/cubano/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
const prisma = new PrismaClient();
let pass = 0; const failures: string[] = [];
function check(l: string, ok: boolean, d?: string) {
  if (ok) { pass++; console.log(`  ✓ ${l}`); return; }
  failures.push(d ? `${l} — ${d}` : l); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`);
}
async function api(page: Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p as string);
    return { status: r.status, json: await r.json().catch(() => null) };
  }, path);
}

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "frog-empire" }, select: { id: true } });
  const clubId = club!.id;

  const onlyPlan = await prisma.membership.upsert({
    where: { id: "mship_girls_only" },
    update: { active: true },
    create: { id: "mship_girls_only", clubId, name: "ZZ Girls Only", active: true,
              options: JSON.stringify([{ id: "opt_go", label: "Monthly", price: 75, billingPeriod: "MONTHLY" }]) },
  });
  const jrPlan = await prisma.membership.upsert({
    where: { id: "mship_girls_jr" },
    update: { active: true },
    create: { id: "mship_girls_jr", clubId, name: "ZZ Girls Jr Frogs", active: true,
              options: JSON.stringify([{ id: "opt_gj", label: "Monthly", price: 60, billingPeriod: "MONTHLY" }]) },
  });

  // Two on Girls Only by SUBSCRIPTION, pointer left elsewhere (the real shape).
  for (const [id, first] of [["m_go_a", "Beatriz"], ["m_go_b", "Dakota"]] as const) {
    await prisma.member.upsert({
      where: { id }, update: { membershipId: jrPlan.id, status: "ACTIVE" },
      create: { id, clubId, firstName: first, lastName: "GirlsOnly", status: "ACTIVE", membershipId: jrPlan.id },
    });
    await prisma.memberSubscription.deleteMany({ where: { memberId: id } });
    await prisma.memberSubscription.create({
      data: { memberId: id, membershipId: onlyPlan.id, optionId: "opt_go", optionLabel: "Monthly",
              price: 75, billingPeriod: "MONTHLY", billingType: "MANUAL", status: "active" },
    });
  }
  // One on Girls Jr Frogs by POINTER ONLY — subscription long ended.
  await prisma.member.upsert({
    where: { id: "m_gj_stale" }, update: { membershipId: jrPlan.id, status: "INACTIVE" },
    create: { id: "m_gj_stale", clubId, firstName: "Stale", lastName: "Pointer",
              status: "INACTIVE", membershipId: jrPlan.id },
  });
  await prisma.memberSubscription.deleteMany({ where: { memberId: "m_gj_stale" } });
  await prisma.memberSubscription.create({
    data: { memberId: "m_gj_stale", membershipId: jrPlan.id, optionId: "opt_gj", optionLabel: "Monthly",
            price: 60, billingPeriod: "MONTHLY", billingType: "MANUAL", status: "expired",
            endDate: new Date("2026-06-01T00:00:00Z") },
  });

  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);

  console.log("\nThe count:");
  const r = await api(page, "/api/memberships");
  const plans = (r.json as Array<Record<string, unknown>>) ?? [];
  const go = plans.find((p) => p.id === "mship_girls_only") as { activeMemberCount?: number; _count?: { members: number } };
  const gj = plans.find((p) => p.id === "mship_girls_jr") as { activeMemberCount?: number; _count?: { members: number } };

  check("the pointer-based count is wrong for both, as it was in production",
    go?._count?.members === 0 && gj?._count?.members === 3,
    `pointer: only=${go?._count?.members} jr=${gj?._count?.members}`);
  check("the subscription count says Girls Only has 2", go?.activeMemberCount === 2,
    String(go?.activeMemberCount));
  check("and says Girls Jr Frogs has 0", gj?.activeMemberCount === 0, String(gj?.activeMemberCount));

  console.log("\nThe card:");
  await page.goto(`${BASE}/dashboard/memberships`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const link = page.locator('a[href="/dashboard/members?plan=mship_girls_only"]').first();
  check("the count is a link on the plan card", (await link.count()) > 0);
  check("and it reads 2 members", /2 members/.test((await link.textContent()) ?? ""),
    (await link.textContent()) ?? "");

  console.log("\nClicking it:");
  await link.click();
  await page.waitForURL(/\/dashboard\/members\?plan=/, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  const body = (await page.textContent("body")) ?? "";
  check("the roster shows both members the card counted",
    /Beatriz/.test(body) && /Dakota/.test(body), "missing one");
  check("and does NOT show the stale-pointer member from the other plan",
    !/Stale Pointer/.test(body));

  const rosterApi = await api(page, "/api/members?paginated=1&plan=mship_girls_only&pageSize=50");
  const rows = ((rosterApi.json as { members?: Array<{ firstName: string }> })?.members ?? []);
  check("the roster API agrees — exactly the 2 it counted",
    rows.length === 2 && rows.every((m) => /Beatriz|Dakota/.test(m.firstName)),
    `${rows.length}: ${rows.map((m) => m.firstName).join(", ")}`);

  const jrRoster = await api(page, "/api/members?paginated=1&plan=mship_girls_jr&pageSize=50");
  check("and the plan with only stale pointers returns nobody",
    (((jrRoster.json as { members?: unknown[] })?.members) ?? []).length === 0,
    JSON.stringify(((jrRoster.json as { members?: unknown[] })?.members ?? []).length));

  await prisma.memberSubscription.deleteMany({ where: { memberId: { in: ["m_go_a", "m_go_b", "m_gj_stale"] } } });
  await prisma.member.deleteMany({ where: { id: { in: ["m_go_a", "m_go_b", "m_gj_stale"] } } });
  await prisma.membership.deleteMany({ where: { id: { in: ["mship_girls_only", "mship_girls_jr"] } } });
  await browser.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
