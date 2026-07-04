import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { memberCanMessage } from "@/lib/parentalControls";
import { userCanAccessEventChat, ensureEventChatMember } from "@/lib/eventChat";

const MESSAGING_DISABLED = {
  error:
    "Messaging is managed by your guardian on this account. Ask them if you need to send a message.",
  code: "MESSAGING_DISABLED",
};

async function requireMembership(groupId: string, userId: string, clubId: string) {
  const group = await prisma.messageGroup.findFirst({
    where: { id: groupId, clubId },
    include: {
      members: { include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } } },
    },
  });
  if (!group) return null;

  const isMember = group.members.some((m) => m.userId === userId);

  // Event-linked groups follow the live registration, not the junction row:
  // a member who cancels loses access even if their row wasn't cleaned up yet,
  // and a newly-registered member gets in (joining lazily) without waiting for
  // a sync. Plain groups keep the original junction-only behavior.
  if (group.eventId) {
    const eligible = await userCanAccessEventChat(userId, clubId, group.eventId);
    if (!eligible) return null;
    if (!isMember) await ensureEventChatMember(group.id, userId);
    return group;
  }

  return isMember ? group : null;
}

// GET /api/member/messages/groups/[id]
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // P4 — guardian-disabled messaging for a controlled minor.
  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(MESSAGING_DISABLED, { status: 403 });
  }

  const group = await requireMembership(params.id, session.user.id, session.user.clubId);
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messageIds = await prisma.groupMessage.findMany({
    where: { groupId: params.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, senderId: true },
  });

  const readableMessages = messageIds.filter((message) => message.senderId !== session.user.id);
  if (readableMessages.length > 0) {
    await prisma.groupMessageReceipt.createMany({
      data: readableMessages.map((message) => ({
        clubId: session.user.clubId,
        groupId: params.id,
        groupMessageId: message.id,
        userId: session.user.id,
      })),
      skipDuplicates: true,
    });
  }

  const messages = await prisma.groupMessage.findMany({
    where: { groupId: params.id },
    orderBy: { createdAt: "asc" },
    include: {
      sender: { select: { id: true, firstName: true, lastName: true } },
      receipts: { select: { userId: true, readAt: true } },
    },
  });

  // no-store: this GET writes the read receipts; mobile WebViews cache plain
  // GETs and would skip the server entirely on re-open.
  return NextResponse.json(
    {
      group,
      messages: messages.map(({ receipts, ...message }) => ({
        ...message,
        readCount: receipts.length,
        readByMe: receipts.some((receipt) => receipt.userId === session.user.id),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const sendSchema = z.object({ body: z.string().min(1) });

// POST /api/member/messages/groups/[id]
// Members can post in regular GROUP threads they're in. BROADCAST groups are
// owner-broadcast-only — members can read but not post.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // P4 — guardian-disabled messaging for a controlled minor.
  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(MESSAGING_DISABLED, { status: 403 });
  }

  // 60 group messages per minute per user. Same reasoning as DM.
  const rl = rateLimit({ key: `messages:group:${session.user.id}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "You're messaging too quickly. Slow down and try again in a moment.");

  const group = await requireMembership(params.id, session.user.id, session.user.clubId);
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (group.type === "BROADCAST") {
    return NextResponse.json({ error: "This is a broadcast group — replies are disabled." }, { status: 403 });
  }

  try {
    const { body } = sendSchema.parse(await req.json());
    const msg = await prisma.groupMessage.create({
      data: { groupId: params.id, senderId: session.user.id, body },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return NextResponse.json(msg, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
