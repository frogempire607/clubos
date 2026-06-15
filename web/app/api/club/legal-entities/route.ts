import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entities = await prisma.legalEntity.findMany({
    where: { clubId: session.user.clubId },
    include: { location: { select: { id: true, name: true } } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json(entities);
}

const schema = z.object({
  name:       z.string().min(1).max(100),
  entityType: z.enum(["LLC", "CORP", "SOLE_PROP", "NONPROFIT", "OTHER"]),
  ein:        z.string().max(20).optional().nullable(),
  isDefault:  z.boolean().optional(),
  locationId: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    // If marking as default, clear existing default first
    if (body.isDefault) {
      await prisma.legalEntity.updateMany({
        where: { clubId: session.user.clubId },
        data: { isDefault: false },
      });
    }

    const entity = await prisma.legalEntity.create({
      data: {
        clubId: session.user.clubId,
        name: body.name,
        entityType: body.entityType,
        ein: body.ein || null,
        isDefault: body.isDefault ?? false,
        locationId: body.locationId || null,
      },
      include: { location: { select: { id: true, name: true } } },
    });

    return NextResponse.json(entity, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
