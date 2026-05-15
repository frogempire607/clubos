import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const schema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  channels: z.string().optional(),
  publishAt: z.string().optional().nullable(),
  unpublishAt: z.string().optional().nullable(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = schema.parse(await req.json());
    const announcement = await prisma.announcement.update({
      where: { id: params.id, clubId: session.user.clubId },
      data: {
        ...data,
        publishAt:
          data.publishAt !== undefined
            ? data.publishAt
              ? new Date(data.publishAt)
              : null
            : undefined,
        unpublishAt:
          data.unpublishAt !== undefined
            ? data.unpublishAt
              ? new Date(data.unpublishAt)
              : null
            : undefined,
      },
    });
    return NextResponse.json(announcement);
  } catch {
    return NextResponse.json({ error: "Failed to update" }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await prisma.announcement.update({
    where: { id: params.id, clubId: session.user.clubId },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
