// Helpers for the Cash & Offline surface. Every non-Stripe transaction row
// runs through here so the surface stays consistent: recorded-by attribution,
// paymentSource labels, refund flags, and receipt state. The rules live in
// one place so the Stripe tab, Cash & Offline tab, Money In tab, and reports
// never disagree.

import type { PaymentSource } from "@/lib/paymentSources";

// The set of paymentSource values that belong to the Cash & Offline surface —
// everything that did NOT come through Stripe. EXTERNAL_READER is included:
// it's a card record but AthletixOS did not charge it (no Stripe object).
export const OFFLINE_PAYMENT_SOURCES: PaymentSource[] = [
  "CASH",
  "CHECK",
  "EXTERNAL_READER",
  "COMP",
  "MANUAL_ADJUSTMENT",
];

export function isOfflineSource(source: string | null | undefined): boolean {
  return source != null && (OFFLINE_PAYMENT_SOURCES as string[]).includes(source);
}

export function isStripeSource(source: string | null | undefined): boolean {
  return source === "STRIPE";
}

// Refund label for the UI — reads better than the raw column values and
// gives us a single place to swap language later.
export function refundReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Refund recorded";
  switch (reason) {
    case "reconciled_void":
      return "Voided by reconciliation";
    case "duplicate":
      return "Duplicate — voided";
    case "chargeback":
      return "Chargeback";
    case "manual":
      return "Manual refund";
    default:
      return reason.charAt(0).toUpperCase() + reason.slice(1).replace(/_/g, " ");
  }
}

// Cash & Offline state pill. Never claims a row is "paid" if it is PENDING;
// never says "refunded" if the amount is still zero.
export function offlineTransactionState(row: {
  status: string;
  paymentSource: string | null;
  refundedAt: Date | string | null;
  refundedAmount: unknown;
}): { key: "PAID" | "PENDING" | "REFUNDED" | "VOID" | "OTHER"; label: string } {
  const refunded = Number(row.refundedAmount ?? 0);
  if (row.refundedAt || refunded > 0) return { key: "REFUNDED", label: "Refunded" };
  if (row.status === "PENDING") return { key: "PENDING", label: "Awaiting payment" };
  if (row.status === "SUCCEEDED") return { key: "PAID", label: "Received" };
  if (row.status === "FAILED") return { key: "OTHER", label: "Failed" };
  return { key: "OTHER", label: row.status.charAt(0) + row.status.slice(1).toLowerCase() };
}
