import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// Record a manual / cash payment or a manual invoice. This never touches
// Stripe — it's the owner logging money received (or owed) outside the app.
const schema = z.object({
  amount: z.number().positive(),
  category: z.string().min(1).default("cash_payment"),
  paymentMethod: z.string().default("CASH"),
  source: z.string().optional().nullable(), // who paid
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  legalEntityId: z.string().optional().nullable(),
  date: z.string().optional().nullable(),
  // true = unpaid invoice (recorded as PENDING until marked paid)
  unpaidInvoice: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const tx = await prisma.transaction.create({
    data: {
      clubId: session.user.clubId,
      amount: data.amount,
      status: data.unpaidInvoice ? "PENDING" : "SUCCEEDED",
      type: data.unpaidInvoice ? "INVOICE" : "MANUAL",
      category: data.category,
      paymentMethod: data.paymentMethod,
      legalEntityId: data.legalEntityId || null,
      source: data.source || null,
      description: data.description || (data.unpaidInvoice ? "Manual invoice" : "Manual payment"),
      notes: data.notes || null,
      manual: true,
      txDate: data.date ? new Date(data.date) : new Date(),
    },
  });
  return NextResponse.json(tx, { status: 201 });
}

// Mark a manual invoice as paid.
const markSchema = z.object({ transactionId: z.string() });
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  let body: z.infer<typeof markSchema>;
  try {
    body = markSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }
  const tx = await prisma.transaction.findFirst({
    where: { id: body.transactionId, clubId: session.user.clubId, manual: true },
    select: { id: true },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updated = await prisma.transaction.update({
    where: { id: body.transactionId },
    data: { status: "SUCCEEDED", txDate: new Date() },
  });
  return NextResponse.json(updated);
}
