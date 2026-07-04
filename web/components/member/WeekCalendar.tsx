"use client";

// Desktop week grid (2c) — 7 day columns with colored event chips, plus
// ‹ Today › paging. Presentational: items in, chip clicks out.

import { useState } from "react";

export type CalItem = {
  id: string;
  title: string;
  startsAt: string;
  color: string;
  textColor: string;
};

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - out.getDay());
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function WeekCalendar({
  items,
  onSelect,
}: {
  items: CalItem[];
  onSelect?: (item: CalItem) => void;
}) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  function shift(weeks: number) {
    setWeekStart((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + weeks * 7);
      return next;
    });
  }

  const weekLabel = weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="pcard p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-stone-900">Week of {weekLabel}</p>
        <div className="flex items-center gap-1 text-xs text-stone-500">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label="Previous week"
            className="w-7 h-7 rounded-lg hover:bg-stone-100 flex items-center justify-center"
          >
            <ChevronIcon dir="left" />
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(startOfWeek(new Date()))}
            className="px-2 py-1 rounded-lg hover:bg-stone-100 font-medium"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label="Next week"
            className="w-7 h-7 rounded-lg hover:bg-stone-100 flex items-center justify-center"
          >
            <ChevronIcon dir="right" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1.5 mb-1.5">
        {DAY_LABELS.map((l) => (
          <span key={l} className="text-[10px] font-bold uppercase tracking-[0.05em] text-stone-400 pl-0.5">
            {l}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day) => {
          const isToday = sameDay(day, today);
          const dayItems = items
            .filter((it) => sameDay(new Date(it.startsAt), day))
            .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
          return (
            <div
              key={day.toISOString()}
              className="min-h-[120px] rounded-[10px] border p-1.5 flex flex-col gap-1 bg-white min-w-0"
              style={
                isToday
                  ? { borderColor: "var(--club-accent-ring)", background: "var(--club-accent-soft)" }
                  : { borderColor: "#F0EEEC" }
              }
            >
              <span
                className="text-xs font-bold"
                style={{ color: isToday ? "var(--club-accent)" : "#78716C" }}
              >
                {day.getDate()}
              </span>
              {dayItems.map((it) => {
                const time = new Date(it.startsAt)
                  .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                  .replace(":00", "")
                  .replace(" ", "")
                  .toLowerCase();
                const chip = (
                  <span
                    className="block text-[9.5px] font-bold rounded-[5px] px-1 py-[3px] leading-[1.15] truncate text-left w-full"
                    style={{ background: it.color, color: it.textColor }}
                  >
                    {time} {it.title}
                  </span>
                );
                return onSelect ? (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onSelect(it)}
                    className="w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)] rounded-[5px]"
                    title={it.title}
                  >
                    {chip}
                  </button>
                ) : (
                  <span key={it.id}>{chip}</span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
      className={dir === "left" ? "rotate-180" : ""}
    >
      <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
    </svg>
  );
}
