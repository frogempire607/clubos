import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { postPendingForClub } from "@/lib/glPostingServer";
import { SKIP_LABELS } from "@/lib/glPosting";

export const dynamic = "force-dynamic";
// Stripe payout sync means a network round-trip or two.
export const maxDuration = 60;

// POST /api/financials/ledger/post — run the posting sweep. finances:edit, Pro+.
//
// Idempotent and resumable: it asks the ledger what is already posted and posts
// the rest, so running it twice is free and a missed row self-heals on the next
// run. Safe to call from a page load.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  const rl = rateLimit({ key: `gl:post:${actor.userId ?? clubId}`, limit: 12, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Posting is already running. Give it a moment.");

  const url = new URL(req.url);
  const report = await postPendingForClub(clubId, actor, {
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    // The lazy on-load call skips the Stripe round-trip; the backfill doesn't.
    skipPayoutSync: url.searchParams.get("payouts") === "0",
  });

  return NextResponse.json({
    ...report,
    // Labels so the UI doesn't hardcode its own copy for each reason.
    skipLabels: SKIP_LABELS,
  });
}
