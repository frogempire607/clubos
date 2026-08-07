"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Sub-tabs for the Members section (mirrors the sidebar's Members group).
const TABS = [
  { label: "All members", href: "/dashboard/members" },
  { label: "Migration", href: "/dashboard/members/migration" },
  { label: "Approvals", href: "/dashboard/members/approvals" },
];

export default function MembersTabs() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b border-app-border mb-6 overflow-x-auto">
      {TABS.map((t) => {
        const active =
          t.href === "/dashboard/members"
            ? pathname === "/dashboard/members"
            : pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            // 4.5.9 — 44px on a phone, unchanged density on desktop.
            className={`inline-flex min-h-[44px] items-center px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors md:min-h-0 ${
              active
                ? "border-brand text-brand font-medium"
                : "border-transparent text-text-muted hover:text-text-primary"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
