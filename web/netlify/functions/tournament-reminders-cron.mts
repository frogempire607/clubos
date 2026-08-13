// Hourly trigger for tournament payment reminders + the coach digest.
//
// A thin HTTP wrapper, exactly like event-charges-cron.mts: every decision —
// which registrations are due, which stage they're on, whether the digest is
// inside its 09:00 window — lives in /api/cron/tournament-reminders and
// lib/tournamentReminders. Because each send is keyed by
// (registration, stage) or (coach, club-local day), a failed or double-fired
// run can log noise but can never double-send; the next hour picks up whatever
// is still outstanding.
//
// Schedule: top of every hour, UTC (Netlify cron is always UTC). A reminder
// goes out within ~1 hour of its nextReminderAt instant, and the digest fires
// on whichever hourly pass lands inside 09:00 in the club's own timezone.
//
// Auth: CRON_SECRET from the site's environment — the same value the charge
// cron uses and the same one the route verifies. If it's unset the route
// answers 503 and this logs loudly rather than failing silently.

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (): Promise<Response> => {
  const secret = Netlify.env.get("CRON_SECRET");
  const base = Netlify.env.get("URL");

  if (!secret) {
    console.error(
      "tournament-reminders-cron: CRON_SECRET is not set — skipping (no reminders or digests will send on a schedule).",
    );
    return new Response("CRON_SECRET not configured", { status: 200 });
  }
  if (!base) {
    console.error("tournament-reminders-cron: URL env var missing — cannot locate the site.");
    return new Response("URL not configured", { status: 200 });
  }

  try {
    const res = await fetch(`${base}/api/cron/tournament-reminders?limit=100`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`tournament-reminders-cron: route answered ${res.status}`, body);
      return new Response(`reminder run failed: ${res.status}`, { status: 200 });
    }
    console.log(
      `tournament-reminders-cron: due=${body?.dueReminders ?? 0} tally=${JSON.stringify(
        body?.tally ?? {},
      )} digests=${body?.digestsSent ?? 0}/${body?.dueDigests ?? 0}`,
    );
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("tournament-reminders-cron: request failed", err);
    return new Response("reminder run errored", { status: 200 });
  }
};

export const config = {
  schedule: "0 * * * *",
};
