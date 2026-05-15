import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  fieldType: z.enum(["text", "email", "phone", "address", "date", "textarea", "number", "select"]).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const field = await prisma.customField.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!field) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const data = updateSchema.parse(body);

    const updated = await prisma.customField.update({
      where: { id: params.id },
      data: {
        ...data,
        options: data.options ? JSON.stringify(data.options) : undefined,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const field = await prisma.customField.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!field) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.customField.update({
    where: { id: params.id },
    data: { active: false },
  });

  return NextResponse.json({ ok: true });
}
