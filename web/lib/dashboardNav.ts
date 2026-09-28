import {
  LayoutGrid,
  Users,
  UserCog,
  ShoppingCart,
  Calendar,
  MessageSquare,
  DollarSign,
  BarChart3,
  FileText,
  Settings,
  Menu,
  ScanLine,
  type LucideIcon,
} from "lucide-react";
import { canAccessPath } from "./permissions";

// Shared nav configuration so the desktop sidebar, the phone "More" page,
// and the phone bottom nav agree on routes, labels, and icons.
//
// Icons are lucide-react component references (NOT unicode glyphs). iOS
// WebKit doesn't have most geometric unicode glyphs in its fallback
// font chain — they render as "?" tofu boxes inside the native shell.
// SVG icons render identically on every surface.

// `match` lists extra hrefs that also count as "this item" for the active
// highlight. Check-in is one destination that lives at two real pages
// (front desk and attendance), so it lights up on either.
export type NavChild = { id: string; label: string; href: string; match?: string[] };
export type NavItem =
  | { id: string; label: string; icon: LucideIcon; href: string; match?: string[]; children?: never }
  | { id: string; label: string; icon: LucideIcon; href?: string; match?: never; children: NavChild[] };

export const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid, href: "/dashboard" },
  {
    id: "members",
    label: "Members",
    icon: Users,
    children: [
      { id: "members-all", label: "All members", href: "/dashboard/members" },
      { id: "members-migration", label: "Migration", href: "/dashboard/members/migration" },
      { id: "members-approvals", label: "Approvals", href: "/dashboard/members/approvals" },
      { id: "members-duplicates", label: "Duplicates", href: "/dashboard/members/duplicates" },
    ],
  },
  {
    id: "staff",
    label: "Staff",
    icon: UserCog,
    // One list for everyone who works here (2026-09-28): staff logins and
    // no-login contractors/guests share /dashboard/staff with a Type filter.
    // The old /dashboard/staff/contractors address redirects there.
    // Payroll & Payouts is ONE item here (Julian, 2026-09-28): one page with
    // two tabs — Payroll (calculates) and Payouts (records what was paid).
    children: [
      { id: "staff-directory", label: "All staff", href: "/dashboard/staff" },
      { id: "staff-schedule", label: "Schedule", href: "/dashboard/staff/schedule" },
      { id: "staff-availability", label: "Availability", href: "/dashboard/staff/availability" },
      {
        id: "staff-payroll",
        label: "Payroll & Payouts",
        href: "/dashboard/staff/payroll",
        match: ["/dashboard/staff/payouts"],
      },
    ],
  },
  // Front desk (phones, at the door) and Attendance (roster, bigger screens)
  // are one job. /dashboard/check-in picks the right one for the screen, and
  // both pages carry a Door / Roster switch.
  {
    id: "check-in",
    label: "Check-in",
    icon: ScanLine,
    href: "/dashboard/check-in",
    match: ["/dashboard/front-desk", "/dashboard/attendance"],
  },
  {
    id: "schedule",
    label: "Schedule",
    icon: Calendar,
    children: [
      { id: "calendar", label: "Calendar", href: "/dashboard/calendar" },
      { id: "classes", label: "Classes", href: "/dashboard/classes" },
      { id: "events", label: "Events", href: "/dashboard/events" },
    ],
  },
  {
    id: "purchase-options",
    label: "Purchase Options",
    icon: ShoppingCart,
    // Canonical URLs, 2026-09-26. These three screens were mounted at TWO
    // addresses: app/dashboard/purchase-options/memberships/page.tsx was a
    // one-line re-export of app/dashboard/memberships/page.tsx, and the same
    // for privates and products. One component, two URLs, and the app disagreed
    // with itself about which to link — global search, the revenue drill-downs,
    // the action centre, the calendar and the classes page all used the bare
    // path while the nav and the home tiles used the purchase-options one.
    //
    // The bare path is canonical because the child routes already live under
    // it: /dashboard/products/inventory, /dashboard/products/bookings and
    // /dashboard/products/[id]/tags. Making purchase-options canonical would
    // have left those children hanging off a different parent, so the nav could
    // never highlight them. This way isItemActive's descendant match lights
    // Products up on every one of them for free.
    //
    // The purchase-options paths now redirect here, so old links and bookmarks
    // keep working.
    children: [
      { id: "memberships", label: "Memberships", href: "/dashboard/memberships" },
      { id: "privates", label: "Privates", href: "/dashboard/privates" },
      { id: "products", label: "Products", href: "/dashboard/products" },
    ],
  },
  {
    id: "communication",
    label: "Communication",
    icon: MessageSquare,
    children: [
      { id: "messages", label: "Messaging", href: "/dashboard/messages" },
      { id: "announcements", label: "Announcements", href: "/dashboard/announcements" },
      { id: "campaigns", label: "Campaigns", href: "/dashboard/communication/campaigns" },
      { id: "email-drafts", label: "Drafts", href: "/dashboard/communication/drafts" },
      { id: "email-results", label: "Email sends", href: "/dashboard/communication/results" },
      { id: "templates", label: "Templates", href: "/dashboard/communication/templates" },
      { id: "audiences", label: "Audiences", href: "/dashboard/communication/audiences" },
      { id: "unsubscribes", label: "Unsubscribes", href: "/dashboard/communication/unsubscribes" },
    ],
  },
  { id: "financials", label: "Financials", icon: DollarSign, href: "/dashboard/financials" },
  { id: "reports", label: "Reports", icon: BarChart3, href: "/dashboard/reports" },
  { id: "documents", label: "Documents", icon: FileText, href: "/dashboard/documents" },
  { id: "settings", label: "Settings", icon: Settings, href: "/dashboard/settings" },
];

