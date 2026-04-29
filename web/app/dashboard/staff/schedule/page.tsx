"use client";

export default function StaffSchedulePage() {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Schedule</h1>
        <p className="text-sm text-stone-500 mt-1">Staff class assignments and weekly schedule</p>
      </div>
      <div className="border border-dashed border-stone-200 rounded-xl py-24 text-center">
        <div className="text-stone-300 text-4xl mb-3">◫</div>
        <p className="text-stone-600 font-medium mb-1">Staff schedule coming soon</p>
        <p className="text-stone-400 text-sm">
          Assign staff to classes and manage weekly teaching schedules here.
        </p>
      </div>
    </div>
  );
}
