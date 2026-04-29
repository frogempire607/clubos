import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";

async function requireGrowth(clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { tier: true } });
  const features = getTierFeatures(club?.tier ?? "starter");
  if (!features.directMessaging) {
    return NextResponse.json(
      {
        error: "Direct messaging requires a Growth plan or higher.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "growth",
      },
      { status: 403 }
    );
  }
  return null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const gate = await requireGrowth(session.user.clubId);
  if (gate) return gate;

  const messages = await prisma.message.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [{ senderId: session.user.id }, { recipientId: session.user.id }],
    },
    include: {
      sender:    { select: { id: true, firstName: true, lastName: true, role: true } },
      recipient: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Group into conversations — unique other-party per conversation
  const seen = new Set<string>();
  const conversations: any[] = [];
  for (const m of messages) {
    const otherId = m.senderId === session.user.id ? m.recipientId : m.senderId;
    if (!seen.has(otherId)) {
      seen.add(otherId);
      const other = m.senderId === session.user.id ? m.recipient : m.sender;
      const unread = messages.filter(
        (x) => x.senderId === otherId && x.recipientId === session.user.id && !x.readAt
      ).length;
      conversations.push({ user: other, lastMessage: m, unread });
    }
  }

  return NextResponse.json(conversations);
}
