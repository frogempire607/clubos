import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  const announcement = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!announcement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.announcementEngagement.findMany({
    where: { clubId: session.user.clubId, announcementId: params.id },
    orderBy: [{ openedAt: "desc" }, { lastSeenAt: "desc" }],
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          memberProfile: { select: { id: true, status: true } },
        },
      },
    },
  });

  return NextResponse.json({
    announcement,
    totals: {
      seen: rows.length,
      opened: rows.filter((row) => row.openedAt).length,
      clicked: rows.filter((row) => row.clickedAt).length,
      linkClicks: rows.filter((row) => row.clickedAt).length,
    },
    members: rows.map((row) => ({
      userId: row.userId,
      name: `${row.user.firstName} ${row.user.lastName}`.trim(),
      email: row.user.email,
      role: row.user.role,
      memberStatus: row.user.memberProfile?.status ?? null,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      openedAt: row.openedAt,
      openCount: row.openCount,
      clickedAt: row.clickedAt,
      clickCount: row.clickCount,
    })),
  });
}
