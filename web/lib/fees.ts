// Centralized fee math — the ONLY place fee percentages live. Never hardcode
// 2.9% / $0.30 / a platform rate anywhere else. PURE and client-safe: no
// server-only imports.
//
// Two independent fees, and the club chooses who absorbs each (2026-10-18):
//
//   Stripe processing   2.9% + $0.30   club.passProcessingFees (default ON)
//   AthletixOS platform tier rate + $0.30 club.passPlatformFee (default OFF)
//
// `net` = what the club intends to receive (AFTER any discount — discounts
// always reduce `net` first, then the gross-up runs).
//
//   Neither passed     parent pays = net
//                      club nets   = net − stripe(net) − platform(net)
//   Processing passed  parent pays = (net + 0.30) / (1 − 0.029)
//                      club nets   = net − platform(parent pays)
//   Platform passed    parent pays = (net + 0.30) / (1 − rate)
//                      club nets   = net − stripe(parent pays)
//   Both passed        parent pays = (net + 0.60) / (1 − 0.029 − rate)
//                      club nets   = net
//
// The parent-facing total is the formula rounded UP to the cent (plus a cent
// in the rare case Stripe's own rounding would still leave the club short),
// so the club is never short. "Club nets" assumes Stripe's standard
// US card rate; Amex / international cards cost Stripe more and that
// difference lands on the club's connected account (direct charges).
//
// BUG FIXED 2026-10-18: the old math added round(net × 2.9%) and ignored
// Stripe's $0.30, so a $100 membership showed $102.90 and the club netted
// $99.62. It now charges $103.30 and the club nets $100.00.

import { getPlatformRate, getTierFeatures } from "@/lib/tier";

export const PROCESSING_FEE_PERCENT = 0.029;
export const PROCESSING_FEE_FIXED_CENTS = 30;

export type FeePolicy = {
  passProcessing: boolean;
  passPlatform: boolean;
  /** Fraction, e.g. 0.02. Floor-checked in lib/tier.ts. */
  platformRate: number;
  platformFixedCents: number;
};

/**
 * Legacy callers pass a bare boolean = "pass Stripe processing" with no
 * platform pass-through. Prefer passing a FeePolicy from feePolicyFor(club).
 */
export type FeePolicyInput = boolean | FeePolicy;

export function toPolicy(p: FeePolicyInput | null | undefined): FeePolicy {
  if (p && typeof p === "object") return p;
  return { passProcessing: !!p, passPlatform: false, platformRate: 0, platformFixedCents: 0 };
}

/** The club's fee policy. Defaults: processing passed? as stored; platform absorbed. */
// Fields REQUIRED (not optional) on purpose: a prisma `select` that forgets
// passPlatformFee or tier fails the type check instead of silently charging
// the wrong amount.
export type ClubFeeFields = {
  passProcessingFees: boolean | null;
  passPlatformFee: boolean | null;
  tier: string | null;
};
export function feePolicyFor(club: ClubFeeFields): FeePolicy {
  return {
    passProcessing: !!club.passProcessingFees,
    passPlatform: !!club.passPlatformFee,
    platformRate: getPlatformRate(club.tier),
    platformFixedCents: getTierFeatures(club.tier).platformFixedCents,
  };
}

/** Stripe's standard fee on a charge of `totalCents` (estimate: 2.9% + 30¢). */
export function stripeFeeCents(totalCents: number): number {
  if (totalCents <= 0) return 0;
  return Math.round(totalCents * PROCESSING_FEE_PERCENT) + PROCESSING_FEE_FIXED_CENTS;
}

/** Nominal platform fee on an amount: rate × amount + fixed. */
export function platformNominalCents(amountCents: number, p: FeePolicy): number {
  if (amountCents <= 0 || p.platformRate <= 0) return 0;
  return Math.round(amountCents * p.platformRate) + p.platformFixedCents;
}

export type ChargeQuote = {
  policy: FeePolicy;
  /** What the club intends to receive (after discounts). */
  netCents: number;
  /** What the paying member is charged. */
  totalCents: number;
  /** total − net: everything added on top of the club's price. */
  surchargeCents: number;
  /** Part of the surcharge that covers Stripe processing (display only). */
  processingPartCents: number;
  /** Part of the surcharge that covers the AthletixOS platform fee (display only). */
  platformPartCents: number;
  /** application_fee_amount to send to Stripe. */
  applicationFeeCents: number;
  /** Stripe's fee on the total, at the standard rate. */
  stripeFeeCents: number;
  /** What lands in the club's Stripe balance (standard card). */
  clubNetCents: number;
};

