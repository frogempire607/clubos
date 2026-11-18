"use client";

// Last resort: the root layout itself crashed, so nothing of the app's frame —
// fonts, theme, providers — can be relied on. Plain markup, inline styles, and
// the same first-party report as every other error screen.
import { useEffect } from "react";
import { reportClientError } from "@/lib/clientErrorReporter";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError(error, "SCREEN", { digest: error.digest ?? null });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#F7F7F9", color: "#111111" }}>
        <div role="alert" style={{ maxWidth: 420, margin: "0 auto", padding: "96px 24px", textAlign: "center" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>This screen ran into a problem</h2>
          <p style={{ fontSize: 14, color: "#6B7280", marginTop: 8 }}>
            Nothing was lost. Try again — if it keeps happening, let us know what you were doing.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ marginTop: 24, minHeight: 44, padding: "0 16px", borderRadius: 8, border: 0, background: "#6D5DF6", color: "#FFFFFF", fontSize: 14, fontWeight: 600 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
