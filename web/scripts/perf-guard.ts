/**
 * Keeps the 2026-11 speed fixes from quietly coming undone.
 *
 *   npx tsx scripts/perf-guard.ts
 *
 * No database, no network — this reads the source tree. Each check names the
 * symptom a person would see if it regressed.
 *
 * Measured before the fixes (Netlify, production, 2026-11-15):
 *   /api/member/portal            1.6 s typical · 5.5 s slow end
 *   /api/members/[id]             2.0 s typical
 *   /api/members/[id]/billing-admin  1.2 s typical · 4.0 s slow end
 * and the database itself answered every SELECT in under 13 ms on average —
 * the time was going on doing things one after another, on asking twice, and
 * on Stripe.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Blank comments so a rule quoted in a comment is not mistaken for code. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
}

/**
 * Bodies of `for (...) { ... }` loops in a source string (brace-matched), so a
 * check can ask "is there an await on Stripe INSIDE a loop?".
 */
function loopBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\bfor\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "{") continue;
    const start = i;
    depth = 0;
    do { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; } while (i < src.length && depth > 0);
    out.push(src.slice(start, i));
  }
  return out;
}
const STRIPE_AWAIT = /await\s+(stripe\.|listCustomerPaymentMethods|resolveCardSnapshot|stampedOwner|liveStripeFacts|bundleOf|fetchCustomerBundle)/;

