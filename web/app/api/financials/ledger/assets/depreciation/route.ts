import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { postDepreciation } from "@/lib/glAssetsServer";

export const dynamic = "force-dynamic";
// A first run on a club with a long-standing register can be hundreds of
// entries, each through the ledger service.
export const maxDuration = 60;

const schema = z
  .object({
    throughMonth: z.string().regex(/^\d{4}-\d{2}$/),
    legalEntityId: z.string().min(1).nullable().optional(),
    assetId: z.string().min(1).nullable().optional(),
  })
  .strict();

// POST /api/financials/ledger/assets/depreciation — post every month of
// depreciation due through `throughMonth`. finances:full, Pro+.
//
// Safe to run twice. The sourceId is `<assetId>:<YYYY-MM>` and
// gl_journal_entries is unique on (clubId, sourceType, sourceId), so a re-run
// posts nothing new — that is a property of the database, not of this route
// remembering to check.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const result = await postDepreciation(
      session.user.clubId,
      {
        throughMonth: parsed.data.throughMonth,
        legalEntityId: parsed.data.legalEntityId ?? null,
        assetId: parsed.data.assetId ?? null,
      },
      ledgerActor(session),
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
