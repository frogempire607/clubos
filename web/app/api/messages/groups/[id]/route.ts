import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const group = await prisma.messageGroup.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
    include: {
      members: { include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } } },
      messages: {
        orderBy: { createdAt: "asc" },
        include: { sender: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });

  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(group);
}

const sendSchema = z.object({ body: z.string().min(1) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
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

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await prisma.messageGroup.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
