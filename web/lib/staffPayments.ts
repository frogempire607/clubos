// ONE shared model for staff/owner-assisted payments: the payment-method
// vocabulary, the payment state machine, server-side discount resolution, and
// the pricing quote every surface displays and every route charges. No page
// may implement its own variant of any of these.
import { prisma } from "@/lib/prisma";
import { findValidDiscountFor, discountedPrice, type DiscountItemType } from "@/lib/discounts";
import { applyProcessingFee } from "@/lib/fees";

// ── Payment methods a staff member can choose ─────────────────────────────
export const STAFF_PAYMENT_METHODS = [
  "SAVED_CARD", //      off-session charge / subscription on the saved method
  "NEW_CARD", //        Stripe-hosted checkout / setup link
  "CASH", //            offline — staff must record receipt of the money
  "CHECK", //           offline — staff must record receipt of the money
  "EXTERNAL_READER", // record only — AthletixOS never charges (where applicable)
] as const;
export type StaffPaymentMethod = (typeof STAFF_PAYMENT_METHODS)[number];

export const STAFF_PAYMENT_METHOD_LABELS: Record<StaffPaymentMethod, string> = {
  SAVED_CARD: "Saved card",
  NEW_CARD: "New card (secure Stripe page)",
  CASH: "Cash",
  CHECK: "Check",
  EXTERNAL_READER: "External reader — record only",
};

export const isOfflineMethod = (m: string | null | undefined): m is "CASH" | "CHECK" =>
  m === "CASH" || m === "CHECK";

// ── Payment states (shared vocabulary — "Approved" NEVER means paid) ──────
export const PAYMENT_STATES = [
  "DRAFT",
  "WAITING_CLIENT",
  "CLIENT_ACCEPTED",
  "AWAITING_CARD",
  "AWAITING_CASH",
  "AWAITING_CHECK",
  "PROCESSING",
  "PAID",
  "FAILED",
  "CANCELED",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  DRAFT: "Draft",
  WAITING_CLIENT: "Waiting for client",
  CLIENT_ACCEPTED: "Client accepted",
  AWAITING_CARD: "Awaiting card",
  AWAITING_CASH: "Client accepted — awaiting cash payment",
  AWAITING_CHECK: "Client accepted — awaiting check payment",
  PROCESSING: "Payment processing",
  PAID: "Paid",
  FAILED: "Failed",
  CANCELED: "Canceled",
};

// ── Offline activation policy ──────────────────────────────────────────────
// 'ON_PAYMENT' (default — safer): a cash/check membership activates only when
// staff records the money as physically received. 'ON_ACCEPTANCE': it
// activates when the client accepts, with the payment still due.
export type OfflineActivationPolicy = "ON_ACCEPTANCE" | "ON_PAYMENT";
export function offlineActivationPolicy(club: { offlineActivationPolicy?: string | null }): OfflineActivationPolicy {
  return club.offlineActivationPolicy === "ON_ACCEPTANCE" ? "ON_ACCEPTANCE" : "ON_PAYMENT";
}

// ── Discount resolution (server-side, block-on-invalid) ───────────────────
export type ResolvedStaffDiscount = {
  id: string;
  code: string;
  description: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
};

/**
 * Resolve a staff-selected discount code for an item. `null`/empty code is a
 * valid no-discount selection. An INVALID code (removed, expired, inactive,
 * exhausted, or not eligible for this item) is a HARD error — callers must
 * block the purchase with the message, never silently ignore it. Exactly one
 * discount may apply (the model has no stacking configuration, so stacking is
 * refused by construction).
 */
export async function resolveStaffDiscount(
  clubId: string,
  rawCode: string | null | undefined,
  item: { type: DiscountItemType; membershipId?: string | null },
): Promise<{ ok: true; discount: ResolvedStaffDiscount | null } | { ok: false; error: string }> {
  const code = (rawCode || "").trim();
  if (!code) return { ok: true, discount: null };
  const check = await findValidDiscountFor(clubId, code, item);
  if (!check.ok) return { ok: false, error: check.error };
  const row = await prisma.discount.findFirst({
    where: { clubId, id: check.discount.id },
    select: { description: true },
  });
  return {
    ok: true,
    discount: {
      id: check.discount.id,
      code: check.discount.code,
      description: row?.description ?? null,
      type: check.discount.type as "PERCENT" | "FIXED",
      value: Number(check.discount.value),
    },
  };
}

// ── The quote every surface shows and every route charges ─────────────────
export type PaymentQuote = {
  originalPrice: number; //   configured price before anything
  discountAmount: number; //  how much the discount takes off
  finalPrice: number; //      original − discount (never < 0)
  processingFee: number; //   card fee passthrough on finalPrice (0 offline)
  totalCharged: number; //    what the card is charged / the cash-check amount due
};

// Stripe refuses card charges under $0.50; offline records have no minimum.
const STRIPE_MIN_CHARGE = 0.5;

export function quotePayment(args: {
  originalPrice: number;
  discount: ResolvedStaffDiscount | null;
  method: StaffPaymentMethod | null; // null = unknown yet → treat as card for fee display
  passProcessingFees: boolean;
}): { ok: true; quote: PaymentQuote } | { ok: false; error: string } {
  const original = Math.max(0, Math.round(args.originalPrice * 100) / 100);
  const final = args.discount
    ? discountedPrice(original, {
        id: args.discount.id,
        code: args.discount.code,
        type: args.discount.type,
        value: args.discount.value,
      })
    : original;
  const discountAmount = Math.round((original - final) * 100) / 100;
  const isCard = args.method === "SAVED_CARD" || args.method === "NEW_CARD" || args.method == null;
  const fees = applyProcessingFee(Math.round(final * 100), isCard && args.passProcessingFees && final > 0);
  const quote: PaymentQuote = {
    originalPrice: original,
    discountAmount,
    finalPrice: final,
    processingFee: fees.feeCents / 100,
    totalCharged: fees.totalCents / 100,
  };
  if (quote.finalPrice < 0) return { ok: false, error: "Discount would make the total negative." };
  if (isCard && quote.finalPrice > 0 && quote.finalPrice < STRIPE_MIN_CHARGE) {
    return {
      ok: false,
      error: `Card charges must be at least $${STRIPE_MIN_CHARGE.toFixed(2)} — this discount brings the total below that. Use cash/check or adjust the discount.`,
    };
  }
  return { ok: true, quote };
}

/** Receipt/description line: "SIBLING Discount Applied" (description preferred when set). */
export function discountAppliedLabel(d: { code: string; description?: string | null } | null | undefined): string | null {
  if (!d) return null;
  const name = (d.description || d.code).trim();
  return `${name} Discount Applied`;
}
