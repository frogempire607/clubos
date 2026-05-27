// Sentry config for the browser bundle. Loaded only when
// NEXT_PUBLIC_SENTRY_DSN is set so dev builds stay quiet.

import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENV ??
      (process.env.NODE_ENV === "production" ? "production" : "development"),
    // Browser-side replay is opt-in via env so we don't ship the extra JS
    // unless explicitly turned on.
    integrations: process.env.NEXT_PUBLIC_SENTRY_REPLAY === "true"
      ? [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })]
      : [],
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
  });
}
