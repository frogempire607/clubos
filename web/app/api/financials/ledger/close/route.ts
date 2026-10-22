import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requireOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { closeMonth, listCloses, loadMonthClose, reopenMonth } from "@/lib/glCloseServer";

export const dynamic = "force-dynamic";
// The checklist runs a dry-run posting sweep, which can touch a few thousand
// source records on a club's first close.
export const maxDuration = 60;

// GET /api/financials/ledger/close?entity=&month=YYYY-MM — the checklist for
// one entity-month, plus the close history. finances:view, Pro+.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const entity = p.get("entity");
  const month = p.get("month");
  try {
    const history = await listCloses(clubId, entity && entity !== "all" ? entity : null);
    if (!entity || entity === "all" || !month) return NextResponse.json({ history, close: null });
    const close = await loadMonthClose(clubId, entity, month, ledgerActor(session), {
      undepositedAcknowledged: p.get("ack") === "1",
    });
    return NextResponse.json({ history, close });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

const closeSchema = z
  .object({
    legalEntityId: z.string().min(1),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    /// The tick against "undeposited funds reviewed". Only a human can answer
    /// it, so it arrives from the human — but the checklist is still
    /// re-evaluated server-side, and this is only one of its five inputs.
    undepositedAcknowledged: z.boolean().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

// POST /api/financials/ledger/close — close a month. finances:full, Pro+.
// Closing sets the lock date, which is a money-affecting act, so it needs the
// full finance permission rather than view.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const parsed = closeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const close = await closeMonth(
      session.user.clubId,
      parsed.data.legalEntityId,
      parsed.data.month,
      ledgerActor(session),
      {
        undepositedAcknowledged: parsed.data.undepositedAcknowledged,
        note: parsed.data.note ?? null,
      },
    );
    return NextResponse.json({ close });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

const reopenSchema = z
  .object({
    legalEntityId: z.string().min(1),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

// PATCH /api/financials/ledger/close — reopen a month. OWNER ONLY, Pro+.
//
// Owner-only because reopening a month means every statement already handed to
// an accountant may now change. The reason is required and audited for the
// same reason.
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notOwner = await requireOwnerLive(session);
  if (notOwner) return notOwner;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const parsed = reopenSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const close = await reopenMonth(
      session.user.clubId,
      parsed.data.legalEntityId,
      parsed.data.month,
      parsed.data.reason,
      ledgerActor(session),
    );
    return NextResponse.json({ close });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
