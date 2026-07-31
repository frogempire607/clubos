// Every-5-minute drain of the Phase 3 EmailSend queue.
//
// This is deliberately nothing but an HTTP wrapper: every safety guarantee
// (per-recipient dedup via the M16 partial unique index, provider fallback
// order, opt-out re-check on retry) lives in /api/cron/email-queue and
// lib/sendClubEmail. A duplicate or overlapping run cannot double-send;
// worst case the second run finds no QUEUED rows and returns 0.
//
// Schedule: */5 * * * * — the Members-page bulk endpoint dispatches inline
// today, so this worker mostly catches:
//   - rows queued by a serverless timeout mid-loop (bulk of >2000)
//   - rows queued by a crash between EmailSend insert and provider dispatch
//   - any future producer that enqueues without inline dispatch
//
// Auth: CRON_SECRET from the site's environment (never committed).

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (): Promise<Response> => {
  const secret = Netlify.env.get("CRON_SECRET");
  const base = Netlify.env.get("URL");

  if (!secret) {
    console.error("email-queue-cron: CRON_SECRET is not set — skipping.");
    return new Response("CRON_SECRET not configured", { status: 200 });
  }
  if (!base) {
    console.error("email-queue-cron: URL env var missing.");
    return new Response("URL not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/email-queue?limit=50`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`email-queue-cron: route answered ${res.status}`, body);
      return new Response(`email queue run failed: ${res.status}`, { status: 200 });
    }
    console.log(
      `email-queue-cron: drained=${body?.drained ?? 0} tally=${JSON.stringify(body?.tally ?? {})}`,
    );
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("email-queue-cron: request failed", err);
    return new Response("email queue run errored", { status: 200 });
  }
};

export const config = {
  schedule: "*/5 * * * *",
};
