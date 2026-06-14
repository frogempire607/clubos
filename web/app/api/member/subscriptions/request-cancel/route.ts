import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBERSHIP_CANCEL_KIND } from "@/lib/approvals";

// POST /api/member/subscriptions/request-cancel
//
// Members/guardians can't self-cancel (the Stripe portal disables it). Instead
// this queues a MEMBERSHIP_CANCEL PendingApproval for the club. Owner/staff
// approve it in the dashboard approvals queue, which performs the real Stripe
// cancellation and notifies the member.
const schema = z.object({
  subscriptionId: z.string().min(1),
  reason: z.string().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const sub = await prisma.memberSubscription.findFirst({
    where: { id: body.subscriptionId, member: { clubId: session.user.clubId, deletedAt: null } },
    select: {
      id: true,
      status: true,
      price: true,
      stripeSubscriptionId: true,
      optionLabel: true,
      memberId: true,
      member: { select: { id: true, firstName: true, lastName: true, userId: true } },
    },
  });
  if (!sub) return NextResponse.json({ error: "Membership not found." }, { status: 404 });

  // Authorization: requester must be the member themselves OR a linked guardian
  // of that member. A guardian link is the platform-wide proof of access.
  const isSelf = sub.member.userId === session.user.id;
  let isGuardian = false;
  if (!isSelf) {
    const link = await prisma.memberGuardianUser.findUnique({
      where: { userId_memberId: { userId: session.user.id, memberId: sub.memberId } },
      select: { userId: true },
    });
    isGuardian = !!link;
  }
  if (!isSelf && !isGuardian) {
    return NextResponse.json({ error: "You don't manage this membership." }, { status: 403 });
  }

  if (sub.status === "canceled" || sub.status === "expired") {
    return NextResponse.json({ error: "This membership is already canceled." }, { status: 409 });
  }

  // De-dupe: one pending cancellation request per subscription.
  const pending = await prisma.pendingApproval.findMany({
    where: { clubId: session.user.clubId, memberId: sub.memberId, kind: MEMBERSHIP_CANCEL_KIND, status: "PENDING" },
    select: { payload: true },
  });
  const already = pending.some(
    (r) => (r.payload as { subscriptionId?: string } | null)?.subscriptionId === sub.id,
  );
  if (already) {
    return NextResponse.json(
      { ok: true, alreadyRequested: true, message: "Your club already has this cancellation request." },
      { status: 200 },
    );
  }

  await prisma.pendingApproval.create({
    data: {
      clubId: session.user.clubId,
      memberId: sub.memberId,
      kind: MEMBERSHIP_CANCEL_KIND,
      amount: sub.price,
      payload: {
        subscriptionId: sub.id,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        optionLabel: sub.optionLabel,
        requestingUserId: session.user.id,
        reason: body.reason || null,
      } as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  return NextResponse.json(
    {
      ok: true,
      pendingApproval: true,
      message:
        "Your cancellation request was sent to your club. They'll confirm it and you'll be notified.",
    },
    { status: 202 },
  );
}
