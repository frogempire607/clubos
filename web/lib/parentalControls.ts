// Parental control gate for paid member-portal actions (class book, event
// register, private lesson request, package buy).
//
// Behavior:
//   - Returns "allow" for any of:
//       * Member isn't a minor
//       * Member has no parentControls configured
//       * The booker is the guardian (session.user.id != member.userId),
//         since a guardian taking the action IS the oversight
//       * Action is free (amount <= 0) AND the action type isn't
//         specifically blocked
//   - Returns "block" with a clear member-facing error for actions
//     explicitly disabled by a control (today: allowPackagePurchase=false).
//   - Returns "queue" — creates a PendingApproval row and tells the route
//     to respond 202 + a member-facing "sent to your guardian" message.
//     Triggered by:
//       * parentControls.requirePaymentApproval === true, OR
//       * dailySpendLimit set AND today's already-approved spend + this
//         action's amount would exceed it.
//
// The PendingApproval row stores everything needed to replay the action
// after the guardian approves. The approval-flow API (step 6) reads the
// payload and calls back into the underlying booking endpoint.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ParentControls = {
  requirePaymentApproval?: boolean;
  monitoredMessaging?: boolean;
  allowPackagePurchase?: boolean;
  dailySpendLimit?: number;
};

export type ApprovalKind =
  | "CLASS_BOOK"
  | "EVENT_REGISTER"
  | "PRIVATE_REQUEST"
  | "PACKAGE_BUY";

export type GateInput = {
  member: {
    id: string;
    clubId: string;
    userId: string | null;
    isMinor: boolean;
    parentControls: Prisma.JsonValue | null;
  };
  bookerUserId: string;
  kind: ApprovalKind;
  amount: number; // dollars; 0 for free actions
  payload: Record<string, unknown>;
};

export type GateResult =
  | { kind: "allow" }
  | {
      kind: "block";
      status: number;
      body: { error: string; code: string };
    }
  | {
      kind: "queue";
      approvalId: string;
      response: {
        pendingApproval: true;
        approvalId: string;
        message: string;
      };
    };

export function readControls(raw: Prisma.JsonValue | null): ParentControls {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as ParentControls;
}

/**
 * Resolve whether the requested action should be allowed, blocked, or
 * queued for guardian approval. The caller writes the PendingApproval
 * row (we do it here) and the caller is responsible for returning the
 * NextResponse based on the result.
 */
export async function applyParentalControls(input: GateInput): Promise<GateResult> {
  const { member, bookerUserId, kind, amount, payload } = input;

  // Booker is the guardian, not the minor → guardian is exercising
  // oversight by definition. No gate.
  if (member.userId && member.userId !== bookerUserId) {
    return { kind: "allow" };
  }

  // Non-minor accounts never see parental gates regardless of any
  // accidental parentControls JSON on the row.
  if (!member.isMinor) return { kind: "allow" };

  const controls = readControls(member.parentControls);
  // No controls configured = no gate.
  if (Object.keys(controls).length === 0) return { kind: "allow" };

  // Explicit block: package purchases disabled.
  if (kind === "PACKAGE_BUY" && controls.allowPackagePurchase === false) {
    return {
      kind: "block",
      status: 403,
      body: {
        error:
          "Your guardian has disabled package purchases on your account. Ask them to enable this if you want to buy a pack.",
        code: "PARENT_BLOCKED_PACKAGE",
      },
    };
  }

  // Free actions skip the approval queue. Owners can still see a free
  // booking happened in the normal logs; no parent value in queueing it.
  if (amount <= 0) return { kind: "allow" };

  // Decide whether approval is required.
  let needsApproval = controls.requirePaymentApproval === true;

  if (!needsApproval && typeof controls.dailySpendLimit === "number") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todaySpend = await prisma.pendingApproval.aggregate({
      where: {
        memberId: member.id,
        status: "APPROVED",
        respondedAt: { gte: startOfDay },
      },
      _sum: { amount: true },
    });
    const spent = Number(todaySpend._sum.amount ?? 0);
    if (spent + amount > controls.dailySpendLimit) {
      needsApproval = true;
    }
  }

  if (!needsApproval) return { kind: "allow" };

  // Queue it.
  const approval = await prisma.pendingApproval.create({
    data: {
      clubId: member.clubId,
      memberId: member.id,
      kind,
      payload: payload as Prisma.InputJsonValue,
      amount,
      status: "PENDING",
    },
  });

  return {
    kind: "queue",
    approvalId: approval.id,
    response: {
      pendingApproval: true,
      approvalId: approval.id,
      message:
        "Sent to your guardian for approval. You'll be notified when they respond.",
    },
  };
}

/**
 * Convenience: select shape callers should use when loading the Member so
 * they have everything `applyParentalControls` needs without re-querying.
 */
export const GATE_MEMBER_SELECT = {
  id: true,
  clubId: true,
  userId: true,
  isMinor: true,
  parentControls: true,
} as const;
