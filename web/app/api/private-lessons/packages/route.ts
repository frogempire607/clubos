import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const packages = await prisma.privatePackage.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    include: { lessonType: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(packages);
}

const schema = z.object({
  title:            z.string().min(1).max(100),
  description:      z.string().max(500).optional().nullable(),
  lessonTypeId:     z.string().optional().nullable(),
  credits:          z.number().int().positive(),
  bonusCredits:     z.number().int().min(0).default(0),
  price:            z.number().nonnegative(),
  expiresAfterDays: z.number().int().positive().optional().nullable(),
  active:           z.boolean().default(true),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = schema.parse(await req.json());
    const pkg = await prisma.privatePackage.create({
      data: { clubId: session.user.clubId, ...data, lessonTypeId: data.lessonTypeId || null },
    });
    return NextResponse.json(pkg, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
