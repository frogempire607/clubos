// Next.js calls this once per runtime startup. We use it to conditionally
// initialise Sentry only when SENTRY_DSN is set, so local development and
// CI builds don't pay the SDK cost or ship sourcemaps unless asked to.
// Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  if (!process.env.SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Sentry's "tunnel" or upstream exceptions reported by Next can be forwarded
// here. We just re-throw so React's error boundary still renders the
// standard error UI. Sentry hooks into this automatically.
export async function onRequestError(
  err: unknown,
  request: Parameters<typeof import("@sentry/nextjs").captureRequestError>[1],
  errorContext: Parameters<typeof import("@sentry/nextjs").captureRequestError>[2],
) {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(err, request, errorContext);
}
