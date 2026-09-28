"use client";

// Payroll & Payouts is one item under Staff: one destination, two tabs.
//   Payroll → /dashboard/staff/payroll — calculates what each person earned
//   Payouts → /dashboard/staff/payouts — records what was actually paid
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { id: "payroll", label: "Payroll", hint: "calculates", href: "/dashboard/staff/payroll" },
  { id: "payouts", label: "Payouts", hint: "records what was paid", href: "/dashboard/staff/payouts" },
] as const;

export default function PayrollTabs({ className = "" }: { className?: string }) {
  const pathname = usePathname() ?? "";
  return (
    <div className={className}>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-text-primary sm:text-2xl">Payroll &amp; Payouts</h1>
      <div role="tablist" aria-label="Payroll and payouts" className="-mx-4 mt-3 overflow-x-auto border-b border-app-border px-4 md:mx-0 md:px-0">
        <div className="flex min-w-max gap-1">
          {TABS.map((t) => {
            const active = pathname === t.href || pathname.startsWith(t.href + "/");
            return (
              <Link
                key={t.id}
                href={t.href}
                role="tab"
                aria-selected={active}
                className={`relative inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap px-2.5 py-2.5 text-[13.5px] md:min-h-0 ${
                  active ? "font-medium text-brand" : "text-text-muted hover:text-text-primary"
                }`}
              >
                {t.label}
                <span className="hidden text-[12px] font-normal text-text-muted sm:inline">· {t.hint}</span>
                {active && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand" />}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
