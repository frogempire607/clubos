import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/private-lessons/types/[id]/duplicate — clone a lesson type.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const src = await prisma.privateLessonType.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const copy = await prisma.privateLessonType.create({
    data: {
      clubId: src.clubId,
      locationId: src.locationId,
      title: `${src.title} (Copy)`,
      description: src.description,
      durationMin: src.durationMin,
      maxAthletes: src.maxAthletes,
      basePrice: src.basePrice,
      coachTierLabel: src.coachTierLabel,
      eligibleCoachIds: src.eligibleCoachIds as object,
      priceOptions: src.priceOptions as object,
      active: false,
      sortOrder: src.sortOrder,
    },
  });
  return NextResponse.json(copy, { status: 201 });
}
