"use client";

export default function StaffSchedulePage() {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Schedule</h1>
        <p className="text-sm text-text-muted mt-1">Staff class assignments and weekly schedule</p>
      </div>
      <div className="border border-dashed border-app-border rounded-xl py-24 text-center">
        <div className="text-text-muted text-4xl mb-3">◫</div>
        <p className="text-text-muted font-medium mb-1">Staff schedule coming soon</p>
        <p className="text-text-muted text-sm">
          Assign staff to classes and manage weekly teaching schedules here.
        </p>
      </div>
    </div>
  );
}
