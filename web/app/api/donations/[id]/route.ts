import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

const schema = z.object({
  donorName: z.string().min(1).optional(),
  donorEmail: z.string().optional().nullable(),
  amount: z.number().positive().optional(),
  fund: z.string().optional().nullable(),
  restricted: z.boolean().optional(),
  sponsorship: z.boolean().optional(),
  paymentMethod: z.string().optional(),
  date: z.string().optional().nullable(),
  receiptUrl: z.string().optional().nullable(),
  legalEntityId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const donation = await prisma.donation.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!donation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const updated = await prisma.donation.update({
    where: { id },
    data: {
      ...(data.donorName !== undefined ? { donorName: data.donorName } : {}),
      ...(data.donorEmail !== undefined ? { donorEmail: data.donorEmail || null } : {}),
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.fund !== undefined ? { fund: data.fund || null } : {}),
      ...(data.restricted !== undefined ? { restricted: data.restricted } : {}),
      ...(data.sponsorship !== undefined ? { sponsorship: data.sponsorship } : {}),
      ...(data.paymentMethod !== undefined ? { paymentMethod: data.paymentMethod } : {}),
      ...(data.date !== undefined ? { date: data.date ? new Date(data.date) : new Date() } : {}),
      ...(data.receiptUrl !== undefined ? { receiptUrl: data.receiptUrl || null } : {}),
      ...(data.legalEntityId !== undefined ? { legalEntityId: data.legalEntityId || null } : {}),
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const donation = await prisma.donation.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!donation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.donation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
