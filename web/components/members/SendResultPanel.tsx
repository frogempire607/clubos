// B6 / §1k — the result of a bulk invitation or reminder send.
//
// Never a flat "Sent 24". Three layers, each only when it has something to say:
//   · success   — "21 invitations sent" + "3 people were skipped: 2 have no
//                 email on file, 1 already finished moving over." + an
//                 expander that names each skipped person and why;
//   · error     — "8 couldn't be delivered" + `Fix these 8`, which filters the
//                 list to exactly those people.
//
// Shared by the migration page and (mount point described in the B6 handoff)
// the members roster. Pure presentation: the caller owns filtering.

"use client";

import { useState } from "react";
import { CheckCircle2, AlertTriangle, ChevronDown, X } from "lucide-react";
import {
  reasonLabel,
  sentHeadline,
  summarizeSkipped,
  type SendResult,
} from "@/lib/migrationQueueModel";

export function SendResultPanel({
  result,
  onShowPeople,
  onDismiss,
}: {
  result: SendResult;
  /** Filter the caller's list to exactly these member ids. */
  onShowPeople?: (ids: string[], label: string) => void;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { skipped, undelivered } = result;
  const skippedLine = summarizeSkipped(skipped);
  const n = undelivered.length;

  return (
    <div role="status" aria-live="polite" className="mb-3 space-y-2">
      <div
        className="rounded-xl border px-4 py-3"
        style={{ background: "var(--color-success-surface)", borderColor: "var(--color-success-border)" }}
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--color-success-icon)" }} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-text-primary">
              {sentHeadline(result.sent, result.reminder)}
              {result.covered > 0 && (
                <span className="font-normal text-text-muted">
                  {" "}· {result.covered} sibling{result.covered === 1 ? "" : "s"} covered by a guardian’s email
                </span>
              )}
            </p>
            {skippedLine && <p className="mt-0.5 text-[12.5px] text-text-muted">{skippedLine}</p>}
            {skipped.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3">
                <button
                  type="button"
                  onClick={() => setOpen((v) => !v)}
                  aria-expanded={open}
                  className="inline-flex min-h-[44px] items-center gap-1 text-[12.5px] font-medium text-brand hover:underline md:min-h-0 md:py-1"
                >
                  {open ? "Hide" : "See"} the {skipped.length} skipped
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
                </button>
                {onShowPeople && (
                  <button
                    type="button"
                    onClick={() => onShowPeople(skipped.map((s) => s.memberId), `${skipped.length} skipped`)}
                    className="inline-flex min-h-[44px] items-center text-[12.5px] text-text-muted underline hover:text-text-primary md:min-h-0 md:py-1"
                  >
                    Show them in the list
                  </button>
                )}
              </div>
            )}
            {open && skipped.length > 0 && (
              <ul className="mt-2 divide-y divide-app-border overflow-hidden rounded-lg border border-app-border bg-surface">
                {skipped.map((s) => (
                  <li key={s.memberId} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-[12.5px]">
                    <span className="min-w-0 truncate font-medium text-text-primary">{s.name}</span>
                    <span className="text-text-muted">{reasonLabel(s.reason)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:text-text-primary"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {n > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border px-4 py-3 sm:flex-row sm:items-center"
          style={{ background: "var(--color-danger-surface)", borderColor: "var(--color-danger-border)" }}
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--color-danger-text)" }} aria-hidden />
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold" style={{ color: "var(--color-danger-text)" }}>
                {n} {result.reminder ? "reminder" : "invitation"}{n === 1 ? "" : "s"} couldn’t be delivered
              </p>
              <p className="mt-0.5 text-[12.5px] text-text-muted">
                The mail provider refused {n === 1 ? "it" : "them"}. Check the address{n === 1 ? "" : "es"} before sending again —
                nothing was charged and nobody’s setup moved backwards.
              </p>
            </div>
          </div>
          {onShowPeople && (
            <button
              type="button"
              onClick={() => onShowPeople(undelivered.map((u) => u.memberId), `${n} undelivered`)}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-lg bg-charcoal px-3 text-[12.5px] font-medium text-white hover:opacity-90 md:min-h-[34px]"
            >
              Fix these {n}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
