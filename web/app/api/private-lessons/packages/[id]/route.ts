import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  title:            z.string().min(1).max(100).optional(),
  description:      z.string().max(500).optional().nullable(),
  lessonTypeId:     z.string().optional().nullable(),
  credits:          z.number().int().positive().optional(),
  bonusCredits:     z.number().int().min(0).optional(),
  price:            z.number().nonnegative().optional(),
  expiresAfterDays: z.number().int().positive().optional().nullable(),
  active:           z.boolean().optional(),
});

async function requirePackage(id: string, clubId: string) {
  return prisma.privatePackage.findFirst({ where: { id, clubId, deletedAt: null } });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pkg = await requirePackage(params.id, session.user.clubId);
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = schema.parse(await req.json());
    const updated = await prisma.privatePackage.update({ where: { id: params.id }, data });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pkg = await requirePackage(params.id, session.user.clubId);
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privatePackage.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
