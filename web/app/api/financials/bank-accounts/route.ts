import { NextResponse } from "next/server";
import { clubTier, limitBlocked } from "@/lib/tierGuard";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { formatZodError } from "@/lib/zodErrors";
import { createManualAccount, listBankAccounts } from "@/lib/bankAccounts";
import { requireTierFeature } from "@/lib/tierGuard";

export const dynamic = "force-dynamic";

// GET /api/financials/bank-accounts — every bank account and the entity whose
// books it belongs to (finances:view). Grouping by entity is the UI's job.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const [accounts, entities] = await Promise.all([
    listBankAccounts(clubId),
    prisma.legalEntity.findMany({ where: { clubId }, select: { id: true, name: true, entityType: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return NextResponse.json({ accounts, entities, unassigned: accounts.filter((a) => !a.legalEntityId).length });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  legalEntityId: z.string().nullable(),
  mask: z.string().trim().max(8).nullable().optional(),
  type: z.enum(["checking", "savings", "credit card", "other"]).optional(),
}).strict();

// POST /api/financials/bank-accounts — add an account kept by hand (a closed
// account, a card that isn't linked) so imported history has a home.
// finances:full.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof z.ZodError ? formatZodError(err) : "Invalid request body" }, { status: 400 });
  }
  // Bank-account limit by plan (Starter 1, Pro 2, Enterprise unlimited).
  {
    const count = await prisma.bankAccount.count({ where: { clubId: session.user.clubId, connection: { deletedAt: null } } });
    const lim = limitBlocked(await clubTier(session.user.clubId), "maxBankAccounts", count);
    if (lim) return lim;
  }
  try {
    const acct = await createManualAccount(session.user.clubId, { name: body.name, legalEntityId: body.legalEntityId, mask: body.mask ?? null, type: body.type ?? "other" });
    return NextResponse.json({ ok: true, id: acct.id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Couldn't add the account." }, { status: 400 });
  }
}
