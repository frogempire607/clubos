import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requirePermissionLive } from "@/lib/apiGuard";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { writeBillingAudit } from "@/lib/billingAudit";
import { buildOffer, createReactivation, reactivationUrl, offerEffectivePrice } from "@/lib/reactivation";
import { priceMoved } from "@/lib/membershipAssignQuoteServer";
import { chargeTiming } from "@/lib/billingAdmin";
import { checkAssignAnchor } from "@/lib/chargeDate";

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
  const denied = await requirePermissionLive(session, "billing", "view");
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
  // From the Assign sheet: price the offer with the family's automatic
  // discount (sibling / group rate) unless staff turned it off. The price is
  // rebuilt here; expectedFinalPrice = what the sheet showed.
  assign: z.object({
    applyFamily: z.boolean(),
    expectedFinalPrice: z.number().nonnegative().optional().nullable(),
  }).optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof postSchema>;
  try {
    data = postSchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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
  // From the Assign sheet: a future first charge can't precede "Starts". A
  // past/today date still means "charged when they accept" (acknowledged below).
  if (data.assign && firstCharge && firstCharge.getTime() > Date.now()) {
    const chk = checkAssignAnchor({ anchor: firstCharge, start: member.membershipStartDate ?? null, now: new Date() });
    if (!chk.ok) return NextResponse.json({ error: chk.error.replace(" Nothing was charged.", " Nothing was sent."), code: "CHARGE_DATE_INVALID" }, { status: 400 });
  }

  const { offer, pricing, discountError } = await buildOffer(member, member.club, firstCharge, { autoDiscount: data.assign?.applyFamily === true });

  // A stored discount that is now removed/expired/ineligible BLOCKS the offer
  // (never silently dropped — the client would see a different price than the
  // owner intended).
  if (discountError) {
    return NextResponse.json(
      { error: `The selected discount can't be applied: ${discountError} Fix or clear the discount in the billing center.`, code: "DISCOUNT_INVALID" },
      { status: 400 },
    );
  }

  if (data.assign && priceMoved(data.assign.expectedFinalPrice, offerEffectivePrice(offer))) {
    return NextResponse.json(
      { error: `The price changed to $${offerEffectivePrice(offer).toFixed(2)} since the sheet opened (the family's memberships moved). Nothing was sent — review it and confirm again.`, code: "PRICE_CHANGED", price: offerEffectivePrice(offer) },
      { status: 409 },
    );
  }

  // NO membership configured ⇒ no offer, period. A member with nothing set up
  // must never receive a $0 "FREE" offer (that is how phantom "Continued
  // membership" placeholders were born). Assign a real plan — or an explicit
  // $0 override for a deliberately-free member — first.
  if (!pricing.configured) {
    return NextResponse.json(
      {
        error:
          "No membership is configured for this member. Assign a membership plan (or an explicit $0 price for a deliberately free membership) in the billing center before creating an offer. Nothing was created.",
        code: "PLAN_REQUIRED",
      },
      { status: 400 },
    );
  }

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
