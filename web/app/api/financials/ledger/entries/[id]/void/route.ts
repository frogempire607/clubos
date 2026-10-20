import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { LedgerError, voidEntry } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().trim().max(300).nullable().optional() }).strict();

// POST /api/financials/ledger/entries/[id]/void — void by REVERSAL.
// finances:edit, Pro+.
//
// A posted entry is never hard-deleted. The service creates a mirror-image
// entry, cross-links the pair, and flips the original to VOID, so the audit
// trail and every report run before today stay true. The reversal posts on the
// original's date — or today, if that period is already closed.
//
// The service claims the original with a conditional update before minting the
// reversal, so two simultaneous void clicks produce one reversal, not two. The
// second gets a 409.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
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

  const rl = rateLimit({ key: `gl:void:${actor.userId ?? clubId}`, limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many changes at once. Wait a moment and try again.");

  let data: z.infer<typeof schema> = {};
  try {
    const raw = await req.text();
    data = raw ? schema.parse(JSON.parse(raw)) : {};
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await voidEntry(clubId, id, data.reason ?? null, actor);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LedgerError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
}
