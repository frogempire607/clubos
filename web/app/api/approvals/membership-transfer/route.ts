// Staff decision on a client-requested membership transfer (Phase 4A).
//
// The account holder can ASK to move a membership between their own family
// members, but the move only happens when staff approve — this is that step.
// Approving re-runs the full preview and eligibility check rather than trusting
// the payload, because the family, the subscription, and the target's own
// membership may all have changed since the request was filed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasBillingSubScope } from "@/lib/permissions";
import { executeTransfer } from "@/lib/membershipTransfer";
import { MEMBERSHIP_TRANSFER_KIND } from "@/lib/membershipTransferKind";

const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
  note: z.string().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = (session.user as { role?: string }).role;
  if (role !== "OWNER" && role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const perms = (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null;
  if (role !== "OWNER" && !hasBillingSubScope(perms, "transfer_subscription")) {
    return NextResponse.json(
      {
        error:
          "You don't have permission to approve membership transfers. " +
          "Ask an owner to enable 'Transfer subscription' on your staff access.",
      },
      { status: 403 },
    );
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const approval = await prisma.pendingApproval.findFirst({
    where: {
      id: data.approvalId,
      clubId: session.user.clubId,
      kind: MEMBERSHIP_TRANSFER_KIND,
      status: "PENDING",
    },
    select: { id: true, memberId: true, payload: true },
  });
  if (!approval) return NextResponse.json({ error: "Request not found or already handled." }, { status: 404 });

  const payload = (approval.payload ?? {}) as {
    subscriptionId?: string;
    toMemberId?: string;
    toMemberName?: string;
    requestedByUserId?: string;
    reason?: string | null;
  };

  if (data.decision === "DECLINE") {
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "DECLINED", respondedAt: new Date(), respondedById: session.user.id },
    });
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: session.user.clubId,
        memberId: approval.memberId,
        type: "NOTE",
        actorUserId: session.user.id,
        message:
          `Membership transfer request DECLINED. The membership stays where it is.` +
          (data.note ? ` Note: ${data.note}` : ""),
      },
    });
    return NextResponse.json({ ok: true, declined: true });
  }

  if (!payload.subscriptionId || !payload.toMemberId) {
    // Malformed payload — resolve it so it stops occupying the queue rather
    // than leaving staff with a card they can never action.
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "DECLINED", respondedAt: new Date(), respondedById: session.user.id },
    });
    return NextResponse.json(
      { error: "That request was malformed and has been dismissed." },
      { status: 409 },
    );
  }

  // Claim the approval BEFORE moving anything, so two staff hitting Approve at
  // once can't both execute the transfer.
  const claimed = await prisma.pendingApproval.updateMany({
    where: { id: approval.id, status: "PENDING" },
    data: { status: "APPROVED", respondedAt: new Date(), respondedById: session.user.id },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "Someone else just handled this request." }, { status: 409 });
  }

  const result = await executeTransfer({
    clubId: session.user.clubId,
    subscriptionId: payload.subscriptionId,
    targetMemberId: payload.toMemberId,
    actorUserId: session.user.id,
    actorRole: role === "OWNER" ? "OWNER" : "STAFF",
    reason: payload.reason ?? data.note ?? null,
    requestedByUserId: payload.requestedByUserId ?? null,
    requestedViaApprovalId: approval.id,
  });

  if (!result.ok) {
    // The transfer failed validation after we claimed the approval — put it
    // back in the queue so staff can retry once the blocker is resolved,
    // rather than silently swallowing the request.
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "PENDING", respondedAt: null, respondedById: null },
    });
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  return NextResponse.json({ ok: true, approved: true });
}
