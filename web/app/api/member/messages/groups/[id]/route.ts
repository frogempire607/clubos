import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function requireMembership(groupId: string, userId: string, clubId: string) {
  const group = await prisma.messageGroup.findFirst({
    where: {
      id: groupId,
      clubId,
      members: { some: { userId } },
    },
    include: {
      members: { include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } } },
    },
  });
  return group;
}

// GET /api/member/messages/groups/[id]
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const group = await requireMembership(params.id, session.user.id, session.user.clubId);
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messages = await prisma.groupMessage.findMany({
    where: { groupId: params.id },
    orderBy: { createdAt: "asc" },
    include: { sender: { select: { id: true, firstName: true, lastName: true } } },
  });

  return NextResponse.json({ group, messages });
}

const sendSchema = z.object({ body: z.string().min(1) });

// POST /api/member/messages/groups/[id]
// Members can post in regular GROUP threads they're in. BROADCAST groups are
// owner-broadcast-only — members can read but not post.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
