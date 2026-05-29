"use client";

import Link from "next/link";
import { BOTTOM_NAV, isItemActive } from "@/lib/dashboardNav";

// Fixed bottom nav for the mobile dashboard. 4 fast-access destinations
// plus a "More" tab that opens the full sidebar drawer so every other
// section stays reachable.
//
// Hidden at md+ — desktop uses the persistent sidebar instead.
//
// safe-area-inset-bottom keeps it clear of the iOS home indicator.
export default function DashboardBottomNav({
  pathname,
  onMore,
}: {
  pathname: string;
  onMore: () => void;
}) {
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--color-sidebar-bg)] border-t border-white/10"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex items-stretch">
        {BOTTOM_NAV.map((item) => {
          if (item.kind === "more") {
            return (
              <li key={item.id} className="flex-1">
                <button
                  type="button"
                  onClick={onMore}
                  className="w-full h-full flex flex-col items-center justify-center gap-0.5 py-2 text-white/60 hover:text-white"
                >
                  <span className="text-xl leading-none">{item.icon}</span>
                  <span className="text-[10px] font-medium">{item.label}</span>
                </button>
              </li>
            );
          }
          const active = isItemActive(item.href, pathname);
          return (
            <li key={item.id} className="flex-1">
              <Link
                href={item.href}
                className={`w-full h-full flex flex-col items-center justify-center gap-0.5 py-2 ${
                  active ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                <span
                  className="text-xl leading-none"
                  style={{ color: active ? "var(--color-primary)" : undefined }}
                >
                  {item.icon}
                </span>
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
