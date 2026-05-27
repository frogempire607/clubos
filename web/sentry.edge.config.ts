// Sentry config for the Edge runtime (middleware + edge route handlers).
// Only loaded when SENTRY_DSN is set — see instrumentation.ts.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "production",
});
