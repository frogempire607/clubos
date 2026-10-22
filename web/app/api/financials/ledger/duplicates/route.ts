import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { dismissBankDuplicate, heldBankDuplicates } from "@/lib/glPostingServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/duplicates — bank rows held because they look
// like the same transaction as a bank-feed row. finances:view, Pro+.
//
// Task 9. A QuickBooks-imported row and a live Plaid row with the same bank
// account, the same amount and dates within three days are almost certainly
// one transaction, and posting both would put the month out by the amount.
// The IMPORTED row is held — never the feed row, which is the bank's own
// record and the one a reconciliation has to tie to.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  return NextResponse.json({ held: await heldBankDuplicates(session.user.clubId) });
}

const schema = z
  .object({
    plaidTransactionId: z.string().min(1),
  })
  .strict();

// PATCH /api/financials/ledger/duplicates — say the pair really is two
// different transactions, releasing the hold. finances:full, Pro+.
//
// There is deliberately no "confirm it IS a duplicate" action here: the held
// row simply never posts, which is the safe resting state. Deleting it belongs
// to the import that created it (undo the import), not to this screen.
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    await dismissBankDuplicate(
      session.user.clubId,
      parsed.data.plaidTransactionId,
      session.user.id ?? null,
    );
    return NextResponse.json({ held: await heldBankDuplicates(session.user.clubId) });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
