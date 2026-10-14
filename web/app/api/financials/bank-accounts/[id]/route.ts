import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { formatZodError } from "@/lib/zodErrors";
import { assignAccountEntity } from "@/lib/bankAccounts";

export const dynamic = "force-dynamic";

const schema = z.object({
  legalEntityId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(80).optional(),
}).strict();

// PATCH /api/financials/bank-accounts/[id]  { legalEntityId?, name? }
// Put the account on an entity's books (its bank rows follow), or rename it.
// finances:full.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof z.ZodError ? formatZodError(err) : "Invalid request body" }, { status: 400 });
  }
  const clubId = session.user.clubId;
  const acct = await prisma.bankAccount.findFirst({ where: { id, clubId }, select: { id: true } });
  if (!acct) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (body.name !== undefined) await prisma.bankAccount.update({ where: { id: acct.id }, data: { name: body.name } });
  let moved = 0;
  if (body.legalEntityId !== undefined) {
    const r = await assignAccountEntity(clubId, acct.id, body.legalEntityId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    moved = r.moved;
  }
  return NextResponse.json({ ok: true, moved });
}
