import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  action: z.enum(["open", "click"]).default("open"),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const announcement = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (!announcement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data = schema.parse(await req.json().catch(() => ({})));
  const now = new Date();
  const update =
    data.action === "click"
      ? { lastSeenAt: now, clickedAt: now, clickCount: { increment: 1 } }
      : { lastSeenAt: now, openedAt: now, openCount: { increment: 1 } };

  await prisma.announcementEngagement.upsert({
    where: { announcementId_userId: { announcementId: announcement.id, userId: session.user.id } },
    update,
    create: {
      clubId: session.user.clubId,
      announcementId: announcement.id,
      userId: session.user.id,
      firstSeenAt: now,
      lastSeenAt: now,
      openedAt: data.action === "open" ? now : null,
      openCount: data.action === "open" ? 1 : 0,
      clickedAt: data.action === "click" ? now : null,
      clickCount: data.action === "click" ? 1 : 0,
    },
  });

  return NextResponse.json({ ok: true });
}
