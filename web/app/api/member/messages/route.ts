import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { memberCanMessage } from "@/lib/parentalControls";

// GET /api/member/messages
// Returns the member's DM conversations + group threads they belong to.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const clubId = session.user.clubId;

  // P4 — guardian-disabled messaging for a controlled minor. Return a
  // shaped empty response with messagingDisabled:true so the page can
  // render a "managed by your guardian" banner instead of an error.
  // Status stays 200 because the page WANTS to load — it just shows
  // the banner in place of the conversation list.
  if (!(await memberCanMessage(userId, clubId))) {
    return NextResponse.json({
      conversations: [],
      groups: [],
      childConversations: [],
      childGroups: [],
      messagingDisabled: true,
    });
  }

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

  // Guardian view: also surface DMs and groups addressed to linked child
  // User accounts, tagged with `forMember` so parents know which kid the
  // thread is about. Children without their own login (no User row) are
  // skipped — there's nothing to relay.
  const guardianLinks = await prisma.memberGuardianUser.findMany({
    where: { userId },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          user: { select: { id: true } },
        },
      },
    },
  });
  const childUserMap = new Map<string, { id: string; firstName: string; lastName: string }>();
  for (const link of guardianLinks) {
    const cuid = link.member.user?.id;
    if (cuid && cuid !== userId) {
      childUserMap.set(cuid, {
        id: link.member.id,
        firstName: link.member.firstName,
        lastName: link.member.lastName,
      });
    }
  }
  const childUserIds = Array.from(childUserMap.keys());

  const childConversations: Array<{
    user: { id: string; firstName: string; lastName: string; role: string };
    forMember: { id: string; firstName: string; lastName: string };
    lastMessage: { id: string; body: string; createdAt: Date; senderId: string; readAt: Date | null };
    unread: number;
  }> = [];
  const childGroups: Array<{
    id: string;
    name: string;
    forMember: { id: string; firstName: string; lastName: string };
    lastMessage:
      | { id: string; body: string; createdAt: Date; sender: { firstName: string; lastName: string } | null }
      | null;
    memberCount: number;
  }> = [];

  if (childUserIds.length > 0) {
    const childDms = await prisma.message.findMany({
      where: {
        clubId,
        OR: [
          { senderId: { in: childUserIds } },
          { recipientId: { in: childUserIds } },
        ],
      },
      include: {
        sender:    { select: { id: true, firstName: true, lastName: true, role: true } },
        recipient: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const seenChild = new Set<string>();
    for (const m of childDms) {
      const childId = childUserIds.includes(m.senderId) ? m.senderId : m.recipientId;
      const otherId = childUserIds.includes(m.senderId) ? m.recipientId : m.senderId;
      // Skip parent↔child threads — the parent already sees those in their own list.
      if (childUserMap.has(otherId)) continue;
      const key = `${childId}:${otherId}`;
      if (seenChild.has(key)) continue;
      seenChild.add(key);
      const other = m.senderId === childId ? m.recipient : m.sender;
      const unread = childDms.filter(
        (x) => x.senderId === otherId && x.recipientId === childId && !x.readAt
      ).length;
      const forMember = childUserMap.get(childId)!;
      childConversations.push({
        user: other,
        forMember,
        lastMessage: { id: m.id, body: m.body, createdAt: m.createdAt, senderId: m.senderId, readAt: m.readAt },
        unread,
      });
    }

    const childGroupRows = await prisma.messageGroup.findMany({
      where: {
        clubId,
        members: { some: { userId: { in: childUserIds } } },
      },
      include: {
        members: { where: { userId: { in: childUserIds } }, select: { userId: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { sender: { select: { id: true, firstName: true, lastName: true } } },
        },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    for (const grp of childGroupRows) {
      // One row per (group, child) — same group can surface for multiple kids.
      for (const gm of grp.members) {
        const forMember = childUserMap.get(gm.userId);
        if (!forMember) continue;
        const last = grp.messages[0] || null;
        childGroups.push({
          id: grp.id,
          name: grp.name,
          forMember,
          lastMessage: last
            ? {
                id: last.id,
                body: last.body,
                createdAt: last.createdAt,
                sender: last.sender ? { firstName: last.sender.firstName, lastName: last.sender.lastName } : null,
              }
            : null,
          memberCount: grp._count.members,
        });
      }
    }
  }

  return NextResponse.json({ conversations, groups, childConversations, childGroups });
}
