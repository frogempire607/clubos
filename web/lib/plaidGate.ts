// Accounting Phase 2, task 8 — the bank-connection tier gate, in one place.
//
// ── WHAT WAS ALREADY GATED, BEFORE THIS FILE ───────────────────────────────
// Audited 2026-10-21. Every Plaid route already checked the `plaid` flag
// EXCEPT `DELETE /api/plaid/transactions`, but via three different mechanisms:
// `requireTierFeature` (4 handlers), a hand-rolled
// `getTierFeatures(club.tier).plaid` (5 handlers), and a soft gate on
// `GET /connections` that returns 200 with an empty list. Error bodies differed
// too — some carried `code: "UPGRADE_REQUIRED"`, some didn't.
//
// Two real holes came out of that audit:
//   1. `POST /api/plaid/connections` is a SECOND token-exchange path (it calls
//      itemPublicTokenExchange exactly like `/exchange`) and it had NO
//      `maxBankAccounts` check — so a club at its limit could exceed it there.
//      scripts/tier-gating-guard.ts only asserted the limit on `/exchange`,
//      which is why it went unnoticed.
//   2. `DELETE /api/plaid/connections/[id]` was gated on `plaid`, so a club
//      that dropped to Starter could not disconnect its own bank.
//
// ── THE TWO GATES, AND WHY THEY DIFFER ─────────────────────────────────────
// The brief asks for two things that pull in opposite directions:
//
//   "Starter can never connect a bank. Gate link-token creation, public-token
//    exchange, sync, and webhooks."
//   "Downgrade rule: keep existing bank data viewable, stop all syncing, and
//    remove the connect button. Never delete history."
//
// A single gate cannot do both — gating reads would hide the history the
// downgrade rule promises to keep. So there are two:
//
//   requireBankConnect  — hard `plaid` check. Connecting and syncing. A Starter
//                         club is refused, always, whatever it already has.
//   requireBankRead     — `plaid` OR the club already HAS bank data. A club
//                         that never had Plaid gets the upgrade prompt; a
//                         downgraded club keeps seeing and tidying its own
//                         history.
//
// Disconnecting is gated by NEITHER. A club must always be able to unplug its
// own bank — gating that is how you trap somebody.
//
// The grandfathered read follows existing precedent in this codebase, not a new
// idea: `app/api/events/[id]/route.ts:190` ("gated, so a club that downgraded
// can still edit an event that has them") and the pricing page's promise
// ("Moving to Starter keeps all your data; Pro-only tools pause until you
// upgrade again").
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { canUseFeature, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { clubTier, limitBlocked } from "@/lib/tierGuard";

/// 403 body shaped like every other tier refusal, so clients can handle one
/// shape. The hand-rolled checks this replaces omitted `code` about half the
/// time.
function blocked(tier: string, message: string): NextResponse {
  return NextResponse.json(
    tierBlockedBody({ message, upgradeRequired: upgradeRequired(tier, "plaid") }),
    { status: 403 },
  );
}

/// Connecting a bank or running a sync. HARD `plaid` gate — a Starter club can
/// never do this, no matter what it already has.
export async function requireBankConnect(clubId: string): Promise<NextResponse | null> {
  const tier = await clubTier(clubId);
  if (canUseFeature(tier, "plaid")) return null;
  return blocked(
    tier,
    "Bank connections are included on Pro and Enterprise. Your existing bank data stays visible, but new connections and syncing are paused.",
  );
}

/// Does this club already have bank data? Soft-deleted connections count:
/// "disconnected" still leaves history the club is entitled to read.
export async function hasBankData(clubId: string): Promise<boolean> {
  const [connections, rows] = await Promise.all([
    prisma.plaidConnection.count({ where: { clubId } }),
    prisma.plaidTransaction.count({ where: { clubId } }),
  ]);
  return connections > 0 || rows > 0;
}

/// Reading or tidying bank data the club already has.
///
/// Allowed when the plan includes `plaid` OR the club already has data — which
/// is exactly the downgrade promise. A club that never connected a bank still
/// gets the upgrade prompt, so this does not leak the feature to Starter.
export async function requireBankRead(clubId: string): Promise<NextResponse | null> {
  const tier = await clubTier(clubId);
  if (canUseFeature(tier, "plaid")) return null;
  if (await hasBankData(clubId)) return null;
  return blocked(tier, "Bank connections are included on Pro and Enterprise.");
}

/// The `maxBankAccounts` limit, for BOTH token-exchange paths.
///
/// Counted identically to the pre-existing check in `/exchange` and
/// `/financials/bank-accounts`: BankAccount rows whose connection is not
/// soft-deleted. Call this on every path that can create a connection —
/// `POST /api/plaid/connections` was missing it.
export async function requireBankAccountRoom(clubId: string): Promise<NextResponse | null> {
  const count = await prisma.bankAccount.count({ where: { clubId, connection: { deletedAt: null } } });
  return limitBlocked(await clubTier(clubId), "maxBankAccounts", count);
}

/// What the UI needs to decide whether to render the "Connect a bank" button.
/// Hiding it is cosmetic — `requireBankConnect` is the real gate — but a button
/// that always 403s is its own kind of bug.
export async function bankConnectState(session: Session): Promise<{
  canConnect: boolean;
  canRead: boolean;
  tier: string;
  hasData: boolean;
}> {
  const clubId = session.user.clubId;
  const tier = await clubTier(clubId);
  const plaid = canUseFeature(tier, "plaid");
  const hasData = plaid ? true : await hasBankData(clubId);
  return { canConnect: plaid, canRead: plaid || hasData, tier, hasData };
}
