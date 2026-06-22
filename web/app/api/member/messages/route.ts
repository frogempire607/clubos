import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { memberCanMessage } from "@/lib/parentalControls";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// Read subjectMemberId off a message row without depending on the cached Prisma
// type (the column is new; the build regenerates the client).
function subjectOf(m: unknown): string | null {
  return (m as { subjectMemberId?: string | null })?.subjectMemberId ?? null;
}

type DmUser = { id: string; firstName: string; lastName: string; role: string };
type ForMember = { id: string; firstName: string; lastName: string };

// GET /api/member/messages
// Returns the member's DM conversations + group threads. A guardian also gets
// one conversation per child (tagged `forMember`) for any thread that's "about"
// that child — including children with no login — via Message.subjectMemberId.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const clubId = session.user.clubId;

  // P4 — guardian-disabled messaging for a controlled minor.
  if (!(await memberCanMessage(userId, clubId))) {
    return NextResponse.json({
      conversations: [],
      groups: [],
      childConversations: [],
      childGroups: [],
      subjects: [],
      messagingDisabled: true,
    });
  }

  // Resolve the viewer's own member profile + the children they guardian.
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      memberProfile: { select: { id: true } },
      guardianOf: {
        select: {
          member: {
            select: { id: true, firstName: true, lastName: true, user: { select: { id: true } } },
          },
        },
      },
    },
  });
  let selfMemberId = me?.memberProfile?.id ?? null;
  if (!selfMemberId && me?.email) {
    const linked = await findOrAutoLinkMember(userId, clubId, me.email);
    selfMemberId = linked?.id ?? null;
  }
  const childById = new Map<string, ForMember>();
  const childUserMap = new Map<string, ForMember>(); // child userId → member (for group threads)
  for (const g of me?.guardianOf ?? []) {
    childById.set(g.member.id, { id: g.member.id, firstName: g.member.firstName, lastName: g.member.lastName });
    if (g.member.user?.id && g.member.user.id !== userId) {
      childUserMap.set(g.member.user.id, { id: g.member.id, firstName: g.member.firstName, lastName: g.member.lastName });
    }
  }

  // Every DM the viewer is a participant in.
  const dms = await prisma.message.findMany({
    where: { clubId, OR: [{ senderId: userId }, { recipientId: userId }] },
    include: {
      sender: { select: { id: true, firstName: true, lastName: true, role: true } },
      recipient: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const conversations: Array<{
    user: DmUser;
    lastMessage: { id: string; body: string; createdAt: Date; senderId: string; readAt: Date | null };
    unread: number;
  }> = [];
  const childConversations: Array<{
    user: DmUser;
    forMember: ForMember;
    about: string;
    lastMessage: { id: string; body: string; createdAt: Date; senderId: string; readAt: Date | null };
    unread: number;
  }> = [];

  const seenSelf = new Set<string>();
  const seenChild = new Set<string>();
  for (const m of dms) {
    const subject = subjectOf(m);
    const otherId = m.senderId === userId ? m.recipientId : m.senderId;
    const other = (m.senderId === userId ? m.recipient : m.sender) as DmUser;
    const isChildSubject = subject && childById.has(subject) && subject !== selfMemberId;

    if (isChildSubject) {
      const key = `${otherId}:${subject}`;
      if (seenChild.has(key)) continue;
      seenChild.add(key);
      const unread = dms.filter(
        (x) => x.senderId === otherId && x.recipientId === userId && !x.readAt && subjectOf(x) === subject,
      ).length;
      childConversations.push({
        user: other,
        forMember: childById.get(subject)!,
        about: subject,
        lastMessage: { id: m.id, body: m.body, createdAt: m.createdAt, senderId: m.senderId, readAt: m.readAt },
        unread,
      });
    } else {
      // Self thread: no subject, or the subject is the viewer's own profile.
      const key = otherId;
      if (seenSelf.has(key)) continue;
      seenSelf.add(key);
      const unread = dms.filter(
        (x) => x.senderId === otherId && x.recipientId === userId && !x.readAt && !(subjectOf(x) && childById.has(subjectOf(x)!)),
      ).length;
      conversations.push({
        user: other,
        lastMessage: { id: m.id, body: m.body, createdAt: m.createdAt, senderId: m.senderId, readAt: m.readAt },
        unread,
      });
    }
  }

  // Group threads the viewer is in.
  const groups = await prisma.messageGroup.findMany({
    where: { clubId, members: { some: { userId } } },
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

  // Group threads addressed to a linked child's own login (kept for kids who
  // have their own account and are added to groups directly).
  const childGroups: Array<{
    id: string;
    name: string;
    forMember: ForMember;
    lastMessage:
      | { id: string; body: string; createdAt: Date; sender: { firstName: string; lastName: string } | null }
      | null;
    memberCount: number;
  }> = [];
  const childUserIds = Array.from(childUserMap.keys());
  if (childUserIds.length > 0) {
    const childGroupRows = await prisma.messageGroup.findMany({
      where: { clubId, members: { some: { userId: { in: childUserIds } } } },
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

  // "About" options for the composer: the viewer (if they're a member) + kids.
  const subjects: Array<{ id: string; name: string; kind: "self" | "child" }> = [
    ...(selfMemberId ? [{ id: selfMemberId, name: "You", kind: "self" as const }] : []),
    ...Array.from(childById.values()).map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      kind: "child" as const,
    })),
  ];

  return NextResponse.json({ conversations, groups, childConversations, childGroups, subjects });
}
