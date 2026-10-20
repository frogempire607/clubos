import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError, removeAttachment } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

// DELETE /api/financials/ledger/entries/[id]/attachments/[attachmentId]
// Detach a document from an entry. finances:edit, Pro+.
//
// The UploadedFile row and the stored bytes are deliberately KEPT — same
// discipline as every other delete path in this codebase. Detaching a document
// from an entry is not a reason to destroy the document, and an accounting
// attachment is exactly the kind of thing someone needs back.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await context.params;
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
    const entry = await removeAttachment(clubId, id, attachmentId, actor);
    return NextResponse.json({ entry });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
