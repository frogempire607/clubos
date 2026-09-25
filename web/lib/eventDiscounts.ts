// The ONE way an event discount is written onto a registration, and the ONE
// way it is read back for display. Every path — public /e/[slug], the member
// portal, staff at-the-door, staff roster, bill-registrants — goes through
// here so a code can't mean one thing on the roster and another in the email.
//
// Why the rule is snapshotted and not re-read: the owner can edit a code from
// 20% to 10%, expire it, or delete it outright. None of that may change what
// someone already agreed to owe. `findValidDiscountFor` is consulted at
// REDEMPTION time; after that, the four columns on the registration are the
// contract. lib/eventRepricing.ts reads them and nothing else.
//
// No stacking, by construction: one code per registration. Applying a second
// REPLACES the first — `registrationDiscountFields` overwrites all five
// columns every time, so there is no path that adds two discounts together.

import type { ValidDiscount } from "@/lib/discounts";
import type { AppliedDiscount } from "@/lib/eventAutoDiscounts";
import { applyProcessingFee } from "@/lib/fees";

/**
 * The columns to write on an EventRegistration for a resolved discount.
 * Pass `null` to clear a discount (staff removing a code) — every column is
 * nulled, never left half-populated.
 *
 * `gross` is the list price the discount was applied to; the returned
 * `amountDue` is the NET the registrant owes. Callers must persist BOTH — the
 * whole design rests on amountDue being net and discountAmount explaining it.
 */
export function registrationDiscountFields(
  discount: ValidDiscount | AppliedDiscount | null,
  gross: number,
): {
  amountDue: number;
  discountId: string | null;
  discountCode: string | null;
  discountType: string | null;
  discountValue: number | null;
  discountAmount: number | null;
  discountSource: string | null;
  discountLabel: string | null;
} {
  const base = Math.max(0, Math.round(gross * 100) / 100);
  if (!discount) {
    return {
      amountDue: base,
      discountId: null,
      discountCode: null,
      discountType: null,
      discountValue: null,
      discountAmount: null,
      discountSource: null,
      discountLabel: null,
    };
  }
  // B3 slice 1: a sibling / group / coach discount has no code and no
  // Discount row — only CODE carries discountId/discountCode.
  const applied = toApplied(discount);
  const cut = discount.type === "PERCENT" ? (base * discount.value) / 100 : discount.value;
  const net = Math.max(0, Math.round((base - cut) * 100) / 100);
  return {
    amountDue: net,
    discountId: applied.source === "CODE" ? applied.id : null,
    discountCode: applied.source === "CODE" ? applied.code : null,
    discountType: applied.type,
    discountValue: applied.value,
    discountAmount: Math.round((base - net) * 100) / 100,
    discountSource: applied.source,
    discountLabel: applied.label,
  };
}

/** A typed code, seen as the one discount a registration carries. */
export function toApplied(d: ValidDiscount | AppliedDiscount): AppliedDiscount {
  if ("source" in d && typeof (d as AppliedDiscount).source === "string") return d as AppliedDiscount;
  const v = d as ValidDiscount & { description?: string | null };
  return {
    source: "CODE",
    id: v.id,
    code: v.code,
    type: v.type === "FIXED" ? "FIXED" : "PERCENT",
    value: Number(v.value),
    label: discountLineLabel(v) ?? v.code,
  };
}

/** What a stored registration's discount is called — the code line, or the
 *  rule's own name for a sibling / group / coach discount. */
export function registrationDiscountName(reg: {
  discountCode?: string | null;
  discountLabel?: string | null;
}): string | null {
  return (reg.discountLabel || "").trim() || (reg.discountCode || "").trim() || null;
}

/**
 * The customer-facing money lines for an event registration, in the order
 * every surface renders them. `net` is what the discount brings the price to;
 * `total` is what the card is actually charged.
 *
 * THE FEE RULE: the processing fee is computed from `net`, never from `gross`.
 * A club passing fees on a $450 camp with a 10% code charges $405 + $11.75 =
 * $416.75 — not $450 + $13.05 discounted afterwards.
 */
export function eventChargeBreakdown(args: {
  gross: number;
  discount: ValidDiscount | null;
  passProcessingFees: boolean;
}): {
  gross: number;
  discountOff: number;
  net: number;
  processingFee: number;
  total: number;
  code: string | null;
  label: string | null;
} {
  const f = registrationDiscountFields(args.discount, args.gross);
  const netCents = Math.round(f.amountDue * 100);
  const fees = applyProcessingFee(netCents, args.passProcessingFees && f.amountDue > 0);
  return {
    gross: Math.max(0, Math.round(args.gross * 100) / 100),
    discountOff: f.discountAmount ?? 0,
    net: f.amountDue,
    processingFee: fees.feeCents / 100,
    total: fees.totalCents / 100,
    code: f.discountCode,
    label: discountLineLabel(args.discount),
  };
}

/** "Sibling discount (SIB50)" — the description when the owner set one, else
 *  the bare code. Rendered on the roster, the invoice email, and the receipt. */
export function discountLineLabel(
  d: { code: string | null; description?: string | null; source?: string; label?: string } | null | undefined,
): string | null {
  if (!d) return null;
  if (d.source && d.source !== "CODE" && d.label) return d.label;
  if (!d.code) return d.label ?? null;
  const name = (d.description || "").trim();
  return name && name.toUpperCase() !== d.code.toUpperCase() ? `${name} (${d.code})` : d.code;
}

/** The registration columns every surface needs to render a discount. Keep in
 *  sync with PricingRegistration in lib/eventRepricing.ts. */
export const REGISTRATION_DISCOUNT_SELECT = {
  discountCode: true,
  discountType: true,
  discountValue: true,
  discountAmount: true,
  discountSource: true,
  discountLabel: true,
} as const;
