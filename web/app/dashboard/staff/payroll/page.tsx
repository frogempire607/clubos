"use client";

// Payroll. Since the pay ledger (Branch 2):
//   Pay lines        every payable thing on/after the club's ledger start date,
//                    saved with the rate that priced it (components/staff/pay/LedgerView)
//   Before <date>    the old period calculator, for work before that date
//   Pay plans        /dashboard/staff/payroll/plans
// A club with no ledger start date yet sees only the period calculator.
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PayrollTabs from "@/components/PayrollTabs";
import PaydaysCard from "@/components/staff/pay/PaydaysCard";
import LedgerView from "@/components/staff/pay/LedgerView";
import LegacyPayrollView from "@/components/staff/pay/LegacyPayrollView";
import { fmtYmd, fmtYmdYear } from "@/lib/payLedger";

function PayrollInner() {
  const params = useSearchParams();
  const focus = params?.get("staff") ?? null;
  const [ledgerStart, setLedgerStart] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<"lines" | "before">("lines");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch("/api/payroll/ledger?from=2999-01-01&to=2999-01-01", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setLedgerStart(d?.ledgerStart ?? null);
        // Until the ledger's first day arrives there are no pay lines yet: open on the old calculation.
        if (d?.ledgerStart && d?.today && d.today < d.ledgerStart) setView("before");
      })
      .catch(() => setLedgerStart(null));
  }, []);

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-8">
      <PayrollTabs className="mb-5" />
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-text-primary">Payroll</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          {ledgerStart
            ? <>What each staff member is owed, line by line, from their <Link href="/dashboard/staff/payroll/plans" className="text-brand hover:underline">pay plans</Link> and what actually happened on the schedule. A class day pays once it has ended; a paid line is locked.</>
            : "Calculated from each staff member's compensation plan over the selected period."}
        </p>
      </div>

      <PaydaysCard onPaid={() => setRefreshKey((k) => k + 1)} />

      {ledgerStart === undefined ? (
        <div className="h-40 animate-pulse rounded-xl border border-app-border bg-surface" aria-label="Loading payroll" />
      ) : ledgerStart === null ? (
        <LegacyPayrollView />
      ) : (
        <>
          <div role="tablist" aria-label="Payroll view" className="mb-4 inline-flex flex-wrap gap-1 rounded-lg bg-app-bg p-1">
            {([["lines", `Pay lines · from ${fmtYmd(ledgerStart)}`], ["before", `Before ${fmtYmdYear(ledgerStart)}`]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                className={`min-h-[44px] rounded-md px-3.5 text-[13px] md:min-h-[34px] ${view === id ? "bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}>
                {label}
              </button>
            ))}
          </div>
          {view === "lines" ? <LedgerView refreshKey={refreshKey} focusUserId={focus} /> : <LegacyPayrollView before={ledgerStart} />}
        </>
      )}
    </div>
  );
}

export default function StaffPayrollPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl p-4 sm:p-8"><div className="h-40 animate-pulse rounded-xl border border-app-border bg-surface" /></div>}>
      <PayrollInner />
    </Suspense>
  );
}
