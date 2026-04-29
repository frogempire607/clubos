import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  capacity: z.number().int().positive().optional().nullable(),
  pricingOptions: z
    .array(z.object({ type: z.enum(["member", "nonmember", "dropin"]), price: z.number() }))
    .optional(),
  active: z.boolean().optional(),
});

async function findClass(id: string, clubId: string) {
  return prisma.recurringClass.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cls = await prisma.recurringClass.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      location: { select: { name: true } },
      _count: { select: { sessions: true } },
    },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(cls);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["OWNER", "STAFF"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = await prisma.recurringClass.update({
    where: { id: params.id },
    data: parsed.data,
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.recurringClass.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
