// Assign a membership to another family member (Phase 4A).
//
// GET  → preview: current owner, payer, eligible family members, usage, and the
//        exact billing sentence the actor will confirm. Never writes.
// POST → execute, OR file a request for staff approval.
//
// ── Two actor paths (owner-decided 2026-08-02) ───────────────────────────────
//
//   STAFF   with the `billing.transfer_subscription` sub-scope (owners bypass)
//           act directly. Not billing:full — moving a membership between
//           siblings is a narrow correction a front-desk lead may need without
//           also getting prices, cards, and plans.
//
//   CLIENT  only the ACCOUNT HOLDER — the payer — may initiate, only between
//           members of their own family, and it does NOT take effect
//           immediately. It files a PendingApproval (kind MEMBERSHIP_TRANSFER)
//           that staff approve. A guardian who is not the account holder can't
//           initiate at all.
//
// The client path reuses PendingApproval rather than inventing a mechanism, so
// it lands in the queue staff already work.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasBillingSubScope } from "@/lib/permissions";
import { buildTransferPreview, executeTransfer } from "@/lib/membershipTransfer";
import { resolvePayerUserId } from "@/lib/familyAccess";
import { MEMBERSHIP_TRANSFER_KIND } from "@/lib/membershipTransferKind";

type Actor =
  | { kind: "STAFF"; role: "OWNER" | "STAFF"; userId: string; clubId: string }
  | { kind: "ACCOUNT_HOLDER"; userId: string; clubId: string }
  | { kind: "DENIED"; status: number; error: string };

/**
 * Who is asking, and in what capacity.
 *
 * Staff authority comes from the permission blob. Client authority comes from
 * being the resolved payer of THIS subscription — not merely from being a
 * guardian of the athlete, which would let a co-parent move a membership the
 * other parent bought.
 */
async function resolveActor(subscriptionId: string): Promise<Actor> {
  const session = await getServerSession(authOptions);
  if (!session) return { kind: "DENIED", status: 401, error: "Unauthorized" };

  if (session.user.role === "OWNER" || session.user.role === "STAFF") {
    const allowed =
      session.user.role === "OWNER" ||
      hasBillingSubScope(
        (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null,
        "transfer_subscription",
      );
    if (!allowed) {
      return {
        kind: "DENIED",
        status: 403,
        error:
          "You don't have permission to move memberships between family members. " +
          "Ask an owner to enable 'Transfer subscription' on your staff access.",
      };
    }
    return { kind: "STAFF", role: session.user.role, userId: session.user.id, clubId: session.user.clubId };
  }

  // MEMBER — must be the payer of this exact subscription.
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: subscriptionId, membership: { clubId: session.user.clubId } },
    select: {
      payerUserId: true,
      member: { select: { userId: true, responsiblePayerUserId: true } },
    },
  });
  if (!sub) return { kind: "DENIED", status: 404, error: "Membership not found." };

  const payerUserId = resolvePayerUserId({
    subscriptionPayerUserId: sub.payerUserId,
    memberResponsiblePayerUserId: sub.member.responsiblePayerUserId,
    memberUserId: sub.member.userId,
  });
  if (!payerUserId || payerUserId !== session.user.id) {
    return {
      kind: "DENIED",
      status: 403,
      error:
        "Only the account holder who pays for this membership can move it. " +
        "Ask them, or contact the club.",
    };
  }
  return { kind: "ACCOUNT_HOLDER", userId: session.user.id, clubId: session.user.clubId };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const actor = await resolveActor(id);
  if (actor.kind === "DENIED") return NextResponse.json({ error: actor.error }, { status: actor.status });

  const targetMemberId = new URL(req.url).searchParams.get("targetMemberId");
  const preview = await buildTransferPreview({
    clubId: actor.clubId,
    subscriptionId: id,
    targetMemberId,
  });
  if (!preview) return NextResponse.json({ error: "Membership not found." }, { status: 404 });

  // The client path never takes effect immediately, and the UI must say so
  // before they press anything.
  return NextResponse.json({
    ...preview,
    actor: actor.kind,
    requiresApproval: actor.kind === "ACCOUNT_HOLDER",
  });
}

