"use client";

import Link from "next/link";
import { BOTTOM_NAV, isItemActive } from "@/lib/dashboardNav";
import { canAccessPath } from "@/lib/permissions";

// Fixed bottom nav for the mobile dashboard. Up to 4 fast-access
// destinations plus a "More" tab that opens the full sidebar drawer so
// every other section stays reachable — including sections the
// permission filter removed from this nav.
//
// Hidden at md+ — desktop uses the persistent sidebar instead.
//
// safe-area-inset-bottom keeps it clear of the iOS home indicator.
//
// Permission gating: for STAFF, hide any link slot they can't access
// (matches DashboardSidebar's behavior via canAccessPath). OWNERS see
// everything. The "More" slot is always rendered so the drawer is
// reachable; the drawer applies its own permission filtering for the
// full nav tree.
export default function DashboardBottomNav({
  pathname,
  onMore,
  role,
  permissions,
}: {
  pathname: string;
  onMore: () => void;
  role?: string;
  permissions?: Record<string, unknown> | null;
}) {
  const isStaff = role === "STAFF";

  const visibleItems = BOTTOM_NAV.filter((item) => {
    if (item.kind === "more") return true; // always visible
    if (!isStaff) return true; // owners see everything
    return canAccessPath(role, permissions ?? null, item.href);
  });

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--color-sidebar-bg)] border-t border-white/10"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex items-stretch">
        {visibleItems.map((item) => {
          if (item.kind === "more") {
            const Icon = item.icon;
            return (
              <li key={item.id} className="flex-1">
                <button
                  type="button"
                  onClick={onMore}
                  className="w-full h-full flex flex-col items-center justify-center gap-1 py-2 text-white/60 hover:text-white"
                >
                  <Icon size={22} strokeWidth={2} />
                  <span className="text-[10px] font-medium">{item.label}</span>
                </button>
              </li>
            );
          }
          const Icon = item.icon;
          const active = isItemActive(item.href, pathname);
          return (
            <li key={item.id} className="flex-1">
              <Link
                href={item.href}
                className={`w-full h-full flex flex-col items-center justify-center gap-1 py-2 ${
                  active ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                <Icon
                  size={22}
                  strokeWidth={2}
                  style={{ color: active ? "var(--color-lime-accent, #A3E635)" : undefined }}
                />
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
