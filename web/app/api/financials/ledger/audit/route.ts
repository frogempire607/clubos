import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { listAudit } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/audit — the append-only trail of every create,
// edit and void on accounts, entries, lines and lock dates. finances:view, Pro+.
// Filters: ?objectType=ACCOUNT|ENTRY|LINE|LOCK_DATE &objectId= &take=
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side, last so a
  // staffer without finance permission hears that, not "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const objectType = p.get("objectType");
  const entries = await listAudit(clubId, {
    objectType: objectType && ["ACCOUNT", "ENTRY", "LINE", "LOCK_DATE"].includes(objectType) ? objectType : undefined,
    objectId: p.get("objectId") ?? undefined,
    take: p.get("take") ? Number(p.get("take")) : undefined,
  });
  return NextResponse.json({ audit: entries });
}
