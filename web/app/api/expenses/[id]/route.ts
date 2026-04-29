import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const updateSchema = z.object({
  description: z.string().min(1).optional(),
  amount: z.number().min(0).optional(),
  category: z.enum(["RENT", "UTILITIES", "INSURANCE", "SOFTWARE", "PAYROLL", "EQUIPMENT", "EVENTS", "MARKETING", "OTHER"]).optional(),
  date: z.string().optional(),
  isRecurring: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expense = await prisma.expense.findFirst({ where: { id: params.id, clubId: session.user.clubId } });
  if (!expense) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = updateSchema.parse(await req.json());
    const updated = await prisma.expense.update({
      where: { id: params.id },
      data: { ...data, date: data.date ? new Date(data.date) : undefined },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expense = await prisma.expense.findFirst({ where: { id: params.id, clubId: session.user.clubId } });
  if (!expense) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.expense.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
