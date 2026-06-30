import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// PATCH / DELETE a single event expense line item (events:edit).

const EXPENSE_KINDS = ["ENTRY", "COACHING", "HOTEL", "TRANSPORT", "UNIFORM", "MISC"] as const;

const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(EXPENSE_KINDS).optional(),
  amount: z.number().min(0).max(1_000_000).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  perAthlete: z.boolean().optional(),
  receiptFileId: z.string().optional().nullable(),
});

async function ownedItem(itemId: string, eventId: string, clubId: string) {
  return prisma.eventExpenseItem.findFirst({
    where: { id: itemId, eventId, clubId },
    select: { id: true },
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  if (!(await ownedItem(itemId, id, clubId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const item = await prisma.eventExpenseItem.update({ where: { id: itemId }, data });
  return NextResponse.json({ ...item, amount: Number(item.amount) });
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  if (!(await ownedItem(itemId, id, clubId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.eventExpenseItem.delete({ where: { id: itemId } });
  return NextResponse.json({ ok: true });
}
