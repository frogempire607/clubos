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
import {
  NAV,
  BOTTOM_NAV,
  isGroupActive,
  isItemActive,
  isEntryActive,
  activeNavHref,
  activeBottomNavId,
  visibleNavFor,
  type NavItem,
} from "../lib/dashboardNav";
import { canAccessPath, ruleForPath, DEFAULT_PERMISSIONS } from "../lib/permissions";

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

function eq(name: string, got: unknown, want: unknown) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
}

function stripCommentsEarly(src: string) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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
  ["/dashboard/members/duplicates", "Members"],
  ["/dashboard/staff", "Staff"],
  ["/dashboard/staff/some-id", "Staff"],
  ["/dashboard/staff/schedule", "Staff"],
  ["/dashboard/staff/availability", "Staff"],
  // 2026-09-28: Payroll & Payouts is one item UNDER Staff (Julian). The
  // longest-href-wins rule keeps the child highlight on it, not on All staff
  // (checked below).
  ["/dashboard/staff/payroll", "Staff"],
  ["/dashboard/staff/payouts", "Staff"],
  ["/dashboard/classes", "Schedule"],
  ["/dashboard/events", "Schedule"],
  ["/dashboard/calendar", "Schedule"],
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
for (const p of ["/dashboard", "/dashboard/check-in", "/dashboard/attendance", "/dashboard/front-desk", "/dashboard/financials", "/dashboard/reports", "/dashboard/documents", "/dashboard/more"]) {
  ok(`${p} activates no group`, groupsActiveAt(p).length === 0, `got [${groupsActiveAt(p).join(", ")}]`);
}

// ── Exactly one entry lights up, even when hrefs nest ───────────────────────
console.log("\nExactly one nav entry is active");
function entriesActiveAt(pathname: string): string[] {
  return NAV.flatMap((i: NavItem) => ("children" in i && i.children ? i.children : [i]))
    .filter((e) => isEntryActive(e, pathname))
    .map((e) => e.label);
}
const casesOneEntry: [string, string][] = [
  ["/dashboard/staff", "All staff"],
  ["/dashboard/staff/abc", "All staff"],
  ["/dashboard/staff/payroll", "Payroll & Payouts"],
  ["/dashboard/staff/payouts", "Payroll & Payouts"],
  ["/dashboard/members", "All members"],
  ["/dashboard/members/duplicates", "Duplicates"],
  ["/dashboard/members/approvals", "Approvals"],
  ["/dashboard/memberships", "Memberships"],
  ["/dashboard/check-in", "Check-in"],
  ["/dashboard/front-desk", "Check-in"],
  ["/dashboard/attendance", "Check-in"],
  ["/dashboard", "Dashboard"],
];
for (const [path, expected] of casesOneEntry) {
  const got = entriesActiveAt(path);
  ok(`${path} → only "${expected}"`, got.length === 1 && got[0] === expected, `got [${got.join(", ")}]`);
}
ok("activeNavHref picks the most specific href", activeNavHref("/dashboard/staff/payroll/2026") === "/dashboard/staff/payroll");

// ── Sidebar shape Julian decided on (2026-09-28) ────────────────────────────
console.log("\nSidebar order and labels");
eq(
  "top-level order",
  NAV.map((i) => i.label),
  ["Dashboard", "Members", "Staff", "Check-in", "Schedule", "Purchase Options", "Communication", "Financials", "Reports", "Documents", "Settings"],
);
const kids = (label: string) => {
  const g = NAV.find((i) => i.label === label);
  return g && "children" in g && g.children ? g.children.map((c) => c.label) : [];
};
eq("Members children", kids("Members"), ["All members", "Migration", "Approvals", "Duplicates"]);
eq("Staff children", kids("Staff"), ["All staff", "Schedule", "Availability", "Payroll & Payouts"]);
eq("Schedule children", kids("Schedule"), ["Calendar", "Classes", "Events"]);
eq("Purchase Options children unchanged", kids("Purchase Options"), ["Memberships", "Privates", "Products"]);
{
  const staff = NAV.find((i) => i.label === "Staff");
  const kidsOf = staff && "children" in staff && staff.children ? staff.children : [];
  const pp = kidsOf.find((c) => c.label === "Payroll & Payouts")!;
  const all = kidsOf.find((c) => c.label === "All staff")!;
  for (const path of ["/dashboard/staff/payroll", "/dashboard/staff/payouts"]) {
    eq(`${path} lights Payroll & Payouts`, isEntryActive(pp, path), true);
    eq(`${path} does NOT light All staff`, isEntryActive(all, path), false);
  }
}
eq("no separate Payroll & Payouts group", NAV.some((i) => i.label === "Payroll & Payouts"), false);
ok(
  "no nav entry points at the retired contractors page",
  !NAV.some((i) => ("children" in i && i.children ? i.children : [i]).some((e) => (e as { href?: string }).href === "/dashboard/staff/contractors")),
);

