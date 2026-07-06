import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCardSnapshot, type CardSnapshot } from "@/lib/memberCard";

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

// Selected the same way the profile card used to: a live plan wins, else a
// purchase-in-progress (pending, e.g. a migrated member awaiting first charge).
type SubRow = {
  id: string;
  status: string;
  price: unknown;
  billingPeriod: string | null;
  billingAnchorDate: Date | null;
  endDate: Date | null;
  membership: { name: string; billingPeriod: string | null } | null;
};
type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  isMinor: boolean;
  status: string;
  stripeCustomerId: string | null;
  stripeSetupCustomerId: string | null;
  subscriptions: SubRow[];
};

function pickActive(subs: SubRow[]): SubRow | null {
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

const memberSelect = {
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
      billingAnchorDate: true,
      endDate: true,
      membership: { select: { name: true, billingPeriod: true } },
    },
    orderBy: { createdAt: "desc" },
  },
} as const;

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
      select: { stripeAccountId: true, memberBillingVisibility: true },
    }),
  ]);

  const stripeAccountId = club?.stripeAccountId ?? null;

  const persons: { m: MemberRow; isSelf: boolean }[] = [
    ...(user?.memberProfile ? [{ m: user.memberProfile as MemberRow, isSelf: true }] : []),
    ...(user?.guardianOf ?? []).map((g) => ({ m: g.member as MemberRow, isSelf: false })),
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
        price,
        period: active?.billingPeriod ?? active?.membership?.billingPeriod ?? null,
        nextBilling: active?.billingAnchorDate ?? active?.endDate ?? null,
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
