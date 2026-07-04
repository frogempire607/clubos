import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { feedUrls } from "@/lib/calendarFeed";

// Member portal: the MEMBER-scope subscription links (club-level — the feed
// shows the same classes/events every member can already see).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(feedUrls(session.user.clubId, "MEMBER"));
}
