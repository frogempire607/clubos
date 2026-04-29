import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const products = await prisma.product.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    include: { _count: { select: { sales: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(products);
}

const schema = z.object({
  name:          z.string().min(1).max(100),
  description:   z.string().max(500).optional().nullable(),
  price:         z.number().nonnegative(),
  category:      z.enum(["GEAR", "APPAREL", "FACILITY", "SERVICE", "OTHER"]).default("OTHER"),
  imageUrl:      z.string().url().optional().nullable(),
  active:        z.boolean().optional(),
  trackInventory: z.boolean().optional(),
  inventory:     z.number().int().nonnegative().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());
    const product = await prisma.product.create({
      data: { clubId: session.user.clubId, ...body, imageUrl: body.imageUrl || null },
    });
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
