import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { MIGRATION_STATUS } from "@/lib/migration";

// Discrete, confirmation-gated billing actions (billing:full). Each action is
// explicit, audited, and preserves history — nothing here deletes rows or
// touches a live Stripe subscription.

const schema = z.object({
  action: z.enum(["cancel_pending_activation", "reassign_subscription"]),
  confirm: z.literal(true, { errorMap: () => ({ message: "This action requires explicit confirmation." }) }),
  // reassign_subscription:
  subscriptionId: z.string().optional(),
  targetMemberId: z.string().optional(),
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
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (data.action === "cancel_pending_activation") {
    // Cancel an incomplete pending activation WITHOUT deleting history: the
    // token stops working, approval state clears, and the member returns to
    // the imported pool. Events, requests, and any saved card stay intact.
    if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {
      return NextResponse.json({ error: "This migration is already complete — nothing pending to cancel." }, { status: 409 });
    }
    if (!member.activationToken && member.approvalStatus !== "PENDING_APPROVAL") {
      return NextResponse.json({ error: "No pending activation to cancel." }, { status: 409 });
    }
    const before = {
      migrationStatus: member.migrationStatus,
      approvalStatus: member.approvalStatus,
      hadActivationToken: !!member.activationToken,
    };
    await prisma.member.update({
      where: { id: member.id },
      data: {
        activationToken: null,
        activationTokenExpires: null,
        approvalStatus: null,
        migrationStatus: MIGRATION_STATUS.IMPORTED,
        billingUpdatedAt: new Date(),
        billingUpdatedById: session.user.id,
      },
    });
    // Any open reactivation offer dies with the pending activation.
    await prisma.membershipReactivation.updateMany({
      where: { memberId: member.id, clubId: member.clubId, status: { in: ["DRAFT", "SENT"] } },
      data: { status: "CANCELED" },
    });
    await writeBillingAudit({
      clubId: member.clubId,
      memberId: member.id,
      actorUserId: session.user.id,
      action: "PENDING_ACTIVATION_CANCELED",
      before,
      after: { migrationStatus: MIGRATION_STATUS.IMPORTED, approvalStatus: null, hadActivationToken: false },
      note: "Pending activation canceled — history preserved, token invalidated.",
    });
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: member.clubId,
        memberId: member.id,
        type: "NOTE",
        message: "Pending activation canceled by staff — link invalidated; no billing was started.",
        actorUserId: session.user.id,
      },
    });
    return NextResponse.json({ ok: true });
  }

  // reassign_subscription — move a NON-Stripe (manual/pending) subscription to
  // the correct athlete. Live Stripe subscriptions are deliberately blocked:
  // repointing those means Stripe customer surgery and is never done silently.
  if (!data.subscriptionId || !data.targetMemberId) {
    return NextResponse.json({ error: "subscriptionId and targetMemberId are required." }, { status: 400 });
  }
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: data.subscriptionId, memberId: member.id },
    include: { membership: { select: { clubId: true, name: true } } },
  });
  if (!sub || sub.membership.clubId !== session.user.clubId) {
    return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  }
  if (sub.stripeSubscriptionId) {
    return NextResponse.json(
      {
        error:
          "This subscription is live in Stripe and can't be reassigned in place. Cancel it through Stripe (or contact support) and set the correct athlete up fresh — reassigning a live charge silently is unsafe.",
      },
      { status: 409 },
    );
  }
  const target = await prisma.member.findFirst({
    where: { id: data.targetMemberId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!target) return NextResponse.json({ error: "Target athlete not found." }, { status: 404 });
  if (target.id === member.id) {
    return NextResponse.json({ error: "That subscription already belongs to this athlete." }, { status: 400 });
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: {
      memberId: target.id,
      notes: `${sub.notes ? sub.notes + " " : ""}[Reassigned from ${member.firstName} ${member.lastName} on ${new Date().toISOString().slice(0, 10)}]`,
    },
  });
  await prisma.member.update({
    where: { id: member.id },
    data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
  });
  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "SUBSCRIPTION_REASSIGNED",
    before: { subscriptionId: sub.id, memberId: member.id, plan: sub.membership.name },
    after: { subscriptionId: sub.id, memberId: target.id, targetName: `${target.firstName} ${target.lastName}` },
    note: `Membership "${sub.optionLabel}" reassigned to ${target.firstName} ${target.lastName}.`,
  });
  return NextResponse.json({ ok: true });
}
