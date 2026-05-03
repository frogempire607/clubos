import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/messages
// Returns the member's DM conversations + group threads they belong to.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const clubId = session.user.clubId;

  // Direct message conversations
  const dms = await prisma.message.findMany({
    where: {
      clubId,
      OR: [{ senderId: userId }, { recipientId: userId }],
    },
    include: {
      sender:    { select: { id: true, firstName: true, lastName: true, role: true } },
      recipient: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const seen = new Set<string>();
  const conversations: Array<{
    user: { id: string; firstName: string; lastName: string; role: string };
    lastMessage: { id: string; body: string; createdAt: Date; senderId: string; readAt: Date | null };
    unread: number;
  }> = [];
  for (const m of dms) {
    const otherId = m.senderId === userId ? m.recipientId : m.senderId;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const other = m.senderId === userId ? m.recipient : m.sender;
    const unread = dms.filter((x) => x.senderId === otherId && x.recipientId === userId && !x.readAt).length;
    conversations.push({
      user: other,
      lastMessage: { id: m.id, body: m.body, createdAt: m.createdAt, senderId: m.senderId, readAt: m.readAt },
      unread,
    });
  }

  // Group threads the member is in
  const groups = await prisma.messageGroup.findMany({
    where: {
      clubId,
      members: { some: { userId } },
    },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { sender: { select: { id: true, firstName: true, lastName: true } } },
      },
      _count: { select: { members: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ conversations, groups });
}
