"use client";

import type { ReactNode } from "react";

/**
 * Labeled permission switches (2b "Permissions" card). Each row is a
 * `role="switch"` toggle with a one-line description; disabled rows keep a
 * tooltip explaining why. Presentational — state lives in the parent.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  disabledReason,
  children,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="border border-stone-200 rounded-xl p-3 flex flex-col gap-1.5"
      title={disabled ? disabledReason : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-stone-900 leading-snug">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className="relative w-[38px] h-[22px] rounded-full flex-shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)]"
          style={{ background: checked ? "var(--club-accent)" : "#D6D3D1" }}
        >
          <span
            className="absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-[left]"
            style={{ left: checked ? 18 : 2 }}
          />
        </button>
      </div>
      <span className="text-[11.5px] text-stone-500 leading-snug">{description}</span>
      {children}
    </div>
  );
}

/** Responsive 2-up grid of ToggleRows. */
export default function PermissionToggleGrid({ children }: { children: ReactNode }) {
  return <div className="grid sm:grid-cols-2 gap-2.5">{children}</div>;
}
