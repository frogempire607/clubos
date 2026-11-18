"use client";

// What a screen shows when it crashes while drawing.
//
// Until 2026-11-15 the app had no error boundary at all: one unexpected value
// in one card (an error reply where a list was expected, say) took the WHOLE
// app to a white page, menu included, and the only way back was to quit and
// reopen. Next.js mounts this inside the dashboard / portal frame, so the menu
// stays put and only the broken screen is replaced.
//
// Used by app/dashboard/error.tsx and app/member/error.tsx.

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "@/lib/clientErrorReporter";

export default function RouteError({
  error,
  reset,
  homeHref,
  homeLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: string;
  homeLabel: string;
}) {
  useEffect(() => {
    console.error("[route error]", error);
    // Record it (first-party, lib/clientErrorReporter.ts). Until 2026-11-18 a
    // screen that reached this page left no trace anywhere: the staff profile
    // crashed on every open for two days and nobody was told.
    reportClientError(error, "SCREEN", { digest: error.digest ?? null });
    // Report it when error reporting is configured. Loaded on demand so the
    // reporting library is not part of every screen's download.
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error)).catch(() => undefined);
    }
  }, [error]);

  return (
    <div role="alert" className="mx-auto max-w-md px-6 py-16 text-center">
      <h2 className="text-lg font-semibold" style={{ color: "var(--color-text, #111111)" }}>
        This screen ran into a problem
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-muted, #6B7280)" }}>
        Nothing was lost. Try again — if it keeps happening, let us know what you were doing.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-muted, #6B7280)" }}>
          Reference: {error.digest}
        </p>
      )}
      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="min-h-[44px] rounded-lg px-4 text-sm font-semibold text-white"
          style={{ background: "var(--club-accent, var(--color-primary, #6D5DF6))" }}
        >
          Try again
        </button>
        <Link
          href={homeHref}
          className="min-h-[44px] inline-flex items-center rounded-lg border px-4 text-sm font-medium"
          style={{ borderColor: "var(--color-border, #E5E7EB)", color: "var(--color-text, #111111)" }}
        >
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
