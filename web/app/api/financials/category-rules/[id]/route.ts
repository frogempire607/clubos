import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

const patchSchema = z.object({
  active: z.boolean().optional(),
  category: z.string().min(1).max(60).optional(),
  matchValue: z.string().max(120).nullable().optional(),
  matchMin: z.number().nullable().optional(),
  matchMax: z.number().nullable().optional(),
  excludeFromTax: z.boolean().optional(),
  markAsTransfer: z.boolean().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const rule = await prisma.transactionCategoryRule.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const updated = await prisma.transactionCategoryRule.update({
    where: { id },
    data: {
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.matchValue !== undefined ? { matchValue: data.matchValue || null } : {}),
      ...(data.matchMin !== undefined ? { matchMin: data.matchMin ?? null } : {}),
      ...(data.matchMax !== undefined ? { matchMax: data.matchMax ?? null } : {}),
      ...(data.excludeFromTax !== undefined ? { excludeFromTax: data.excludeFromTax } : {}),
      ...(data.markAsTransfer !== undefined ? { markAsTransfer: data.markAsTransfer } : {}),
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

  const rule = await prisma.transactionCategoryRule.findFirst({
    where: { id, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.transactionCategoryRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
