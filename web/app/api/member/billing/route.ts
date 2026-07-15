import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCardSnapshot, type CardSnapshot } from "@/lib/memberCard";
import { feeBreakdown } from "@/lib/fees";

// GET /api/member/billing
//
// Per-person billing summary for the member portal Payment & billing card:
// the account holder (self) PLUS every managed child, each with plan, status,
// price/frequency, next billing date, and the saved card (brand · last4 ·
// cardholder). This is what makes billing visible for guardians who manage
// several children on mobile — the old profile card only rendered the logged-in
// user's own subscription, so children showed a bare "Card on file".
//
// Card lookups hit the club's connected Stripe account, so this lives on its
// OWN endpoint (the profile page fetches it once) instead of the hot
// /api/member/portal payload that every page loads. All Stripe reads are
// read-only and degrade to null — nothing is ever charged here.

export const dynamic = "force-dynamic";

// Prisma.validator gives us a reusable select that is fully type-inferred
// (Prisma infers the exact result shape) WITHOUT `as const` — an `as const`
// select makes the `status.in` array a readonly tuple, which Prisma's generated
// types reject (they require a mutable string[]).
const memberSelect = Prisma.validator<Prisma.MemberSelect>()({
  id: true,
  firstName: true,
  lastName: true,
  isMinor: true,
  status: true,
  stripeCustomerId: true,
  stripeSetupCustomerId: true,
  subscriptions: {
    where: { status: { in: ["active", "past_due", "pending"] } },
    select: {
      id: true,
      status: true,
      price: true,
      billingPeriod: true,
      billingType: true,
      billingAnchorDate: true,
      endDate: true,
      // Reconciled-from-Stripe facts (lib/stripeSync.ts). currentPeriodEnd is
      // Stripe's real next-billing date; stripeStatus is the raw sub status;
      // stripeSnapshot carries the last invoice + card brand/last4.
      currentPeriodEnd: true,
      stripeStatus: true,
      stripeSnapshot: true,
      // Membership has no scalar billingPeriod/price (they live in an options
      // JSON); the period comes from the subscription snapshot below.
      membership: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  },
});
type MemberPayload = Prisma.MemberGetPayload<{ select: typeof memberSelect }>;
type SubPayload = MemberPayload["subscriptions"][number];

// Selected the same way the profile card used to: a live plan wins, else a
// purchase-in-progress (pending, e.g. a migrated member awaiting first charge).
function pickActive(subs: SubPayload[]): SubPayload | null {
  return (
    subs.find((s) => s.status === "active") ||
    subs.find((s) => s.status === "pending") ||
    subs.find((s) => s.status === "past_due") ||
    subs[0] ||
    null
  );
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending: "Pending — not charged yet",
  past_due: "Past due",
  canceled: "Canceled",
  expired: "Expired",
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clubId = session.user.clubId;

  const [user, club] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        memberProfile: { select: memberSelect },
        guardianOf: { select: { member: { select: memberSelect } } },
      },
    }),
    prisma.club.findUnique({
      where: { id: clubId },
      select: { stripeAccountId: true, memberBillingVisibility: true, passProcessingFees: true },
    }),
  ]);

  const stripeAccountId = club?.stripeAccountId ?? null;

  const persons: { m: MemberPayload; isSelf: boolean }[] = [
    ...(user?.memberProfile ? [{ m: user.memberProfile, isSelf: true }] : []),
    ...(user?.guardianOf ?? []).map((g) => ({ m: g.member, isSelf: false })),
  ];

  const people = await Promise.all(
    persons.map(async ({ m, isSelf }) => {
      const active = pickActive(m.subscriptions);
      const customerId = m.stripeSetupCustomerId || m.stripeCustomerId || null;
      let card: CardSnapshot | null = null;
      if (customerId && stripeAccountId) {
        card = await resolveCardSnapshot(customerId, stripeAccountId);
      }
      const rawPrice = active && active.price != null ? Number(active.price) : null;
      const price = rawPrice != null && Number.isFinite(rawPrice) ? rawPrice : null;
      // The club passes the Stripe processing fee → a RECURRING Stripe sub is
      // actually charged base + fee. Display only; math lives in lib/fees.ts.
      const fees =
        club?.passProcessingFees && active?.billingType === "RECURRING" && price != null && price > 0
          ? feeBreakdown(price, true)
          : null;
      const snap = (active?.stripeSnapshot as Record<string, unknown> | null) ?? null;
      const lastInvoice = snap && typeof snap.latestInvoice === "object" ? (snap.latestInvoice as {
        amountPaid?: number | null;
        paidAt?: string | null;
      }) : null;
      const lastPayment =
        lastInvoice && lastInvoice.paidAt
          ? { amount: (lastInvoice.amountPaid ?? 0) / 100, paidAt: lastInvoice.paidAt }
          : null;
      return {
        memberId: m.id,
        name: isSelf ? "You" : `${m.firstName} ${m.lastName}`.trim(),
        fullName: `${m.firstName} ${m.lastName}`.trim(),
        isSelf,
        isMinor: !!m.isMinor,
        memberStatus: m.status,
        plan: active?.membership?.name ?? null,
        status: active?.status ?? null,
        statusLabel: active ? STATUS_LABEL[active.status] ?? active.status : null,
        // Raw Stripe status, present once reconciled — lets the UI show the true
        // Stripe state (e.g. "trialing") alongside our normalized status.
        stripeStatus: active?.stripeStatus ?? null,
        price,
        // Present only when a processing fee applies: what's actually charged.
        feeBreakdown: fees ? { base: fees.base, fee: fees.fee, total: fees.total } : null,
        period: active?.billingPeriod ?? null,
        // Prefer Stripe's real next-billing date once reconciled.
        nextBilling: active?.currentPeriodEnd ?? active?.billingAnchorDate ?? active?.endDate ?? null,
        lastPayment,
        subscriptionId: active?.id ?? null,
        hasCard: !!customerId,
        card,
      };
    }),
  );

  return NextResponse.json({
    people,
    visibility: (club?.memberBillingVisibility as Record<string, boolean> | null) ?? null,
  });
}
