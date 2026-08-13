import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { runDueTournamentReminders, runCoachDigests } from "@/lib/tournamentReminders";

/** Constant-time compare so the secret can't be probed a byte at a time. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// POST|GET /api/cron/tournament-reminders
//
// Two passes in one invocation (§5.6.1): the payment reminders that are due
// right now, then the responsible-coach digest for registrations that have sat
// unanswered. Splitting them would mean two Netlify schedules and two secrets
// for no gain, and the digest's own 09:00-in-club-time gate is what keeps it
// daily on an hourly wrapper.
//
// Auth: the same CRON_SECRET the charge cron uses, same constant-time compare,
// and the same 503-when-unset rule. This one sends email rather than moving
// money, but an unauthenticated endpoint that mails a club's whole unpaid list
// is not an acceptable default either.
//
// Not the only path: the registrations roster lazy-sweeps a few reminders on
// open, exactly as it does for due charges, so a club that never configures a
// scheduler still gets them. Every path is idempotent — the per-stage dedupe
// key is what makes that true, not this route.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — scheduled reminders are disabled." },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const provided = bearer ?? url.searchParams.get("key");
  if (!secretMatches(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 100);
  const { due, results } = await runDueTournamentReminders({ limit });

  // `force=1` runs the digest outside its 09:00 window — for an operator
  // checking the wiring, and for nothing else. The per-day dedupe key means
  // even that can't produce a second email.
  const digests = await runCoachDigests({ force: url.searchParams.get("force") === "1" });

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({
    ok: true,
    dueReminders: due,
    tally,
    results,
    dueDigests: digests.coaches,
    digestsSent: digests.sent,
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
