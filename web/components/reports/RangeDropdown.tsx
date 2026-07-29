"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";

export type RangeKey =
  | "this_week"
  | "last_week"
  | "month"
  | "last_month"
  | "qtd"
  | "ytd"
  | "year"
  | "all"
  | "before_athletix"
  | "since_athletix"
  | "custom";

const OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "qtd", label: "Quarter to date" },
  { key: "ytd", label: "Year to date" },
  { key: "year", label: "Last 12 months" },
  { key: "all", label: "All time" },
  { key: "before_athletix", label: "Before AthletixOS" },
  { key: "since_athletix", label: "Since joining AthletixOS" },
  { key: "custom", label: "Custom range…" },
];

export default function RangeDropdown({
  value,
  onChange,
  customFrom,
  customTo,
  onCustomChange,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
  customFrom?: string;
  customTo?: string;
  onCustomChange?: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);
  const current = OPTIONS.find((o) => o.key === value) ?? OPTIONS[2];
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-9 flex items-center gap-2 px-3 border border-app-border rounded-lg bg-surface text-sm font-medium text-text-primary hover:bg-app-bg transition-colors min-h-[44px] sm:min-h-9"
      >
        <CalendarDays size={15} strokeWidth={2} className="text-text-muted" />
        <span>{current.label}</span>
        <ChevronDown size={13} strokeWidth={2} className="text-text-muted" />
      </button>
      {open && (
        <>
          {/* Bottom sheet on mobile / dropdown on desktop */}
          <div
            className="hidden sm:block absolute right-0 mt-2 w-64 bg-surface border border-app-border rounded-xl shadow-lg p-1.5 z-40"
            style={{ boxShadow: "0 10px 30px rgba(17,17,17,0.12)" }}
          >
            <RangeList value={value} onChange={onChange} onClose={() => setOpen(false)} />
            {value === "custom" && (
              <CustomInputs
                from={customFrom}
                to={customTo}
                onCustomChange={(f, t) => {
                  onCustomChange?.(f, t);
                  setOpen(false);
                }}
              />
            )}
          </div>
          <div className="sm:hidden fixed inset-0 z-50 flex items-end" onClick={() => setOpen(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div
              className="relative w-full bg-surface rounded-t-2xl p-3 pb-safe max-h-[80vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
              style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
            >
              <div className="w-10 h-1 bg-app-border rounded mx-auto mb-3" />
              <RangeList value={value} onChange={onChange} onClose={() => setOpen(false)} mobile />
              {value === "custom" && (
                <CustomInputs
                  from={customFrom}
                  to={customTo}
                  onCustomChange={(f, t) => {
                    onCustomChange?.(f, t);
                    setOpen(false);
                  }}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RangeList({
  value,
  onChange,
  onClose,
  mobile,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
  onClose: () => void;
  mobile?: boolean;
}) {
  return (
    <ul>
      {OPTIONS.map((o) => (
        <li key={o.key}>
          <button
            type="button"
            className={`w-full flex items-center px-2.5 py-2 rounded-md text-left text-sm ${
              value === o.key
                ? "bg-app-bg text-text-primary font-semibold"
                : "text-text-primary hover:bg-app-bg"
            } ${mobile ? "min-h-[44px]" : ""}`}
            onClick={() => {
              onChange(o.key);
              if (o.key !== "custom") onClose();
            }}
          >
            {o.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CustomInputs({
  from,
  to,
  onCustomChange,
}: {
  from?: string;
  to?: string;
  onCustomChange: (from: string, to: string) => void;
}) {
  const [f, setF] = useState(from ?? "");
  const [t, setT] = useState(to ?? "");
  return (
    <div className="border-t border-app-border mt-1 pt-2 px-2 pb-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={f}
          onChange={(e) => setF(e.target.value)}
          className="flex-1 px-2 py-1.5 text-sm border border-app-border rounded"
        />
        <span className="text-xs text-text-muted">to</span>
        <input
          type="date"
          value={t}
          onChange={(e) => setT(e.target.value)}
          className="flex-1 px-2 py-1.5 text-sm border border-app-border rounded"
        />
      </div>
      <button
        onClick={() => {
          if (f && t) onCustomChange(f, t);
        }}
        className="w-full h-9 min-h-[44px] sm:min-h-9 rounded-lg bg-charcoal text-white text-sm font-semibold"
      >
        Apply
      </button>
    </div>
  );
}
