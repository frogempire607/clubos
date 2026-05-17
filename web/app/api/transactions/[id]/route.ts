import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// Owner review: assign entity / category / payment method / notes to an
// existing transaction. We never auto-categorize aggressively — this is the
// explicit owner-review path.
const schema = z.object({
  legalEntityId: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const tx = await prisma.transaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const updated = await prisma.transaction.update({
    where: { id },
    data: {
      ...(data.legalEntityId !== undefined ? { legalEntityId: data.legalEntityId || null } : {}),
      ...(data.category !== undefined ? { category: data.category || null } : {}),
      ...(data.paymentMethod !== undefined ? { paymentMethod: data.paymentMethod || null } : {}),
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
    },
    include: { legalEntity: { select: { id: true, name: true } } },
  });
  return NextResponse.json(updated);
}

// Only manually-recorded payments may be deleted (never delete Stripe
// financial records — they're the source of truth).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const tx = await prisma.transaction.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true, manual: true },
  });
  if (!tx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!tx.manual) {
    return NextResponse.json(
      { error: "Stripe transactions can't be deleted. Only manual entries can be removed." },
      { status: 400 },
    );
  }
  await prisma.transaction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
