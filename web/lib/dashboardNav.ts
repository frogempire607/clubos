import {
  LayoutGrid,
  Users,
  Shield,
  ShoppingCart,
  Calendar,
  MessageSquare,
  CheckSquare,
  DollarSign,
  BarChart3,
  FileText,
  Settings,
  Menu,
  ScanLine,
  type LucideIcon,
} from "lucide-react";

// Shared nav configuration so the desktop sidebar, the mobile drawer,
// and the mobile bottom nav agree on routes, labels, and icons.
//
// Icons are lucide-react component references (NOT unicode glyphs). iOS
// WebKit doesn't have most geometric unicode glyphs in its fallback
// font chain — they render as "?" tofu boxes inside the native shell.
// SVG icons render identically on every surface.

export type NavChild = { id: string; label: string; href: string };
export type NavItem =
  | { id: string; label: string; icon: LucideIcon; href: string; children?: never }
  | { id: string; label: string; icon: LucideIcon; href?: string; children: NavChild[] };

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
    ],
  },
  {
    id: "staff",
    label: "Staff",
    icon: Shield,
    children: [
      { id: "staff-directory", label: "Directory", href: "/dashboard/staff" },
      { id: "staff-contractors", label: "Guest & Contractors", href: "/dashboard/staff/contractors" },
      { id: "staff-schedule", label: "Schedule", href: "/dashboard/staff/schedule" },
      { id: "staff-availability", label: "Availability", href: "/dashboard/staff/availability" },
      { id: "staff-payroll", label: "Payroll", href: "/dashboard/staff/payroll" },
      { id: "staff-payouts", label: "Payouts", href: "/dashboard/staff/payouts" },
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
    id: "classes-events",
    label: "Classes & Events",
    icon: Calendar,
    children: [
      { id: "classes", label: "Classes", href: "/dashboard/classes" },
      { id: "events", label: "Events", href: "/dashboard/events" },
      { id: "calendar", label: "Calendar", href: "/dashboard/calendar" },
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
  { id: "front-desk", label: "Front desk", icon: ScanLine, href: "/dashboard/front-desk" },
  { id: "attendance", label: "Attendance", icon: CheckSquare, href: "/dashboard/attendance" },
  { id: "financials", label: "Financials", icon: DollarSign, href: "/dashboard/financials" },
  { id: "reports", label: "Reports", icon: BarChart3, href: "/dashboard/reports" },
  { id: "documents", label: "Documents", icon: FileText, href: "/dashboard/documents" },
  { id: "settings", label: "Settings", icon: Settings, href: "/dashboard/settings" },
];

// Bottom-nav slots for mobile. 4 fast-access items + a "More" slot that
// opens the full drawer so nothing is unreachable.
export type BottomNavItem =
  | { id: string; label: string; icon: LucideIcon; href: string; kind: "link" }
  | { id: "more"; label: string; icon: LucideIcon; kind: "more" };

export const BOTTOM_NAV: BottomNavItem[] = [
  { id: "home", label: "Home", icon: LayoutGrid, href: "/dashboard", kind: "link" },
  { id: "members", label: "Members", icon: Users, href: "/dashboard/members", kind: "link" },
  // Front desk replaced Classes here (2026-09-25): checking people in happens
  // every practice; editing classes lives one tap away under More.
  { id: "front-desk", label: "Desk", icon: ScanLine, href: "/dashboard/front-desk", kind: "link" },
  { id: "money", label: "Money", icon: DollarSign, href: "/dashboard/financials", kind: "link" },
  { id: "more", label: "More", icon: Menu, kind: "more" },
];

export function isGroupActive(item: NavItem, pathname: string): boolean {
  if ("children" in item && item.children) {
    // isItemActive, not a bare startsWith. A bare prefix test matched across a
    // path separator, so "/dashboard/memberships".startsWith("/dashboard/members")
    // was true and visiting Memberships lit up the MEMBERS group. The sidebar
    // pointed at the wrong section rather than at no section, which is both
    // harder to notice and worse to act on.
    return item.children.some((c) => isItemActive(c.href, pathname));
  }
  return false;
}

export function isItemActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  // The `+ "/"` is what makes this segment-aware: an exact hit, or a genuine
  // descendant. /dashboard/products matches /dashboard/products/inventory and
  // does not match a sibling that merely shares a prefix.
  return pathname === href || pathname.startsWith(href + "/");
}
