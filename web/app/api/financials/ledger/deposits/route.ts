import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { LedgerError } from "@/lib/ledgerServer";
import { recordDeposit, undepositedPayments } from "@/lib/glPostingServer";
import { reconcilableAccounts } from "@/lib/glReconcileServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/deposits — the cash and cheques recorded but not
// yet banked, plus the accounts they can be deposited into. finances:view, Pro+.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const [payments, accounts] = await Promise.all([
    undepositedPayments(session.user.clubId),
    reconcilableAccounts(session.user.clubId),
  ]);
  return NextResponse.json({ payments, accounts: accounts.filter((a) => !a.isCard) });
}

const schema = z
  .object({
    bankAccountGlId: z.string().min(1),
    depositDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    transactionIds: z.array(z.string().min(1)).min(1).max(500),
    memo: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

// POST /api/financials/ledger/deposits — record a deposit: move a batch of cash
// and cheques from 1020 Undeposited Funds into a bank account. finances:edit, Pro+.
//
// The AMOUNT IS NOT ACCEPTED FROM THE CLIENT — the service sums the chosen
// payments server-side. `Transaction.glDepositId` is claimed conditionally, so
// a double-click at the front desk cannot bank the same cash twice.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  const rl = rateLimit({ key: `gl:deposit:${actor.userId ?? clubId}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many deposits at once. Wait a moment and try again.");

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await recordDeposit(clubId, data, actor);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
