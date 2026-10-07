import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { runClassTopUp } from "@/lib/classTopUp";

/** Constant-time compare so the secret can't be probed a byte at a time. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// POST|GET /api/cron/class-sessions-topup
// Keeps every ongoing recurring class supplied with class days 180 days ahead
// (lib/classTopUp), and — for clubs switched on to the new coach assignments —
// gives the new days their staff rows. Hit daily by
// netlify/functions/class-sessions-topup-cron at 08:30 UTC.
//
// Auth: a shared secret in the Authorization header or ?key=. Without
// CRON_SECRET set the route is disabled (503) rather than left open.
//
// Idempotent: class days are unique per (class, date) and created with
// skipDuplicates; staff rows are reconciled, not appended. A double-fired or
// half-finished run is safe to repeat.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — the class top-up job is disabled." },
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

  const results = await runClassTopUp();
  const tally = results.reduce(
    (acc, r) => {
      acc.classes += r.classes;
      acc.sessionsCreated += r.sessionsCreated;
      acc.staffRowsCreated += r.staffRowsCreated;
      if (r.outcome === "error") acc.failedClubs++;
      return acc;
    },
    { classes: 0, sessionsCreated: 0, staffRowsCreated: 0, failedClubs: 0 },
  );
  return NextResponse.json({ ok: tally.failedClubs === 0, clubs: results.length, tally, results });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
