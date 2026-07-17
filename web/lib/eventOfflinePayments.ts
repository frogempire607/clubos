// Offline (cash/check) money for event registrations — the DB side.
// The vocabulary and status rules live in lib/eventPayments.ts (pure); this is
// the only place that writes the Transaction backing an offline registration.

import { prisma } from "@/lib/prisma";

/**
 * The PENDING Transaction representing an event registration's amount DUE.
 *
 * Mirrors the membership cash/check rule exactly: acceptance ≠ payment. This
 * row is never revenue and never triggers a receipt — it flips to SUCCEEDED
 * only when staff records the physical payment
 * (/api/events/[id]/registrations/[regId]/offline-payment).
 *
 * memberId is nullable on purpose: event registrants are frequently not
 * members, and the money still has to be tracked.
 */
export async function createEventOfflinePendingTx(args: {
  clubId: string;
  eventId: string;
  memberId: string | null;
  amount: number;
  method: "CASH" | "CHECK";
  eventName: string;
  registrantName: string;
  discountCode?: string | null;
  discountAmount?: number | null;
}): Promise<{ id: string }> {
  return prisma.transaction.create({
    data: {
      clubId: args.clubId,
      memberId: args.memberId,
      amount: args.amount,
      status: "PENDING",
      type: "EVENT",
      eventId: args.eventId,
      category: "events",
      description: `Event registration — ${args.eventName} — ${args.registrantName} (pay by ${args.method.toLowerCase()} at event)`,
      paymentMethod: args.method,
      paymentSource: args.method,
      reconciliationStatus: "OFFLINE",
      manual: true,
      discountCode: args.discountCode ?? null,
      discountAmount: args.discountAmount ?? null,
    },
    select: { id: true },
  });
}
