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
import { recurringUnitWithFee } from "@/lib/fees";
import { liveStripeFacts, type LiveFacts } from "@/lib/membershipMoneyServer";
import {
  commitmentView, howTheyPay, nextPayment, autoRenewPlan, renewsNow, paymentMethodLabel, refundable, moneyEventSentence,
  stripeEndsAt, periodWord, fmtDate, type MoneyRow,
} from "@/lib/membershipMoney";

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
    sib && (sib.anyOn || sib.family.some((l) => l.drift))
      ? {
          summary: siblingOn(sib.cfg) ? membershipSiblingSummary(sib.cfg) : "",
          // B3 slice 3 — the club's group rates and this athlete's answers.
          groups: sib.rates.filter((r) => r.on).map((r) => ({ id: r.id, label: r.label, options: r.options, value: sib.groupValues[r.id] ?? "" })),
          family: sib.family
            .filter((l) => l.position != null)
            .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
            .map((l) => ({ memberId: l.memberId, name: l.memberName, position: l.position, price: l.price, expected: l.expected })),
          current: curLine && curRow
            ? { subId: curLine.subId, optionId: curRow.optionId, drift: curLine.drift, label: curLine.label, source: curLine.source, price: curLine.price, expected: curLine.expected }
            : null,
        }
      : null;

  // ── B16 — the money summary, payments and money history for the current row ──
  const money = current && curRow && (view.state === "ACTIVE_STRIPE" || view.state === "ACTIVE_OFFLINE" || view.state === "PAST_DUE" || view.state === "PAUSED")
    ? await buildMoney(clubId, member, curRow, current, plans)
    : null;

  return NextResponse.json({
    money,
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

// ── B16 money payload ────────────────────────────────────────────────────────

type SubRow = { id: string; stripeSubscriptionId: string | null; membershipId: string; optionId: string | null; optionLabel: string; price: unknown; stripeSnapshot: unknown };
type PlanRow = { id: string; name: string; options: unknown; contractMonths: number | null; autoRenewDefault: boolean };

const MEMBERSHIP_TX_TYPES = ["MEMBERSHIP", "SUBSCRIPTION"];
const SOURCE_WORD: Record<string, string> = { STRIPE: "Stripe", CASH: "Cash", CHECK: "Check", COMP: "Waived / comp", EXTERNAL_READER: "Card reader", MANUAL_ADJUSTMENT: "Manual" };
const MONEY_KINDS = ["PAYMENT_RECORDED", "PAYMENT_WAIVED", "PAYMENT_REFUNDED", "RENEWAL_CHANGED", "PLAN_CHANGED", "CHARGE_DATE_MOVED"];

function renewsText(m: MoneyRow, renews: boolean): string {
  if (renews) return `On — renews ${periodWord(m.billingPeriod)} until someone cancels`;
  const ends = m.hasStripe ? stripeEndsAt(m) : m.endDate;
  return ends ? `Off — ends ${fmtDate(ends)}, no renewal` : "Off — ends at the end of the paid period";
}

async function buildMoney(
  clubId: string,
  member: { id: string; requestedPaymentMethod: string | null; club: { passProcessingFees: boolean; stripeAccountId: string | null } },
  row: SubRow,
  cur: PanelSub,
  plans: PlanRow[],
) {
  const now = new Date();
  const live: LiveFacts | null = row.stripeSubscriptionId && member.club.stripeAccountId
    ? await liveStripeFacts(row.stripeSubscriptionId, member.club.stripeAccountId, 3000)
    : null;
  const m: MoneyRow = {
    hasStripe: cur.hasStripe, status: cur.status, stripeStatus: live?.status ?? cur.stripeStatus, price: cur.price, billingPeriod: cur.billingPeriod,
    startDate: cur.startDate, endDate: cur.endDate, currentPeriodEnd: live?.currentPeriodEnd ?? cur.currentPeriodEnd, paidThroughDate: cur.paidThroughDate,
    minimumTermEndsAt: cur.minimumTermEndsAt, autoRenew: cur.autoRenew, cancelAt: live ? live.cancelAt : cur.cancelAt,
    pausedAt: cur.pausedAt, pausedUntil: cur.pausedUntil, deliberateFree: cur.deliberateFree,
  };
  // What the option promises, for "Commitment not recorded".
  const plan = plans.find((p) => p.id === row.membershipId) ?? null;
  const option = plan && row.optionId ? parseOptions(plan.options).find((o) => o.id === row.optionId) ?? null : null;
  const optionContractMonths = plan && option ? resolveTerms(option, { contractMonths: plan.contractMonths, autoRenewDefault: plan.autoRenewDefault }).contractMonths : null;

  const snapPm = (row.stripeSnapshot ?? null) as { defaultPaymentMethod?: { brand?: string; last4?: string; type?: string; label?: string } | null } | null;
  const pmLabel = paymentMethodLabel(live?.pm) ?? paymentMethodLabel(snapPm?.defaultPaymentMethod ? { type: snapPm.defaultPaymentMethod.type ?? null, brand: snapPm.defaultPaymentMethod.brand, last4: snapPm.defaultPaymentMethod.last4, label: snapPm.defaultPaymentMethod.label } : null);
  const offlineMethod = member.requestedPaymentMethod === "CHECK" ? "CHECK" : member.requestedPaymentMethod === "CASH" ? "CASH" : null;
  const charge = member.club.passProcessingFees && cur.hasStripe ? recurringUnitWithFee(Math.round(cur.price * 100), true) / 100 : cur.price;

  const txs = await prisma.transaction.findMany({
    where: { clubId, OR: [{ memberId: member.id }, { athleteMemberId: member.id }], type: { in: MEMBERSHIP_TX_TYPES }, status: { in: ["SUCCEEDED", "REFUNDED", "FAILED", "PENDING"] }, NOT: { reconciliationStatus: "VOID" } },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, amount: true, refundedAmount: true, status: true, paymentSource: true, paymentMethod: true, description: true, txDate: true, createdAt: true, refundedAt: true, refundReason: true, coversStart: true, coversEnd: true, stripeChargeId: true, stripePaymentIntentId: true, manual: true },
  });
  const when = (t: { txDate: Date | null; createdAt: Date }) => t.txDate ?? t.createdAt;
  // Payments inside the commitment window: money received (or a period waived)
  // for this membership's term. Counted from the ledger, capped by the view.
  const termStart = cur.startDate, termEnd = cur.minimumTermEndsAt;
  const paymentsInTerm = termStart && termEnd
    ? txs.filter((t) => (t.status === "SUCCEEDED" || t.status === "REFUNDED") && (Number(t.amount) > 0 || t.paymentSource === "COMP") && when(t).getTime() >= termStart.getTime() - 86_400_000 && when(t).getTime() < termEnd.getTime()).length
    : null;

  const commitment = commitmentView(m, { optionContractMonths, paymentsInTerm, now });
  const next = nextPayment(m, { chargeAmount: charge, skippedAt: live?.skipAt ?? null, now });
  const renews = renewsNow(m);
  const toggle = autoRenewPlan(m, !renews, now);

  const events = await prisma.memberSubscriptionEvent.findMany({
    where: { clubId, memberId: member.id, memberSubscriptionId: row.id, kind: { in: MONEY_KINDS } },
    orderBy: { at: "desc" }, take: 12,
    select: { id: true, kind: true, at: true, detail: true, actorUserId: true },
  });
  const actorIds = Array.from(new Set(events.map((e) => e.actorUserId).filter((x): x is string => !!x)));
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const nameOf = new Map(actors.map((a) => [a.id, `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim() || null]));
  const history = events
    .map((e) => ({ id: e.id, at: e.at, text: moneyEventSentence({ kind: e.kind, at: e.at, detail: (e.detail ?? null) as Record<string, unknown> | null, actorName: e.actorUserId ? nameOf.get(e.actorUserId) ?? null : null }) }))
    .filter((e): e is { id: string; at: Date; text: string } => !!e.text);

  return {
    subscriptionId: row.id,
    hasStripe: cur.hasStripe,
    liveRead: cur.hasStripe ? !!live : null,
    pmLabel,
    howTheyPay: howTheyPay(m, { pmLabel, offlineMethod }),
    next,
    paidThrough: cur.hasStripe ? (cur.paidThroughDate && cur.paidThroughDate > (m.currentPeriodEnd ?? new Date(0)) ? cur.paidThroughDate : m.currentPeriodEnd) : cur.paidThroughDate,
    commitment,
    skippedChargeAt: live?.skipAt ?? null,
    autoRenew: { on: renews, nowText: renewsText(m, renews), toggle: toggle.ok ? { endsAt: toggle.endsAt, sentence: toggle.sentence } : { endsAt: null, sentence: toggle.error, blocked: true } },
    payments: txs.slice(0, 6).map((t) => {
      const src = (t.paymentSource ?? (t.manual ? t.paymentMethod : "STRIPE") ?? "").toUpperCase();
      const left = refundable({ amount: Number(t.amount), refundedAmount: t.refundedAmount != null ? Number(t.refundedAmount) : null, status: t.status });
      const refunded = t.refundedAmount != null ? Number(t.refundedAmount) : 0;
      return {
        id: t.id, at: when(t), amount: Number(t.amount), method: SOURCE_WORD[src] ?? (src ? src.charAt(0) + src.slice(1).toLowerCase() : "—"),
        status: t.status === "REFUNDED" ? "Refunded" : refunded > 0 ? `Refunded $${refunded.toFixed(2)}` : t.status === "FAILED" ? "Failed" : t.status === "PENDING" ? "Awaiting payment" : Number(t.amount) === 0 ? "No charge" : "Paid",
        tone: t.status === "FAILED" ? "bad" : t.status === "REFUNDED" || refunded > 0 ? "warn" : t.status === "PENDING" ? "pend" : "ok",
        description: t.description, covers: t.coversStart && t.coversEnd ? { start: t.coversStart, end: t.coversEnd } : null,
        refundable: left, refundReason: t.refundReason,
      };
    }),
    history,
  };
}
