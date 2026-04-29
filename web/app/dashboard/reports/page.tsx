"use client";

export default function ReportsPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Reports</h1>
        <p className="text-sm text-text-muted mt-1">Analytics and exportable reports for your club</p>
      </div>
      <div className="border border-dashed border-app-border rounded-xl py-24 text-center">
        <div className="text-text-muted text-4xl mb-3">▦</div>
        <p className="text-text-muted font-medium mb-1">Reports coming soon</p>
        <p className="text-text-muted text-sm">
          Attendance reports, revenue summaries, member growth, and exports will appear here.
        </p>
      </div>
    </div>
  );
}
