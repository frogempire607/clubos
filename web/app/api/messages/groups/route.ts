import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";

async function requireGrowth(clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { tier: true } });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.directMessaging) {
    return NextResponse.json(
      { error: "Group messaging requires a Growth plan or higher.", code: "UPGRADE_REQUIRED", upgradeRequired: "growth" },
      { status: 403 }
    );
  }
  return null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const gate = await requireGrowth(session.user.clubId);
  if (gate) return gate;

  const groups = await prisma.messageGroup.findMany({
    where: { clubId: session.user.clubId },
    include: {
      members: { include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(groups);
}

const createSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["GROUP", "BROADCAST"]).default("GROUP"),
  memberUserIds: z.array(z.string()).min(1),
  filterType: z.string().optional(),
  filterValue: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gate = await requireGrowth(session.user.clubId);
  if (gate) return gate;

  try {
    const data = createSchema.parse(await req.json());

    const group = await prisma.messageGroup.create({
      data: {
        clubId: session.user.clubId,
        name: data.name,
        type: data.type,
        filterType: data.filterType || null,
        filterValue: data.filterValue || null,
        createdById: session.user.id,
        members: {
          create: data.memberUserIds.map((userId) => ({ userId })),
        },
      },
      include: {
        members: { include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    return NextResponse.json(group, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
