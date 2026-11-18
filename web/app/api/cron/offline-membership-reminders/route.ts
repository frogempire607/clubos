import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { runOfflineMembershipReminders } from "@/lib/pushServer";

/** Constant-time compare so the secret can't be probed a byte at a time. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// POST|GET /api/cron/offline-membership-reminders
// Three days before a cash or check membership ends: a push to the club's
// owner and billing staff, and a reminder to the paying family by push and by
// email. Hit daily by netlify/functions/offline-membership-reminders-cron.
//
// Auth: a shared secret in the Authorization header or ?key=. Without
// CRON_SECRET set the route is disabled (503) rather than left open.
//
// Idempotent: a notification_logs row is written before every send and the
// send happens only if that write succeeded, so a double-fired or overlapping
// run cannot remind anyone twice for the same membership period.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — cash and check membership reminders are disabled." },
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

  const result = await runOfflineMembershipReminders();
  return NextResponse.json({ ok: true, ...result });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