// ── Phone bottom bar ────────────────────────────────────────────────────────
console.log("\nPhone bottom bar");
eq("bottom bar slots", BOTTOM_NAV.map((b) => b.label), ["Home", "Members", "Check-in", "Money", "More"]);
const bottomCases: [string, string][] = [
  ["/dashboard", "home"],
  ["/dashboard/members", "members"],
  ["/dashboard/members/abc", "members"],
  // The prefix bug again, on the phone: Memberships must not light Members.
  ["/dashboard/memberships", "more"],
  ["/dashboard/check-in", "check-in"],
  ["/dashboard/front-desk", "check-in"],
  ["/dashboard/attendance", "check-in"],
  ["/dashboard/financials", "money"],
  ["/dashboard/more", "more"],
  ["/dashboard/classes", "more"],
  ["/dashboard/staff/payroll", "more"],
];
for (const [path, expected] of bottomCases) {
  const got = activeBottomNavId(path);
  ok(`bottom bar at ${path} → ${expected}`, got === expected, `got ${got}`);
}
{
  const layout = readFileSync(join(ROOT, "app/dashboard/layout.tsx"), "utf8");
  ok("dashboard layout no longer mounts the mobile drawer", !/DashboardMobileDrawer/.test(stripCommentsEarly(layout)));
  ok("dashboard layout has no hamburger button", !/aria-label="Open menu"/.test(layout));
  const bar = readFileSync(join(ROOT, "components/DashboardBottomNav.tsx"), "utf8");
  ok("bottom bar does not hide on scroll", !/addEventListener\("scroll"/.test(bar) && !/translate-y-full/.test(bar));
}

// ── Permissions for the new destinations ────────────────────────────────────
console.log("\nPermissions for Check-in and More");
const none = Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).map((k) => [k, "none"]));
const attendanceEdit = { ...none, attendance: "edit" };
ok("/dashboard/more has no rule (everyone may open it)", ruleForPath("/dashboard/more") === null);
ok("STAFF with nothing can open More", canAccessPath("STAFF", none, "/dashboard/more"));
ok("/dashboard/check-in is gated like attendance", canAccessPath("STAFF", none, "/dashboard/check-in") === false);
ok("…and opens with attendance: edit", canAccessPath("STAFF", attendanceEdit, "/dashboard/check-in"));
ok(
  "STAFF with only attendance sees Dashboard + Check-in in the nav",
  JSON.stringify(visibleNavFor("STAFF", attendanceEdit).map((i) => i.label)) === JSON.stringify(["Dashboard", "Check-in"]),
  `got ${JSON.stringify(visibleNavFor("STAFF", attendanceEdit).map((i) => i.label))}`,
);
ok("OWNER sees the whole nav", visibleNavFor("OWNER", null).length === NAV.length);

// ── The retired contractors page redirects into All staff ───────────────────
console.log("\nRetired pages redirect");
{
  const src = readFileSync(join(ROOT, "app/dashboard/staff/contractors/page.tsx"), "utf8");
  ok(
    "/dashboard/staff/contractors redirects to /dashboard/staff?type=contractors",
    src.includes("next/navigation") && src.includes(`redirect("/dashboard/staff?type=contractors")`),
  );
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
  ...BOTTOM_NAV.map((b) => b.href),
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
