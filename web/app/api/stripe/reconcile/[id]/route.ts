import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { recomputeMemberStatus } from "@/lib/memberStatus";

const schema = z.object({
  action: z.enum(["LINK", "IGNORE"]),
  // Required for LINK: which member this Stripe subscription belongs to.
  memberId: z.string().optional(),
  // Optional for LINK: which plan to record it under. Falls back to a shared
  // "External (Stripe)" plan when the owner doesn't specify one.
  membershipId: z.string().optional(),
});

// Map a Stripe recurring interval (+count) to our billingPeriod vocabulary.
function billingPeriodFor(interval: string | null, count: number | null | undefined): string {
  const c = count ?? 1;
  switch (interval) {
    case "week":
      return "WEEKLY";
    case "year":
      return "ANNUAL";
    case "month":
      if (c === 3) return "QUARTERLY";
      if (c === 6) return "SEMI_ANNUAL";
      if (c === 12) return "ANNUAL";
      return "MONTHLY";
    default:
      return "MONTHLY";
  }
}

function localStatusFor(stripeStatus: string | null): string {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return "active";
  }
}

// Find-or-create a shared placeholder plan for externally-created Stripe subs
// the owner links without picking a specific AthletixOS plan.
async function externalMembershipId(clubId: string): Promise<string> {
  const existing = await prisma.membership.findFirst({
    where: { clubId, name: "External (Stripe)", deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.membership.create({
    data: {
      clubId,
      name: "External (Stripe)",
      description: "Subscriptions created directly in Stripe and linked during reconciliation.",
      options: JSON.stringify([]),
      active: false,
      purchaseAccess: "STAFF_ONLY",
    },
    select: { id: true },
  });
  return created.id;
}

// PATCH /api/stripe/reconcile/[id]
// Owner/staff (finances:edit) resolves a reconciliation review row.
//   - IGNORE: dismiss it (no billing change).
//   - LINK:   record a local MemberSubscription MIRROR of the live Stripe
//             subscription against a confirmed member. This does NOT touch the
//             Stripe subscription — it only makes AthletixOS reflect it.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const row = await prisma.stripeReconciliation.findFirst({ where: { id, clubId } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "OPEN") {
    return NextResponse.json({ error: "This item was already resolved." }, { status: 409 });
  }

  if (body.action === "IGNORE") {
    await prisma.stripeReconciliation.update({
      where: { id: row.id },
      data: { status: "IGNORED", resolvedAt: new Date(), resolvedById: session.user.id },
    });
    return NextResponse.json({ ok: true, status: "IGNORED" });
  }

  // LINK
  const memberId = body.memberId || row.suggestedMemberId;
  if (!memberId) {
    return NextResponse.json({ error: "Choose which member this subscription belongs to." }, { status: 400 });
  }
  const member = await prisma.member.findFirst({ where: { id: memberId, clubId }, select: { id: true, stripeCustomerId: true } });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Guard against double-linking the same Stripe subscription.
  const already = await prisma.memberSubscription.findFirst({
    where: { stripeSubscriptionId: row.stripeSubscriptionId },
    select: { id: true },
  });
  if (already) {
    await prisma.stripeReconciliation.update({
      where: { id: row.id },
      data: { status: "LINKED", resolvedMemberId: memberId, resolvedAt: new Date(), resolvedById: session.user.id },
    });
    return NextResponse.json({ ok: true, status: "LINKED", note: "Subscription was already linked." });
  }

  const membershipId = body.membershipId
    ? (await prisma.membership.findFirst({ where: { id: body.membershipId, clubId }, select: { id: true } }))?.id
    : null;
  const resolvedMembershipId = membershipId || (await externalMembershipId(clubId));

  const snap = (row.snapshot as Record<string, unknown> | null) ?? {};
  const intervalCount = typeof snap.intervalCount === "number" ? snap.intervalCount : 1;

  await prisma.memberSubscription.create({
    data: {
      memberId,
      membershipId: resolvedMembershipId,
      optionLabel: "Linked from Stripe",
      price: row.amountCents != null ? row.amountCents / 100 : 0,
      billingPeriod: billingPeriodFor(row.interval, intervalCount),
      billingType: "RECURRING",
      autoRenew: true,
      status: localStatusFor(row.stripeStatus),
      startDate: new Date(),
      billingAnchorDate: row.currentPeriodEnd,
      currentPeriodEnd: row.currentPeriodEnd,
      stripeSubscriptionId: row.stripeSubscriptionId,
      stripePriceId: row.priceId,
      stripeProductId: row.productId,
      stripeStatus: row.stripeStatus,
      stripeSnapshot: (row.snapshot as object) ?? undefined,
      notes: "Linked from an existing Stripe subscription during reconciliation.",
    },
  });

  if (!member.stripeCustomerId && row.stripeCustomerId) {
    await prisma.member.updateMany({
      where: { id: memberId, clubId, stripeCustomerId: null },
      data: { stripeCustomerId: row.stripeCustomerId },
    });
  }

  await prisma.stripeReconciliation.update({
    where: { id: row.id },
    data: { status: "LINKED", resolvedMemberId: memberId, resolvedAt: new Date(), resolvedById: session.user.id },
  });
  await recomputeMemberStatus(memberId, clubId);

  return NextResponse.json({ ok: true, status: "LINKED" });
}
