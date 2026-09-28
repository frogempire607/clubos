"use client";

import Link from "next/link";
import { BOTTOM_NAV, activeBottomNavId } from "@/lib/dashboardNav";
import { canAccessPath } from "@/lib/permissions";

// Fixed bottom tab bar for the phone dashboard — the ONE phone nav (audit
// §6.2/§6.6: no hamburger, no drawer). Four fast-access destinations plus
// "More", a real page (/dashboard/more) listing everything else the viewer
// can open.
//
// It never hides on scroll: a tab bar that slides away is a tab bar people
// can't find. Hidden at md+ — desktop uses the persistent sidebar instead.
//
// safe-area-inset-bottom keeps it clear of the iOS home indicator.
//
// Permission gating: for STAFF, hide any slot they can't access (matches
// DashboardSidebar's behavior via canAccessPath). OWNERS see everything.
// "More" is always rendered; the More page filters its own list.
export default function DashboardBottomNav({
  pathname,
  role,
  permissions,
}: {
  pathname: string;
  role?: string;
  permissions?: Record<string, unknown> | null;
}) {
  const isStaff = role === "STAFF";

  const visibleItems = BOTTOM_NAV.filter((item) => {
    if (item.id === "more") return true; // always visible
    if (!isStaff) return true; // owners see everything
    return canAccessPath(role, permissions ?? null, item.href);
  });
  const activeId = activeBottomNavId(pathname);

  return (
    <nav
      aria-label="Main"
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--color-sidebar-bg)] border-t border-white/10"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex items-stretch">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          return (
            <li key={item.id} className="flex-1 min-w-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`sidebar-focus w-full h-full min-h-[56px] flex flex-col items-center justify-center gap-1 py-2 ${
                  active ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                <Icon
                  size={22}
                  strokeWidth={2}
                  style={{ color: active ? "var(--color-lime-accent, #A3E635)" : undefined }}
                />
                <span className="text-[12px] font-medium truncate max-w-full px-1">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
