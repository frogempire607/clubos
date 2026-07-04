import { NextResponse } from "next/server";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { resolveFeedScope, feedItems, buildIcs } from "@/lib/calendarFeed";

// Public, token-gated iCal feed. Calendar apps (Apple/Google/Outlook) poll
// this URL, so changes to classes/events show up automatically.
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ clubId: string; token: string }> }) {
  const { clubId, token } = await context.params;

  const rl = rateLimit({ key: `calfeed:${ipFromRequest(req)}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const scope = resolveFeedScope(clubId, token);
  if (!scope) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data = await feedItems(clubId, scope);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(buildIcs(data.clubName, scope, data.items), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="calendar.ics"',
      // Let calendar clients cache briefly; they poll on their own schedule.
      "Cache-Control": "public, max-age=300",
    },
  });
}
