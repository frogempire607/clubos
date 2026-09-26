"use client";

// B21 — a small on/off switch (role="switch"). 44px tap target on phones.
export default function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center disabled:cursor-not-allowed md:min-h-0 md:min-w-0"
    >
      <span
        className={`relative inline-block h-[22px] w-[38px] rounded-full transition-colors duration-150 motion-reduce:transition-none group-disabled:opacity-60 ${
          checked ? "bg-brand" : "bg-app-border"
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-[left] duration-150 motion-reduce:transition-none ${
            checked ? "left-[19px]" : "left-[3px]"
          }`}
        />
      </span>
    </button>
  );
}
