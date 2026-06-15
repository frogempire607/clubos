import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { memberCanMessage } from "@/lib/parentalControls";

const MESSAGING_DISABLED = {
  error:
    "Messaging is managed by your guardian on this account. Ask them if you need to send a message.",
  code: "MESSAGING_DISABLED",
};

// GET /api/member/messages/dm/[userId]
// Returns the thread between the current member and the other user, marks
// incoming messages as read.
export async function GET(_req: Request, context: { params: Promise<{ userId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // P4 — guardian-disabled messaging for a controlled minor.
  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(MESSAGING_DISABLED, { status: 403 });
  }

  // Confirm the other user belongs to the same club
  const other = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, role: true },
  });
  if (!other) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messages = await prisma.message.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [
        { senderId: session.user.id, recipientId: params.userId },
        { senderId: params.userId, recipientId: session.user.id },
      ],
    },
    include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: "asc" },
  });

  await prisma.message.updateMany({
    where: {
      clubId: session.user.clubId,
      senderId: params.userId,
      recipientId: session.user.id,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return NextResponse.json({ other, messages });
}

const sendSchema = z.object({ body: z.string().min(1) });

// POST /api/member/messages/dm/[userId]
// Member can only reply to a thread the other party already started — prevents
// members cold-DMing arbitrary users in the club.
export async function POST(req: Request, context: { params: Promise<{ userId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // P4 — guardian-disabled messaging for a controlled minor.
  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(MESSAGING_DISABLED, { status: 403 });
  }

  // 60 messages per minute per user. Generous enough for a real
  // conversation; blocks spam blasts.
  const rl = rateLimit({ key: `messages:dm:${session.user.id}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "You're messaging too quickly. Slow down and try again in a moment.");

  const other = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!other) return NextResponse.json({ error: "Recipient not found" }, { status: 404 });

  // Members can DM staff/owners freely; for member-to-member, require an existing thread.
  if (other.role === "MEMBER") {
    const existing = await prisma.message.findFirst({
      where: {
        clubId: session.user.clubId,
        senderId: params.userId,
        recipientId: session.user.id,
      },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "You can only reply to existing conversations with other members." },
        { status: 403 }
      );
    }
  }

  try {
    const { body } = sendSchema.parse(await req.json());
    const message = await prisma.message.create({
      data: {
        clubId: session.user.clubId,
        senderId: session.user.id,
        recipientId: params.userId,
        body,
      },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
