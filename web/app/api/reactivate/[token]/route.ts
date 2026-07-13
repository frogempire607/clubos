import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseOffer, compareOfferToCurrent } from "@/lib/reactivation";
import { chargeTiming, prettyPeriod } from "@/lib/billingAdmin";
import { resolveCardSnapshot, prettyBrand } from "@/lib/memberCard";
import { publicClubLogoUrl } from "@/lib/clubLogo";

export const dynamic = "force-dynamic";

// GET /api/reactivate/[token] — the public, token-gated offer payload for the
// reactivation confirmation page. NO AUTH (the token IS the authorization,
// same model as /activate). Returns only what the page needs — no Stripe ids,
// no full card numbers, nothing about other members.
export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token || token.length < 20) {
    return NextResponse.json({ error: "Invalid link" }, { status: 400 });
  }

  const r = await prisma.membershipReactivation.findUnique({
    where: { token },
    include: {
      member: {
        select: {
          id: true, clubId: true, firstName: true, lastName: true, isMinor: true,
          email: true, guardianEmail: true, guardianName: true,
          stripeSetupCustomerId: true, stripeCustomerId: true, stripeSetupPaymentMethodId: true,
          responsiblePayerUserId: true,
          // Staleness comparison inputs — the CURRENT setup is rebuilt and
          // diffed against the offer snapshot on every view.
          membershipStartDate: true, commitmentEndDate: true, requestedCancellationDate: true,
          requestedPaymentMethod: true, migrationMembershipId: true,
          legacyMembershipName: true, legacyMembershipPrice: true, legacyBillingFrequency: true,
          migrationSelectedOption: true, migrationPriceOverride: true,
          migrationFinalBillingDate: true, billingAnchorDate: true,
        },
      },
      club: {
        select: {
          id: true, name: true, logoUrl: true, primaryColor: true, contactEmail: true,
          stripeAccountId: true, stripeChargesEnabled: true,
        },
      },
    },
  });
  if (!r) return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });

  if (r.status === "CONFIRMED") {
    return NextResponse.json({
      confirmed: true,
      club: { name: r.club.name, logoUrl: publicClubLogoUrl(r.club.id, r.club.logoUrl), primaryColor: r.club.primaryColor },
      athleteName: `${r.member.firstName} ${r.member.lastName}`.trim(),
      confirmedAt: r.confirmedAt,
    });
  }
  if (r.status === "CANCELED" || r.status === "SUPERSEDED") {
    return NextResponse.json(
      { error: "This offer was replaced or withdrawn. Ask the club for a fresh link.", code: "OFFER_CLOSED" },
      { status: 410 },
    );
  }
  if (r.tokenExpires < new Date()) {
    return NextResponse.json(
      { error: "This link has expired. Ask the club to resend it.", code: "EXPIRED" },
      { status: 410 },
    );
  }

  const offer = parseOffer(r.offer);
  if (!offer) {
    return NextResponse.json({ error: "This offer can't be loaded. Contact the club." }, { status: 500 });
  }

  // The offer is an immutable snapshot. If the club's current billing setup
  // no longer matches it, this link must not be confirmable — the club
  // regenerates and resends a fresh version instead.
  try {
    const cmp = await compareOfferToCurrent(r.member, r.club, offer);
    if (!cmp.matches) {
      return NextResponse.json(
        {
          error:
            "This offer has been updated by the club since it was sent, so this link can no longer be confirmed. Ask the club to resend the latest version.",
          code: "OFFER_OUT_OF_DATE",
        },
        { status: 409 },
      );
    }
  } catch (e) {
    console.error("reactivate GET: staleness check failed", e);
    // Fail closed on comparison errors — never show possibly-wrong terms.
    return NextResponse.json(
      { error: "This offer can't be verified right now. Try again in a minute.", code: "OFFER_UNVERIFIED" },
      { status: 503 },
    );
  }

  // First view stamp (best-effort).
  if (!r.viewedAt) {
    prisma.membershipReactivation
      .update({ where: { id: r.id }, data: { viewedAt: new Date() } })
      .catch(() => {});
  }

  // Saved payment method summary (read-only; degrades to null).
  const card = await resolveCardSnapshot(
    r.member.stripeSetupCustomerId ?? r.member.stripeCustomerId,
    r.club.stripeAccountId,
  );

  let payerName: string | null = null;
  if (offer.payerUserId) {
    const u = await prisma.user.findUnique({
      where: { id: offer.payerUserId },
      select: { firstName: true, lastName: true },
    });
    if (u) payerName = `${u.firstName} ${u.lastName}`.trim();
  }
  if (!payerName && r.member.isMinor) payerName = r.member.guardianName;

  const firstCharge = offer.firstChargeDate ? new Date(offer.firstChargeDate) : null;
  const timing = chargeTiming(firstCharge);
  const isFree = offer.paymentMode === "FREE" || offer.price <= 0;

  return NextResponse.json({
    club: {
      name: r.club.name,
      logoUrl: publicClubLogoUrl(r.club.id, r.club.logoUrl),
      primaryColor: r.club.primaryColor,
      contactEmail: r.club.contactEmail,
    },
    athlete: {
      firstName: r.member.firstName,
      lastName: r.member.lastName,
      isMinor: r.member.isMinor,
    },
    offer: {
      planName: offer.planName,
      optionLabel: offer.optionLabel,
      price: offer.price,
      billingPeriod: offer.billingPeriod,
      periodLabel: prettyPeriod(offer.billingPeriod),
      startDate: offer.startDate,
      firstChargeDate: offer.firstChargeDate,
      commitmentEndDate: offer.commitmentEndDate,
      paymentMode: offer.paymentMode,
      offerVersion: r.offerVersion,
    },
    chargeTiming: {
      // Recomputed at read time: a future-dated offer that the client only
      // opens after the date passed becomes an immediate charge, and the page
      // must say so before they confirm.
      immediate: !isFree && offer.paymentMode === "CARD" && timing.immediate,
      isFree,
    },
    card: card
      ? { brand: prettyBrand(card.brand), last4: card.last4, cardholder: card.cardholder }
      : null,
    hasUsableCard: !!r.member.stripeSetupPaymentMethodId,
    payerName,
    personalNote: r.personalNote,
    tokenExpires: r.tokenExpires,
    terms: {
      authorization: isFree
        ? `By confirming you accept ${r.club.name}'s membership terms.`
        : `By confirming you authorize ${r.club.name} to charge the payment method on file $${offer.price.toFixed(2)} ${prettyPeriod(offer.billingPeriod)}${offer.firstChargeDate ? `, starting ${new Date(offer.firstChargeDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}` : ""}, until the membership ends or is canceled per the club's policy.`,
    },
  });
}
