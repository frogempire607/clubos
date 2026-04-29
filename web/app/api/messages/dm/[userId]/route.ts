import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMemberMessage } from "@/lib/memberMessaging";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const messages = await prisma.message.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [
        { senderId: session.user.id, recipientId: params.userId },
        { senderId: params.userId, recipientId: session.user.id },
      ],
    },
    include: {
      sender: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Mark incoming messages as read
  await prisma.message.updateMany({
    where: {
      clubId: session.user.clubId,
      senderId: params.userId,
      recipientId: session.user.id,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return NextResponse.json(messages);
}

const sendSchema = z.object({ body: z.string().min(1) });

export async function POST(
  req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const recipient = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    include: { memberProfile: { include: { guardian: true } } },
  });
  if (!recipient) return NextResponse.json({ error: "User not found" }, { status: 404 });

  try {
    const { body } = sendSchema.parse(await req.json());

    if (recipient.memberProfile) {
      const result = await sendMemberMessage({
        clubId: session.user.clubId,
        senderId: session.user.id,
        memberId: recipient.memberProfile.id,
        body,
      });

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }

      return NextResponse.json(result.messages[0], { status: 201 });
    }

    const message = await prisma.message.create({
      data: {
        clubId: session.user.clubId,
        senderId: session.user.id,
        recipientId: params.userId,
        body,
      },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
