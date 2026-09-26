// B6 / §1h + §1k — the chrome around the migration queue:
//
//   MigrationTurnControl   Needs you · Waiting on member · In setup · Done
//   MigrationNeedsYouCards the 4-up "what needs you" cards (phone: snap scroller)
//   MigrationWaitingOnPill the coloured whose-turn pill in the Step column
//   MigrationEmptySearch   names the active filters + a spelling suggestion
//
// Counts come from the funnel payload; the rules that produce them live in
// lib/migrationQueueModel.ts so the list route filters with the same ones.

"use client";

import { SearchX } from "lucide-react";
import {
  NEEDS,
  NEED_COPY,
  QUEUE_TURNS,
  QUEUE_TURN_LABELS,
  type Need,
  type NeedCounts,
  type QueueTurn,
} from "@/lib/migrationQueueModel";

export type TurnCountsPayload = { needsYou: number; waitingOnMember: number; inSetup: number; done: number; blocked: number };

const TURN_COUNT_KEY: Record<QueueTurn, keyof TurnCountsPayload> = {
  needs_you: "needsYou",
  waiting_member: "waitingOnMember",
  in_setup: "inSetup",
  done: "done",
};

/** Segmented control. Picking the active segment again clears it. */
export function MigrationTurnControl({
  counts,
  active,
  onPick,
}: {
  counts: TurnCountsPayload | null;
  active: QueueTurn | null;
  onPick: (t: QueueTurn | null) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Whose turn"
      className="grid grid-cols-2 gap-[3px] rounded-lg bg-app-bg p-[3px] sm:inline-flex sm:flex-wrap"
    >
      {QUEUE_TURNS.map((t) => {
        const on = active === t;
        const n = counts ? counts[TURN_COUNT_KEY[t]] : null;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(on ? null : t)}
            className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md px-3 text-[13px] transition md:min-h-[32px] ${
              on ? "bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"
            }`}
          >
            {QUEUE_TURN_LABELS[t]}
            {n !== null && (
              <span className={`tabular-nums ${on ? "text-text-primary" : "text-text-muted"}`}>{n.toLocaleString()}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Four cards, one per thing the owner can clear. Desktop: 4-up (2×2 at md).
 * Phone: a horizontal snap scroller that keeps the page itself from
 * scrolling sideways — the overflow is contained in this row.
 */
export function MigrationNeedsYouCards({
  needs,
  active,
  onPick,
}: {
  needs: NeedCounts | null;
  active: Need | null;
  onPick: (n: Need | null) => void;
}) {
  return (
    <div
      className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4"
      aria-label="Needs you"
    >
      {NEEDS.map((k) => {
        const c = NEED_COPY[k];
        const n = needs ? needs[k] : null;
        const on = active === k;
        const idle = n === 0;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onPick(on ? null : k)}
            aria-pressed={on}
            className={`flex min-h-[44px] w-[78%] shrink-0 snap-start flex-col rounded-xl border bg-surface p-3.5 text-left transition sm:w-auto ${
              on ? "border-brand ring-1 ring-brand" : "border-app-border hover:border-brand/50"
            } ${idle ? "opacity-60" : ""}`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-text-primary">{c.title}</span>
              <span
                className="text-[22px] font-semibold tabular-nums leading-none"
                style={k === "blocked" && n ? { color: "var(--color-danger-text)" } : undefined}
              >
                {n === null ? "–" : n.toLocaleString()}
              </span>
            </span>
            <span className="mt-1 text-[12px] text-text-muted">{c.body}</span>
            <span className="mt-2 text-[12px] font-medium text-brand">{idle ? "Nothing to do" : on ? "Showing these · clear" : `${c.action} →`}</span>
          </button>
        );
      })}
    </div>
  );
}

const PILL: Record<string, { label: string; style: React.CSSProperties }> = {
  STAFF: { label: "You", style: { background: "var(--color-info-surface)", color: "var(--color-primary)" } },
  MEMBER: { label: "Member", style: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" } },
  BLOCKED: { label: "Blocked", style: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" } },
  NOBODY: { label: "Nobody", style: { background: "var(--color-chip-surface, var(--color-bg))", color: "var(--color-chip-text, var(--color-muted))" } },
};

/** `You` brand-tint · `Member` orange-tint · red when blocked · `Nobody` neutral. */
export function MigrationWaitingOnPill({ waitingOn }: { waitingOn: string }) {
  const p = PILL[waitingOn] ?? PILL.NOBODY;
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={p.style}
      title={waitingOn === "STAFF" ? "Waiting on you" : waitingOn === "MEMBER" ? "Waiting on the member" : undefined}
    >
      {p.label}
    </span>
  );
}

/** §1k empty search — says what is filtering, offers a way out. */
export function MigrationEmptySearch({
  sentence,
  suggestion,
  hasFilters,
  onUseSuggestion,
  onClear,
  onSearchAll,
}: {
  sentence: string;
  suggestion: string | null;
  hasFilters: boolean;
  onUseSuggestion: (s: string) => void;
  onClear: () => void;
  /** Keep the search, drop the other filters. Omitted when there is no search. */
  onSearchAll?: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-app-bg">
        <SearchX className="h-5 w-5 text-text-muted" aria-hidden />
      </span>
      <p className="text-[14px] font-semibold text-text-primary">{sentence}</p>
      {suggestion && (
        <p className="mt-1 text-[13px] text-text-muted">
          Did you mean{" "}
          <button
            type="button"
            onClick={() => onUseSuggestion(suggestion)}
            className="inline-flex min-h-[44px] items-center font-medium text-brand underline md:min-h-0"
          >
            {suggestion}
          </button>
          ?
        </p>
      )}
      {hasFilters && (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {onSearchAll && (
            <button
              type="button"
              onClick={onSearchAll}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-3 text-[13px] text-text-primary hover:bg-app-bg md:min-h-[34px]"
            >
              Search everyone imported
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-white hover:bg-brand-hover md:min-h-[34px]"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
