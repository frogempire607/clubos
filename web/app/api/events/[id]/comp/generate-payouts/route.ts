import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive, isOwnerLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import {
  collectedRevenue,
  computePayoutAmount,
  payoutBasisNote,
} from "@/lib/eventComp";

/** Thrown inside the claim transaction to roll back a Payout another request already created. */
class AlreadyGenerated extends Error {}

// POST /api/events/[id]/comp/generate-payouts (finances:edit)
// Turns each compensated assignment into ONE pending Payout row — a payable
// for the owner to review and mark paid through the existing payouts page.
// Never moves money, never touches Stripe. assignment.payoutId is the
// never-pay-twice guard, CLAIMED CONDITIONALLY in the same transaction that
// creates the Payout: once generated, re-running (or a second tap) skips the
// row; to re-issue, void/handle the Payout in the ledger.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Money: Financials & payroll FULL, read live (was the token-snapshot
  // `finances:edit` until 2026-10-07).
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  // Self rule: a non-owner never generates a payout to THEMSELF. Their own row
  // is skipped (and reported as skippedSelf) rather than failing the whole run,
  // so the other coaches still get their payables; an owner generates theirs.
  const actorIsOwner = await isOwnerLive(session);

  const event = await prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true, compNoRefunds: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [assignments, txns, roster] = await Promise.all([
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
    prisma.eventStaffAssignment.findMany({ where: { eventId: event.id, clubId }, select: { userId: true } }),
  ]);
  // Second safety (2026-09-28): a STAFF pay row only pays if that person is
  // still on the event's roster. Removing a coach already deletes their unpaid
  // row (lib/staffAssignmentsServer.ts); this makes a stale row harmless too.
  const onRoster = new Set(roster.map((r) => r.userId));
  const revenue = collectedRevenue(txns, { ignoreRefunds: event.compNoRefunds });

  let created = 0;
  let skippedExisting = 0;
  let skippedZero = 0;
  let skippedOffRoster = 0;
  let skippedSelf = 0;
  const results: Array<{ payeeName: string; amount: number }> = [];

  for (const a of assignments) {
    if (a.compMethod === "NONE") continue;
    if (a.payoutId) {
      skippedExisting++;
      continue;
    }
    if (!actorIsOwner && a.payeeType === "STAFF" && a.userId === session.user.id) {
      skippedSelf++;
      continue;
    }
    if (a.payeeType === "STAFF" && a.userId && !onRoster.has(a.userId)) {
      skippedOffRoster++;
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

    // Create the payable and claim the assignment TOGETHER, and only if the
    // assignment is still unclaimed. Two taps on "Create payout records" used
    // to each create a Payout and each point the assignment at its own: the
    // unique payoutId stopped nothing, because the two ids differ, and the
    // owner was left with two payables for one job (audit R9). Now the claim
    // is conditional (payoutId still null); the tap that loses rolls its
    // Payout back and counts the row as already generated.
    const note = payoutBasisNote(input, revenue, event.name, { ignoreRefunds: event.compNoRefunds });
    const won = await prisma
      .$transaction(async (db) => {
        const payout = await db.payout.create({
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
            notes: note,
            createdById: session.user.id ?? null,
          },
          select: { id: true },
        });
        const claim = await db.eventCompAssignment.updateMany({
          where: { id: a.id, payoutId: null },
          data: { payoutId: payout.id },
        });
        if (claim.count !== 1) throw new AlreadyGenerated();
        return true;
      })
      .catch((err) => {
        if (err instanceof AlreadyGenerated) return false;
        throw err;
      });
    if (!won) {
      skippedExisting++;
      continue;
    }
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
    skippedOffRoster,
    skippedSelf,
    revenue,
    results,
  });
}
