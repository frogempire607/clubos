// Centralized Stripe processing-fee math. The ONLY place fee percentages live —
// never hardcode 2.9% / $0.30 anywhere else. When a club enables
// `passProcessingFees`, the fee is transparently added to the customer's
// checkout total so the club nets the full intended amount.

// Stripe US standard processing rate. The fixed component defaults to 0 so the
// surcharge is the clean, predictable amount shown to members (e.g. $100 →
// +$2.90 → $102.90). Set PROCESSING_FEE_FIXED_CENTS to 30 to also recover
// Stripe's per-transaction $0.30.
export const PROCESSING_FEE_PERCENT = 0.029;
export const PROCESSING_FEE_FIXED_CENTS = 0;

export type FeeBreakdown = {
  pass: boolean;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
};

export function computeProcessingFeeCents(subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  return Math.round(subtotalCents * PROCESSING_FEE_PERCENT) + PROCESSING_FEE_FIXED_CENTS;
}

// Resolve what the customer is actually charged. When `pass` is false the
// breakdown still returns (feeCents 0) so callers can render uniformly.
export function applyProcessingFee(subtotalCents: number, pass: boolean): FeeBreakdown {
  const feeCents = pass ? computeProcessingFeeCents(subtotalCents) : 0;
  return {
    pass,
    subtotalCents,
    feeCents,
    totalCents: subtotalCents + feeCents,
  };
}

// One-time `payment`-mode Stripe Checkout line item for the surcharge, or null
// when the club isn't passing fees. Add it alongside the main line item so the
// member sees a clear, separate "Processing fee" line.
export function processingFeeLineItem(
  subtotalCents: number,
  pass: boolean,
): { quantity: number; price_data: { currency: string; unit_amount: number; product_data: { name: string } } } | null {
  const fee = pass ? computeProcessingFeeCents(subtotalCents) : 0;
  if (fee <= 0) return null;
  return {
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: fee,
      product_data: { name: "Processing fee" },
    },
  };
}

// Subscription mode can't carry a one-time line item, so fold the fee into the
// recurring unit amount. Returns the amount the recurring price should charge.
export function recurringUnitWithFee(subtotalCents: number, pass: boolean): number {
  return subtotalCents + (pass ? computeProcessingFeeCents(subtotalCents) : 0);
}

// Human-readable description for settings / checkout copy.
export function describeProcessingFee(): string {
  const pct = (PROCESSING_FEE_PERCENT * 100).toFixed(1).replace(/\.0$/, "");
  const fixed = PROCESSING_FEE_FIXED_CENTS > 0 ? ` + $${(PROCESSING_FEE_FIXED_CENTS / 100).toFixed(2)}` : "";
  return `${pct}%${fixed}`;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
