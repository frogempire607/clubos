import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const group = await prisma.messageGroup.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
    include: {
      members: { include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } } },
      messages: {
        orderBy: { createdAt: "asc" },
        include: {
          sender: { select: { id: true, firstName: true, lastName: true } },
          receipts: { select: { userId: true, readAt: true } },
        },
      },
    },
  });

  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const unreadForViewer = group.messages.filter((message) => message.senderId !== session.user.id);
  if (unreadForViewer.length > 0) {
    await prisma.groupMessageReceipt.createMany({
      data: unreadForViewer.map((message) => ({
        clubId: session.user.clubId,
        groupId: group.id,
        groupMessageId: message.id,
        userId: session.user.id,
      })),
      skipDuplicates: true,
    });
  }

  return NextResponse.json({
    ...group,
    messages: group.messages.map(({ receipts, ...message }) => ({
      ...message,
      readCount: receipts.length,
      readByMe: receipts.some((receipt) => receipt.userId === session.user.id),
    })),
  });
}

const sendSchema = z.object({ body: z.string().min(1) });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const group = await prisma.messageGroup.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { body } = sendSchema.parse(await req.json());
    const msg = await prisma.groupMessage.create({
      data: { groupId: params.id, senderId: session.user.id, body },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return NextResponse.json(msg, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await prisma.messageGroup.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
