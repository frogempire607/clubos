import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { feedUrls } from "@/lib/calendarFeed";

// Owner/staff: shareable calendar-feed links for every scope. The STAFF link
// exposes athlete names on private lessons — the UI labels it accordingly.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "schedule", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  return NextResponse.json({
    staff: feedUrls(clubId, "STAFF"),
    member: feedUrls(clubId, "MEMBER"),
    public: feedUrls(clubId, "PUBLIC"),
  });
}
