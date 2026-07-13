import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

// Append-only billing audit writer. Every billing mutation (control-center
// edit, payment-method action, reactivation lifecycle, approval, apply-mode
// script) records one row with a before/after diff. Failures are logged but
// NEVER block the mutation itself — an audit hiccup must not break billing.

export type BillingAuditEntry = {
  clubId: string;
  memberId?: string | null;
  actorUserId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  note?: string | null;
};

export async function writeBillingAudit(entry: BillingAuditEntry): Promise<void> {
  try {
    await prisma.billingAuditLog.create({
      data: {
        clubId: entry.clubId,
        memberId: entry.memberId ?? null,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        before: entry.before === undefined ? Prisma.JsonNull : (entry.before as Prisma.InputJsonValue),
        after: entry.after === undefined ? Prisma.JsonNull : (entry.after as Prisma.InputJsonValue),
        note: entry.note ?? null,
      },
    });
  } catch (e) {
    console.error("Billing audit write failed:", e, entry.action);
  }
}
