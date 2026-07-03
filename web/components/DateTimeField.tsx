"use client";

// Safari (macOS) renders <input type="datetime-local"> as grayed segmented
// text with no calendar icon and no popup — staff read it as a disabled
// field ("Sal couldn't edit the publish date"). A separate date + time pair
// gets a real clickable picker in every browser, so use this instead of
// datetime-local on owner/staff surfaces.
//
// Value contract matches datetime-local: "YYYY-MM-DDTHH:mm" or "" — callers
// don't change how they store or submit the value.
export default function DateTimeField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const date = value ? value.slice(0, 10) : "";
  const time = value && value.length >= 16 ? value.slice(11, 16) : "";

  function update(d: string, t: string) {
    onChange(d ? `${d}T${t || "00:00"}` : "");
  }

  const inputClass =
    "px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand";

  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 ${className ?? ""}`}>
      <input
        type="date"
        value={date}
        onChange={(e) => update(e.target.value, time)}
        className={`${inputClass} w-full`}
      />
      <input
        type="time"
        value={time}
        onChange={(e) => update(date, e.target.value)}
        disabled={!date}
        title={date ? undefined : "Pick a date first"}
        className={`${inputClass} disabled:opacity-50`}
      />
    </div>
  );
}
