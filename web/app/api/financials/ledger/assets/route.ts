import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { createAsset, listAssets } from "@/lib/glAssetsServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/assets?entity=&includeDisposed=1 — the fixed-asset
// register. finances:view, Pro+.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const p = new URL(req.url).searchParams;
  const entity = p.get("entity");
  const assets = await listAssets(session.user.clubId, {
    legalEntityId: entity && entity !== "all" ? entity : null,
    includeDisposed: p.get("includeDisposed") === "1",
  });
  return NextResponse.json({ assets });
}

// Cost and salvage cross the wire as INTEGER CENTS, matching storage, so one
// rounding rule applies on both sides.
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullable().optional(),
    costCents: z.number().int().positive().max(2_000_000_000),
    inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    usefulLifeMonths: z.number().int().positive().max(1200),
    salvageValueCents: z.number().int().min(0).max(2_000_000_000),
    legalEntityId: z.string().min(1).nullable(),
    assetAccountId: z.string().min(1),
    accumDepAccountId: z.string().min(1),
    depExpenseAccountId: z.string().min(1),
  })
  .strict();

// POST /api/financials/ledger/assets — add an asset. finances:full, Pro+.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const id = await createAsset(session.user.clubId, parsed.data, ledgerActor(session));
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
