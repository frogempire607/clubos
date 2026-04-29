import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const discounts = await prisma.discount.findMany({
    where: { clubId: session.user.clubId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(discounts);
}

const schema = z.object({
  code:          z.string().min(1).max(50).toUpperCase(),
  description:   z.string().max(200).optional().nullable(),
  type:          z.enum(["PERCENT", "FIXED"]),
  value:         z.number().positive(),
  maxUses:       z.number().int().positive().optional().nullable(),
  active:        z.boolean().optional(),
  expiresAt:     z.string().optional().nullable(),
  membershipIds: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    const existing = await prisma.discount.findUnique({
      where: { clubId_code: { clubId: session.user.clubId, code: body.code } },
    });
    if (existing) {
      return NextResponse.json({ error: "A discount with that code already exists." }, { status: 409 });
    }

    const discount = await prisma.discount.create({
      data: {
        clubId:        session.user.clubId,
        code:          body.code,
        description:   body.description || null,
        type:          body.type,
        value:         body.value,
        maxUses:       body.maxUses || null,
        active:        body.active ?? true,
        expiresAt:     body.expiresAt ? new Date(body.expiresAt) : null,
        membershipIds: body.membershipIds ?? [],
      },
    });

    return NextResponse.json(discount, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
