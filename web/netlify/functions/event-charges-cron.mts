// Hourly trigger for event-day card charges.
//
// This is deliberately nothing but an HTTP wrapper: all business logic,
// idempotency, and safety live in /api/cron/event-charges (lib/eventAutoCharge)
// — per-registration idempotency keys that never rotate on unresolved
// attempts, prior-PaymentIntent recovery, Transaction dedupe on the PI id, and
// fail-closed when Stripe can't be verified. Because of that, a failed or
// double-fired run can log noise but can never double-charge; the next run
// simply picks up whatever is still due.
//
// Schedule: top of every hour, UTC (Netlify cron is always UTC). A charge runs
// within ~1 hour after its scheduledChargeAt instant.
//
// Auth: CRON_SECRET from the site's environment (never committed) — the same
// value the route verifies with a constant-time compare. If it's unset the
// route answers 503 and this logs loudly.

// Runtime global provided by Netlify Functions v2 — declared here so the repo
// needs no extra dependency just for types.
declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (): Promise<Response> => {
  const secret = Netlify.env.get("CRON_SECRET");
  // URL = the site's canonical production URL, set by Netlify automatically.
  const base = Netlify.env.get("URL");

  if (!secret) {
    console.error("event-charges-cron: CRON_SECRET is not set — skipping (no charges will run on a schedule).");
    return new Response("CRON_SECRET not configured", { status: 200 });
  }
  if (!base) {
    console.error("event-charges-cron: URL env var missing — cannot locate the site.");
    return new Response("URL not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/event-charges?limit=50`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`event-charges-cron: route answered ${res.status}`, body);
      return new Response(`event charges run failed: ${res.status}`, { status: 200 });
    }
    console.log(
      `event-charges-cron: due=${body?.due ?? 0} tally=${JSON.stringify(body?.tally ?? {})}`,
    );
    return new Response("ok", { status: 200 });
  } catch (err) {
    // Log clearly and end normally — the next hourly run retries safely.
    console.error("event-charges-cron: request failed", err);
    return new Response("event charges run errored", { status: 200 });
  }
};

export const config = {
  schedule: "0 * * * *",
};
