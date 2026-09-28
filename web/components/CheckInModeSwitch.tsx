"use client";

// Door / Roster switch shown at the top of both check-in screens. They are one
// job (the "Check-in" nav item) seen two ways:
//   Door   → /dashboard/front-desk  — tap people in as they arrive
//   Roster → /dashboard/attendance  — mark a session's roster
import Link from "next/link";
import { usePathname } from "next/navigation";

const MODES = [
  { id: "door", label: "Door", href: "/dashboard/front-desk" },
  { id: "roster", label: "Roster", href: "/dashboard/attendance" },
] as const;

export default function CheckInModeSwitch({ className = "" }: { className?: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Check-in mode" className={`inline-flex rounded-lg border border-app-border bg-app-bg p-0.5 ${className}`}>
      {MODES.map((m) => {
        const active = pathname === m.href || pathname.startsWith(m.href + "/");
        return (
          <Link
            key={m.id}
            href={m.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-[44px] min-w-[88px] items-center justify-center rounded-md px-4 text-[13px] font-medium md:min-h-[32px] ${
              active ? "bg-surface text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"
            }`}
          >
            {m.label}
          </Link>
        );
      })}
    </nav>
  );
}
