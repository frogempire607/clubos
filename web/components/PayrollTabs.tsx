"use client";

// Payroll & Payouts is one item under Staff: one destination, three tabs.
//   Payroll   → /dashboard/staff/payroll       — what each person is owed (pay lines)
//   Pay plans → /dashboard/staff/payroll/plans — how each person is paid
//   Payouts   → /dashboard/staff/payouts       — records what was actually paid
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { id: "payroll", label: "Payroll", hint: "what is owed", href: "/dashboard/staff/payroll" },
  { id: "plans", label: "Pay plans", hint: "how each person is paid", href: "/dashboard/staff/payroll/plans" },
  { id: "payouts", label: "Payouts", hint: "records what was paid", href: "/dashboard/staff/payouts" },
] as const;

export default function PayrollTabs({ className = "" }: { className?: string }) {
  const pathname = usePathname() ?? "";
  return (
    <div className={className}>
      <h1 className="text-xl sm:text-2xl font-semibold text-text-primary leading-tight tracking-tight">Payroll &amp; Payouts</h1>
      <div role="tablist" aria-label="Payroll and payouts" className="-mx-4 mt-3 overflow-x-auto border-b border-app-border px-4 md:mx-0 md:px-0">
        <div className="flex min-w-max gap-1">
          {TABS.map((t) => {
            // The longest matching tab wins (Pay plans lives under /payroll).
            const match = TABS.filter((x) => pathname === x.href || pathname.startsWith(x.href + "/")).sort((a, b) => b.href.length - a.href.length)[0];
            const active = match?.id === t.id;
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
