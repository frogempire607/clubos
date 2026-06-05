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
import { sendEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

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

  // Replay path: if the guardian already approved this kind of action
  // for this member in the last hour, let it through. The booking
  // endpoints have their own idempotency checks (already-booked,
  // already-registered, etc.) so a stale approval can't accidentally
  // double-book — worst case the second attempt 409s on its own.
  const replayWindowMs = 60 * 60 * 1000;
  const existingApproved = await prisma.pendingApproval.findFirst({
    where: {
      memberId: member.id,
      kind,
      status: "APPROVED",
      respondedAt: { gte: new Date(Date.now() - replayWindowMs) },
    },
    orderBy: { respondedAt: "desc" },
  });
  if (existingApproved) return { kind: "allow" };

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

  // Notify every guardian of this child by email. Fire-and-forget — a
  // failed SMTP send never blocks the gate response. If SMTP isn't
  // configured the email helper console-logs and returns silently.
  notifyGuardians(member.id, kind, amount).catch((e) =>
    console.error("[parentalControls] guardian notify failed:", e),
  );

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

const KIND_LABEL: Record<ApprovalKind, string> = {
  CLASS_BOOK: "a class booking",
  EVENT_REGISTER: "an event registration",
  PRIVATE_REQUEST: "a private lesson request",
  PACKAGE_BUY: "a lesson-package purchase",
};

async function notifyGuardians(memberId: string, kind: ApprovalKind, amount: number) {
  // Load the child name + every guardian's email in one shot.
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      firstName: true,
      lastName: true,
      guardianLinks: {
        select: {
          user: { select: { email: true, firstName: true } },
        },
      },
      // Fall back to the inline guardianEmail field if there are no
      // MemberGuardianUser links yet (member-only family, no portal
      // logins on the guardian side).
      guardianEmail: true,
      guardianName: true,
    },
  });
  if (!member) return;

  const recipients = new Map<string, string | null>();
  for (const link of member.guardianLinks) {
    if (link.user?.email) {
      recipients.set(link.user.email, link.user.firstName ?? null);
    }
  }
  if (recipients.size === 0 && member.guardianEmail) {
    recipients.set(member.guardianEmail, member.guardianName ?? null);
  }
  if (recipients.size === 0) return;

  const childName = `${member.firstName} ${member.lastName}`.trim();
  const action = KIND_LABEL[kind];
  const amountText = amount > 0 ? `$${amount.toFixed(2)}` : "free";
  const portalUrl = `${getAppBaseUrl()}/member/profile`;

  await Promise.allSettled(
    Array.from(recipients).map(([to, firstName]) =>
      sendEmail({
        to,
        subject: `Approval needed: ${childName}'s ${action}`,
        html: `
          <p>Hi ${firstName ?? "there"},</p>
          <p>
            <strong>${childName}</strong> is asking for your approval before
            completing ${action} (${amountText}).
          </p>
          <p>
            Open your member portal to approve or decline:<br />
            <a href="${portalUrl}">${portalUrl}</a>
          </p>
          <p style="color:#777;font-size:12px">
            This message was sent because you have parental controls enabled
            on ${childName}'s account in AthletixOS.
          </p>
        `,
      }),
    ),
  );
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
