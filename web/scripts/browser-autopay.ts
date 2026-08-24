/**
 * Browser check: the §8.6 autopay + auto-renew surfaces, driven through a real
 * authenticated session.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *
 * Every branch that would TALK to Stripe is deliberately out of reach here —
 * scripts/dev-local.sh blanks STRIPE_SECRET_KEY, and the fixtures below are
 * built so each guard fires before any API call. So this proves the routing,
 * the permission gates, the refusals, the queue, and the two writes that touch
 * no Stripe object (set_auto_renew on a manual row). It does NOT prove that
 * `stripe.subscriptions.update(cancel_at_period_end)` or the create-on-ON path
 * behave against a live account; those need a Stripe test account and are
 * called out as untested in the handover.
 *
 *   ./scripts/dev-local.sh                            # local Postgres only
 *   npx tsx scripts/seed-local-browser-test.ts
 *   npx tsx scripts/browser-autopay.ts
 *
 * Drive ONE host consistently — the app redirects between 127.0.0.1 and
 * localhost and the session cookie does not follow.
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

// localhost, NOT 127.0.0.1: the app redirects to `localhost` after sign-in, and
// the session cookie is host-scoped — signing in on one and landing on the
// other silently drops the session and bounces straight back to /login.
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXECUTABLE = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await page.fill('input[type="email"]', "owner@local.test");
  await page.fill('input[type="password"]', "localtest123");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Fetch from inside the page so the session cookie rides along. */
async function api(page: Page, path: string, init?: { method?: string; body?: unknown }) {
  return page.evaluate(
    async ([p, m, b]) => {
      const res = await fetch(p as string, {
        method: (m as string) || "GET",
        ...(b ? { headers: { "content-type": "application/json" }, body: b as string } : {}),
      });
      let json: unknown = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    },
    [path, init?.method ?? "GET", init?.body ? JSON.stringify(init.body) : null] as const,
  );
}

