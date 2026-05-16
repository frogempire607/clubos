import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";

const schema = z.object({
  amount: z.number().positive(),
  date: z.string().optional(),
  service: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

// POST /api/contractors/[id]/payments — log a payment / service rendered.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const contractor = await prisma.contractor.findFirst({
    where: { id, clubId: session!.user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const payment = await prisma.contractorPayment.create({
    data: {
      clubId: session!.user.clubId,
      contractorId: id,
      amount: data.amount,
      date: data.date ? new Date(data.date) : new Date(),
      service: data.service || null,
      notes: data.notes || null,
    },
  });

  return NextResponse.json(payment, { status: 201 });
}

// DELETE /api/contractors/[id]/payments?paymentId=... — remove a logged payment.
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const paymentId = new URL(req.url).searchParams.get("paymentId");
  if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

  const payment = await prisma.contractorPayment.findFirst({
    where: { id: paymentId, contractorId: id, clubId: session!.user.clubId },
    select: { id: true },
  });
  if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.contractorPayment.delete({ where: { id: paymentId } });
  return NextResponse.json({ ok: true });
}
