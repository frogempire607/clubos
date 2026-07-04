"use client";

import { useRef } from "react";
import type { ReactNode } from "react";

export type SegmentOption = {
  value: string;
  label: ReactNode;
  /** Optional count rendered as a small badge after the label. */
  badge?: number;
};

/**
 * Pill segmented tabs on a soft track — the portal's tab primitive
 * (Schedule|Bookings, Agenda|Calendar, Upcoming|Past|All).
 *
 * Accessible: `role="tablist"` with `aria-selected` + arrow-key roving
 * focus. Presentational only; selection state lives in the parent.
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
  className = "",
}: {
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function focusAndSelect(index: number) {
    const next = options[(index + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[(index + options.length) % options.length]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusAndSelect(index + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusAndSelect(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAndSelect(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAndSelect(options.length - 1);
    }
  }

  const pad = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex w-full gap-1 rounded-xl bg-[#EEECE9] p-1 ${className}`}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 rounded-[9px] font-semibold whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)] ${pad} ${
              selected ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {opt.label}
            {typeof opt.badge === "number" && opt.badge > 0 && (
              <span
                className="min-w-[16px] h-[16px] px-1 rounded-full text-[10px] font-bold inline-flex items-center justify-center"
                style={{ background: "var(--club-accent-soft)", color: "var(--club-accent)" }}
              >
                {opt.badge > 9 ? "9+" : opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
