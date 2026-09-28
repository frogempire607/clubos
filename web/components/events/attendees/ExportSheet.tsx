"use client";

// Export (design handoff §3 header action). Downloads from
// GET /api/events/[id]/attendees/export, which builds the file from the same
// loader + filter this screen shows — so "what's shown" really is what's shown.

import { useState } from "react";
import Sheet from "@/components/Sheet";
import type { AttendeeFilter } from "@/lib/eventAttendees";

const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold inline-flex items-center justify-center";

export default function ExportSheet({
  eventId,
  filter,
  filterLabel,
  shownCount,
  allCount,
  showRemoved,
  onClose,
}: {
  eventId: string;
  filter: AttendeeFilter;
  filterLabel: string;
  shownCount: number;
  allCount: number;
  showRemoved: boolean;
  onClose: () => void;
}) {
  const filtered = filter !== "all" || showRemoved;
  const [scope, setScope] = useState<"shown" | "all">(filtered ? "shown" : "all");
  const [format, setFormat] = useState<"csv" | "pdf">("csv");

  const q = new URLSearchParams({ format });
  if (scope === "shown") {
    q.set("filter", filter);
    if (showRemoved && filter === "all") q.set("removed", "1");
  }
  const href = `/api/events/${eventId}/attendees/export?${q.toString()}`;

  const choice = (on: boolean) =>
    `min-h-11 px-3 py-2 rounded-[10px] border text-left text-[14px] ${on ? "border-brand bg-info-surface text-text-primary font-semibold" : "border-app-border text-text-primary"}`;

  return (
    <Sheet
      open
      onClose={onClose}
      title="Export attendees"
      description="Name, source, contact, category, attending, owes, status, paid, payment method and payment links sent."
      footer={
        <>
          <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={onClose}>
            Cancel
          </button>
          <a href={href} download className={`${btn} bg-brand text-white hover:bg-brand-hover`} onClick={() => setTimeout(onClose, 0)}>
            Download {format.toUpperCase()}
          </a>
        </>
      }
    >
      <fieldset>
        <legend className="text-[12px] font-semibold text-text-primary mb-1.5">Who</legend>
        <div className="flex flex-col gap-2">
          {filtered && (
            <button type="button" aria-pressed={scope === "shown"} className={choice(scope === "shown")} onClick={() => setScope("shown")}>
              What&apos;s shown — {showRemoved && filter === "all" ? "including removed" : filterLabel} · {shownCount}
            </button>
          )}
          <button type="button" aria-pressed={scope === "all"} className={choice(scope === "all")} onClick={() => setScope("all")}>
            Everyone · {allCount}
          </button>
        </div>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="text-[12px] font-semibold text-text-primary mb-1.5">Format</legend>
        <div className="flex gap-2">
          {(["csv", "pdf"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={format === f} className={`${choice(format === f)} flex-1 text-center`} onClick={() => setFormat(f)}>
              {f === "csv" ? "Spreadsheet (CSV)" : "PDF"}
            </button>
          ))}
        </div>
      </fieldset>
    </Sheet>
  );
}