console.log("\n§1 Stripe is never called one-at-a-time inside a loop on a page read");
for (const rel of [
  "app/api/members/[id]/billing-admin/route.ts",
  "lib/payerWallet.ts",
  "lib/paymentMethodsAdmin.ts",
  "app/api/member/auto-renew/route.ts",
  "app/api/member/billing/route.ts",
]) {
  const src = code(rel);
  // Only the GET / read helpers matter; the write paths are deliberately serial.
  const scope = rel.endsWith("billing-admin/route.ts") ? src.slice(0, src.indexOf("export async function PATCH")) : src;
  const scoped = rel === "lib/paymentMethodsAdmin.ts" ? scope.slice(scope.indexOf("export async function lastPaidWithForCustomers"), scope.indexOf("export async function locatePaymentMethod")) : scope;
  const bad = loopBodies(scoped).filter((b) => STRIPE_AWAIT.test(b));
  check(`${rel}: no sequential Stripe await in a loop`, bad.length === 0, bad[0]?.slice(0, 160).replace(/\s+/g, " "));
}
{
  const src = code("app/api/members/[id]/billing-admin/route.ts");
  check("billing-admin: each Stripe customer is fetched once per request (memoAsync)", /memoAsync\(\(customerId: string\) => fetchCustomerBundle/.test(src));
  check("billing-admin: the Stripe reads have a time budget", /withTimeout\(/.test(src) && /STRIPE_READ_BUDGET_MS/.test(src));
  check("billing-admin: ?lite=1 skips Stripe", /searchParams\.get\("lite"\) === "1"/.test(src) && /loadStripeReads\(lite \? null/.test(src));
  check("billing-admin: no Stripe memo at module level (it would leak one family's cards to the next viewer)",
    !/^(const|let|var)\s+\w+\s*=\s*memoAsync\(/m.test(src));
  const approvals = code("app/dashboard/members/approvals/page.tsx");
  check("approvals list asks for the lite read per card", /billing-admin\?lite=1/.test(approvals));
}
{
  const card = code("lib/memberCard.ts");
  check("card label lookups give up after a budget instead of Stripe's 80 s default", /withTimeout\(readCardSnapshot/.test(card));
  check("no card memo at module level", !/^(const|let|var)\s+\w+\s*=\s*(memoAsync|cardSnapshotLookup)\(/m.test(card));
}

console.log("\n§2 a card that shows five rows asks for five rows");
{
  const home = code("app/dashboard/page.tsx");
  check("dashboard home does not download the whole roster", !/fetch\(\s*"\/api\/members"\s*\)/.test(home) && /\/api\/members\?recent=5/.test(home));
  check("dashboard home does not download every event", !/fetch\(\s*"\/api\/events"\s*\)/.test(home) && /\/api\/events\?next=5/.test(home));
  check("dashboard home cards load independently (one slow read cannot hold the page)", !/await Promise\.all\(\[\s*fetch\("\/api\/members/.test(home));
  const memberHome = code("app/member/page.tsx");
  check("member home asks for three announcements", /\/api\/member\/announcements\?limit=3/.test(memberHome));
  const ann = code("app/api/member/announcements/route.ts");
  check("announcement 'seen' bookkeeping is two statements, not one write per announcement", /createMany\(/.test(ann) && !/\.upsert\(/.test(ann));
}

console.log("\n§3 nothing is asked for twice on one screen");
{
  const layout = code("app/member/layout.tsx");
  const previewEffect = /useEffect\(\(\) => \{\s*fetch\("\/api\/preview"\)[\s\S]*?\}, \[(.*?)\]\);/.exec(layout);
  check("member layout checks preview mode once, not on every navigation", !!previewEffect && previewEffect[1].trim() === "", `deps: [${previewEffect?.[1] ?? "?"}]`);
  for (const rel of ["app/member/layout.tsx", "app/member/page.tsx", "app/member/profile/page.tsx", "app/member/messages/page.tsx", "components/member/BookingsPanel.tsx", "components/member/AthleteRail.tsx", "components/member/ui.tsx", "app/member/club/page.tsx"]) {
    const src = code(rel);
    check(`${rel}: portal/club reads go through sharedGet`, !/fetch\("\/api\/member\/(portal|club)"\)/.test(src));
  }
  for (const rel of ["components/NotificationBell.tsx", "components/ActionCenterWidget.tsx"]) {
    check(`${rel}: action-center is one shared request`, /sharedGet[^(]*\("\/api\/dashboard\/action-center"\)/.test(code(rel)));
  }
  for (const rel of ["components/members/MembershipPanel.tsx", "components/members/PaymentMethodsCard.tsx"]) {
    check(`${rel}: the billing read is shared with its neighbour`, /sharedGet[^(]*\(`\/api\/members\/\$\{memberId\}\/billing-admin`\)/.test(code(rel)));
  }
}

console.log("\n§4 independent reads run together");
{
  const portal = code("app/api/member/portal/route.ts");
  check("member portal: own profile and managed children are read side by side", /const \[own, guardianOf\] = await Promise\.all\(/.test(portal));
  check("member portal: no duplicate subscription/member queries", (portal.match(/prisma\.memberSubscription\.findMany/g) ?? []).length === 1);
  const profile = code("app/api/members/[id]/route.ts");
  check("staff member profile: the detail blocks are awaited together", /await Promise\.all\(tasks\);/.test(profile) && (profile.match(/tasks\.push\(\(async \(\) => \{/g) ?? []).length >= 7);
  const roster = code("lib/membersQuery.ts");
  check("staff roster: counts and facets go out together", /const \[total, archived, historical, facets\] = await Promise\.all\(/.test(roster));
}

console.log("\n§5 a tap always shows something");
for (const rel of ["app/dashboard/loading.tsx", "app/member/loading.tsx", "app/dashboard/error.tsx", "app/member/error.tsx"]) {
  check(`${rel} exists`, existsSync(join(ROOT, rel)));
}
{
  const layout = code("app/dashboard/layout.tsx");
  check("dashboard frame is drawn while the session loads (no blank 'Loading…' page)", !/>Loading…</.test(layout) && /aria-busy="true"/.test(layout));
  check("dashboard menu falls back to the signed-in role, never to 'unknown = owner'", /me \?\? \{ role: sessionUser\.role/.test(layout) && /me=\{viewer\}/.test(layout) && /role=\{viewer\.role\}/.test(layout));
  check("dashboard frame uses the phone's real visible height", !/100vh/.test(layout) && /100dvh/.test(layout));
}

console.log(`\n${"─".repeat(70)}`);
if (failed) {
  console.log(`✗ ${failed} speed guard check(s) failed\n`);
  process.exit(1);
}
console.log("✓ speed guard passed\n");
