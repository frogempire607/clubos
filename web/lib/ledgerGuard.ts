// Small shared pieces for the /api/financials/ledger/* routes.
//
// ── WHY THERE IS NO `gateLedger()` WRAPPER HERE ─────────────────────────────
// The first cut of this file wrapped the three access checks (session →
// permission → tier) in one helper that each route called. It worked, but it
// defeated scripts/permission-boundary-guard.ts, which reads the source tree
// and requires a VISIBLE permission check in every mutating handler. That guard
// is a deliberate ratchet — "a NEW ungated mutating route fails the build" —
// and it exists because middleware.ts does not match /api, so the guard written
// in a route is the entire boundary for that route.
//
// Adding eight ledger routes to its APPROVED_INLINE exception list would have
// made the build pass while making the guard blind to the next route somebody
// adds here. So the checks are written out in each route instead, in the same
// order and shape as app/api/financials/receipts/route.ts:
//
//   const session = await getServerSession(authOptions);
//   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
//   const denied = await requirePermissionLive(session, "finances", "edit");
//   if (denied) return denied;
//   const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
//   if (tierGate) return tierGate;
//
// The explicit `if (!session)` is required, not stylistic: requirePermissionLive
// does not narrow the type, and CLAUDE.md records that omitting it fails the
// build with "'session' is possibly null".
//
// Three rules the routes follow, asserted by scripts/ledger-tests.ts §9:
//   · reads use `finances:view`, writes use `finances:edit` — matching the
//     existing finance mutations (/api/stripe/reconcile POST,
//     /api/events/[id]/comp/generate-payouts);
//   · the LOCK DATE is owner-only (requireOwnerLive), because it is the control
//     that stops everyone else editing closed history and so cannot be
//     delegated through a permission level;
//   · the tier check (`fullFinancials` — Pro and Enterprise) comes LAST, so a
//     staff member with no finance permission is told they lack permission
//     rather than told to upgrade the plan.
import type { Session } from "next-auth";
import type { Actor } from "@/lib/ledgerServer";

/// Who to record in the audit trail. The display name is denormalized into
/// every audit row at write time so the log stays readable after a staff member
/// is removed from the club.
export function ledgerActor(session: Session): Actor {
  const user = session.user as { id?: string; name?: string | null };
  return { userId: user.id ?? null, name: user.name ?? null };
}
