// Daily trigger for the payday reminder email to club owners.
//
// Deliberately nothing but an HTTP wrapper: the logic and idempotency live in
// /api/cron/pay-reminders (lib/payReminderEmails) — each staff pay schedule's
// lastEmailedFor is claimed before an email goes out, so a failed or
// double-fired run can log noise but never emails the same payday twice.
//
// Schedule: 12:00 UTC daily (Netlify cron is always UTC) ≈ 8am Eastern
// (7am in winter), so the owner sees it the morning a payment is due.
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
    console.error("pay-reminders-cron: CRON_SECRET is not set — skipping (no payday emails will go out).");
    return new Response("CRON_SECRET not configured", { status: 200 });
  }
  if (!base) {
    console.error("pay-reminders-cron: URL env var missing — cannot locate the site.");
    return new Response("URL not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/pay-reminders`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`pay-reminders-cron: route answered ${res.status}`, body);
      return new Response(`pay reminders run failed: ${res.status}`, { status: 200 });
    }
    console.log(`pay-reminders-cron: clubs=${body?.clubs ?? 0} tally=${JSON.stringify(body?.tally ?? {})}`);
    return new Response("ok", { status: 200 });
  } catch (err) {
    // Log clearly and end normally — tomorrow's run picks up anything overdue.
    console.error("pay-reminders-cron: request failed", err);
    return new Response("pay reminders run errored", { status: 200 });
  }
};

export const config = {
  schedule: "0 12 * * *",
};
