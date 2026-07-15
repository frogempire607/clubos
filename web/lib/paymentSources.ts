// Single source of truth for payment-source + reconciliation-status
// vocabulary. Every surface that labels or buckets money (Financials, reports,
// receipts, attendance, reconciliation) must use these definitions — never
// re-derive them from paymentMethod strings.

export const PAYMENT_SOURCES = [
  "STRIPE", //            Stripe-processed card payment (Connect)
  "CASH", //              offline cash, AthletixOS-recorded only
  "CHECK", //             offline check, AthletixOS-recorded only
  "EXTERNAL_READER", //   card collected on an external reader — RECORD ONLY,
  //                      AthletixOS did not charge; never Stripe-confirmed
  "COMP", //              comped / no charge
  "MANUAL_ADJUSTMENT", // owner-entered manual/invoice adjustment
] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const PAYMENT_SOURCE_LABELS: Record<PaymentSource, string> = {
  STRIPE: "Stripe",
  CASH: "Cash",
  CHECK: "Check",
  EXTERNAL_READER: "External card reader (record only)",
  COMP: "Comp",
  MANUAL_ADJUSTMENT: "Manual adjustment",
};

export const RECONCILIATION_STATUSES = [
  "VERIFIED", //   confirmed by a Stripe object (invoice/PI/charge id on row)
  "OFFLINE", //    cash/check/comp — nothing in Stripe to verify against
  "UNVERIFIED", // card record with NO Stripe confirmation (external reader);
  //              must never be displayed or counted as verified Stripe revenue
  "REVIEW", //    claims to be Stripe money but carries no Stripe id
  "VOID", //      voided/reclassified — excluded from ALL revenue aggregates
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  VERIFIED: "Verified (Stripe)",
  OFFLINE: "Offline record",
  UNVERIFIED: "Unverified external payment",
  REVIEW: "Needs review",
  VOID: "Voided",
};

/** Prisma where-fragment: exclude voided rows from every revenue aggregate. */
export const EXCLUDE_VOID = { NOT: { reconciliationStatus: "VOID" } } as const;

/**
 * Classification for attendance/at-the-door payment methods
 * (app/api/attendance/charge). CREDIT is the external-reader option: it only
 * records — AthletixOS does not charge the card — so it is UNVERIFIED.
 */
export function attendanceMethodClassification(method: string): {
  paymentSource: PaymentSource;
  reconciliationStatus: ReconciliationStatus;
} {
  switch (method) {
    case "CASH":
      return { paymentSource: "CASH", reconciliationStatus: "OFFLINE" };
    case "CHECK":
      return { paymentSource: "CHECK", reconciliationStatus: "OFFLINE" };
    case "CREDIT":
      return { paymentSource: "EXTERNAL_READER", reconciliationStatus: "UNVERIFIED" };
    case "COMP":
      return { paymentSource: "COMP", reconciliationStatus: "OFFLINE" };
    default:
      return { paymentSource: "MANUAL_ADJUSTMENT", reconciliationStatus: "OFFLINE" };
  }
}
