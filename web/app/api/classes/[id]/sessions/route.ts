import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cls = await prisma.recurringClass.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const upcoming = searchParams.get("upcoming") !== "false";
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 60);

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const sessions = await prisma.classSession.findMany({
    where: {
      classId: params.id,
      ...(upcoming ? { date: { gte: todayStart } } : {}),
    },
    include: {
      _count: { select: { attendance: true } },
    },
    orderBy: { date: "asc" },
    take: limit,
  });

  return NextResponse.json(sessions);
}