// Bottom-nav slots for phones: one bar, no hamburger (audit §6.2/§6.6).
// Four fast-access destinations + "More", which is a real page listing
// everything else the viewer can open.
export type BottomNavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
  match?: string[];
};

export const BOTTOM_NAV: BottomNavItem[] = [
  { id: "home", label: "Home", icon: LayoutGrid, href: "/dashboard" },
  { id: "members", label: "Members", icon: Users, href: "/dashboard/members" },
  {
    id: "check-in",
    label: "Check-in",
    icon: ScanLine,
    href: "/dashboard/check-in",
    match: ["/dashboard/front-desk", "/dashboard/attendance"],
  },
  { id: "money", label: "Money", icon: DollarSign, href: "/dashboard/financials" },
  { id: "more", label: "More", icon: Menu, href: "/dashboard/more" },
];

export function isItemActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  // The `+ "/"` is what makes this segment-aware: an exact hit, or a genuine
  // descendant. /dashboard/products matches /dashboard/products/inventory and
  // does not match a sibling that merely shares a prefix.
  return pathname === href || pathname.startsWith(href + "/");
}

/** Every href a nav entry answers to: its own plus any `match` extras. */
function hrefsOf(entry: { href?: string; match?: string[] }): string[] {
  return [...(entry.href ? [entry.href] : []), ...(entry.match ?? [])];
}

/**
 * The single nav href that best describes `pathname`: the longest NAV href
 * (including `match` extras) that isItemActive accepts.
 *
 * Longest wins because some nav hrefs are ancestors of others.
 * "/dashboard/staff" (All staff) is an ancestor of "/dashboard/staff/payroll"
 * (Payroll & Payouts). A plain isItemActive test would light up BOTH groups on
 * the payroll page — the "wrong section highlighted" bug again, one level
 * down. Picking the most specific href keeps exactly one item active.
 */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const item of NAV) {
    const entries = "children" in item && item.children ? item.children : [item];
    for (const e of entries) {
      for (const h of hrefsOf(e)) {
        if (isItemActive(h, pathname) && (!best || h.length > best.length)) best = h;
      }
    }
  }
  return best;
}

/** True when this leaf / child is THE active nav entry for `pathname`. */
export function isEntryActive(entry: { href?: string; match?: string[] }, pathname: string): boolean {
  const best = activeNavHref(pathname);
  if (best) return hrefsOf(entry).includes(best);
  // Not a NAV path at all (e.g. /dashboard/more): fall back to the plain test.
  return hrefsOf(entry).some((h) => isItemActive(h, pathname));
}

export function isGroupActive(item: NavItem, pathname: string): boolean {
  if ("children" in item && item.children) {
    // isEntryActive, not a bare startsWith. A bare prefix test matched across a
    // path separator, so "/dashboard/memberships".startsWith("/dashboard/members")
    // was true and visiting Memberships lit up the MEMBERS group. The sidebar
    // pointed at the wrong section rather than at no section, which is both
    // harder to notice and worse to act on.
    return item.children.some((c) => isEntryActive(c, pathname));
  }
  return false;
}

/**
 * Which bottom-bar tab is lit. Home, Members, Check-in and Money light up on
 * their own pages (Check-in also on front desk and attendance); every other
 * dashboard page is reached through More, so More is lit there.
 */
export function activeBottomNavId(pathname: string): string {
  for (const b of BOTTOM_NAV) {
    if (b.id === "more") continue;
    if (hrefsOf(b).some((h) => isItemActive(h, pathname))) return b.id;
  }
  return "more";
}

/**
 * NAV as one viewer may see it. OWNERS (and a viewer whose role hasn't loaded
 * yet) get everything; STAFF lose any leaf or child canAccessPath refuses, and
 * a group with no children left disappears. Shared by the desktop sidebar and
 * the phone More page so the two can never disagree.
 */
export function visibleNavFor(role: string | undefined, perms: Record<string, unknown> | null | undefined): NavItem[] {
  if (role !== "STAFF") return NAV;
  return NAV.flatMap((item): NavItem[] => {
    if ("children" in item && item.children) {
      const kids = item.children.filter((c) => canAccessPath(role, perms ?? null, c.href));
      if (kids.length === 0) return [];
      return [{ ...item, children: kids }];
    }
    const href = (item as { href: string }).href;
    return canAccessPath(role, perms ?? null, href) ? [item] : [];
  });
}
