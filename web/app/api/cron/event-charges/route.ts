import { NextResponse } from "next/server";
import { runDueEventCharges } from "@/lib/eventAutoCharge";

// POST|GET /api/cron/event-charges
// Runs every due AUTO_CARD event charge. There is no scheduler in the app, so
// this exists for an external one (Netlify scheduled function, GitHub Action,
// cron-job.org, …) to hit on a cadence — hourly is plenty.
//
// Auth: a shared secret in the Authorization header or ?key=. Without
// CRON_SECRET set the route is disabled (503) rather than left open — an
// unauthenticated endpoint that moves money is not an acceptable default.
//
// This is a safety net, not the only path: the registrations + Action Center
// surfaces also sweep due charges lazily, so charges still run if no scheduler
// is ever configured. Every path is idempotent (per-registration keys, PI
// re-use, Transaction dedupe on the PaymentIntent id).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — scheduled charging is disabled." },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const provided = bearer ?? url.searchParams.get("key");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const { due, results } = await runDueEventCharges({ limit });

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({ ok: true, due, tally, results });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
