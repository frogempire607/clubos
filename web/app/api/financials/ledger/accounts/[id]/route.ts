import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError, deleteAccount, updateAccount } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    active: z.boolean().optional(),
    parentId: z.string().min(1).nullable().optional(),
  })
  .strict();

// PATCH /api/financials/ledger/accounts/[id] — rename, redescribe, re-parent,
// activate or deactivate. finances:edit, Pro+.
//
// `number` and `type` are deliberately NOT editable: both are referenced by
// prior postings and by every report, so changing either rewrites history. A
// club that wants a different number adds a new account and deactivates the
// old one, which keeps the old postings readable.
//
// A system account can be renamed but never deactivated — the service enforces
// that, because Phase 2's automatic posting resolves those accounts by
// systemKey and losing one would break posting silently.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side, last so a
  // staffer without finance permission hears that, not "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const account = await updateAccount(clubId, id, data, actor);
    return NextResponse.json({ account });
  } catch (err) {
    if (err instanceof LedgerError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
}

// DELETE /api/financials/ledger/accounts/[id] — only while the account has
// never been posted to. finances:edit, Pro+.
//
// An account WITH postings is refused with a message pointing at deactivation
// instead; the RESTRICT foreign key on gl_journal_lines.accountId is the
// database-level backstop.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side, last so a
  // staffer without finance permission hears that, not "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  try {
    await deleteAccount(clubId, id, actor);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
}
