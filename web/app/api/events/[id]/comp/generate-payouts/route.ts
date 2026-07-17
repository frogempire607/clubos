import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import {
  collectedRevenue,
  computePayoutAmount,
  payoutBasisNote,
} from "@/lib/eventComp";

// POST /api/events/[id]/comp/generate-payouts (finances:edit)
// Turns each compensated assignment into ONE pending Payout row — a payable
// for the owner to review and mark paid through the existing payouts page.
// Never moves money, never touches Stripe. assignment.payoutId (unique) is
// the never-pay-twice guard: once generated, re-running skips the row; to
// re-issue, void/handle the Payout in the ledger.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const event = await prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true, compNoRefunds: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [assignments, txns] = await Promise.all([
    prisma.eventCompAssignment.findMany({ where: { eventId: event.id, clubId } }),
    prisma.transaction.findMany({
      where: { clubId, eventId: event.id },
      select: {
        status: true,
        reconciliationStatus: true,
        amount: true,
        refundedAmount: true,
        stripeFeeAmount: true,
      },
    }),
  ]);
  const revenue = collectedRevenue(txns, { ignoreRefunds: event.compNoRefunds });

  let created = 0;
  let skippedExisting = 0;
  let skippedZero = 0;
  const results: Array<{ payeeName: string; amount: number }> = [];

  for (const a of assignments) {
    if (a.compMethod === "NONE") continue;
    if (a.payoutId) {
      skippedExisting++;
      continue;
    }
    const input = {
      compMethod: a.compMethod,
      flatAmount: a.flatAmount != null ? Number(a.flatAmount) : null,
      percent: a.percent != null ? Number(a.percent) : null,
      basis: a.basis,
    };
    const amount = computePayoutAmount(input, revenue);
    if (!amount || amount <= 0) {
      skippedZero++;
      continue;
    }

    const payout = await prisma.payout.create({
      data: {
        clubId,
        // The payouts page vocabulary: contractors on file surface as "Guest
        // clinician" payees; staff stay STAFF.
        payeeType: a.payeeType === "STAFF" ? "STAFF" : "GUEST",
        payeeUserId: a.userId,
        contractorId: a.contractorId,
        payeeName: a.payeeName,
        kind: "EVENT",
        eventId: event.id,
        amount,
        status: "PENDING",
        notes: payoutBasisNote(input, revenue, event.name, { ignoreRefunds: event.compNoRefunds }),
        createdById: session.user.id ?? null,
      },
      select: { id: true },
    });

    // Claim the assignment; the unique payoutId column makes a concurrent
    // double-generate impossible to record twice.
    await prisma.eventCompAssignment.update({
      where: { id: a.id },
      data: { payoutId: payout.id },
    });
    created++;
    results.push({ payeeName: a.payeeName, amount });
  }

  if (created > 0) {
    await writeBillingAudit({
      clubId,
      actorUserId: session.user.id ?? null,
      action: "EVENT_PAYOUTS_GENERATED",
      after: {
        eventId: event.id,
        eventName: event.name,
        revenue,
        payouts: results,
      },
      note: `${created} event payout record(s) created for ${event.name} — pending review on the payouts page.`,
    });
  }

  return NextResponse.json({
    ok: true,
    created,
    skippedExisting,
    skippedZero,
    revenue,
    results,
  });
}
