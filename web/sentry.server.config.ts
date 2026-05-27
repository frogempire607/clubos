// Sentry config for the Node.js server runtime (API routes, server
// components, server actions). Only loaded when SENTRY_DSN is set —
// see instrumentation.ts.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // 10% of transactions are sampled by default. Bump in env if you want
  // more visibility for a launch week.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "production",
  // Don't spam Sentry with local "fetch failed" noise.
  ignoreErrors: ["AbortError", "TypeError: fetch failed"],
});
