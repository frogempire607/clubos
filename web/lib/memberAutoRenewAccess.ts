// Who may turn auto-renew on or off for a membership from the member portal.
//
// Julian (2026-09-28): a parent should be able to choose, from their own
// profile, whether ANY of their family's memberships auto-renews — Stripe or
// cash. "Their family" means exactly the people they can PAY for:
//
//   · themselves, when they are an adult member with their own login
//     (a minor's own login never decides money — their guardian does), and
//   · every athlete they hold a CONFIRMED guardian link to with canPay on
//     (lib/familyAccess ACTIVE_GUARDIAN_LINK + the Phase 4C permission grid).
//
// The old check accepted any guardian link row at all — PENDING, REVOKED, or
// one the primary guardian had set to "can't pay". Those people can no longer
// reach this toggle.

import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import { feeBreakdown } from "@/lib/fees";
import { autoRenewCopy, howYouPayLine, paymentMethodLabel, type AutoRenewCopy } from "@/lib/autoRenewCopy";
import type { CardSnapshot } from "@/lib/memberCard";

export type PayablePerson = { memberId: string; firstName: string; lastName: string; isSelf: boolean };

export async function payablePeopleFor(userId: string, clubId: string): Promise<PayablePerson[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      memberProfile: { select: { id: true, clubId: true, firstName: true, lastName: true, isMinor: true, deletedAt: true } },
      guardianOf: {
        where: { ...ACTIVE_GUARDIAN_LINK, canPay: true, member: { deletedAt: null, clubId } },
        select: { member: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });
  if (!user) return [];
  const out: PayablePerson[] = [];
  const self = user.memberProfile;
  if (self && self.clubId === clubId && !self.deletedAt && !self.isMinor) {
    out.push({ memberId: self.id, firstName: self.firstName, lastName: self.lastName, isSelf: true });
  }
  for (const g of user.guardianOf) {
    if (out.some((p) => p.memberId === g.member.id)) continue;
    out.push({ memberId: g.member.id, firstName: g.member.firstName, lastName: g.member.lastName, isSelf: false });
  }
  return out;
}

/** The club owner's user id — where member self-service notices land. */
export async function clubOwnerUserId(clubId: string): Promise<string | null> {
  const owner = await prisma.user.findFirst({
    where: { clubId, role: "OWNER", deletedAt: null },
    select: { id: true },
  });
  return owner?.id ?? null;
}

// ── One membership, described for the portal toggle ─────────────────────────


export const AUTO_RENEW_SUB_SELECT = {
  id: true, memberId: true, status: true, autoRenew: true, optionLabel: true,
  price: true, billingPeriod: true, billingType: true, stripeSubscriptionId: true,
  startDate: true, endDate: true, minimumTermEndsAt: true, currentPeriodEnd: true, paidThroughDate: true,
  membership: { select: { name: true } },
} as const;

type SubRow = {
  id: string; memberId: string; status: string; autoRenew: boolean; optionLabel: string | null;
  price: unknown; billingPeriod: string | null; billingType: string; stripeSubscriptionId: string | null;
  startDate: Date | null; endDate: Date | null; minimumTermEndsAt: Date | null;
  currentPeriodEnd: Date | null; paidThroughDate: Date | null;
  membership: { name: string } | null;
};

/** Card lookups may carry `label` / `type` / "last paid with" (lib/memberCard). */
type CardLike = (CardSnapshot & { label?: string | null; type?: string | null; lastPaidWith?: string | { label?: string | null } | null }) | null;

const OFFLINE_METHOD_LABEL: Record<string, string> = { CASH: "Cash at the club", CHECK: "Check at the club" };

export type AutoRenewRow = {
  subscriptionId: string;
  memberId: string;
  name: string;
  isSelf: boolean;
  plan: string;
  billing: "CARD" | "OFFLINE";
  autoRenew: boolean;
  amount: number;
  howYouPay: string;
  copy: Omit<AutoRenewCopy, "stopsOn" | "nextChargeOn" | "commitmentEndsOn"> & {
    stopsOn: string | null; nextChargeOn: string | null; commitmentEndsOn: string | null;
  };
};

export function describeForPortal(input: {
  sub: SubRow;
  person: PayablePerson;
  passProcessingFees: boolean;
  card: CardLike;
  /** paymentMethod of the last SUCCEEDED membership payment (CASH, CHECK, STRIPE…). */
  lastPaidMethod: string | null;
  now: Date;
}): AutoRenewRow {
  const { sub, person, card, now } = input;
  const billing: "CARD" | "OFFLINE" = sub.billingType === "MANUAL" || !sub.stripeSubscriptionId ? "OFFLINE" : "CARD";
  const base = Number(sub.price ?? 0) || 0;
  const amount = billing === "CARD" && input.passProcessingFees && base > 0 ? feeBreakdown(base, true).total : base;
  const copy = autoRenewCopy(
    {
      billing, autoRenew: sub.autoRenew, status: sub.status,
      startDate: sub.startDate, minimumTermEndsAt: sub.minimumTermEndsAt, endDate: sub.endDate,
      currentPeriodEnd: sub.currentPeriodEnd, paidThroughDate: sub.paidThroughDate,
      amount, billingPeriod: sub.billingPeriod,
    },
    now,
  );
  const lastPaid = card?.lastPaidWith
    ? typeof card.lastPaidWith === "string" ? card.lastPaidWith : card.lastPaidWith.label ?? null
    : null;
  const methodLabel = billing === "CARD"
    ? paymentMethodLabel(card) ?? lastPaid
    : (input.lastPaidMethod && OFFLINE_METHOD_LABEL[input.lastPaidMethod]) ?? null;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    subscriptionId: sub.id,
    memberId: sub.memberId,
    name: person.isSelf ? "You" : `${person.firstName} ${person.lastName}`.trim(),
    isSelf: person.isSelf,
    plan: [sub.membership?.name, sub.optionLabel].filter(Boolean).join(" · ") || "Membership",
    billing,
    autoRenew: sub.autoRenew,
    amount,
    howYouPay: howYouPayLine({ billing, methodLabel, nextChargeOn: copy.nextChargeOn, amount, autoRenew: sub.autoRenew, stopsOn: copy.stopsOn }),
    copy: {
      ...copy,
      stopsOn: iso(copy.stopsOn),
      nextChargeOn: iso(copy.nextChargeOn),
      commitmentEndsOn: iso(copy.commitmentEndsOn),
    },
  };
}
