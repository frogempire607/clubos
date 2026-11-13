// "They paid another way" on a PAST-DUE month marks the failed Stripe invoice
// paid outside Stripe (lib/membershipMoneyServer.paidAnotherWay). Stripe then
// sends invoice.paid for an invoice no card ever paid. The webhook must NOT
// turn that into a Transaction: the cash is already in the ledger as a
// CASH/CHECK row, and a second row would double the money and label it
// verified card revenue.
//
// Two independent signals, either one is enough:
//   1. Stripe's own flag on the invoice (`paid_out_of_band`).
//   2. Our cash row, which names the invoice it settled in its notes. This is
//      the belt for a payload that omits the flag (webhook events arrive on a
//      newer API version than the pinned SDK).

import { prisma } from "@/lib/prisma";

/** The marker a cash row's notes carry when it settled a Stripe invoice. */
export const SETTLED_INVOICE_MARK = "Settled Stripe invoice";

/** Pure: Stripe says this invoice was marked paid by hand, not by a charge. */
export function invoiceFlaggedOutOfBand(invoice: unknown): boolean {
  return (invoice as { paid_out_of_band?: unknown } | null)?.paid_out_of_band === true;
}

export async function settledOutsideStripe(invoice: unknown): Promise<boolean> {
  if (invoiceFlaggedOutOfBand(invoice)) return true;
  const id = (invoice as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return false;
  const row = await prisma.transaction.findFirst({
    where: { manual: true, stripeInvoiceId: null, paymentSource: { in: ["CASH", "CHECK"] }, notes: { contains: `${SETTLED_INVOICE_MARK} ${id} ` } },
    select: { id: true },
  });
  return !!row;
}
