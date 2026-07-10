import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { writeBillingAudit } from "@/lib/billingAudit";
import { locatePaymentMethod } from "@/lib/paymentMethodsAdmin";
import { prettyBrand } from "@/lib/memberCard";

// POST /api/members/[id]/payment-methods/make-default  (billing:full)
//
// The REPLACE confirm step. Body { ref, confirm: true } where ref is the
// opaque payment-method digest from the billing summary. Effects, in order:
//   1. customer invoice_settings.default_payment_method → this method
//   2. every LIVE subscription on that customer → default_payment_method
//   3. the member's captured on-file pointer (stripeSetupPaymentMethodId)
// The previous method is NOT detached — removal is a separate, safety-gated
// action once nothing backs it anymore.
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
      id: true, clubId: true, stripeSetupCustomerId: true, stripeCustomerId: true,
      stripeSetupPaymentMethodId: true,
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
  const stripeAccount = club.stripeAccountId;

  const located = await locatePaymentMethod(member, stripeAccount, data.ref);
  if (!located) {
    return NextResponse.json({ error: "That payment method is no longer on file. Refresh and try again." }, { status: 404 });
  }

  const label = located.pm.card
    ? `${prettyBrand(located.pm.card.brand)} ···· ${located.pm.card.last4}`
    : "Link wallet";

  // 1. Customer default.
  await stripe.customers.update(
    located.customerId,
    { invoice_settings: { default_payment_method: located.pm.id } },
    { stripeAccount },
  );

  // 2. Live subscriptions on that customer.
  const updatedSubs: string[] = [];
  for (const sub of located.liveSubs) {
    const current = typeof sub.default_payment_method === "string" ? sub.default_payment_method : sub.default_payment_method?.id;
    if (current === located.pm.id) continue;
    await stripe.subscriptions.update(sub.id, { default_payment_method: located.pm.id }, { stripeAccount });
    updatedSubs.push(sub.id);
  }

  // 3. Member on-file pointer (what approval / reactivation will charge).
  const beforePmWasCaptured = member.stripeSetupPaymentMethodId;
  await prisma.member.update({
    where: { id: member.id },
    data: {
      stripeSetupCustomerId: member.stripeSetupCustomerId ?? located.customerId,
      stripeSetupPaymentMethodId: located.pm.id,
      paymentSetupStatus: "COMPLETE",
      billingUpdatedAt: new Date(),
      billingUpdatedById: session.user.id,
    },
  });

  await writeBillingAudit({
    clubId: member.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "PM_MADE_DEFAULT",
    before: { hadCapturedMethod: !!beforePmWasCaptured },
    after: { method: label, liveSubscriptionsRepointed: updatedSubs.length },
    note: `${label} is now the default payment method${updatedSubs.length ? ` (and ${updatedSubs.length} live subscription${updatedSubs.length > 1 ? "s" : ""} repointed)` : ""}.`,
  });

  return NextResponse.json({ ok: true, method: label, liveSubscriptionsRepointed: updatedSubs.length });
}
