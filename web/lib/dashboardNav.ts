import {
  LayoutGrid,
  Users,
  UserCheck,
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
  { id: "members", label: "Members", icon: Users, href: "/dashboard/members" },
  { id: "approvals", label: "Approvals", icon: UserCheck, href: "/dashboard/approvals" },
  {
    id: "staff",
    label: "Staff",
    icon: Shield,
    children: [
      { id: "staff-directory", label: "Directory", href: "/dashboard/staff" },
      { id: "staff-contractors", label: "Guest & Contractors", href: "/dashboard/staff/contractors" },
      { id: "staff-schedule", label: "Schedule", href: "/dashboard/staff/schedule" },
      { id: "staff-availability", label: "Availability", href: "/dashboard/staff/availability" },
      { id: "staff-payroll", label: "Payroll / Payouts", href: "/dashboard/staff/payroll" },
    ],
  },
  {
    id: "purchase-options",
    label: "Purchase Options",
    icon: ShoppingCart,
    children: [
      { id: "memberships", label: "Memberships", href: "/dashboard/purchase-options/memberships" },
      { id: "privates", label: "Privates", href: "/dashboard/purchase-options/privates" },
      { id: "products", label: "Products", href: "/dashboard/purchase-options/products" },
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
    ],
  },
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
  { id: "classes", label: "Classes", icon: Calendar, href: "/dashboard/classes", kind: "link" },
  { id: "money", label: "Money", icon: DollarSign, href: "/dashboard/financials", kind: "link" },
  { id: "more", label: "More", icon: Menu, kind: "more" },
];

export function isGroupActive(item: NavItem, pathname: string): boolean {
  if ("children" in item && item.children) {
    return item.children.some((c) => pathname.startsWith(c.href));
  }
  return false;
}

export function isItemActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}
