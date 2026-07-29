import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { suggestExpenseMatches } from "@/lib/plaidMatching";

// GET  /api/plaid/transactions/[id]/match  → suggested matches for one row.
// POST /api/plaid/transactions/[id]/match  → confirm a match (link an
//     Expense to this row, or create a new one). Two-way link is set atomically.
//     Body: { expenseId?: string, createExpense?: { category, description?, notes? } }
//
// Rule: NEVER auto-finalize. Owner must click. Server refuses to link a row
// that's already matched.

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const row = await prisma.plaidTransaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true, plaidTransactionId: true, amount: true, date: true, merchantName: true, name: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const suggestions = await suggestExpenseMatches(prisma, session.user.clubId, {
    plaidTransactionId: row.plaidTransactionId,
    amount: Number(row.amount),
    date: row.date,
    merchantName: row.merchantName,
    name: row.name,
  });
  return NextResponse.json({ suggestions });
}

const postSchema = z
  .object({
    expenseId: z.string().optional(),
    createExpense: z
      .object({
        category: z.string().min(1),
        description: z.string().optional(),
        notes: z.string().optional(),
        vendor: z.string().optional(),
      })
      .optional(),
  })
  .refine((v) => !!(v.expenseId || v.createExpense), {
    message: "Provide expenseId or createExpense",
  });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const row = await prisma.plaidTransaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true, categorizedExpenseId: true, amount: true, date: true, name: true, merchantName: true, plaidConnectionId: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.categorizedExpenseId) {
    return NextResponse.json(
      { error: "Already matched — unmatch first before matching again." },
      { status: 409 },
    );
  }
  if (Number(row.amount) <= 0) {
    return NextResponse.json({ error: "This row is money in, not an expense." }, { status: 400 });
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const result = await prisma.$transaction(async (tx) => {
    let expenseId = body.expenseId;
    if (body.createExpense) {
      const created = await tx.expense.create({
        data: {
          clubId: session.user.clubId,
          amount: Math.abs(Number(row.amount)),
          category: body.createExpense.category,
          description: body.createExpense.description || row.name,
          vendor: body.createExpense.vendor || row.merchantName || null,
          notes: body.createExpense.notes || null,
          date: row.date,
          matchedPlaidTransactionId: row.id,
          plaidConnectionId: row.plaidConnectionId,
          reviewedAt: new Date(),
          reviewedByUserId: session.user.id ?? null,
        },
      });
      expenseId = created.id;
    } else if (expenseId) {
      const exp = await tx.expense.findFirst({
        where: { id: expenseId, clubId: session.user.clubId },
        select: { id: true, matchedPlaidTransactionId: true },
      });
      if (!exp) throw new Error("EXPENSE_NOT_FOUND");
      if (exp.matchedPlaidTransactionId && exp.matchedPlaidTransactionId !== row.id) {
        throw new Error("EXPENSE_ALREADY_MATCHED");
      }
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          matchedPlaidTransactionId: row.id,
          reviewedAt: new Date(),
          reviewedByUserId: session.user.id ?? null,
        },
      });
    }
    await tx.plaidTransaction.update({
      where: { id: row.id },
      data: {
        categorizedExpenseId: expenseId ?? null,
        reviewedAt: new Date(),
        reviewedByUserId: session.user.id ?? null,
      },
    });
    return { expenseId };
  }).catch((e: Error) => ({ error: e.message }));

  if ("error" in result) {
    if (result.error === "EXPENSE_NOT_FOUND") return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    if (result.error === "EXPENSE_ALREADY_MATCHED")
      return NextResponse.json({ error: "That expense is already matched to another bank row." }, { status: 409 });
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, expenseId: result.expenseId });
}

// DELETE /api/plaid/transactions/[id]/match — unmatch (drop the link both ways)
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const row = await prisma.plaidTransaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true, categorizedExpenseId: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.$transaction(async (tx) => {
    if (row.categorizedExpenseId) {
      await tx.expense.updateMany({
        where: { id: row.categorizedExpenseId, clubId: session.user.clubId },
        data: { matchedPlaidTransactionId: null },
      });
    }
    await tx.plaidTransaction.update({
      where: { id: row.id },
      data: { categorizedExpenseId: null, reviewedAt: null, reviewedByUserId: null },
    });
  });

  return NextResponse.json({ ok: true });
}
