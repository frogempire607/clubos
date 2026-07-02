import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/messages/unread → { count }
// Unread direct messages addressed to the signed-in member, for the bottom-nav
// badge in the member portal.
// no-store: iOS WebKit (Capacitor shell) will otherwise serve a cached count
// and the badge never clears after reading a thread on mobile.
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ count: 0, announcements: 0 }, NO_STORE);
  const now = new Date();
  const [count, announcements] = await Promise.all([
    prisma.message.count({
      where: { clubId: session.user.clubId, recipientId: session.user.id, readAt: null },
    }),
    // Announcements currently in their publish window that this user has never
    // seen. The member announcements list GET upserts an engagement row for
    // every visible announcement, so this clears as soon as they open News.
    prisma.announcement.count({
      where: {
        clubId: session.user.clubId,
        deletedAt: null,
        AND: [
          { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
          { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        ],
        engagements: { none: { userId: session.user.id } },
      },
    }),
  ]);
  return NextResponse.json({ count, announcements }, NO_STORE);
}