// ceil to the cent with a tolerance so 10330.0000001 doesn't become 10331.
function ceilCents(x: number): number {
  return Math.ceil(x - 1e-7);
}

/** The single gross-up. Every charge, subscription and display goes through this. */
export function quoteCharge(netCents: number, policyInput: FeePolicyInput): ChargeQuote {
  const p = toPolicy(policyInput);
  const net = Math.max(0, Math.round(Number.isFinite(netCents) ? netCents : 0));
  if (net <= 0) {
    return { policy: p, netCents: 0, totalCents: 0, surchargeCents: 0, processingPartCents: 0, platformPartCents: 0, applicationFeeCents: 0, stripeFeeCents: 0, clubNetCents: 0 };
  }
  const r = p.passPlatform ? p.platformRate : 0;
  const f = p.passPlatform ? p.platformFixedCents : 0;

  let total: number;
  if (p.passProcessing && p.passPlatform) total = ceilCents((net + PROCESSING_FEE_FIXED_CENTS + f) / (1 - PROCESSING_FEE_PERCENT - r));
  else if (p.passProcessing) total = ceilCents((net + PROCESSING_FEE_FIXED_CENTS) / (1 - PROCESSING_FEE_PERCENT));
  else if (p.passPlatform) total = ceilCents((net + f) / (1 - r));
  else total = net;

  // What the passed fees leave the club with, at total t.
  const covered = (t: number): boolean => {
    if (p.passProcessing && p.passPlatform) return t - stripeFeeCents(t) - platformNominalCents(t, p) >= net;
    if (p.passProcessing) return t - stripeFeeCents(t) >= net;
    if (p.passPlatform) return t - platformNominalCents(t, p) >= net;
    return true;
  };
  // The formula is rounded UP to the cent (above). Stripe rounds its own fee,
  // so on rare amounts that is still a cent short — only then add a cent. We
  // never round DOWN: the parent-facing total is always ≥ ceil(formula).
  let guard = 0;
  while (!covered(total) && guard++ < 10) total++;

  const stripe = stripeFeeCents(total);
  let app: number;
  if (p.passProcessing && p.passPlatform) app = total - stripe - net; // remainder → club nets exactly net
  else if (p.passPlatform) app = total - net; // parent covered the platform fee
  else if (p.passProcessing) app = platformNominalCents(total, p); // club pays platform on what parent paid
  else app = platformNominalCents(net, p);
  // Stripe requires application_fee ≤ charge; never push the club below zero
  // on a tiny charge either.
  app = Math.max(0, Math.min(app, total - stripe));

  const surcharge = total - net;
  let processingPart = 0;
  let platformPart = 0;
  if (p.passProcessing && p.passPlatform) {
    processingPart = Math.min(stripe, surcharge);
    platformPart = surcharge - processingPart;
  } else if (p.passProcessing) processingPart = surcharge;
  else if (p.passPlatform) platformPart = surcharge;

  return {
    policy: p,
    netCents: net,
    totalCents: total,
    surchargeCents: surcharge,
    processingPartCents: processingPart,
    platformPartCents: platformPart,
    applicationFeeCents: app,
    stripeFeeCents: stripe,
    clubNetCents: total - stripe - app,
  };
}

/** application_fee_amount for a one-time charge of a club price `netCents`. */
export function applicationFeeCents(netCents: number, policy: FeePolicyInput): number {
  return quoteCharge(netCents, policy).applicationFeeCents;
}

/**
 * application_fee_percent for a subscription whose recurring unit is the
 * grossed-up total of `netCents`. Stripe only takes a percent on
 * subscriptions, so the $0.30 fixed part is folded into the percent for this
 * unit amount. FLOORED to Stripe's 2-decimal precision so the club is never
 * short; the platform absorbs the sub-cent difference. If a coupon later
 * reduces an invoice, Stripe applies the same percent to the smaller amount.
 */
