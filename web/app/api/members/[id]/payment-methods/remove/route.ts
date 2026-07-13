import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { writeBillingAudit } from "@/lib/billingAudit";
import { locatePaymentMethod } from "@/lib/paymentMethodsAdmin";
import { canRemovePaymentMethod } from "@/lib/billingAdmin";
import { prettyBrand } from "@/lib/memberCard";

// POST /api/members/[id]/payment-methods/remove  (billing:full)
//
// Safety-gated removal. A method is only removable when NOTHING would break:
// it must not be the effective method behind any live subscription, and it
// must not be the captured method a pending activation / sent reactivation
// expects to charge (make the replacement the default first — that repoints
// everything). Detaching never deletes payment or invoice history.
const schema = z.object({
  ref: z.string().min(8),
  confirm: z.literal(true, { errorMap: () => ({ message: "This action requires explicit confirmation." }) }),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true, clubId: true, approvalStatus: true, migrationStatus: true,
      stripeSetupCustomerId: true, stripeCustomerId: true, stripeSetupPaymentMethodId: true,
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const club = await prisma.club.findUnique({
    where: { id: member.clubId },
    select: { stripeAccountId: true },
  });
  if (!club?.stripeAccountId) {
    return NextResponse.json({ error: "This club hasn't connected Stripe." }, { status: 400 });
  }

  const located = await locatePaymentMethod(member, club.stripeAccountId, data.ref);
  if (!located) {
    return NextResponse.json({ error: "That payment method is no longer on file. Refresh and try again." }, { status: 404 });
  }

  // Does anything pending expect to charge this exact method?
  const openReactivation = await prisma.membershipReactivation.findFirst({
    where: { memberId: member.id, clubId: member.clubId, status: { in: ["DRAFT", "SENT"] } },
    select: { id: true },
  });
  const activationPending =
    member.approvalStatus === "PENDING_APPROVAL" ||
    member.migrationStatus === "INVITED" ||
    member.migrationStatus === "ACTIVATED" ||
    !!openReactivation;
  const backsPendingActivation = activationPending && member.stripeSetupPaymentMethodId === located.pm.id;

  const verdict = canRemovePaymentMethod({
    backsLiveSubscription: located.liveSubsCharging.length > 0,
    backsPendingActivation,
    otherValidMethodExists: located.otherMethods.length > 0,
  });
  if (!verdict.allowed) {
    return NextResponse.json({ error: verdict.reason, code: "UNSAFE_REMOVAL_BLOCKED" }, { status: 409 });
  }

  const label = located.pm.card
    ? `${prettyBrand(located.pm.card.brand)} ···· ${located.pm.card.last4}`
    : "Link wallet";

  await stripe.paymentMethods.detach(located.pm.id, undefined, { stripeAccount: club.stripeAccountId });

  // Clear stale pointers (defensive — the safety gate means nothing pending
  // points here, but a stale customer-default or captured id could).
  if (member.stripeSetupPaymentMethodId === located.pm.id) {
    await prisma.member.update({
      where: { id: member.id },
      data: {
        stripeSetupPaymentMethodId: null,
        billingUpdatedAt: new Date(),
        billingUpdatedById: session.user.id,
      },
    });
  } else {
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });
  }

  await writeBillingAudit({
    clubId: member.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "PM_REMOVED",
    before: { method: label },
    after: { method: null },
    note: `${label} detached from the customer. Payment and invoice history untouched.`,
  });

  return NextResponse.json({ ok: true, removed: label });
}
