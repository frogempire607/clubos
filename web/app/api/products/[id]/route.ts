import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  name:          z.string().min(1).max(100).optional(),
  description:   z.string().max(500).optional().nullable(),
  price:         z.number().nonnegative().optional(),
  category:      z.enum(["GEAR", "APPAREL", "FACILITY", "SERVICE", "OTHER"]).optional(),
  imageUrl:      z.string().url().optional().nullable(),
  active:        z.boolean().optional(),
  trackInventory: z.boolean().optional(),
  inventory:     z.number().int().nonnegative().optional().nullable(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await prisma.product.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = schema.parse(await req.json());
    const updated = await prisma.product.update({ where: { id: params.id }, data: body });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await prisma.product.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.product.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
