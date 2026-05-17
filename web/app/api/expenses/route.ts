import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const entity = searchParams.get("entity");

  const expenses = await prisma.expense.findMany({
    where: {
      clubId: session.user.clubId,
      ...(entity && entity !== "all" ? { legalEntityId: entity } : {}),
      ...(from || to ? {
        date: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      } : {}),
    },
    orderBy: { date: "desc" },
    include: { legalEntity: { select: { id: true, name: true } } },
  });

  return NextResponse.json(expenses);
}

// Category is a free string with a suggested catalog (lib/financials.ts) —
// custom categories are allowed, so we don't gate it behind an enum.
const createSchema = z.object({
  description: z.string().min(1),
  amount: z.number().min(0),
  category: z.string().min(1).default("OTHER"),
  date: z.string().optional(),
  isRecurring: z.boolean().default(false),
  notes: z.string().optional(),
  vendor: z.string().optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
  legalEntityId: z.string().optional().nullable(),
  reimbursable: z.boolean().optional().default(false),
  receiptUrl: z.string().optional().nullable(),
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
        vendor: data.vendor || null,
        paymentMethod: data.paymentMethod || null,
        legalEntityId: data.legalEntityId || null,
        reimbursable: data.reimbursable ?? false,
        receiptUrl: data.receiptUrl || null,
      },
    });
    return NextResponse.json(expense, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
