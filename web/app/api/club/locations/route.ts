import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures, getTierName, upgradeRequired, tierBlockedBody } from "@/lib/tier";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locations = await prisma.location.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(locations);
}

const schema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = schema.parse(await req.json());

    // Tier gate: enforce max locations per plan.
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { tier: true },
    });
    const features = getTierFeatures(club?.tier ?? "growth");
    if (features.maxLocations !== null) {
      const count = await prisma.location.count({
        where: { clubId: session.user.clubId, deletedAt: null },
      });
      if (count >= features.maxLocations) {
        return NextResponse.json(
          tierBlockedBody({
            message:
              `Your ${getTierName(club?.tier ?? "growth")} plan allows up to ${features.maxLocations} location${features.maxLocations === 1 ? "" : "s"}. Upgrade to add more.`,
            upgradeRequired: upgradeRequired(club?.tier ?? "growth", "maxLocations"),
          }),
          { status: 403 },
        );
      }
    }

    const location = await prisma.location.create({
      data: {
        clubId: session.user.clubId,
        name: data.name,
        address: data.address || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
      },
    });
    return NextResponse.json(location, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
