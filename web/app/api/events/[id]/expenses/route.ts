import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// Expense breakdown line items for an event (tournament cost transparency).
// GET  — list items (events:view)
// POST — add an item (events:edit)

const EXPENSE_KINDS = ["ENTRY", "COACHING", "HOTEL", "TRANSPORT", "UNIFORM", "MISC"] as const;

const itemSchema = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(EXPENSE_KINDS).default("MISC"),
  amount: z.number().min(0).max(1_000_000),
  description: z.string().trim().max(500).optional().nullable(),
  // perAthlete items are charged in full to each registrant (entry fee, uniform);
  // shared items are split across attendees (hotel, transportation, coaching).
  perAthlete: z.boolean().optional().default(false),
  receiptFileId: z.string().optional().nullable(),
});

async function ownedEvent(id: string, clubId: string) {
  return prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true },
  });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const ev = await ownedEvent(id, clubId);
  if (!ev) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const items = await prisma.eventExpenseItem.findMany({
    where: { eventId: id, clubId },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(items.map((i) => ({ ...i, amount: Number(i.amount) })));
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const ev = await ownedEvent(id, clubId);
  if (!ev) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof itemSchema>;
  try {
    data = itemSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const item = await prisma.eventExpenseItem.create({
    data: {
      eventId: id,
      clubId,
      label: data.label,
      kind: data.kind,
      amount: data.amount,
      description: data.description ?? null,
      perAthlete: data.perAthlete ?? false,
      receiptFileId: data.receiptFileId ?? null,
    },
  });
  return NextResponse.json({ ...item, amount: Number(item.amount) }, { status: 201 });
}
