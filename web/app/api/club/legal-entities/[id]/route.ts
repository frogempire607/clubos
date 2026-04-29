import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  name:       z.string().min(1).max(100).optional(),
  entityType: z.enum(["LLC", "CORP", "SOLE_PROP", "NONPROFIT", "OTHER"]).optional(),
  ein:        z.string().max(20).optional().nullable(),
  isDefault:  z.boolean().optional(),
  locationId: z.string().optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    const existing = await prisma.legalEntity.findFirst({
      where: { id: params.id, clubId: session.user.clubId },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (body.isDefault) {
      await prisma.legalEntity.updateMany({
        where: { clubId: session.user.clubId },
        data: { isDefault: false },
      });
    }

    const entity = await prisma.legalEntity.update({
      where: { id: params.id },
      data: {
        ...body,
        ein: body.ein ?? existing.ein,
        locationId: body.locationId ?? existing.locationId,
      },
      include: { location: { select: { id: true, name: true } } },
    });

    return NextResponse.json(entity);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await prisma.legalEntity.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.legalEntity.delete({ where: { id: params.id } });
  return new NextResponse(null, { status: 204 });
}
