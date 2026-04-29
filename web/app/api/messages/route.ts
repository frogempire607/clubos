import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const announcements = await prisma.announcement.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(announcements);
}

const createSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  channels: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const announcement = await prisma.announcement.create({
      data: {
        clubId: session.user.clubId,
        title: data.title,
        body: data.body,
        channels: data.channels || "all",
      },
    });

    return NextResponse.json(announcement, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
