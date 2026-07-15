import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { compareClubCharges, fillChargeFees } from "@/lib/stripeSync";

// Charge-level Stripe ↔ AthletixOS comparison. Pages every charge on the
// connected account.
export const maxDuration = 60;

// GET /api/stripe/reconcile/charges (finances:view)
// READ-ONLY comparison: Stripe charges with no local Transaction (missing
// revenue), local Stripe-claimed rows with no Stripe match, duplicate rows
// sharing one Stripe payment, matched rows missing exact fee/net, and refunds
// not recorded locally. Never mutates anything.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const report = await compareClubCharges(session.user.clubId);
  return NextResponse.json(report, { status: report.ok ? 200 : 502 });
}

// POST /api/stripe/reconcile/charges (finances:edit)
// The ONLY write this endpoint performs: fill missing Stripe-derived fee/net/
// charge-id columns on rows already matched to a Stripe charge (audit-logged).
// Missing Transactions are NEVER auto-created here — that requires the
// allowlisted owner-approved backfill script.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const report = await compareClubCharges(clubId);
  if (!report.ok) return NextResponse.json(report, { status: 502 });
  const filled = await fillChargeFees(clubId, report.feeGaps, session.user.id ?? null);
  return NextResponse.json({ ok: true, filled, remainingGaps: report.feeGaps.length - filled });
}
