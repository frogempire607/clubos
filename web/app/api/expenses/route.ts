import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const expenses = await prisma.expense.findMany({
    where: {
      clubId: session.user.clubId,
      ...(from || to ? {
        date: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      } : {}),
    },
    orderBy: { date: "desc" },
  });

  return NextResponse.json(expenses);
}

const createSchema = z.object({
  description: z.string().min(1),
  amount: z.number().min(0),
  category: z.enum(["RENT", "UTILITIES", "INSURANCE", "SOFTWARE", "PAYROLL", "EQUIPMENT", "EVENTS", "MARKETING", "OTHER"]).default("OTHER"),
  date: z.string().optional(),
  isRecurring: z.boolean().default(false),
  notes: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = createSchema.parse(await req.json());
    const expense = await prisma.expense.create({
      data: {
        clubId: session.user.clubId,
        description: data.description,
        amount: data.amount,
        category: data.category,
        date: data.date ? new Date(data.date) : new Date(),
        isRecurring: data.isRecurring,
        notes: data.notes || null,
      },
    });
    return NextResponse.json(expense, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
