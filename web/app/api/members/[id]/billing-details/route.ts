import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { isImported } from "@/lib/memberTracks";
import { billingIsLive, migrationInProgress } from "@/lib/migrationSetup";

// GET /api/members/[id]/billing-details   (billing:view)
//
// Two small facts the retired "Advanced billing" page used to carry, that
// nothing else returns:
//
//   · migration — is this member still mid-migration? Decides whether
//     /dashboard/members/<id>/billing shows "Migration setup" or redirects to
//     the Membership panel (lib/migrationSetup billingPageDecision).
//   · stripe — the Stripe customer and subscription ids, for the collapsed
//     "Stripe details" disclosure in components/members/PaymentMethodsCard.
//     Staff paste these into Stripe support tickets; they are ids, not
//     secrets, and they are shown only to billing staff.
//
// Read only. No Stripe calls.

export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, status: true, isMinor: true,
      migrationStatus: true, importedAt: true, importBatchId: true, legacyMemberId: true,
      migrationCompletedAt: true,
      stripeCustomerId: true, stripeSetupCustomerId: true,
      club: { select: { stripeAccountId: true } },
      subscriptions: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, status: true, optionLabel: true, billingType: true,
          stripeSubscriptionId: true, stripeStatus: true,
          membership: { select: { name: true } },
        },
      },
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const imported = isImported({
    id: member.id, firstName: member.firstName, lastName: member.lastName, status: member.status, isMinor: member.isMinor,
    migrationStatus: member.migrationStatus, importedAt: member.importedAt,
    importBatchId: member.importBatchId, legacyMemberId: member.legacyMemberId,
  });

  const customers: { role: "SETUP" | "MEMBER"; id: string }[] = [];
  if (member.stripeSetupCustomerId) customers.push({ role: "SETUP", id: member.stripeSetupCustomerId });
  if (member.stripeCustomerId && member.stripeCustomerId !== member.stripeSetupCustomerId) {
    customers.push({ role: "MEMBER", id: member.stripeCustomerId });
  }

  return NextResponse.json({
    migration: {
      imported,
      status: member.migrationStatus,
      completedAt: member.migrationCompletedAt,
      inProgress: migrationInProgress({
        imported,
        migrationStatus: member.migrationStatus,
        migrationCompletedAt: member.migrationCompletedAt,
      }),
    },
    live: billingIsLive(member.subscriptions),
    stripe: {
      connected: !!member.club.stripeAccountId,
      customers,
      subscriptions: member.subscriptions
        .filter((s) => s.stripeSubscriptionId)
        .map((s) => ({
          id: s.id,
          label: [s.membership?.name, s.optionLabel].filter(Boolean).join(" · ") || "Membership",
          status: s.status,
          stripeStatus: s.stripeStatus,
          stripeSubscriptionId: s.stripeSubscriptionId,
          syncable: ["active", "pending", "past_due"].includes(s.status),
        })),
    },
  });
}
