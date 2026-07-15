import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { buildOffer, createReactivation, type OfferMember } from "@/lib/reactivation";
import { chargeTiming } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

// POST /api/members/[id]/reactivation/change-request — owner resolves a
// client's change request (billing:full).
//
//   action DENY    → request marked DENIED; the ORIGINAL offer unlocks and can
//                    be confirmed again. Nothing else changes.
//   action APPROVE → request marked APPROVED and a NEW offer version is
//                    generated from the member's CURRENT billing setup (the
//                    owner edits billing first via the billing center — those
//                    edits never charge). The old token goes stale
//                    (SUPERSEDED); the owner previews + sends the new version
//                    through the existing flow.
//
// Resolving a request never charges anyone: only client confirmation or an
// explicit authorized activation creates a charge/subscription.
const schema = z.object({
  reactivationId: z.string().min(1),
  action: z.enum(["APPROVE", "DENY"]),
  // Optional owner note recorded in the audit trail.
  note: z.string().max(500).optional().nullable(),
  // Required by createReactivation when the current setup's first-charge date
  // is today/past (same acknowledgement the normal offer flow demands).
  acknowledgeImmediateCharge: z.boolean().optional().default(false),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { reactivationId, action, note, acknowledgeImmediateCharge } = parsed.data;

  const r = await prisma.membershipReactivation.findFirst({
    where: { id: reactivationId, clubId, memberId },
    select: { id: true, status: true, offerVersion: true, changeRequest: true, changeRequestStatus: true },
  });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.changeRequestStatus !== "OPEN") {
    return NextResponse.json({ error: "No open change request on this offer." }, { status: 409 });
  }

  if (action === "DENY") {
    await prisma.membershipReactivation.update({
      where: { id: r.id },
      data: {
        changeRequestStatus: "DENIED",
        changeRequestResolvedAt: new Date(),
        changeRequestResolvedById: session.user.id ?? null,
      },
    });
    await writeBillingAudit({
      clubId,
      memberId,
      actorUserId: session.user.id ?? null,
      action: "REACTIVATION_CHANGE_DENIED",
      before: { reactivationId: r.id, request: r.changeRequest },
      after: { reactivationId: r.id, changeRequestStatus: "DENIED" },
      note: note || "Owner denied the client's change request — the original offer is open for confirmation again.",
    });
    return NextResponse.json({ ok: true, action: "DENY" });
  }

  // APPROVE: regenerate a fresh offer version from the member's CURRENT setup.
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    include: { club: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const firstCharge = member.migrationFinalBillingDate ?? member.billingAnchorDate ?? null;
  const { offer, discountError } = await buildOffer(member as unknown as OfferMember, member.club, firstCharge);
  if (discountError) {
    return NextResponse.json(
      { error: `The selected discount can't be applied: ${discountError} Fix or clear the discount in the billing center first.`, code: "DISCOUNT_INVALID" },
      { status: 400 },
    );
  }

  if (offer.paymentMode === "CARD") {
    if (!firstCharge) {
      return NextResponse.json(
        {
          error: "Set an owner-approved first billing date (billing center) before approving — the new offer needs one.",
          code: "DATE_REQUIRED",
        },
        { status: 400 },
      );
    }
    const timing = chargeTiming(firstCharge);
    if (timing.immediate && !acknowledgeImmediateCharge) {
      return NextResponse.json(
        {
          error: "The current billing date is today or has passed — confirming the new offer would charge immediately.",
          code: "IMMEDIATE_CHARGE_CONFIRM_REQUIRED",
        },
        { status: 409 },
      );
    }
  }

  // Mark the request approved on the OLD row, then supersede it with the new
  // version (createReactivation supersedes every open offer → old token stale).
  await prisma.membershipReactivation.update({
    where: { id: r.id },
    data: {
      changeRequestStatus: "APPROVED",
      changeRequestResolvedAt: new Date(),
      changeRequestResolvedById: session.user.id ?? null,
    },
  });
  const next = await createReactivation({
    clubId,
    memberId,
    offer,
    personalNote: note || null,
    createdById: session.user.id ?? null,
  });
  await writeBillingAudit({
    clubId,
    memberId,
    actorUserId: session.user.id ?? null,
    action: "REACTIVATION_CHANGE_APPROVED",
    before: { reactivationId: r.id, offerVersion: r.offerVersion, request: r.changeRequest },
    after: { reactivationId: next.id, offerVersion: next.offerVersion, offer },
    note:
      note ||
      "Owner approved the client's change request — new offer version generated from the current billing setup. Preview and send it; nothing has been charged.",
  });

  return NextResponse.json({
    ok: true,
    action: "APPROVE",
    newReactivationId: next.id,
    newOfferVersion: next.offerVersion,
  });
}
