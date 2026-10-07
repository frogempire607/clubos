"use client";

// Read-only "who is coaching this class day" for a club on the new coach
// scheduling — used where the old inline coach editors used to be (Calendar).
// It shows each coach with their role and state, and ONE button that opens
// the class-day sheet (components/staff/schedule/ClassDaySheet.tsx), where
// every change to a class day is made.
import type { RichStaffRow } from "@/lib/classStaff";
import { classDayState, rowState, type StateTone } from "@/lib/classStaffUi";

const TONE: Record<StateTone, React.CSSProperties> = {
  normal: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
  late: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
  covered: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
  noshow: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
  canceled: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
};

export default function ClassDayCoaches({
  day,
  onOpen,
}: {
  day: { switched?: boolean; canceled?: boolean; cancel?: { paid: boolean } | null; needsCoverage?: boolean; staffRows?: RichStaffRow[] };
  onOpen: () => void;
}) {
  const state = classDayState(day);
  const rows = (day.staffRows ?? []).map((r) => ({ r, st: rowState(r) })).filter((x) => !!x.st);
  return (
    <div className="mt-3 border-t border-app-border pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-medium text-text-primary">Coaches</p>
        {state && (
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={TONE[state.tone]}>
            {state.label}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] text-text-muted">Nobody assigned.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map(({ r, st }) => (
            <li key={r.id ?? r.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-primary">
              <span className="font-medium">{r.name}</span>
              <span className="rounded-full px-2 py-0.5 text-xs" style={TONE.normal}>{r.roleLabel}</span>
              {st!.tone !== "normal" && (
                <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={TONE[st!.tone]}>{st!.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-3.5 text-[13px] font-medium text-text-primary hover:bg-app-bg md:min-h-[36px]"
      >
        Open this class day
      </button>
      <p className="mt-1.5 text-xs text-text-muted">Coaches, call-outs, substitutes and canceling are all in one place there.</p>
    </div>
  );
}
