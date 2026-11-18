"use client";

// The screen's side of lib/connectionGuard.ts: the "can't reach the server"
// bar and its Try again button. Wrap a layout's page content in it.
//
// Try again remounts the content (a changed `key`), which re-runs every load
// on the screen. That is what a stuck spinner needs: the request it was
// waiting on has already failed and will never clear it.

import { useCallback, useEffect, useRef, useState } from "react";
import { installConnectionGuard, loadFailureMessage, safeToAutoRetry, type LoadFailure } from "@/lib/connectionGuard";
import { hasOpenOverlay } from "@/lib/overlay";
import { confirmDialog } from "@/lib/dialogs";

// Rebuilding the screen closes whatever is open on it. Typed text was already
// checked before an automatic retry; an open sheet was not — one holding only
// choices (a plan picked, boxes ticked, a date chosen) has no typed text and
// was closed under the person the moment the connection came back (crash audit
// 2026-11-18). Sheets from lib/overlay.ts register themselves; the older
// hand-built ones are found by their full-screen element.
function workInProgress(): { sheetOpen: boolean; typed: boolean } {
  const sheetOpen = hasOpenOverlay() || !!document.querySelector('[data-page] [role="dialog"], [data-page] div.fixed.inset-0, main [role="dialog"]');
  const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("main input, main textarea, [data-page] input, [data-page] textarea"));
  const typed = !safeToAutoRetry(fields.map((f) => ({ value: f.value, type: f.getAttribute("type"), defaultValue: f.defaultValue })));
  return { sheetOpen, typed };
}

export default function ConnectionGuard({ children }: { children: React.ReactNode }) {
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failureRef = useRef<LoadFailure | null>(null);
  failureRef.current = failure;

  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((n) => n + 1);
  }, []);

  // The button is the person's own choice — but it still says what it costs
  // before throwing away an open sheet or unsaved typing.
  const retryAsked = useCallback(async () => {
    const w = workInProgress();
    if ((w.sheetOpen || w.typed) && !(await confirmDialog("Reload this screen?\n\nAnything open or typed here that has not been saved will be cleared.", { confirmLabel: "Reload" }))) return;
    retry();
  }, [retry]);

  useEffect(() => {
    const uninstall = installConnectionGuard(window, {
      onFailure: (kind) => setFailure((cur) => cur ?? kind),
      // An answer after a failure means the connection is back, but the screen
      // that failed is still stuck: keep the bar so Try again stays on offer.
      onSuccess: () => undefined,
    });
    const onOnline = () => {
      if (!failureRef.current) return;
      const w = workInProgress();
      // Never by itself while a sheet is open or something is typed: the bar
      // stays up and Try again is one tap away.
      if (!w.sheetOpen && !w.typed) retry();
    };
    window.addEventListener("online", onOnline);
    return () => {
      uninstall();
      window.removeEventListener("online", onOnline);
    };
  }, [retry]);

  return (
    <>
      {failure && (
        <div
          role="alert"
          className="fixed left-0 right-0 top-0 z-[70] safe-area-top bg-[#1F1F23] text-white shadow-lg"
        >
          <div className="mx-auto max-w-3xl px-4 py-2.5 flex items-center gap-3">
            <p className="flex-1 min-w-0 text-[14px] leading-snug">{loadFailureMessage(failure)}</p>
            <button
              type="button"
              onClick={retryAsked}
              className="min-h-11 px-4 rounded-[10px] bg-white text-[#111111] text-[14px] font-semibold flex-shrink-0"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setFailure(null)}
              aria-label="Dismiss"
              className="min-h-11 min-w-11 rounded-[10px] text-[20px] leading-none text-white/80 hover:text-white flex-shrink-0"
            >
              ×
            </button>
          </div>
        </div>
      )}
      <div key={attempt} data-page className="contents">
        {children}
      </div>
    </>
  );
}