async function main() {
  // ── fixtures ──────────────────────────────────────────────────────────────
  const club = await prisma.club.findFirst({ where: { slug: "frog-empire" }, select: { id: true } });
  if (!club) throw new Error("Seed the local club first.");
  // Build the fixture rather than borrowing a seeded row: this test flips
  // billing state and must not leave a seeded member changed for the next
  // script that reads the same database.
  const plan = await prisma.membership.findFirst({
    where: { clubId: club.id, deletedAt: null },
    select: { id: true },
  });
  // m_dupe_keep is the seeded member with a portal login (marcus@local.test),
  // which is what lets the member-side route be driven as a real member rather
  // than asserted about.
  const member = await prisma.member.findFirst({
    where: { clubId: club.id, deletedAt: null, id: "m_dupe_keep" },
    select: { id: true },
  });
  if (!plan || !member) throw new Error("Seed the local club first.");
  const sub = await prisma.memberSubscription.create({
    data: {
      memberId: member.id, membershipId: plan.id,
      optionLabel: "Autopay fixture", price: 175, billingPeriod: "MONTHLY",
      billingType: "MANUAL", status: "active", autoRenew: true,
      startDate: new Date(), currentPeriodEnd: new Date(Date.now() + 20 * 864e5),
      paidThroughDate: new Date(Date.now() + 20 * 864e5),
    },
    select: { id: true, memberId: true, autoRenew: true, price: true, billingPeriod: true },
  });
  console.log(`\nFixture: subscription ${sub.id} on member ${sub.memberId} ($${sub.price} ${sub.billingPeriod})\n`);

  const startedAt = new Date();
  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage();
  await login(page);

  const A = `/api/members/${sub.memberId}/billing-admin/actions`;

  // ── 1. the confirm-dialog preview ─────────────────────────────────────────
  console.log("Owner preview (GET):");
  const offPrev = await api(page, `${A}?subscriptionId=${sub.id}&direction=off`);
  check("preview 200s for the off direction", offPrev.status === 200, `got ${offPrev.status}`);
  const offBody = offPrev.json as { ready?: boolean; sentence?: string } | null;
  check("a manual row reports autopay is already off, not a fake date",
    offBody?.ready === false && /already off/i.test(offBody?.sentence ?? ""),
    JSON.stringify(offBody));

  const onPrev = await api(page, `${A}?subscriptionId=${sub.id}&direction=on`);
  const onBody = onPrev.json as { ready?: boolean; blockedReason?: string; sentence?: string } | null;
  check("the on direction refuses with a reason, never a silent ready:true",
    onPrev.status === 200 && onBody?.ready === false && !!onBody?.blockedReason,
    JSON.stringify(onBody));

  check("preview 400s without a direction",
    (await api(page, `${A}?subscriptionId=${sub.id}`)).status === 400);
  check("preview 404s for a subscription that is not this member's",
    (await api(page, `${A}?subscriptionId=nope&direction=off`)).status === 404);

  // ── 2. set_autopay refusals (no Stripe object exists to act on) ───────────
  console.log("\nOwner set_autopay:");
  const already = await api(page, A, {
    method: "POST", body: { action: "set_autopay", confirm: true, subscriptionId: sub.id, autopay: false },
  });
  check("turning autopay OFF on a manual row is refused, not a no-op success",
    already.status === 409 && (already.json as { code?: string })?.code === "ALREADY_OFF",
    `${already.status} ${JSON.stringify(already.json)}`);

  const onAttempt = await api(page, A, {
    method: "POST", body: { action: "set_autopay", confirm: true, subscriptionId: sub.id, autopay: true },
  });
  check("turning autopay ON without club Stripe is refused before anything is written",
    onAttempt.status === 409, `${onAttempt.status} ${JSON.stringify(onAttempt.json)}`);
  const untouched = await prisma.memberSubscription.findUnique({
    where: { id: sub.id }, select: { billingType: true, stripeSubscriptionId: true },
  });
  check("a refused ON leaves the row exactly as it was",
    untouched?.billingType === "MANUAL" && untouched?.stripeSubscriptionId === null);

  check("set_autopay without confirm:true is rejected",
    (await api(page, A, { method: "POST", body: { action: "set_autopay", subscriptionId: sub.id, autopay: true } })).status === 400);
  check("set_autopay refuses another member's subscription",
    (await api(page, A, { method: "POST", body: { action: "set_autopay", confirm: true, subscriptionId: "nope", autopay: false } })).status === 404);

  // ── 3. set_auto_renew — the one real write with no Stripe object ──────────
  console.log("\nOwner set_auto_renew:");
  const before = await prisma.memberSubscription.findUnique({
    where: { id: sub.id }, select: { autoRenew: true, endDate: true, paidThroughDate: true, currentPeriodEnd: true },
  });
  const target = !before!.autoRenew;
  const flip = await api(page, A, {
    method: "POST", body: { action: "set_auto_renew", confirm: true, subscriptionId: sub.id, autoRenew: target },
  });
  check(`flipping auto-renew to ${target} succeeds`, flip.status === 200,
    `${flip.status} ${JSON.stringify(flip.json)}`);
  const after = await prisma.memberSubscription.findUnique({
    where: { id: sub.id }, select: { autoRenew: true, endDate: true },
  });
  check("the flip actually reached the database", after?.autoRenew === target);
  if (target === false) {
    check("auto-renew OFF stamps an end date — a membership that stops must say when",
      after?.endDate != null);
  } else {
    check("auto-renew ON clears the end date — it no longer stops",
      after?.endDate === null);
  }
  const repeat = await api(page, A, {
    method: "POST", body: { action: "set_auto_renew", confirm: true, subscriptionId: sub.id, autoRenew: target },
  });
  check("asking for the state it is already in is an idempotent no-op, not an error",
    repeat.status === 200 && (repeat.json as { unchanged?: boolean })?.unchanged === true,
    `${repeat.status} ${JSON.stringify(repeat.json)}`);

  const audits = await prisma.billingAuditLog.count({
    where: {
      memberId: sub.memberId,
      action: { in: ["AUTO_RENEW_ON", "AUTO_RENEW_OFF"] },
      createdAt: { gte: startedAt },
    },
  });
  check("the change is in the billing audit log", audits > 0, `${audits} rows`);

  // restore
  await api(page, A, {
    method: "POST", body: { action: "set_auto_renew", confirm: true, subscriptionId: sub.id, autoRenew: before!.autoRenew },
  });

  // ── 4. the member queue, end to end, without touching Stripe ─────────────
  //
  // A row that LOOKS Stripe-billed reaches ready:true on the off direction
  // without any API call — that preview reads local fields only. The request is
  // then queued, rendered, and DECLINED. Approving it would be the one action
  // that talks to Stripe, so it deliberately is not exercised here.
  console.log("\nMember request queue:");
  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: {
      stripeSubscriptionId: "sub_localfixture_notreal",
      billingType: "RECURRING",
      currentPeriodEnd: new Date(Date.now() + 20 * 864e5),
    },
  });

  const queued = await prisma.pendingApproval.create({
    data: {
      clubId: club.id, memberId: sub.memberId, kind: "MEMBERSHIP_AUTOPAY_CHANGE",
      amount: sub.price, status: "PENDING",
      payload: { subscriptionId: sub.id, direction: "off", optionLabel: "Fixture", reason: null },
    },
    select: { id: true },
  });

  const queue = await api(page, "/api/approvals");
  const rows = ((queue.json as { approvals?: Array<Record<string, unknown>> } | null)?.approvals ?? []);
  const row = rows.find((r) => r.id === queued.id) as
    | { direction?: string; preview?: { ready?: boolean; sentence?: string } | null }
    | undefined;
  check("the request appears in the owner approvals queue", !!row);
  check("the queue row carries its direction", row?.direction === "off");
  check("the queue row carries a LIVE preview, recomputed rather than replayed from the payload",
    row?.preview?.ready === true && /collects \$/.test(row?.preview?.sentence ?? ""),
    JSON.stringify(row?.preview));

  const declined = await api(page, "/api/approvals/membership-autopay", {
    method: "POST", body: { approvalId: queued.id, decision: "DECLINE" },
  });
  check("declining closes the request", declined.status === 200 &&
    (declined.json as { approved?: boolean })?.approved === false);
  const closed = await prisma.pendingApproval.findUnique({
    where: { id: queued.id }, select: { status: true },
  });
  check("a declined request is DECLINED, and the membership is untouched", closed?.status === "DECLINED");
  const stillOn = await prisma.memberSubscription.findUnique({
    where: { id: sub.id }, select: { billingType: true, stripeSubscriptionId: true },
  });
  check("declining changed no billing state",
    stillOn?.billingType === "RECURRING" && stillOn?.stripeSubscriptionId === "sub_localfixture_notreal");

  check("acting on a request that is no longer pending 404s",
    (await api(page, "/api/approvals/membership-autopay", {
      method: "POST", body: { approvalId: queued.id, decision: "APPROVE" },
    })).status === 404);

  // ── 5. the member-side route, as an actual member ────────────────────────
  console.log("\nMember-side route (signed in as a member):");
  const mp = await browser.newPage();
  await mp.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await mp.waitForTimeout(800);
  await mp.fill('input[placeholder="apex-wrestling"]', "frog-empire");
  await mp.fill('input[type="email"]', "marcus@local.test");
  await mp.fill('input[type="password"]', "localtest123");
  await Promise.all([
    mp.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    mp.click('button[type="submit"]'),
  ]);

  const M = `/api/member/subscriptions/${sub.id}/autopay`;
  const mGet = await api(mp, M);
  const mBody = mGet.json as { currentlyOn?: boolean; direction?: string; sentence?: string } | null;
  check("a member sees which way their own membership can move",
    mGet.status === 200 && mBody?.currentlyOn === true && mBody?.direction === "off",
    `${mGet.status} ${JSON.stringify(mBody)}`);
  check("the member is shown the same sentence the owner will see",
    /collects \$/.test(mBody?.sentence ?? ""), JSON.stringify(mBody?.sentence));

  const mSame = await api(mp, M, { method: "POST", body: { direction: "on" } });
  check("asking for the state it is already in queues nothing",
    mSame.status === 200 && (mSame.json as { unchanged?: boolean })?.unchanged === true,
    `${mSame.status} ${JSON.stringify(mSame.json)}`);

  const mReq = await api(mp, M, { method: "POST", body: { direction: "off", reason: "Paying cash now" } });
  check("a real request returns 202 — accepted, not applied", mReq.status === 202,
    `${mReq.status} ${JSON.stringify(mReq.json)}`);
  const memberQueued = await prisma.pendingApproval.findFirst({
    where: { memberId: sub.memberId, kind: "MEMBERSHIP_AUTOPAY_CHANGE", status: "PENDING" },
    select: { id: true, payload: true },
  });
  check("it lands in the owner queue, not in the billing state", !!memberQueued);
  const stillManualSide = await prisma.memberSubscription.findUnique({
    where: { id: sub.id }, select: { billingType: true, stripeSubscriptionId: true },
  });
  check("the member's request changed nothing about the subscription",
    stillManualSide?.billingType === "RECURRING" &&
    stillManualSide?.stripeSubscriptionId === "sub_localfixture_notreal");

  const mDupe = await api(mp, M, { method: "POST", body: { direction: "off" } });
  check("a duplicate request does not queue a second time",
    mDupe.status === 200 && (mDupe.json as { alreadyRequested?: boolean })?.alreadyRequested === true,
    `${mDupe.status} ${JSON.stringify(mDupe.json)}`);

  check("a member cannot act on their own request — the approval route is staff-only",
    (await api(mp, "/api/approvals/membership-autopay", {
      method: "POST", body: { approvalId: memberQueued?.id ?? "x", decision: "APPROVE" },
    })).status === 403 ||
    (await api(mp, "/api/approvals/membership-autopay", {
      method: "POST", body: { approvalId: memberQueued?.id ?? "x", decision: "APPROVE" },
    })).status === 401);

  check("an owner session cannot use the member request route",
    (await api(page, M, { method: "POST", body: { direction: "off" } })).status === 401);

  if (memberQueued) await prisma.pendingApproval.delete({ where: { id: memberQueued.id } });
  await mp.close();

  // Remove the fixture entirely — including its audit rows, which belong to a
  // subscription that never really existed.
  await prisma.pendingApproval.deleteMany({ where: { id: queued.id } });
  await prisma.memberSubscriptionEvent.deleteMany({ where: { memberSubscriptionId: sub.id } });
  await prisma.memberSubscription.delete({ where: { id: sub.id } });

  await browser.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
