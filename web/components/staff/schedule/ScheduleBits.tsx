"use client";

// The shared look of a schedule item (Branch 3): the activity-type tag, the
// state badges and the legend. One mapping (lib/activityType.ts) for the staff
// Schedule and a staff profile's Schedule tab. Colour is never the only
// signal — the type prints its name and every state is text with an icon.
import { AlertTriangle, ArrowLeftRight, Ban, Check, Clock, Layers, UserX } from "lucide-react";
import { STATE_BADGES, activityMeta, legendFor, type ScheduleState } from "@/lib/activityType";

const ICONS = { alert: AlertTriangle, clock: Clock, swap: ArrowLeftRight, ban: Ban, overlap: Layers, x: UserX, check: Check } as const;

const TONE: Record<"warn" | "danger" | "info" | "muted", React.CSSProperties> = {
  warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)", borderColor: "var(--color-warn-border)" },
  danger: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)", borderColor: "var(--color-danger-border)" },
  info: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)", borderColor: "transparent" },
  muted: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)", borderColor: "transparent" },
};

/** "● MS/HS" — the activity type, as a coloured dot plus its short name. */
export function TypeTag({ type, className = "" }: { type: string | null | undefined; className?: string }) {
  const m = activityMeta(type);
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-medium uppercase tracking-wide text-text-muted ${className}`}>
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: m.color }} />
      {m.short}
    </span>
  );
}

/** The left-edge stripe colour for an item of this type. */
export const stripeOf = (type: string | null | undefined): React.CSSProperties => ({ borderLeftColor: activityMeta(type).color });

/** State badges: an icon and the words. `title` carries the detail (what it overlaps with). */
export function StateBadges({ states, detail, text }: { states: readonly ScheduleState[]; detail?: string | null; text?: Partial<Record<ScheduleState, string>> }) {
  if (states.length === 0) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {states.map((s) => {
        const b = STATE_BADGES[s];
        const Icon = ICONS[b.icon];
        return (
          <span key={s} title={s === "CONFLICT" && detail ? detail : undefined}
            className="inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-left text-[12px] font-semibold leading-tight" style={TONE[b.tone]}>
            <Icon aria-hidden className="h-3 w-3 shrink-0" />
            {text?.[s] ?? b.label}
          </span>
        );
      })}
    </span>
  );
}

/** The legend for the types on screen, plus what the state badges mean. */
export function ScheduleLegend({ types, showStates = true }: { types: Iterable<string>; showStates?: boolean }) {
  const list = legendFor(types);
  if (list.length === 0) return null;
  return (
    <div aria-label="Legend" className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-app-border bg-surface px-3 py-2 text-[12.5px] text-text-muted">
      {list.map((t) => (
        <span key={t.type} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
          {t.label}
        </span>
      ))}
      {showStates && (
        <span className="inline-flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <StateBadges states={["NEEDS_COVERAGE", "LATE_CALLOUT", "SUBSTITUTE", "CANCELLED", "CONFLICT"]} />
        </span>
      )}
    </div>
  );
}
