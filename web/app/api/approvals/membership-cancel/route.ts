import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { MEMBERSHIP_CANCEL_KIND } from "@/lib/approvals";
import { sendCancellationDecisionEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

// POST /api/approvals/membership-cancel
//
// Owner/staff respond to a member's MEMBERSHIP_CANCEL request. Approving
// performs the real Stripe cancellation in the chosen mode, updates the local
// subscription, recomputes member status, and notifies the member. Declining
// closes the request and notifies the member it stays active.
//
//   mode = PERIOD_END        → cancel_at_period_end (keep access until paid-through)
//   mode = IMMEDIATE         → cancel now, no refund
//   mode = IMMEDIATE_REFUND  → cancel now + refund the last paid invoice
const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
  mode: z.enum(["PERIOD_END", "IMMEDIATE", "IMMEDIATE_REFUND"]).optional(),
});

type Payload = {
  subscriptionId?: string;
  stripeSubscriptionId?: string | null;
  optionLabel?: string | null;
  reason?: string | null;
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  // Cancelling a paid membership is a financial action.
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const clubId = session!.user.clubId;
  const approval = await prisma.pendingApproval.findFirst({
    where: { id: body.approvalId, clubId, kind: MEMBERSHIP_CANCEL_KIND, status: "PENDING" },
    select: { id: true, memberId: true, payload: true },
  });
  if (!approval) return NextResponse.json({ error: "Request not found." }, { status: 404 });

  const member = await prisma.member.findFirst({
    where: { id: approval.memberId, clubId },
    select: {
      firstName: true,
      isMinor: true,
      email: true,
      guardianEmail: true,
      club: { select: { name: true, stripeAccountId: true } },
    },
  });
  const baseUrl = getAppBaseUrl();
  const payload = (approval.payload as Payload | null) ?? {};
  const membershipName = payload.optionLabel || "your membership";
  const contactEmail = member
    ? member.isMinor
      ? member.guardianEmail || member.email
      : member.email || member.guardianEmail
    : null;

  // ── DECLINE ──
  if (body.decision === "DECLINE") {
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "DECLINED", respondedAt: new Date(), respondedById: session!.user.id },
    });
    if (contactEmail && member) {
      sendCancellationDecisionEmail({
        to: contactEmail,
        firstName: member.firstName,
        clubName: member.club.name,
        membershipName,
        decision: "DECLINED",
        portalUrl: `${baseUrl}/member/profile`,
      }).catch((e) => console.error("Cancellation email failed:", e));
    }
    return NextResponse.json({ ok: true, approved: false });
  }

  // ── APPROVE ──
  const mode = body.mode || "PERIOD_END";
  const sub = payload.subscriptionId
    ? await prisma.memberSubscription.findFirst({
        where: { id: payload.subscriptionId, member: { clubId } },
        select: { id: true, stripeSubscriptionId: true, memberId: true },
      })
    : null;
  if (!sub) return NextResponse.json({ error: "That membership no longer exists." }, { status: 404 });

  const acct = member?.club.stripeAccountId || null;
  let periodEndTs: number | null = null;
  let refunded = false;

  // Hard-fail on Stripe cancel errors so the approval stays PENDING and the
  // owner can retry — never mark it approved if Stripe didn't actually cancel.
  try {
    if (sub.stripeSubscriptionId && acct) {
      if (mode === "PERIOD_END") {
        const updated = await stripe.subscriptions.update(
          sub.stripeSubscriptionId,
          { cancel_at_period_end: true },
          { stripeAccount: acct },
        );
        periodEndTs = (updated as unknown as { current_period_end?: number }).current_period_end ?? null;
      } else {
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId, undefined, { stripeAccount: acct });
      }
    }
  } catch (e) {
    console.error("Stripe cancel failed:", e);
    return NextResponse.json({ error: `Could not cancel on Stripe: ${String(e)}` }, { status: 502 });
  }

  // Best-effort refund of the last paid invoice (soft-fail — cancellation has
  // already gone through at this point).
  if (mode === "IMMEDIATE_REFUND" && sub.stripeSubscriptionId && acct) {
    try {
      const invoices = await stripe.invoices.list(
        { subscription: sub.stripeSubscriptionId, limit: 1 },
        { stripeAccount: acct },
      );
      const inv = invoices.data[0] as unknown as {
        payment_intent?: string | { id?: string } | null;
        amount_paid?: number;
      } | undefined;
      const piId = typeof inv?.payment_intent === "string" ? inv.payment_intent : inv?.payment_intent?.id;
      if (piId && (inv?.amount_paid ?? 0) > 0) {
        await stripe.refunds.create({ payment_intent: piId }, { stripeAccount: acct });
        refunded = true;
      }
    } catch (e) {
      console.error("Refund failed (cancellation still applied):", e);
    }
  }

  const periodEnd = mode === "PERIOD_END" && !!sub.stripeSubscriptionId;
  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: periodEnd
      ? { autoRenew: false, notes: "Cancellation approved — ends at period end" }
      : { status: "canceled", canceledAt: new Date(), autoRenew: false },
  });
  await recomputeMemberStatus(sub.memberId, clubId);

  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: { status: "APPROVED", respondedAt: new Date(), respondedById: session!.user.id },
  });

  if (contactEmail && member) {
    const effectiveText = periodEnd
      ? periodEndTs
        ? `It stays active until ${new Date(periodEndTs * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}, then ends.`
        : "It stays active until the end of your current billing period, then ends."
      : "Access has ended.";
    sendCancellationDecisionEmail({
      to: contactEmail,
      firstName: member.firstName,
      clubName: member.club.name,
      membershipName,
      decision: "APPROVED",
      effectiveText,
      refunded,
      portalUrl: `${baseUrl}/member/profile`,
    }).catch((e) => console.error("Cancellation email failed:", e));
  }

  return NextResponse.json({ ok: true, approved: true, mode, refunded, periodEnd });
}
