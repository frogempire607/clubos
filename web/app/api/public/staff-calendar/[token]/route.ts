import { NextResponse } from "next/server";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { staffFeedIcs } from "@/lib/staffCalendarFeed";

// GET /api/public/staff-calendar/<token>[.ics]
// A coach's personal calendar subscription. No session: the unguessable token
// IS the key (calendar apps cannot sign in). It answers with ONLY that
// person's own classes, events and private lessons — never pay, never anyone
// else's schedule — and 404s for an unknown or replaced token, or once the
// person is no longer on staff.
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token: raw } = await context.params;
  const rl = rateLimit({ key: `staffcal:${ipFromRequest(req)}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);
  const ics = await staffFeedIcs(raw.replace(/\.ics$/i, ""));
  if (!ics) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="my-schedule.ics"',
      // Private to whoever holds the link; calendar apps poll on their own schedule.
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  });
}
