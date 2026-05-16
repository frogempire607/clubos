import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";

async function findContractor(id: string, clubId: string) {
  return prisma.contractor.findFirst({ where: { id, clubId, deletedAt: null } });
}

// GET /api/contractors/[id] — detail + payment history.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const contractor = await prisma.contractor.findFirst({
    where: { id, clubId: session!.user.clubId, deletedAt: null },
    include: { payments: { orderBy: { date: "desc" } } },
  });
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const totalPaid = contractor.payments.reduce((s, p) => s + Number(p.amount), 0);
  return NextResponse.json({ ...contractor, totalPaid });
}

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  w9Url: z.string().optional().nullable(),
  payoutNotes: z.string().optional().nullable(),
  active: z.boolean().optional(),
});

// PATCH /api/contractors/[id]
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const contractor = await findContractor(id, session!.user.clubId);
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof updateSchema>;
  try {
    data = updateSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const updated = await prisma.contractor.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.email !== undefined && { email: data.email || null }),
      ...(data.phone !== undefined && { phone: data.phone || null }),
      ...(data.role !== undefined && { role: data.role || null }),
      ...(data.w9Url !== undefined && { w9Url: data.w9Url || null }),
      ...(data.payoutNotes !== undefined && { payoutNotes: data.payoutNotes || null }),
      ...(data.active !== undefined && { active: data.active }),
    },
  });
  return NextResponse.json(updated);
}

// DELETE /api/contractors/[id] — soft delete (payment history is retained
// for accounting; the row is just hidden).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const contractor = await findContractor(id, session!.user.clubId);
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.contractor.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
  return NextResponse.json({ ok: true });
}
