import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { newActivationToken } from "@/lib/migration";
import { resolveOfferPricing, type ResolvedPricing } from "@/lib/billingAdmin";

// Membership reactivation offers — server helpers shared by the owner-side
// composer (create/preview/send) and the public token page (view/confirm).
// The offer snapshot is built HERE from server data only; nothing about
// price/dates ever comes from a client payload.

export const REACTIVATION_TTL_DAYS = 14;

export type ReactivationOffer = {
  membershipId: string | null;
  planName: string;
  optionLabel: string | null;
  price: number;
  billingPeriod: string;
  startDate: string | null; // ISO
  firstChargeDate: string | null; // ISO; null only for FREE/OFFLINE offers
  commitmentEndDate: string | null; // ISO
  paymentMode: "CARD" | "OFFLINE" | "FREE";
  payerUserId: string | null;
};

export type OfferMember = {
  id: string;
  clubId: string;
  membershipStartDate: Date | null;
  commitmentEndDate: Date | null;
  requestedCancellationDate: Date | null;
  requestedPaymentMethod: string | null;
  migrationMembershipId: string | null;
  legacyMembershipName: string | null;
  legacyMembershipPrice: Prisma.Decimal | number | null;
  legacyBillingFrequency: string | null;
  migrationSelectedOption: unknown;
  migrationPriceOverride: Prisma.Decimal | number | null;
  responsiblePayerUserId: string | null;
};

/**
 * Build the server-side offer snapshot for a member. `firstChargeDate` is the
 * owner-approved date (already validated by the caller). Pricing follows the
 * same precedence as migration approval.
 */
export async function buildOffer(
  member: OfferMember,
  club: { stripeAccountId: string | null; stripeChargesEnabled: boolean },
  firstChargeDate: Date | null,
): Promise<{ offer: ReactivationOffer; pricing: ResolvedPricing }> {
  const plan = member.migrationMembershipId
    ? await prisma.membership.findFirst({
        where: { id: member.migrationMembershipId, clubId: member.clubId, deletedAt: null },
        select: { id: true, name: true, options: true },
      })
    : null;

  const pricing = resolveOfferPricing(
    {
      legacyMembershipName: member.legacyMembershipName,
      legacyMembershipPrice: member.legacyMembershipPrice as number | string | null,
      legacyBillingFrequency: member.legacyBillingFrequency,
      migrationSelectedOption: member.migrationSelectedOption,
      migrationPriceOverride: member.migrationPriceOverride as number | string | null,
    },
    plan ? { name: plan.name, options: plan.options } : null,
  );

  const offline =
    !club.stripeAccountId ||
    !club.stripeChargesEnabled ||
    member.requestedPaymentMethod === "CASH" ||
    member.requestedPaymentMethod === "CHECK";
  const paymentMode: ReactivationOffer["paymentMode"] =
    pricing.price <= 0 ? "FREE" : offline ? "OFFLINE" : "CARD";

  const commitment = member.requestedCancellationDate ?? member.commitmentEndDate ?? null;

  return {
    pricing,
    offer: {
      membershipId: plan?.id ?? null,
      planName: pricing.planName,
      optionLabel: pricing.optionLabel,
      price: pricing.price,
      billingPeriod: pricing.period,
      startDate: (member.membershipStartDate ?? new Date()).toISOString(),
      firstChargeDate: paymentMode === "CARD" ? firstChargeDate?.toISOString() ?? null : null,
      commitmentEndDate: commitment ? commitment.toISOString() : null,
      paymentMode,
      payerUserId: member.responsiblePayerUserId ?? null,
    },
  };
}

/**
 * Create a new reactivation offer for a member, superseding any open one
 * (DRAFT/SENT). History is never deleted — superseded rows keep their token
 * (now unusable via the status check) and their send/consent trail.
 */
export async function createReactivation(args: {
  clubId: string;
  memberId: string;
  offer: ReactivationOffer;
  personalNote: string | null;
  createdById: string | null;
}) {
  const open = await prisma.membershipReactivation.findMany({
    where: { clubId: args.clubId, memberId: args.memberId, status: { in: ["DRAFT", "SENT"] } },
    select: { id: true, offerVersion: true },
  });
  if (open.length) {
    await prisma.membershipReactivation.updateMany({
      where: { id: { in: open.map((o) => o.id) } },
      data: { status: "SUPERSEDED" },
    });
  }
  const latest = await prisma.membershipReactivation.findFirst({
    where: { clubId: args.clubId, memberId: args.memberId },
    orderBy: { offerVersion: "desc" },
    select: { offerVersion: true },
  });

  return prisma.membershipReactivation.create({
    data: {
      clubId: args.clubId,
      memberId: args.memberId,
      token: newActivationToken(),
      tokenExpires: new Date(Date.now() + REACTIVATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      offerVersion: (latest?.offerVersion ?? 0) + 1,
      offer: args.offer as unknown as Prisma.InputJsonValue,
      personalNote: args.personalNote,
      status: "DRAFT",
      createdById: args.createdById,
    },
  });
}

/** Parse an offer JSON back into a typed shape (defensive against bad rows). */
export function parseOffer(raw: unknown): ReactivationOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.planName !== "string" || typeof o.price !== "number") return null;
  return {
    membershipId: typeof o.membershipId === "string" ? o.membershipId : null,
    planName: o.planName,
    optionLabel: typeof o.optionLabel === "string" ? o.optionLabel : null,
    price: o.price,
    billingPeriod: typeof o.billingPeriod === "string" ? o.billingPeriod : "MONTHLY",
    startDate: typeof o.startDate === "string" ? o.startDate : null,
    firstChargeDate: typeof o.firstChargeDate === "string" ? o.firstChargeDate : null,
    commitmentEndDate: typeof o.commitmentEndDate === "string" ? o.commitmentEndDate : null,
    paymentMode: o.paymentMode === "OFFLINE" || o.paymentMode === "FREE" ? o.paymentMode : "CARD",
    payerUserId: typeof o.payerUserId === "string" ? o.payerUserId : null,
  };
}

