"use client";

export default function StaffAvailabilityPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Availability</h1>
        <p className="text-sm text-stone-500 mt-1">Manage staff availability windows and exceptions</p>
      </div>
      <div className="border border-dashed border-stone-200 rounded-xl py-24 text-center">
        <div className="text-stone-300 text-4xl mb-3">◎</div>
        <p className="text-stone-600 font-medium mb-1">Staff availability coming soon</p>
        <p className="text-stone-400 text-sm">
          Set recurring weekly hours and block out vacations or exceptions per staff member.
        </p>
      </div>
    </div>
  );
}
