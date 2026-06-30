import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

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
          // Pull the reader name so owners/coaches can see WHO read each
          // message and exactly WHEN.
          receipts: {
            select: {
              userId: true,
              readAt: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
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
      // Per-reader detail (with timestamp) so owners/coaches can see who
      // saw the message and when.
      readers: receipts
        .filter((r) => r.user)
        .map((r) => ({
          userId: r.userId,
          firstName: r.user!.firstName,
          lastName: r.user!.lastName,
          readAt: r.readAt,
        })),
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
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Messaging access can delete groups — not owner-only.
  const denied = requirePermission(session, "messages", "full");
  if (denied) return denied;
  // Scope to the caller's club — deleteMany returns count instead of throwing,
  // and the clubId predicate prevents cross-tenant deletion by guessed id.
  const deleted = await prisma.messageGroup.deleteMany({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
