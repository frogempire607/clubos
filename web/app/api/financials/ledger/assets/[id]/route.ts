import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { deleteAsset, disposeAsset, updateAsset } from "@/lib/glAssetsServer";

export const dynamic = "force-dynamic";

const updateSchema = z
  .object({
    action: z.literal("update").optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    costCents: z.number().int().positive().max(2_000_000_000).optional(),
    inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    usefulLifeMonths: z.number().int().positive().max(1200).optional(),
    salvageValueCents: z.number().int().min(0).max(2_000_000_000).optional(),
    legalEntityId: z.string().min(1).nullable().optional(),
    assetAccountId: z.string().min(1).optional(),
    accumDepAccountId: z.string().min(1).optional(),
    depExpenseAccountId: z.string().min(1).optional(),
  })
  .strict();

const disposeSchema = z
  .object({
    action: z.literal("dispose"),
    disposedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    proceedsCents: z.number().int().min(0).max(2_000_000_000),
    proceedsAccountId: z.string().min(1).nullable(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

// PATCH /api/financials/ledger/assets/[id] — edit an asset, or dispose of it
// with `{ action: "dispose" }`. finances:full, Pro+.
//
// Disposal is a PATCH rather than its own route because it is a change to this
// asset: it posts one entry and flips the asset's status, and keeping it here
// means one permission check and one tier gate instead of two.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const body = await req.json().catch(() => null);
  const clubId = session.user.clubId;

  try {
    if (body && typeof body === "object" && (body as { action?: string }).action === "dispose") {
      const parsed = disposeSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
      const result = await disposeAsset(
        clubId,
        params.id,
        {
          disposedDate: parsed.data.disposedDate,
          proceedsCents: parsed.data.proceedsCents,
          proceedsAccountId: parsed.data.proceedsAccountId,
          note: parsed.data.note ?? null,
        },
        ledgerActor(session),
      );
      return NextResponse.json(result);
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    const { action, ...input } = parsed.data;
    void action;
    await updateAsset(clubId, params.id, input);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

// DELETE /api/financials/ledger/assets/[id] — only while it has posted
// nothing. finances:full, Pro+.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  try {
    await deleteAsset(session.user.clubId, params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
