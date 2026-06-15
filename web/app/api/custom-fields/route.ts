import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const fields = await prisma.customField.findMany({
    where: { clubId: session.user.clubId, active: true },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json(fields);
}

const createSchema = z.object({
  label: z.string().min(1),
  fieldType: z.enum(["text", "email", "phone", "address", "date", "textarea", "number", "select"]),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  sortOrder: z.number().int().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const count = await prisma.customField.count({
      where: { clubId: session.user.clubId, active: true },
    });

    const field = await prisma.customField.create({
      data: {
        clubId: session.user.clubId,
        label: data.label,
        fieldType: data.fieldType,
        required: data.required,
        options: JSON.stringify(data.options || []),
        sortOrder: data.sortOrder ?? count,
      },
    });

    return NextResponse.json(field, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
