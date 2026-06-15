import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const types = await prisma.clubEventType.findMany({
    where: { clubId: session.user.clubId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json(types);
}

const createSchema = z.object({
  name: z.string().min(1),
  color: z.string().default("#F1EFE8"),
  textColor: z.string().default("#5F5E5A"),
  sortOrder: z.number().int().default(0),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const type = await prisma.clubEventType.create({
      data: {
        clubId: session.user.clubId,
        name: data.name,
        color: data.color,
        textColor: data.textColor,
        sortOrder: data.sortOrder,
      },
    });

    return NextResponse.json(type, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
