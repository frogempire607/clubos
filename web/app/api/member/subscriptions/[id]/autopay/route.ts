import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBERSHIP_AUTOPAY_KIND } from "@/lib/approvals";
import { previewAutopayChange } from "@/lib/autopay";

// GET  /api/member/subscriptions/[id]/autopay — what would happen, in words.
// POST /api/member/subscriptions/[id]/autopay — ask the club to make it happen.
//
// §8.6.3 / decision D8. This QUEUES; it never transitions.
//
// The member path queues for the same reason request-cancel does: the
// subscription lifecycle is the club's money, and members have never been given
// a Stripe Customer Portal button. It also means "turn autopay on" cannot be
// used to start a charge the club did not agree to.
//
// The GET exists so the member sees the same sentence the owner will see —
// including the fee passthrough — before they ask for anything.

const schema = z.object({
  direction: z.enum(["on", "off"]),
  reason: z.string().max(500).optional().nullable(),
});

/** Self, or a linked guardian. The guardian link is the proof of access. */
async function authorize(subscriptionId: string, clubId: string, userId: string) {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: subscriptionId, member: { clubId, deletedAt: null } },
    select: {
      id: true, status: true, price: true, optionLabel: true, memberId: true,
      stripeSubscriptionId: true,
      member: { select: { id: true, userId: true } },
    },
  });
  if (!sub) return { error: NextResponse.json({ error: "Membership not found." }, { status: 404 }) };
  if (sub.member.userId !== userId) {
    const link = await prisma.memberGuardianUser.findUnique({
      where: { userId_memberId: { userId, memberId: sub.memberId } },
      select: { userId: true },
    });
    if (!link) return { error: NextResponse.json({ error: "You don't manage this membership." }, { status: 403 }) };
  }
  return { sub };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const gate = await authorize(id, session.user.clubId, session.user.id);
  if (gate.error) return gate.error;

  // Which way this membership can move is a fact about the row, not a choice:
  // a Stripe-billed one can only go off, a manual one can only go on.
  const direction = gate.sub!.stripeSubscriptionId ? "off" : "on";
  const preview = await previewAutopayChange(id, session.user.clubId, direction);
  if (!preview) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  return NextResponse.json({
    currentlyOn: !!gate.sub!.stripeSubscriptionId,
    direction,
    ready: preview.ready,
    blockedReason: preview.blockedReason,
    effectiveAt: preview.effectiveAt,
    chargeAmount: preview.chargeAmount,
    price: preview.price,
    sentence: preview.sentence,
  });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const gate = await authorize(id, session.user.clubId, session.user.id);
  if (gate.error) return gate.error;
  const sub = gate.sub!;

  if (sub.status === "canceled" || sub.status === "expired") {
    return NextResponse.json({ error: "This membership has already ended." }, { status: 409 });
  }
  // Asking for the state it is already in is a no-op, not a queue entry.
  const currentlyOn = !!sub.stripeSubscriptionId;
  if ((body.direction === "on") === currentlyOn) {
    return NextResponse.json(
      { ok: true, unchanged: true, message: `Autopay is already ${currentlyOn ? "on" : "off"}.` },
      { status: 200 },
    );
  }

  // Refuse EARLY when the club could not act on it — a request that will be
  // declined tomorrow for a reason we can see today is a request nobody should
  // have to work. The member is told what to do instead.
  const preview = await previewAutopayChange(id, session.user.clubId, body.direction);
  if (preview && !preview.ready) {
    return NextResponse.json(
      { error: preview.blockedReason ?? preview.sentence, code: "NOT_READY" },
      { status: 409 },
    );
  }

  const pending = await prisma.pendingApproval.findMany({
    where: {
      clubId: session.user.clubId, memberId: sub.memberId,
      kind: MEMBERSHIP_AUTOPAY_KIND, status: "PENDING",
    },
    select: { payload: true },
  });
  if (pending.some((r) => (r.payload as { subscriptionId?: string } | null)?.subscriptionId === sub.id)) {
    return NextResponse.json(
      { ok: true, alreadyRequested: true, message: "Your club already has this request." },
      { status: 200 },
    );
  }

  await prisma.pendingApproval.create({
    data: {
      clubId: session.user.clubId,
      memberId: sub.memberId,
      kind: MEMBERSHIP_AUTOPAY_KIND,
      amount: sub.price,
      payload: {
        subscriptionId: sub.id,
        direction: body.direction,
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
      preview: preview?.sentence ?? null,
      message: "Your request was sent to your club. Nothing changes until they confirm it.",
    },
    { status: 202 },
  );
}
