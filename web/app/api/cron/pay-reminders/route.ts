import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { runPayReminderEmails } from "@/lib/payReminderEmails";

/** Constant-time compare so the secret can't be probed a byte at a time. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// POST|GET /api/cron/pay-reminders
// Emails each club's owner(s) ONE digest of staff paydays due today (or gone
// overdue without an email). Hit daily by netlify/functions/pay-reminders-cron
// at 12:00 UTC (≈ 8am Eastern). The in-app reminders (Payroll page, Action
// Center) don't depend on this — they are computed live.
//
// Auth: a shared secret in the Authorization header or ?key=. Without
// CRON_SECRET set the route is disabled (503) rather than left open.
//
// Idempotent: each schedule's lastEmailedFor is claimed before sending, so a
// double-fired run can't email the same payday twice.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — payday reminder emails are disabled." },
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

  const results = await runPayReminderEmails();
  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({ ok: true, clubs: results.length, tally, results });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
