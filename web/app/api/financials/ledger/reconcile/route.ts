import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import {
  finishReconciliation,
  loadReconciliation,
  reconcilableAccounts,
  setCleared,
  undoReconciliation,
  upsertReconciliation,
} from "@/lib/glReconcileServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/reconcile?account=&start=&end=
// The workpaper for one account + statement period, or just the account list
// when no account is named. finances:view, Pro+.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const accounts = await reconcilableAccounts(clubId);
  const accountId = p.get("account");
  const start = p.get("start");
  const end = p.get("end");
  if (!accountId || !start || !end) return NextResponse.json({ accounts, reconciliation: null });

  try {
    return NextResponse.json({ accounts, reconciliation: await loadReconciliation(clubId, accountId, start, end) });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    accountId: z.string().min(1),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    statementEndingCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
    notes: z.string().trim().max(500).nullable().optional(),
  }),
  z.object({
    action: z.literal("clear"),
    reconciliationId: z.string().min(1),
    lineIds: z.array(z.string().min(1)).max(1000),
    cleared: z.boolean(),
  }),
  z.object({ action: z.literal("finish"), reconciliationId: z.string().min(1) }),
  z.object({
    action: z.literal("undo"),
    reconciliationId: z.string().min(1),
    reason: z.string().trim().max(300).nullable().optional(),
  }),
]);

// POST /api/financials/ledger/reconcile — one endpoint, four actions.
// finances:edit, Pro+.
//
// `finish` recomputes the difference SERVER-SIDE and refuses anything but
// exactly $0.00 — the client cannot talk its way past that gate. Finishing
// freezes the cleared lines (lib/ledgerServer.voidEntry then refuses to void
// their entries); `undo` is the audited escape hatch.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const reconciliation =
      body.action === "upsert"
        ? await upsertReconciliation(clubId, body, actor)
        : body.action === "clear"
          ? await setCleared(clubId, body.reconciliationId, body.lineIds, body.cleared, actor)
          : body.action === "finish"
            ? await finishReconciliation(clubId, body.reconciliationId, actor)
            : await undoReconciliation(clubId, body.reconciliationId, body.reason ?? null, actor);
    return NextResponse.json({ reconciliation });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
