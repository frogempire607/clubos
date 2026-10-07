// Daily trigger for the class top-up: every ongoing recurring class keeps its
// class days 180 days ahead, and clubs switched on to the new coach
// assignments get staff rows for the new days.
//
// Deliberately nothing but an HTTP wrapper: the logic and idempotency live in
// /api/cron/class-sessions-topup (lib/classTopUp) — class days are unique per
// (class, date), so a failed or double-fired run can log noise but never
// creates a duplicate day.
//
// Schedule: 08:30 UTC daily (Netlify cron is always UTC) ≈ 4:30am Eastern
// (3:30am in winter) — before anyone opens a schedule, and well clear of the
// 12:00 UTC payday reminders.
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
    console.error("class-sessions-topup-cron: CRON_SECRET is not set — skipping (class days will not be topped up).");
    return new Response("CRON_SECRET not configured", { status: 200 });
  }
  if (!base) {
    console.error("class-sessions-topup-cron: URL env var missing — cannot locate the site.");
    return new Response("URL not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/class-sessions-topup`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`class-sessions-topup-cron: route answered ${res.status}`, body);
      return new Response(`class top-up run failed: ${res.status}`, { status: 200 });
    }
    console.log(`class-sessions-topup-cron: clubs=${body?.clubs ?? 0} tally=${JSON.stringify(body?.tally ?? {})}`);
    return new Response("ok", { status: 200 });
  } catch (err) {
    // Log clearly and end normally — tomorrow's run tops up anything missed.
    console.error("class-sessions-topup-cron: request failed", err);
    return new Response("class top-up run errored", { status: 200 });
  }
};

export const config = {
  schedule: "30 8 * * *",
};
