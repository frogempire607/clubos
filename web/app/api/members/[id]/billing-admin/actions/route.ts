import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { MIGRATION_STATUS } from "@/lib/migration";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { turnAutopayOff, turnAutopayOn, setAutoRenew, previewAutopayChange } from "@/lib/autopay";
import { SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";

// Discrete, confirmation-gated billing actions (billing:full). Each action is
// explicit, audited, and preserves history — nothing here deletes rows or
// touches a live Stripe subscription.

const schema = z.object({
  action: z.enum([
    "cancel_pending_activation",
    "reassign_subscription",
    "set_deliberate_free",
    "set_autopay",
    "set_auto_renew",
  ]),
  confirm: z.literal(true, { errorMap: () => ({ message: "This action requires explicit confirmation." }) }),
  // reassign_subscription:
  subscriptionId: z.string().optional(),
  targetMemberId: z.string().optional(),
  // set_deliberate_free:
  deliberateFree: z.boolean().optional(),
  // set_autopay / set_auto_renew:
  autopay: z.boolean().optional(),
  autoRenew: z.boolean().optional(),
  reason: z.string().max(200).optional().nullable(),
});

// GET ?subscriptionId=…&direction=on|off — the exact sentence the confirm
// dialog must show, computed from live values. Read-only; `billing:view`.
// A dialog that states the wrong charge is worse than one that states none, so
// this is recomputed at render time and never snapshotted.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const subscriptionId = url.searchParams.get("subscriptionId");
  const direction = url.searchParams.get("direction");
  if (!subscriptionId || (direction !== "on" && direction !== "off")) {
    return NextResponse.json({ error: "subscriptionId and direction are required." }, { status: 400 });
  }
  const owns = await prisma.memberSubscription.count({
    where: { id: subscriptionId, memberId: id, member: { clubId: session.user.clubId, deletedAt: null } },
  });
  if (!owns) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });

  const preview = await previewAutopayChange(subscriptionId, session.user.clubId, direction);
  if (!preview) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  return NextResponse.json(preview);
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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

  // set_autopay — §8.6.3. The owner path executes immediately; the member path
  // queues (/api/member/subscriptions/[id]/autopay → the approvals queue).
  // Both land in the same two functions, so there is exactly one implementation
  // of what turning a card on or off means.
  if (data.action === "set_autopay") {
    if (!data.subscriptionId || data.autopay === undefined) {
      return NextResponse.json({ error: "subscriptionId and autopay are required." }, { status: 400 });
    }
    const owns = await prisma.memberSubscription.count({
      where: { id: data.subscriptionId, memberId: member.id },
    });
    if (!owns) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    const actor = { userId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION };
    const result = data.autopay
      ? await turnAutopayOn(data.subscriptionId, session.user.clubId, actor)
      : await turnAutopayOff(data.subscriptionId, session.user.clubId, actor);
    if (!result.ok) {
      // 409 for "you cannot do that to this row", 502 for "Stripe would not".
      const status = result.code === "STRIPE_FAILED" ? 502 : 409;
      return NextResponse.json({ error: result.error, code: result.code }, { status });
    }
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });
    return NextResponse.json({
      ok: true,
      direction: result.direction,
      effectiveAt: result.effectiveAt,
      message: result.message,
    });
  }

  // set_auto_renew — §8.6.4. Whether the membership CONTINUES, which is a
  // different question from who charges the card. Mapped to
  // cancel_at_period_end, never a recomputed absolute cancel_at.
  if (data.action === "set_auto_renew") {
    if (!data.subscriptionId || data.autoRenew === undefined) {
      return NextResponse.json({ error: "subscriptionId and autoRenew are required." }, { status: 400 });
    }
    const ownsRow = await prisma.memberSubscription.count({
      where: { id: data.subscriptionId, memberId: member.id },
    });
    if (!ownsRow) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    const result = await setAutoRenew(data.subscriptionId, session.user.clubId, data.autoRenew, {
      userId: session.user.id,
      source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
    });
    if (!result.ok) {
      if (result.code === "UNCHANGED") return NextResponse.json({ ok: true, unchanged: true });
      const status = result.code === "STRIPE_FAILED" ? 502 : 409;
      return NextResponse.json({ error: result.error, code: result.code }, { status });
    }
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });
    return NextResponse.json({ ok: true, effectiveAt: result.effectiveAt, message: result.message });
  }

  // set_deliberate_free — the club states that a $0 membership is a comp it
  // meant to give, not a leftover placeholder row. This is the ONLY writer of
  // MemberSubscription.deliberateFree; the flag is never inferred from the
  // price, because inferring it is precisely the bug that counted migration
  // artifacts as active members.
  if (data.action === "set_deliberate_free") {
    if (!data.subscriptionId || data.deliberateFree === undefined) {
      return NextResponse.json({ error: "subscriptionId and deliberateFree are required." }, { status: 400 });
    }
    const target = await prisma.memberSubscription.findFirst({
      where: { id: data.subscriptionId, memberId: member.id },
      include: { membership: { select: { clubId: true, name: true } } },
    });
    if (!target || target.membership.clubId !== session.user.clubId) {
      return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
    }

    // On a priced row the flag changes nothing — a paid membership counts
    // when a payment lands, comp or not. Storing it there would leave staff
    // believing they had comped someone who is still expected to pay, which
    // is worse than refusing. Point at the control that actually does it.
    if (Number(target.price) > 0) {
      return NextResponse.json(
        {
          error:
            `This membership is ${Number(target.price).toFixed(2)}, not free. Marking it comped would change ` +
            `nothing — a priced membership counts once a payment is recorded. To actually give it away, set ` +
            `the price to $0 first (Edit billing → price override, or “Mark free”), then mark it deliberate.`,
          code: "NOT_A_FREE_MEMBERSHIP",
        },
        { status: 409 },
      );
    }

    if (target.deliberateFree === data.deliberateFree) {
      return NextResponse.json({ ok: true, unchanged: true });
    }

    const note = data.reason?.trim()
      ? `[${data.deliberateFree ? "Comped" : "Comp removed"} ${new Date().toISOString().slice(0, 10)}: ${data.reason.trim()}]`
      : `[${data.deliberateFree ? "Marked deliberate comp" : "Comp marker removed"} ${new Date().toISOString().slice(0, 10)}]`;

    await prisma.memberSubscription.update({
      where: { id: target.id },
      data: {
        deliberateFree: data.deliberateFree,
        notes: `${target.notes ? target.notes + " " : ""}${note}`,
      },
    });
    await prisma.member.update({
      where: { id: member.id },
      data: { billingUpdatedAt: new Date(), billingUpdatedById: session.user.id },
    });

    // The flag decides whether this row counts as a membership at all, so
    // the member's stored status must be recomputed in the same breath —
    // otherwise the roster keeps yesterday's answer until something else
    // happens to touch them.
    await recomputeMemberStatus(member.id, session.user.clubId);
    const after = await prisma.member.findUnique({
      where: { id: member.id },
      select: { status: true },
    });
    const status = after?.status ?? member.status;

    await writeBillingAudit({
      clubId: session.user.clubId,
      memberId: member.id,
      actorUserId: session.user.id,
      action: data.deliberateFree ? "MEMBERSHIP_COMPED" : "MEMBERSHIP_COMP_REMOVED",
      before: { subscriptionId: target.id, deliberateFree: target.deliberateFree },
      after: { subscriptionId: target.id, deliberateFree: data.deliberateFree, memberStatus: status },
      note: data.deliberateFree
        ? `"${target.optionLabel}" marked a deliberate $0 membership${data.reason?.trim() ? ` — ${data.reason.trim()}` : ""}.`
        : `"${target.optionLabel}" is no longer marked a deliberate $0 membership${data.reason?.trim() ? ` — ${data.reason.trim()}` : ""}.`,
    });

    return NextResponse.json({ ok: true, deliberateFree: data.deliberateFree, memberStatus: status });
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
    // Phase 4A replaced the old blanket 409 here.
    //
    // This action still refuses live Stripe subs, but the reason changed: it is
    // no longer "you can't do this", it is "there is a purpose-built flow that
    // does it safely". This endpoint's reassign is a bare FK repoint with no
    // preview, no eligibility check, no usage snapshot, and no record of what
    // the actor understood about the money — fine for a MANUAL/pending row,
    // unacceptable for one Stripe is actively charging.
    //
    // The transfer endpoint moves the beneficiary while deliberately leaving
    // the Stripe subscription, customer and card alone, and stores the exact
    // sentence the actor confirmed. Telling staff to cancel and re-create (the
    // old advice) would have ended the billing relationship and destroyed the
    // original receipt.
    return NextResponse.json(
      {
        error:
          "This membership is live in Stripe. Use “Assign to another family member” on the " +
          "membership instead — it moves the athlete while leaving the payment, card and receipt " +
          "exactly as they are.",
        code: "USE_TRANSFER_FLOW",
        transferUrl: `/api/member-subscriptions/${sub.id}/transfer`,
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