/** Reactivation link for a token. */
export function reactivationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/reactivate/${token}`;
}

const longDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

/**
 * Assemble the email params for a reactivation row — shared by the send route
 * and the owner preview so what the owner previews is EXACTLY what goes out.
 */
export function buildReactivationEmailParams(args: {
  to: string;
  reactivation: { token: string; tokenExpires: Date; personalNote: string | null; offer: unknown };
  athleteName: string;
  club: {
    name: string;
    logoUrl?: string | null;
    primaryColor?: string | null;
    contactEmail?: string | null;
    emailFromName?: string | null;
    emailReplyTo?: string | null;
  };
  clubLogoPublicUrl: string | null;
  cardSummary: string | null;
  payerName: string | null;
  baseUrl: string;
}): import("@/lib/email").ReactivationEmailParams | null {
  const offer = parseOffer(args.reactivation.offer);
  if (!offer) return null;
  const firstCharge = offer.firstChargeDate ? new Date(offer.firstChargeDate) : null;
  const immediate = !!firstCharge && firstCharge.getTime() <= Date.now() + 60_000;
  const isFree = offer.paymentMode === "FREE" || offer.price <= 0;
  return {
    to: args.to,
    athleteName: args.athleteName,
    clubName: args.club.name,
    clubLogoUrl: args.clubLogoPublicUrl,
    clubPrimaryColor: args.club.primaryColor ?? null,
    membershipName: offer.planName,
    optionLabel: offer.optionLabel,
    priceLabel: isFree ? "Free" : `$${offer.price.toFixed(2)}`,
    periodLabel: prettyPeriodLabel(offer.billingPeriod),
    startDateLabel: longDate(offer.startDate),
    firstChargeLabel: isFree ? null : longDate(offer.firstChargeDate),
    immediateCharge: immediate,
    commitmentLabel: longDate(offer.commitmentEndDate),
    cardSummary: args.cardSummary,
    payerName: args.payerName,
    personalNote: args.reactivation.personalNote,
    reactivationUrl: reactivationUrl(args.baseUrl, args.reactivation.token),
    expiresLabel:
      longDate(args.reactivation.tokenExpires.toISOString()) ?? "in 14 days",
    supportEmail: args.club.contactEmail ?? null,
    fromName: args.club.emailFromName || args.club.name,
    replyTo: args.club.emailReplyTo || args.club.contactEmail || null,
  };
}

/**
 * Load everything the reactivation email needs for a member's latest open
 * offer (DRAFT/SENT): the row, the recipient, club branding, card summary,
 * payer name. Used by BOTH the send route and the owner preview so they can
 * never drift apart. Returns an error string on any precondition failure.
 */
export async function loadReactivationEmailContext(memberId: string, clubId: string) {
  const { resolveCardSnapshot, prettyBrand } = await import("@/lib/memberCard");
  const { publicClubLogoUrl } = await import("@/lib/clubLogo");
  const { getAppBaseUrl } = await import("@/lib/baseUrl");

  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, isMinor: true, email: true, guardianEmail: true,
      stripeSetupCustomerId: true, stripeCustomerId: true, responsiblePayerUserId: true,
      club: {
        select: {
          id: true, name: true, logoUrl: true, primaryColor: true, contactEmail: true,
          emailFromName: true, emailReplyTo: true, stripeAccountId: true,
        },
      },
    },
  });
  if (!member) return { error: "Member not found" as const };

  const reactivation = await prisma.membershipReactivation.findFirst({
    where: { memberId, clubId, status: { in: ["DRAFT", "SENT"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!reactivation) return { error: "No open reactivation offer — create one first." as const };
  if (reactivation.tokenExpires < new Date()) {
    return { error: "The offer's link has expired — regenerate it first." as const };
  }

  const to = member.isMinor ? member.guardianEmail || member.email : member.email || member.guardianEmail;
  if (!to) return { error: "This member has no email (or guardian email) on file." as const };

  const card = await resolveCardSnapshot(
    member.stripeSetupCustomerId ?? member.stripeCustomerId,
    member.club.stripeAccountId,
  );
  const cardSummary = card
    ? `${prettyBrand(card.brand)} ···· ${card.last4}${card.cardholder ? ` (${card.cardholder})` : ""}`
    : null;

  let payerName: string | null = null;
  if (member.responsiblePayerUserId) {
    const u = await prisma.user.findUnique({
      where: { id: member.responsiblePayerUserId },
      select: { firstName: true, lastName: true },
    });
    if (u) payerName = `${u.firstName} ${u.lastName}`.trim();
  }

  const params = buildReactivationEmailParams({
    to,
    reactivation,
    athleteName: `${member.firstName} ${member.lastName}`.trim(),
    club: member.club,
    clubLogoPublicUrl: publicClubLogoUrl(member.club.id, member.club.logoUrl),
    cardSummary,
    payerName,
    baseUrl: getAppBaseUrl(),
  });
  if (!params) return { error: "The offer snapshot is unreadable — regenerate the offer." as const };

  return { member, reactivation, params };
}

function prettyPeriodLabel(period: string): string {
  switch ((period || "").toUpperCase()) {
    case "WEEKLY": return "weekly";
    case "BIWEEKLY": return "every 2 weeks";
    case "MONTHLY": return "monthly";
    case "QUARTERLY": return "quarterly";
    case "SEMI_ANNUAL": return "every 6 months";
    case "ANNUAL": return "yearly";
    default: return (period || "recurring").toLowerCase();
  }
}
