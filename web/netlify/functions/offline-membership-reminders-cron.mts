// Daily trigger for the "cash or check membership ends soon" reminders: a push
// to the club's owner and billing staff, and a push plus an email to the
// paying family, three days before the membership ends.
//
// Deliberately nothing but an HTTP wrapper: the logic and idempotency live in
// /api/cron/offline-membership-reminders (lib/pushServer) — a notification_logs
// row is claimed before anything goes out, so a failed or double-fired run can
// log noise but never reminds anyone twice for the same membership period.
//
// Schedule: 13:00 UTC daily (Netlify cron is always UTC) ≈ 9am Eastern
// (8am in winter), an hour after the payday digest so the two do not overlap.
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
    console.error("offline-membership-reminders-cron: CRON_SECRET is not set — skipping (no reminders will go out).");
    return new Response("CRON_SECRET not configured", { status: 200 });
  }
  if (!base) {
    console.error("offline-membership-reminders-cron: URL env var missing — cannot locate the site.");
    return new Response("URL not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/offline-membership-reminders`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`offline-membership-reminders-cron: route answered ${res.status}`, body);
      return new Response(`membership reminders run failed: ${res.status}`, { status: 200 });
    }
    console.log(
      `offline-membership-reminders-cron: due=${body?.due ?? 0} staffPushes=${body?.staffPushes ?? 0} ` +
        `familyPushes=${body?.familyPushes ?? 0} emails=${body?.emails ?? 0} errors=${body?.errors ?? 0}`,
    );
    return new Response("ok", { status: 200 });
  } catch (err) {
    // Log clearly and end normally — tomorrow's run is still inside the window.
    console.error("offline-membership-reminders-cron: request failed", err);
    return new Response("membership reminders run errored", { status: 200 });
  }
};

export const config = {
  schedule: "0 13 * * *",
};
