/**
 * The sidebar's "where am I" logic, and the canonical-URL contract.
 *
 *   npm run test:dashboard-nav
 *
 * No database, no network.
 *
 * Two bugs this locks down, both found 2026-09-26:
 *
 *   WRONG SECTION HIGHLIGHTED. isGroupActive compared with a bare
 *   pathname.startsWith(child.href), which matches across a path separator.
 *   "/dashboard/memberships".startsWith("/dashboard/members") is true, so
 *   opening Memberships lit up the MEMBERS group. Not "no active item" — the
 *   WRONG active item, which is harder to notice and worse to act on.
 *
 *   TWO URLS, ONE SCREEN. app/dashboard/purchase-options/{memberships,privates,
 *   products}/page.tsx were one-line re-exports of the bare pages, so each
 *   screen answered at two addresses. Half the app linked to one and half to the
 *   other: global search, the revenue drill-downs, the action centre, the
 *   calendar and the classes page used the bare path; the nav and the home tiles
 *   used purchase-options. Arriving through a link the nav did not recognise
 *   left the sidebar pointing somewhere else entirely.
 *
 * The third block is the one that keeps it fixed: every NAV href must be a path
 * the app actually serves as a page, not a redirect. A redirect in the nav is
 * how you get back here.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV, BOTTOM_NAV, isGroupActive, isItemActive, type NavItem } from "../lib/dashboardNav";

const ROOT = join(__dirname, "..");
let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function groupsActiveAt(pathname: string): string[] {
  return NAV.filter((i: NavItem) => "children" in i && i.children && isGroupActive(i, pathname)).map((i) => i.label);
}

console.log("\nDASHBOARD NAV\n");

// ── isItemActive: segment boundaries ────────────────────────────────────────
console.log("isItemActive respects path segments");
ok("exact match", isItemActive("/dashboard/products", "/dashboard/products"));
ok("descendant matches", isItemActive("/dashboard/products", "/dashboard/products/inventory"));
ok("deeper descendant matches", isItemActive("/dashboard/products", "/dashboard/products/abc/tags"));
ok(
  "a prefix-sharing sibling does NOT match",
  isItemActive("/dashboard/members", "/dashboard/memberships") === false,
  "this is the bug: /dashboard/members must not claim /dashboard/memberships",
);
ok("home is exact only", isItemActive("/dashboard", "/dashboard"));
ok("home does not claim every page", isItemActive("/dashboard", "/dashboard/members") === false);

// ── isGroupActive: the reported symptom ─────────────────────────────────────
console.log("\nisGroupActive highlights exactly one, correct group");
const casesOneGroup: [string, string][] = [
  ["/dashboard/memberships", "Purchase Options"],
  ["/dashboard/privates", "Purchase Options"],
  ["/dashboard/products", "Purchase Options"],
  ["/dashboard/products/inventory", "Purchase Options"],
  ["/dashboard/products/bookings", "Purchase Options"],
  ["/dashboard/members", "Members"],
  ["/dashboard/members/approvals", "Members"],
  ["/dashboard/members/some-id", "Members"],
  ["/dashboard/staff", "Staff"],
  ["/dashboard/staff/payroll", "Staff"],
  ["/dashboard/classes", "Classes & Events"],
  ["/dashboard/events", "Classes & Events"],
  ["/dashboard/calendar", "Classes & Events"],
  ["/dashboard/messages", "Communication"],
  ["/dashboard/communication/templates", "Communication"],
];
for (const [path, expected] of casesOneGroup) {
  const got = groupsActiveAt(path);
  ok(
    `${path} → ${expected}`,
    got.length === 1 && got[0] === expected,
    got.length === 1 ? `got ${got[0]}` : `got [${got.join(", ")}]`,
  );
}

// The regression in one assertion, stated the way the bug read on screen.
ok(
  "Memberships does not light up Members",
  groupsActiveAt("/dashboard/memberships").includes("Members") === false,
);

console.log("\nLeaf destinations activate no group");
for (const p of ["/dashboard", "/dashboard/attendance", "/dashboard/front-desk", "/dashboard/financials", "/dashboard/reports", "/dashboard/documents"]) {
  ok(`${p} activates no group`, groupsActiveAt(p).length === 0, `got [${groupsActiveAt(p).join(", ")}]`);
}

// ── Canonical URLs: no nav href may be a redirect ───────────────────────────
console.log("\nEvery nav href resolves to a real page, not a redirect");

function pageFileFor(href: string): string | null {
  const p = join(ROOT, "app", href.replace(/^\//, ""), "page.tsx");
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

const navHrefs = [
  ...NAV.flatMap((i: NavItem) =>
    "children" in i && i.children ? i.children.map((c) => c.href) : [(i as { href: string }).href],
  ),
  ...BOTTOM_NAV.filter((b) => b.kind === "link").map((b) => (b as { href: string }).href),
];

for (const href of Array.from(new Set(navHrefs))) {
  const file = pageFileFor(href);
  if (!file) {
    ok(`${href} has a page`, false, "no page.tsx at that path");
    continue;
  }
  const src = readFileSync(file, "utf8");
  // A redirect stub is a handful of lines whose whole job is redirect(). A real
  // page that happens to call redirect() conditionally is fine, so key off the
  // stub shape rather than the mere presence of the word.
  const isStub = /from "next\/navigation"/.test(src) && /\bredirect\(/.test(src) && src.split("\n").length < 20;
  ok(`${href} is a page, not a redirect stub`, !isStub, isStub ? `${file} looks like a redirect stub` : undefined);
}

// ── The old aliases still answer ────────────────────────────────────────────
console.log("\nThe purchase-options aliases still exist as redirects");
for (const slug of ["memberships", "privates", "products"]) {
  const p = join(ROOT, "app/dashboard/purchase-options", slug, "page.tsx");
  let src = "";
  try {
    src = readFileSync(p, "utf8");
  } catch {
    /* handled below */
  }
  ok(
    `/dashboard/purchase-options/${slug} redirects to /dashboard/${slug}`,
    src.includes("next/navigation") && src.includes(`redirect("/dashboard/${slug}")`),
    src ? "present but not redirecting to the bare path" : "file missing",
  );
  ok(
    `/dashboard/purchase-options/${slug} no longer re-exports the page`,
    !/^export \{ default \}/m.test(src),
    "still a re-export, so the screen is mounted twice",
  );
}

// ── Nothing links to the alias any more ─────────────────────────────────────
console.log("\nNo source file links to a purchase-options URL");

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const offenders: string[] = [];
for (const dir of ["app", "components", "lib"]) {
  for (const file of walk(join(ROOT, dir))) {
    // The redirect stubs themselves live at that path; they are the target.
    if (file.includes("app/dashboard/purchase-options/")) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    src.split("\n").forEach((line, i) => {
      // PATH_PERMISSIONS legitimately still lists the prefix so the redirect
      // stays gated. Anything that puts the alias in an href or a router push
      // is a link, and links are what split the app in two.
      if (!/\/dashboard\/purchase-options/.test(line)) return;
      if (/prefix:/.test(line)) return;
      offenders.push(`${file.replace(ROOT + "/", "")}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
}
ok(
  "no href or push targets /dashboard/purchase-options",
  offenders.length === 0,
  offenders.length ? `\n     ${offenders.join("\n     ")}` : undefined,
);

console.log("");
if (failures.length > 0) {
  console.log(`✗ ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${passed}/${passed} passed — dashboard nav + canonical URLs`);
process.exit(0);
