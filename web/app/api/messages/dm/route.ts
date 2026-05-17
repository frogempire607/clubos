import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { sendMemberMessage } from "@/lib/memberMessaging";

async function requireGrowth(clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { tier: true } });
  const features = getTierFeatures(club?.tier ?? "growth");
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

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gate = await requireGrowth(session.user.clubId);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  const messageBody = typeof body.body === "string" ? body.body.trim() : "";

  if (!memberId || !messageBody) {
    return NextResponse.json({ error: "Member and message are required." }, { status: 400 });
  }

  const result = await sendMemberMessage({
    clubId: session.user.clubId,
    senderId: session.user.id,
    memberId,
    body: messageBody,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result, { status: 201 });
}