export function applicationFeePercent(netCents: number, policy: FeePolicyInput): number {
  const q = quoteCharge(netCents, policy);
  if (q.totalCents <= 0 || q.applicationFeeCents <= 0) return 0;
  return Math.floor((q.applicationFeeCents / q.totalCents) * 10000) / 100;
}

// ── Back-compatible helpers (all route through quoteCharge) ─────────────────

export type FeeBreakdown = {
  pass: boolean;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
};

/** Surcharge added on top of `subtotalCents` (0 when nothing is passed). */
export function computeProcessingFeeCents(subtotalCents: number, policy: FeePolicyInput = true): number {
  return quoteCharge(subtotalCents, policy).surchargeCents;
}

export function applyProcessingFee(subtotalCents: number, pass: FeePolicyInput): FeeBreakdown {
  const q = quoteCharge(subtotalCents, pass);
  const p = toPolicy(pass);
  return {
    pass: p.passProcessing || p.passPlatform,
    subtotalCents: Math.max(0, Math.round(subtotalCents)),
    feeCents: q.surchargeCents,
    totalCents: Math.max(q.totalCents, Math.round(subtotalCents) || 0),
  };
}

/** Label for the single surcharge line a member sees. */
export function surchargeLabel(policy: FeePolicyInput): string {
  const p = toPolicy(policy);
  if (p.passProcessing && p.passPlatform) return "Processing & service fee";
  if (p.passPlatform) return "Service fee";
  return "Processing fee";
}

// One-time `payment`-mode Stripe Checkout line item for the surcharge, or null
// when nothing is passed. Add it alongside the main line item so the member
// sees a clear, separate fee line.
export function processingFeeLineItem(
  subtotalCents: number,
  pass: FeePolicyInput,
): { quantity: number; price_data: { currency: string; unit_amount: number; product_data: { name: string } } } | null {
  const fee = quoteCharge(subtotalCents, pass).surchargeCents;
  if (fee <= 0) return null;
  return {
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: fee,
      product_data: { name: surchargeLabel(pass) },
    },
  };
}

// Subscription mode can't carry a one-time line item, so fold the surcharge
// into the recurring unit amount.
export function recurringUnitWithFee(subtotalCents: number, pass: FeePolicyInput): number {
  if (subtotalCents <= 0) return Math.max(0, Math.round(subtotalCents));
  return quoteCharge(subtotalCents, pass).totalCents;
}

/**
 * The PRE-2026-10-18 recurring formula (base + round(base × 2.9%), no $0.30).
 * Kept ONLY so code reading an existing Stripe subscription can recognise a
 * unit amount created before the fix. Never use it to create a charge.
 */
export function legacyRecurringUnitWithFee(subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  return subtotalCents + Math.round(subtotalCents * PROCESSING_FEE_PERCENT);
}

// Dollars-in / dollars-out breakdown for display surfaces. A displayed total
// always equals what recurringUnitWithFee actually charges.
export function feeBreakdown(priceDollars: number, pass: FeePolicyInput): { base: number; fee: number; total: number } {
  const cents = Number.isFinite(priceDollars) ? Math.round(priceDollars * 100) : 0;
  const b = applyProcessingFee(cents, pass);
  return { base: b.subtotalCents / 100, fee: b.feeCents / 100, total: b.totalCents / 100 };
}

// Human-readable description for settings / checkout copy.
export function describeProcessingFee(): string {
  const pct = (PROCESSING_FEE_PERCENT * 100).toFixed(1).replace(/\.0$/, "");
  return `${pct}% + $${(PROCESSING_FEE_FIXED_CENTS / 100).toFixed(2)}`;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Refunds: when a charge is refunded, the AthletixOS application fee is
 * refunded with it, proportionally (Stripe's default on direct charges is to
 * KEEP it). Stripe never returns its own processing fee. Every refunds.create
 * on a connected account must pass `refund_application_fee:
 * REFUND_APPLICATION_FEE` explicitly. Decision 2026-10-18 — flip here only. */
export const REFUND_APPLICATION_FEE = true;

/** True when anything (processing and/or platform) is added to the member's total. */
export function passesAnyFee(policy: FeePolicyInput | null | undefined): boolean {
  const p = toPolicy(policy);
  return p.passProcessing || p.passPlatform;
}
