import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseAnnouncementLimit } from "@/lib/announcementLimit";

// GET /api/member/announcements[?limit=N]
// Club announcements that are currently in their publish window, newest first.
// `limit` (1–50) is for the home-page card, which shows three: without it the
// card downloaded every announcement the club ever published — full bodies —
// and marked all of them seen, on every open of the home page.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const limit = parseAnnouncementLimit(new URL(req.url).searchParams.get("limit"));

  const announcements = await prisma.announcement.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      AND: [
        { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: "desc" },
    ...(limit ? { take: limit } : {}),
    select: {
      id: true,
      title: true,
      body: true,
      channels: true,
      publishAt: true,
      createdAt: true,
    },
  });

  // "Seen" bookkeeping in two statements however many announcements there
  // are (it was one upsert per announcement, all at once, on every load).
  // Only what was actually returned is marked — so the home card's three do
  // not clear the unread badge for the rest.
  if (announcements.length > 0) {
    const nowSeen = new Date();
    const ids = announcements.map((a) => a.id);
    await prisma.announcementEngagement.createMany({
      data: ids.map((announcementId) => ({
        clubId: session.user.clubId,
        announcementId,
        userId: session.user.id,
        firstSeenAt: nowSeen,
        lastSeenAt: nowSeen,
      })),
      skipDuplicates: true,
    });
    await prisma.announcementEngagement.updateMany({
      where: { userId: session.user.id, announcementId: { in: ids }, lastSeenAt: { lt: nowSeen } },
      data: { lastSeenAt: nowSeen },
    });
  }

  // no-store: this GET writes the "seen" engagement rows; mobile WebViews
  // cache plain GETs and would skip the server entirely on re-open.
  return NextResponse.json(announcements, { headers: { "Cache-Control": "no-store" } });
}