const postSchema = z.object({
  targetMemberId: z.string().min(1),
  reason: z.string().max(500).optional().nullable(),
  // Explicit confirmation that the actor read what happens to the money.
  acknowledgeBillingUnchanged: z.literal(true),
  // Separate tick, required only when the membership has been used.
  acknowledgeUsage: z.boolean().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const actor = await resolveActor(id);
  if (actor.kind === "DENIED") return NextResponse.json({ error: actor.error }, { status: actor.status });

  let data: z.infer<typeof postSchema>;
  try {
    data = postSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.errors[0];
      // The acknowledgement is a literal(true), so a missing tick reads as a
      // type error. Say what actually needs to happen instead.
      if (issue.path.includes("acknowledgeBillingUnchanged")) {
        return NextResponse.json(
          {
            error: "Confirm you understand the payment doesn't move before continuing.",
            code: "ACKNOWLEDGEMENT_REQUIRED",
          },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: issue.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const preview = await buildTransferPreview({
    clubId: actor.clubId,
    subscriptionId: id,
    targetMemberId: data.targetMemberId,
  });
  if (!preview) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  if (preview.blockers.length) {
    const b = preview.blockers[0];
    return NextResponse.json({ error: b.message, code: b.code }, { status: 409 });
  }

  // Usage never blocks (owner decision — an accidental self-purchase is always
  // already billed) but it must be seen and acknowledged, not discovered later.
  if (preview.usage.hasUsage && !data.acknowledgeUsage) {
    return NextResponse.json(
      {
        error:
          `This membership has already been used — ${preview.usage.attendanceCount} attendance ` +
          `record(s) and ${preview.usage.bookingCount} booking(s) under ${preview.from.name}. ` +
          `Those stay with ${preview.from.name}; only the membership moves. Confirm to continue.`,
        code: "USAGE_ACKNOWLEDGEMENT_REQUIRED",
        usage: preview.usage,
      },
      { status: 409 },
    );
  }

  // ── Client path: file for approval, change nothing ────────────────────────
  if (actor.kind === "ACCOUNT_HOLDER") {
    const duplicate = await prisma.pendingApproval.findFirst({
      where: {
        clubId: actor.clubId,
        kind: MEMBERSHIP_TRANSFER_KIND,
        status: "PENDING",
        memberId: preview.from.memberId,
      },
      select: { id: true, payload: true },
    });
    const already =
      duplicate &&
      (duplicate.payload as { subscriptionId?: string } | null)?.subscriptionId === id;
    if (already) {
      return NextResponse.json(
        {
          ok: true,
          pendingApproval: true,
          duplicate: true,
          message: "You've already asked the club to move this membership. They'll review it shortly.",
        },
        { status: 202 },
      );
    }

    const approval = await prisma.pendingApproval.create({
      data: {
        clubId: actor.clubId,
        // Filed against the CURRENT holder so it surfaces on the profile where
        // the membership actually sits today.
        memberId: preview.from.memberId,
        kind: MEMBERSHIP_TRANSFER_KIND,
        status: "PENDING",
        payload: {
          subscriptionId: id,
          fromMemberId: preview.from.memberId,
          fromMemberName: preview.from.name,
          toMemberId: data.targetMemberId,
          toMemberName: preview.to?.name ?? null,
          planName: preview.planName,
          optionLabel: preview.optionLabel,
          reason: data.reason ?? null,
          requestedByUserId: actor.userId,
          payerUserIdAtRequest: preview.payer.userId,
          isLiveStripe: preview.isLiveStripe,
          acknowledgedBillingNote: preview.billingNote,
          usageSnapshot: preview.usage,
        },
      },
      select: { id: true },
    });

    await prisma.memberMigrationEvent.create({
      data: {
        clubId: actor.clubId,
        memberId: preview.from.memberId,
        type: "NOTE",
        actorUserId: actor.userId,
        message:
          `Account holder requested moving "${preview.planName}" from ${preview.from.name} to ` +
          `${preview.to?.name ?? data.targetMemberId}. Awaiting staff approval — nothing has changed yet.` +
          (data.reason ? ` Reason: ${data.reason}` : ""),
      },
    });

    return NextResponse.json(
      {
        ok: true,
        pendingApproval: true,
        approvalId: approval.id,
        message:
          `Sent to ${"the club"} for approval. Nothing has changed yet — ` +
          `we'll move the membership once staff confirm.`,
      },
      { status: 202 },
    );
  }

  // ── Staff path: execute now ───────────────────────────────────────────────
  const result = await executeTransfer({
    clubId: actor.clubId,
    subscriptionId: id,
    targetMemberId: data.targetMemberId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    reason: data.reason ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    message: `${preview.planName} now belongs to ${preview.to?.name}. ${preview.payer.name} is still the payer.`,
  });
}
