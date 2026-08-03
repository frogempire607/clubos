// Offline (cash/check) money for event registrations — the DB side.
// The vocabulary and status rules live in lib/eventPayments.ts (pure); this is
// the only place that writes the Transaction backing an offline registration.

import { prisma } from "@/lib/prisma";
import { writeBillingAudit } from "@/lib/billingAudit";
import { sendPaymentReceiptEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
// Classification + labels live in lib/paymentSources.ts (the pure vocabulary
// module) so they can be unit-tested without pulling a Prisma client in.
import {
  eventOfflineMethodClassification,
  eventOfflineMethodLabel,
  type EventOfflineMethod,
} from "@/lib/paymentSources";

export type { EventOfflineMethod };

export type SettleResult =
  | { ok: true; transactionId: string; amount: number; method: EventOfflineMethod }
  | { ok: false; error: string; status: number };

/**
 * THE settlement path for offline event money. Every surface that turns cash,
 * a check, or an external card-reader swipe into revenue for an event goes
 * through here — the Registrations roster action AND the Bookings at-the-door
 * flow.
 *
 * Why one path: the Bookings flow used to write its own free-floating
 * Transaction that no registration knew about. Staff who needed to mark
 * someone paid had to remove and re-add their booking, and every cycle minted
 * another SUCCEEDED row while the registration still read "owes". Frog Empire
 * Road Trip ended up with four $450 Transactions for two athletes, both still
 * unpaid on paper. Money for an event is recorded against a REGISTRATION or it
 * is not recorded at all.
 *
 * Idempotency: the registration is CLAIMED with a conditional updateMany
 * before any money is written, so a double-click at the front desk settles
 * once. Offline money has no unique key of its own — the claim is the guard.
 */
export async function settleEventRegistrationOffline(args: {
  clubId: string;
  registrationId: string;
  method: EventOfflineMethod;
  reference?: string | null;
  actorUserId?: string | null;
  /** Optional check against the recorded amount due; must match to the cent. */
  amountReceived?: number | null;
  /** Skip the receipt email (nothing currently does; kept explicit). */
  skipReceipt?: boolean;
}): Promise<SettleResult> {
  const { clubId, registrationId, method } = args;

  const reg = await prisma.eventRegistration.findFirst({
    where: { id: registrationId, clubId },
    include: { event: { select: { id: true, name: true } }, club: { select: { name: true } } },
  });
  if (!reg) return { ok: false, error: "Registration not found", status: 404 };
  if (reg.status === "PAID") return { ok: false, error: "This registration is already paid.", status: 409 };
  if (reg.status === "CANCELED") return { ok: false, error: "This registration was canceled.", status: 409 };

  const due = Number(reg.amountDue ?? 0);
  if (!(due > 0)) return { ok: false, error: "This registration has no amount due.", status: 400 };
  if (args.amountReceived != null && Math.abs(args.amountReceived - due) > 0.005) {
    return {
      ok: false,
      error: `Amount received ($${args.amountReceived.toFixed(2)}) must equal the amount due ($${due.toFixed(2)}).`,
      status: 400,
    };
  }

  const receivedAt = new Date();

  // CLAIM before any money write. Two identical POSTs both pass the status
  // check above (each read the row before the other wrote it); the conditional
  // update lets exactly one through, so the same physical cash is never booked
  // as revenue twice.
  const claim = await prisma.eventRegistration.updateMany({
    where: { id: reg.id, clubId, status: { notIn: ["PAID", "CANCELED"] } },
    data: { status: "PAID", paidAt: receivedAt, paidVia: method },
  });
  if (claim.count === 0) {
    return { ok: false, error: "This registration was just settled by someone else.", status: 409 };
  }

  const cls = eventOfflineMethodClassification(method);

  // The PENDING offline row normally already exists (created at registration).
  // Mint one now if the registrant switched to cash at the door or is settling
  // a failed auto-charge, so the money is always exactly one Transaction.
  let txId: string | null = null;
  if (reg.transactionId) {
    const existing = await prisma.transaction.findFirst({
      where: { id: reg.transactionId, clubId },
      select: { id: true, status: true },
    });
    if (existing?.status === "SUCCEEDED") {
      return { ok: false, error: "This registration's payment is already recorded.", status: 409 };
    }
    if (existing?.status === "PENDING") txId = existing.id;
  }
  if (!txId) {
    const created = await createEventOfflinePendingTx({
      clubId,
      eventId: reg.event.id,
      memberId: reg.memberId,
      amount: due,
      method: method === "TERMINAL" ? "CASH" : method,
      eventName: reg.event.name,
      registrantName: reg.name,
    });
    txId = created.id;
  }

  const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });

  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      status: "SUCCEEDED",
      paymentMethod: method,
      paymentSource: cls.paymentSource,
      reconciliationStatus: cls.reconciliationStatus,
      txDate: receivedAt,
      description:
        (tx.description || `Event registration — ${reg.event.name}`).replace(
          / \(pay by (cash|check) at event\)/i,
          "",
        ) + ` — paid by ${eventOfflineMethodLabel(method).toLowerCase()}`,
      notes: `${tx.notes ? tx.notes + "\n" : ""}Received ${receivedAt.toISOString()} by staff${args.reference ? ` · ref: ${args.reference}` : ""}.`,
      recordedByUserId: args.actorUserId ?? tx.recordedByUserId ?? null,
    },
  });

  await prisma.eventRegistration.update({
    where: { id: reg.id },
    data: {
      amountPaid: due,
      receivedById: args.actorUserId ?? null,
      checkReference: args.reference || null,
      transactionId: tx.id,
      lastChargeError: null,
    },
  });

  await writeBillingAudit({
    clubId,
    memberId: reg.memberId,
    actorUserId: args.actorUserId ?? null,
    action: "EVENT_OFFLINE_PAYMENT_RECEIVED",
    before: { registrationId: reg.id, status: reg.status, amountDue: due },
    after: {
      registrationId: reg.id,
      status: "PAID",
      transactionId: tx.id,
      method,
      paymentSource: cls.paymentSource,
      reconciliationStatus: cls.reconciliationStatus,
      reference: args.reference || null,
      amount: due,
    },
    note: `${eventOfflineMethodLabel(method)} received for ${reg.event.name} — ${reg.name}.`,
  });

  // Receipt — only now, after real money changed hands.
  if (reg.email && !args.skipReceipt) {
    try {
      await sendPaymentReceiptEmail({
        to: reg.email,
        firstName: reg.name?.split(" ")[0] || "there",
        clubName: reg.club.name,
        description: `${reg.event.name} — event registration · Paid by ${eventOfflineMethodLabel(method)}`,
        amountPaid: `$${due.toFixed(2)}`,
        paidAt: receivedAt,
        portalUrl: `${getAppBaseUrl()}/member`,
      });
    } catch (e) {
      console.error("event offline receipt failed", e);
    }
  }

  return { ok: true, transactionId: tx.id, amount: due, method };
}

/**
 * The PENDING Transaction representing an event registration's amount DUE.
 *
 * Mirrors the membership cash/check rule exactly: acceptance ≠ payment. This
 * row is never revenue and never triggers a receipt — it flips to SUCCEEDED
 * only when staff records the physical payment (settleEventRegistrationOffline).
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
