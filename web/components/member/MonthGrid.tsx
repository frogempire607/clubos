"use client";

// Mobile month grid (1e) — day cells with colored event dots; tapping a day
// tells the parent, which renders that day's items below. Presentational.

import { useState } from "react";
import type { CalItem } from "@/components/member/WeekCalendar";

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_HEADS = ["S", "M", "T", "W", "T", "F", "S"];

export default function MonthGrid({
  items,
  selectedDate,
  onSelectDate,
}: {
  items: CalItem[];
  selectedDate: Date | null;
  onSelectDate: (d: Date) => void;
}) {
  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const today = new Date();

  function shift(months: number) {
    setMonthStart((prev) => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + months);
      return next;
    });
  }

  // Cells from the Sunday before the 1st through the Saturday after month end.
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }
  // Trim trailing full weeks outside the month.
  while (cells.length > 7 && cells[cells.length - 7].getMonth() !== monthStart.getMonth()) {
    cells.splice(cells.length - 7, 7);
  }

  return (
    <div className="pcard p-4">
      <div className="flex items-center justify-between mb-2.5">
        <p className="text-sm font-semibold text-stone-900">
          {monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </p>
        <div className="flex items-center gap-1 text-stone-500">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label="Previous month"
            className="w-8 h-8 rounded-lg hover:bg-stone-100 flex items-center justify-center"
          >
            <ChevronIcon dir="left" />
          </button>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label="Next month"
            className="w-8 h-8 rounded-lg hover:bg-stone-100 flex items-center justify-center"
          >
            <ChevronIcon dir="right" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_HEADS.map((l, i) => (
          <span key={i} className="text-[9px] font-bold uppercase tracking-[0.04em] text-stone-400 text-center">
            {l}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day) => {
          const inMonth = day.getMonth() === monthStart.getMonth();
          const isToday = sameDay(day, today);
          const isSelected = !!selectedDate && sameDay(day, selectedDate);
          const dayItems = items.filter((it) => sameDay(new Date(it.startsAt), day));
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onSelectDate(day)}
              aria-pressed={isSelected}
              aria-label={`${day.toLocaleDateString("en-US", { month: "long", day: "numeric" })}${dayItems.length ? `, ${dayItems.length} scheduled` : ""}`}
              className="relative aspect-square min-h-[44px] rounded-lg flex items-center justify-center text-[11px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)]"
              style={
                isSelected
                  ? { background: "var(--club-accent)", color: "var(--club-accent-contrast)" }
                  : {
                      background: "#FAFAF9",
                      color: inMonth ? (isToday ? "var(--club-accent)" : "#57534E") : "#D6D3D1",
                    }
              }
            >
              {day.getDate()}
              {dayItems.length > 0 && (
                <span className="absolute bottom-[5px] flex gap-[2px]">
                  {dayItems.slice(0, 3).map((it) => (
                    <span
                      key={it.id}
                      className="w-1 h-1 rounded-full"
                      style={{ background: isSelected ? "#fff" : it.color }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-stone-400 mt-2.5">
        Tap a day to see its classes &amp; events. Same data as Agenda — your pick.
      </p>
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
