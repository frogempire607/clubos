"use client";

// The browser's side of client error reporting: send one small report when a
// screen crashes (crash audit 2026-11-18). First-party — it posts to this
// app's own /api/public/client-errors and nowhere else.
//
// Three promises it keeps, because an error reporter that causes errors is
// worse than none:
//   · it never throws, whatever it is handed;
//   · one crash is reported once per page load, and at most five reports are
//     sent per page load (a loop that throws every frame sends one);
//   · it never delays or blocks the page — fire and forget.

import { buildReport, fingerprintOf, isNoise, type ClientErrorSource } from "@/lib/clientErrors";

export const MAX_REPORTS_PER_LOAD = 5;
const sent = new Set<string>();
let count = 0;

export function _resetClientErrorReporterForTests() {
  sent.clear();
  count = 0;
}

export function reportClientError(error: unknown, source: ClientErrorSource, extra: { digest?: string | null } = {}): boolean {
  try {
    if (typeof window === "undefined") return false;
    const report = buildReport({
      error,
      source,
      href: window.location?.href ?? "/",
      viewport: window.innerWidth && window.innerHeight ? `${window.innerWidth}x${window.innerHeight}` : null,
      digest: extra.digest ?? null,
    });
    if (isNoise(report)) return false;
    const key = fingerprintOf(report);
    if (sent.has(key) || count >= MAX_REPORTS_PER_LOAD) return false;
    sent.add(key);
    count++;
    const body = JSON.stringify(report);
    // keepalive: the report still goes out if the person leaves the page.
    void window
      .fetch("/api/public/client-errors", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "same-origin" })
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Listen for errors nothing caught. Returns the function that stops listening. */
export function installClientErrorReporter(win: Window): () => void {
  const onError = (e: ErrorEvent) => { reportClientError(e.error ?? e.message, "WINDOW"); };
  const onRejection = (e: PromiseRejectionEvent) => { reportClientError(e.reason, "PROMISE"); };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
