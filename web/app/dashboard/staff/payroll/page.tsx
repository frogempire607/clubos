"use client";

export default function StaffPayrollPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Payroll &amp; Payouts</h1>
        <p className="text-sm text-text-muted mt-1">Track staff hours, pay rates, and payout history</p>
      </div>
      <div className="border border-dashed border-app-border rounded-xl py-24 text-center">
        <div className="text-text-muted text-4xl mb-3">$</div>
        <p className="text-text-muted font-medium mb-1">Payroll coming soon</p>
        <p className="text-text-muted text-sm">
          Calculate staff pay based on hours or salary and export payroll reports here.
        </p>
      </div>
    </div>
  );
}
