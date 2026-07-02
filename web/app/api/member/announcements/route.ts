import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/announcements
// Club announcements that are currently in their publish window.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();

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
    select: {
      id: true,
      title: true,
      body: true,
      channels: true,
      publishAt: true,
      createdAt: true,
    },
  });

  if (announcements.length > 0) {
    const nowSeen = new Date();
    await Promise.all(
      announcements.map((announcement) =>
        prisma.announcementEngagement.upsert({
          where: { announcementId_userId: { announcementId: announcement.id, userId: session.user.id } },
          update: { lastSeenAt: nowSeen },
          create: {
            clubId: session.user.clubId,
            announcementId: announcement.id,
            userId: session.user.id,
            firstSeenAt: nowSeen,
            lastSeenAt: nowSeen,
          },
        }),
      ),
    );
  }

  // no-store: this GET writes the "seen" engagement rows; mobile WebViews
  // cache plain GETs and would skip the server entirely on re-open.
  return NextResponse.json(announcements, { headers: { "Cache-Control": "no-store" } });
}
