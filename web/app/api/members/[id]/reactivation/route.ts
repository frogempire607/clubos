import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { writeBillingAudit } from "@/lib/billingAudit";
import { buildOffer, createReactivation, reactivationUrl } from "@/lib/reactivation";
import { chargeTiming } from "@/lib/billingAdmin";

// Reactivation offers for one member.
//   GET  (billing:view) — current + past offers with consent records.
//   POST (billing:full) — create/regenerate an offer + fresh secure token.
//        The offer snapshot is built SERVER-SIDE from the member's saved
//        billing setup; the only inputs are the owner-approved first-charge
//        date and the optional personal note. A past date is rejected unless
//        the owner explicitly acknowledges the immediate charge.

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "view");
  if (denied) return denied;

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.membershipReactivation.findMany({
    where: { memberId: id, clubId: session.user.clubId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const baseUrl = baseUrlFromRequest(req);
  return NextResponse.json({
    reactivations: rows.map((r) => ({
      id: r.id,
      status: r.status,
      offerVersion: r.offerVersion,
      offer: r.offer,
      personalNote: r.personalNote,
      emailSentAt: r.emailSentAt,
      emailSendCount: r.emailSendCount,
      sentToEmail: r.sentToEmail,
      viewedAt: r.viewedAt,
      confirmedAt: r.confirmedAt,
      consent: r.consent,
      tokenExpires: r.tokenExpires,
      createdAt: r.createdAt,
      // Client change request (locks confirmation while OPEN).
      changeRequest: r.changeRequest,
      changeRequestStatus: r.changeRequestStatus,
      changeRequestAt: r.changeRequestAt,
      url: r.status === "DRAFT" || r.status === "SENT" ? reactivationUrl(baseUrl, r.token) : null,
    })),
  });
}

const postSchema = z.object({
  firstChargeDate: z.string().optional().nullable(),
  personalNote: z.string().max(1500).optional().nullable(),
  // A today/past first-charge date means confirming will charge immediately —
  // the owner must acknowledge that explicitly to even create such an offer.
  acknowledgeImmediateCharge: z.boolean().optional().default(false),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof postSchema>;
  try {
    data = postSchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: { club: { select: { stripeAccountId: true, stripeChargesEnabled: true } } },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (member.migrationStatus === "COMPLETED" && member.status === "ACTIVE") {
    // Allowed — an owner may re-offer a corrected membership — but flag live subs.
    const live = await prisma.memberSubscription.findFirst({
      where: {
        memberId: member.id,
        stripeSubscriptionId: { not: null },
        status: { in: ["active", "past_due"] },
      },
      select: { id: true },
    });
    if (live) {
      return NextResponse.json(
        { error: "This member already has a live Stripe subscription. Leave them alone, or resolve that subscription first." },
        { status: 409 },
      );
    }
  }

  // Resolve the first-charge date: explicit input → saved final billing date →
  // billing anchor. Whatever it resolves to, a past/today date needs explicit
  // owner acknowledgement.
  let firstCharge: Date | null = null;
  if (data.firstChargeDate) {
    const d = new Date(data.firstChargeDate);
    if (isNaN(d.getTime())) return NextResponse.json({ error: "Invalid first charge date." }, { status: 400 });
    firstCharge = d;
  } else {
    firstCharge = member.migrationFinalBillingDate ?? member.billingAnchorDate ?? null;
  }

  const { offer, pricing } = await buildOffer(member, member.club, firstCharge);

  if (offer.paymentMode === "CARD") {
    if (!firstCharge) {
      return NextResponse.json(
        { error: "Set an owner-approved first billing date before creating the offer.", code: "DATE_REQUIRED" },
        { status: 400 },
      );
    }
    const timing = chargeTiming(firstCharge);
    if (timing.immediate && !data.acknowledgeImmediateCharge) {
      return NextResponse.json(
        {
          error: "That date is today or already passed, so confirming would charge immediately.",
          code: "IMMEDIATE_CHARGE_CONFIRM_REQUIRED",
          message:
            "Pick a new future billing date (recommended), or explicitly acknowledge that the client will be charged the moment they confirm.",
        },
        { status: 409 },
      );
    }
  }

  const reactivation = await createReactivation({
    clubId: member.clubId,
    memberId: member.id,
    offer,
    personalNote: data.personalNote?.trim() || null,
    createdById: session.user.id,
  });

  await prisma.member.update({
    where: { id: member.id },
    data: {
      ...(firstCharge ? { migrationFinalBillingDate: firstCharge } : {}),
      billingUpdatedAt: new Date(),
      billingUpdatedById: session.user.id,
    },
  });

  await writeBillingAudit({
    clubId: member.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "REACTIVATION_CREATED",
    after: {
      offerVersion: reactivation.offerVersion,
      plan: pricing.planName,
      price: pricing.price,
      period: pricing.period,
      firstChargeDate: offer.firstChargeDate,
      paymentMode: offer.paymentMode,
    },
    note: `Reactivation offer v${reactivation.offerVersion} created (token expires ${reactivation.tokenExpires.toLocaleDateString()}).`,
  });

  return NextResponse.json({
    ok: true,
    reactivation: {
      id: reactivation.id,
      status: reactivation.status,
      offerVersion: reactivation.offerVersion,
      offer: reactivation.offer,
      personalNote: reactivation.personalNote,
      tokenExpires: reactivation.tokenExpires,
      url: reactivationUrl(baseUrlFromRequest(req), reactivation.token),
    },
  });
}
