"use client";

// The shared dialog primitive (audit §6.2: extracted from the one modal that
// was already built correctly, DashboardMobileDrawer). Desktop: centred
// dialog. Phones (<md): bottom sheet with a grab handle and 22px top radius.
// role="dialog" + aria-modal + aria-labelledby, Escape and backdrop close,
// body scroll locked while open. Swipe-to-dismiss is a B22 follow-up.
//
// Crash audit 2026-11-18 — a Sheet closes when the person closes it:
//   · Escape only reaches the TOP sheet (a confirm dialog over an edit sheet
//     used to close both with one key press);
//   · the backdrop closes on a press that starts and ends on the backdrop,
//     never on a text selection dragged out of the panel;
//   · the scroll lock is counted, so sheets closing in any order give the
//     page its scrolling back;
//   · `onClose` may be a new function every render — nothing re-subscribes,
//     so a parent that re-renders or reloads leaves the sheet alone.
// All of that lives in lib/overlay.ts and is shared with the older modals.
import { useId } from "react";
import { backdropDismiss, useOverlayLayer } from "@/lib/overlay";

export default function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  /** false = backdrop/Escape do nothing (use for a confirm that must be answered). */
  dismissable?: boolean;
}) {
  const titleId = useId();
  // Registered even when not dismissable: it is still the top layer, so
  // Escape stops here instead of reaching whatever is open underneath.
  useOverlayLayer(open, { onEscape: dismissable ? onClose : null, lockScroll: true });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-black/50" {...backdropDismiss(dismissable ? onClose : null)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-[22px] border border-app-border bg-surface shadow-2xl md:rounded-[14px]"
        style={{ maxWidth: width }}
      >
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-app-border md:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold text-text-primary">{title}</h2>
            {description && <div className="mt-1 text-[13px] text-text-muted">{description}</div>}
          </div>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl text-text-muted hover:bg-app-bg hover:text-text-primary"
            >
              ×
            </button>
          )}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>}
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-app-border px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
