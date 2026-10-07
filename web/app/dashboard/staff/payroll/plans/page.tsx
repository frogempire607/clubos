"use client";

// Payroll → Pay plans: every staff member's named, dated pay plans — add,
// edit, copy one plan to another coach, remove.
import PayrollTabs from "@/components/PayrollTabs";
import PayPlansPanel from "@/components/staff/pay/PayPlansPanel";

export default function PayPlansPage() {
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <PayrollTabs className="mb-5" />
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-text-primary">Pay plans</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          A coach can have several plans — for example one rate as lead coach of one class and another as an assistant in a different class.
          When more than one could pay the same class day, the most specific one is used. If none fits, that day shows as “needs review” on Payroll rather than a guessed amount.
        </p>
      </div>
      <PayPlansPanel />
    </div>
  );
}
