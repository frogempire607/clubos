"use client";

// Pay tab on a staff profile. Since the pay ledger (Branch 2) a staff member
// can hold several named, dated pay plans, so the plan list and its editor are
// the shared PayPlansPanel (also Payroll → Pay plans). The pay schedule card is
// unchanged. Staff can see their own plans and their own pay lines but never
// change them — the server refuses, and this tab is read-only for them.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";
import PayScheduleCard from "@/components/staff/pay/PayScheduleCard";
import PayPlansPanel from "@/components/staff/pay/PayPlansPanel";
import type { StaffTabProps } from "@/components/staff/types";

export default function PayTab({ data, reload, setDirty }: StaffTabProps) {
  const { staff, viewer } = data;
  const first = staff.firstName || "this staff member";
  const [scheduleDirty, setScheduleDirty] = useState(false);

  useEffect(() => {
    setDirty(scheduleDirty);
  }, [scheduleDirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  if (!viewer.canViewPay) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-dashed border-app-border bg-surface px-5 py-4 text-[13px] text-text-muted">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Pay is visible to the owner and staff with Financials &amp; payroll: view.</span>
      </div>
    );
  }

  const readOnly = !viewer.canEditPay || viewer.isSelf;
  return (
    <div className="pb-4">
      {readOnly && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-4 py-3 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {viewer.isSelf
              ? "Your pay is set by the owner."
              : `Only the owner and staff with Financials & payroll: full can change ${first}'s pay.`}
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[1.55fr_1fr]">
        <div className="min-w-0">
          <PayPlansPanel staffId={staff.id} onChanged={() => void reload()} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <PayScheduleCard
            staffId={staff.id}
            first={first}
            readOnly={readOnly}
            isSelf={viewer.isSelf}
            onDirtyChange={setScheduleDirty}
          />
          <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold text-text-primary">How pay is worked out</h2>
            <p className="mt-2 text-[13px] text-text-primary">
              A class day pays once it has ended, from the plan that best fits that class and role. Salary pays once per pay period. A substitute is paid from their own plan.
            </p>
            <p className="mt-2 text-[12.5px] text-text-muted">
              These are the plans, not an amount owed. Payroll shows what is owed, line by line.
            </p>
          </section>
          {!viewer.isSelf && (
            <section className="rounded-xl border border-app-border bg-surface p-2">
              <PayLink href={`/dashboard/staff/payroll?staff=${staff.id}`} title="Payroll" desc={`What ${first} is owed, line by line.`} />
              <PayLink href="/dashboard/staff/payouts" title="Payouts" desc={`Records what you actually paid ${first}, and when.`} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function PayLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-app-bg">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-text-primary">{title}</span>
        <span className="block text-[12.5px] text-text-muted">{desc}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
    </Link>
  );
}
