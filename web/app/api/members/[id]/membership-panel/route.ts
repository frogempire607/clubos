import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { derivePanel, cancelPreview, type PanelSub } from "@/lib/membershipPanel";
import { parseOptions, resolveTerms } from "@/lib/membershipOptions";
import { resolveDraftOptionId } from "@/lib/billingAdmin";
import { resumeLapsedPauses } from "@/lib/membershipPause";
import { datesEditable } from "@/lib/membershipPanel";
import { siblingLinesForMember } from "@/lib/membershipSiblingServer";
import { siblingOn, membershipSiblingSummary } from "@/lib/membershipSiblingDiscount";

// B13 — GET /api/members/[id]/membership-panel
//
// Everything the Membership panel renders, derived once, server-side, from the
// athlete's rows (lib/membershipPanel). The component never computes a
// sentence of its own. Also carries what the Assign / Cancel dialogs need so
// they open without a second round trip: the sellable options with their
// terms, the card on file, the guardian's email, and the cancel dates.

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  // A pause whose date has passed is over — Stripe already resumed; bring the row along.
  await resumeLapsedPauses(clubId, [id]);

  const member = await prisma.member.findFirst({
    where: { id, clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, status: true, isMinor: true, guardianName: true, guardianEmail: true, email: true,
      requestedPaymentMethod: true, stripeSetupPaymentMethodId: true, stripeSetupCustomerId: true, responsiblePayerUserId: true,
      migrationMembershipId: true, migrationSelectedOption: true, migrationPriceOverride: true, migrationStatus: true,
      subscriptions: {
        orderBy: { createdAt: "desc" },
        include: { membership: { select: { id: true, name: true } } },
      },
      club: { select: { passProcessingFees: true, stripeAccountId: true, stripeChargesEnabled: true } },
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [plans, reactivation, payerUser] = await Promise.all([
    prisma.membership.findMany({
      where: { clubId, deletedAt: null, active: true },
      select: { id: true, name: true, options: true, contractMonths: true, autoRenewDefault: true },
      orderBy: { name: "asc" },
    }),
    prisma.membershipReactivation.findFirst({ where: { memberId: member.id, clubId }, orderBy: { createdAt: "desc" }, select: { status: true, emailSentAt: true, tokenExpires: true } }),
    member.responsiblePayerUserId
      ? prisma.user.findUnique({ where: { id: member.responsiblePayerUserId }, select: { firstName: true, lastName: true } })
      : Promise.resolve(null),
  ]);

  const subs: PanelSub[] = member.subscriptions.map((s) => {
    const snap = (s.stripeSnapshot ?? null) as { defaultPaymentMethod?: { brand?: string; last4?: string } | null; cancelAt?: string | null } | null;
    return {
      id: s.id,
      planName: s.membership?.name ?? null,
      optionLabel: s.optionLabel,
      price: Number(s.price),
      billingPeriod: s.billingPeriod,
      billingType: s.billingType,
      status: s.status,
      stripeStatus: s.stripeStatus,
      hasStripe: !!s.stripeSubscriptionId,
      startDate: s.startDate,
      endDate: s.endDate,
      currentPeriodEnd: s.currentPeriodEnd,
      paidThroughDate: s.paidThroughDate,
      autoRenew: s.autoRenew,
      minimumTermEndsAt: s.minimumTermEndsAt,
      deliberateFree: s.deliberateFree,
      cancelAt: snap?.cancelAt ? new Date(snap.cancelAt) : null,
      card: snap?.defaultPaymentMethod ? { brand: snap.defaultPaymentMethod.brand ?? null, last4: snap.defaultPaymentMethod.last4 ?? null } : null,
      createdAt: s.createdAt,
      pausedAt: s.pausedAt,
      pausedUntil: s.pausedUntil,
    };
  });

  // The saved setup, resolved to a sellable option the way activate_card will.
  let draft: { planName: string; optionLabel: string | null; price: number | null; period: string | null; offerSentAt: Date | null; optionId: string | null; planId: string } | null = null;
  const hasLiveRow = subs.some((s) => s.status === "active" || s.status === "pending" || s.status === "past_due");
  if (!hasLiveRow && member.migrationMembershipId) {
    const plan = plans.find((p) => p.id === member.migrationMembershipId) ?? (await prisma.membership.findFirst({ where: { id: member.migrationMembershipId, clubId }, select: { id: true, name: true, options: true, contractMonths: true, autoRenewDefault: true } }));
    if (plan) {
      const options = parseOptions(plan.options);
      const optionId = resolveDraftOptionId(options, member.migrationSelectedOption);
      const option = optionId ? options.find((o) => o.id === optionId) ?? null : null;
      const override = member.migrationPriceOverride != null ? Number(member.migrationPriceOverride) : null;
      draft = {
        planId: plan.id,
        planName: plan.name,
        optionId,
        optionLabel: option?.label ?? (typeof member.migrationSelectedOption === "string" ? member.migrationSelectedOption : null),
        price: override ?? option?.price ?? null,
        period: option?.billingPeriod ?? null,
        offerSentAt: reactivation && (reactivation.status === "SENT") && reactivation.tokenExpires > new Date() ? reactivation.emailSentAt : null,
      };
    }
  }

  const latestCard = subs.find((s) => s.card?.last4)?.card ?? null;
  const hasCard = !!member.stripeSetupCustomerId && !!member.stripeSetupPaymentMethodId;
  const cardLabel = latestCard?.last4 ? `${cap(latestCard.brand ?? "Card")} ····${latestCard.last4}` : hasCard ? "Card on file" : null;
  const payerName = payerUser ? `${payerUser.firstName} ${payerUser.lastName}`.trim() : member.isMinor && member.guardianName ? member.guardianName : null;

  const view = derivePanel({
    firstName: member.firstName,
    memberStatus: member.status,
    subs,
    draft: draft ? { planName: draft.planName, optionLabel: draft.optionLabel, price: draft.price, period: draft.period, offerSentAt: draft.offerSentAt } : null,
    hasCard,
    cardLabel,
    requestedPaymentMethod: member.requestedPaymentMethod,
    payerName,
    passProcessingFees: member.club.passProcessingFees,
    now: new Date(),
  });

  const current = view.currentSubId ? subs.find((s) => s.id === view.currentSubId) ?? null : null;
  const cancel = current && (view.state === "ACTIVE_STRIPE" || view.state === "ACTIVE_OFFLINE" || view.state === "PAST_DUE" || view.state === "PAUSED")
    ? (() => { const p = cancelPreview(current, new Date()); return {
        periodEnd: p.periodEnd, atPeriodEndAvailable: p.atPeriodEndAvailable,
        periodEndAccessUntil: p.keepsAccessUntil("period_end"), nowAccessUntil: p.keepsAccessUntil("now"),
        consequencePeriodEnd: p.consequence("period_end"), consequenceNow: p.consequence("now"),
      }; })()
    : null;

  // Sellable options with their resolved terms, for Assign.
  const options = plans.flatMap((p) => parseOptions(p.options).filter((o) => o.id && o.billingPeriod !== "ONE_TIME").map((o) => {
    const t = resolveTerms(o, { contractMonths: p.contractMonths, autoRenewDefault: p.autoRenewDefault });
    return { planId: p.id, planName: p.name, id: o.id!, label: o.label, price: o.price, billingPeriod: o.billingPeriod, contractMonths: t.contractMonths, autoRenew: t.autoRenewDefault };
  }));

  // B3 slice 2 — the sibling membership discount: this athlete's family, and
  // whether the current membership's price matches the rule. Read-only; the
  // owner applies a recommendation through Change plan.
  const sib = await siblingLinesForMember(clubId, member.id).catch(() => null);
  const curLine = current && sib ? sib.lines.find((l) => l.subId === current.id) ?? null : null;
  const curRow = current ? member.subscriptions.find((s) => s.id === current.id) ?? null : null;
  const sibling =
    sib && (siblingOn(sib.cfg) || sib.family.some((l) => l.drift))
      ? {
          summary: membershipSiblingSummary(sib.cfg),
          family: sib.family
            .filter((l) => l.position != null)
            .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
            .map((l) => ({ memberId: l.memberId, name: l.memberName, position: l.position, price: l.price, expected: l.expected })),
          current: curLine && curRow
            ? { subId: curLine.subId, optionId: curRow.optionId, drift: curLine.drift, label: curLine.label, price: curLine.price, expected: curLine.expected }
            : null,
        }
      : null;

  return NextResponse.json({
    sibling,
    view,
    member: { id: member.id, firstName: member.firstName, lastName: member.lastName, isMinor: member.isMinor, guardianEmail: member.guardianEmail, email: member.email },
    club: { passProcessingFees: member.club.passProcessingFees, stripeReady: !!member.club.stripeAccountId && !!member.club.stripeChargesEnabled },
    hasCard,
    cardLabel,
    requestedPaymentMethod: member.requestedPaymentMethod,
    draft,
    options,
    cancel,
    current: current ? {
      id: current.id, hasStripe: current.hasStripe, price: current.price, optionLabel: current.optionLabel, planName: current.planName, billingPeriod: current.billingPeriod,
      deliberateFree: current.deliberateFree, startDate: current.startDate, endDate: current.endDate, paidThroughDate: current.paidThroughDate, currentPeriodEnd: current.currentPeriodEnd,
      minimumTermEndsAt: current.minimumTermEndsAt, pausedAt: current.pausedAt, pausedUntil: current.pausedUntil, editable: datesEditable(current.hasStripe),
    } : null,
    history: subs.map((s) => ({ id: s.id, label: s.planName && s.planName !== s.optionLabel ? `${s.planName} · ${s.optionLabel}` : s.optionLabel, price: s.price, billingPeriod: s.billingPeriod, status: s.status, startDate: s.startDate, endDate: s.endDate, hasStripe: s.hasStripe })),
  });
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
