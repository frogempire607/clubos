// The renewal lines a screen shows, for any set of memberships: the facts from
// the rows, Stripe's stop dates from what Stripe last told us
// (lib/stripeStops), and the one rule (lib/renewalTruth). Reads only.

import { feeBreakdown, passesAnyFee, type FeePolicyInput } from "@/lib/fees";
import { renewalLine, renewalTruth, switchLine, type RenewalTruth } from "@/lib/renewalTruth";
import { loadStripeStops, stopOf, type StripeStops } from "@/lib/stripeStops";

export type RenewalRow = {
  id: string;
  status: string;
  price: unknown;
  billingType?: string | null;
  autoRenew: boolean;
  endDate: Date | null;
  currentPeriodEnd: Date | null;
  paidThroughDate: Date | null;
  canceledAt?: Date | null;
  expiredAt?: Date | null;
  stripeSubscriptionId: string | null;
};

export type RenewalView = { kind: RenewalTruth["kind"]; line: string; switchText: string; endsAt: string | null; renewsAt: string | null; mismatch: RenewalTruth["mismatch"] };

/** What a renewal is charged: the price, plus the fee the club passes on to cards. */
export function renewalAmount(row: Pick<RenewalRow, "price" | "stripeSubscriptionId">, fees: FeePolicyInput): number {
  const price = Number(row.price ?? 0) || 0;
  return row.stripeSubscriptionId && price > 0 && passesAnyFee(fees) ? feeBreakdown(price, fees).total : price;
}

export function truthFor(row: RenewalRow, stops: StripeStops, fees: FeePolicyInput): RenewalTruth {
  return renewalTruth({
    hasStripe: !!row.stripeSubscriptionId,
    status: row.status,
    autoRenew: row.autoRenew,
    endDate: row.endDate,
    stripeStop: stopOf(stops, row.stripeSubscriptionId),
    currentPeriodEnd: row.currentPeriodEnd,
    paidThroughDate: row.paidThroughDate,
    canceledAt: row.canceledAt,
    expiredAt: row.expiredAt,
    amount: renewalAmount(row, fees),
  });
}

export function viewOf(t: RenewalTruth, now: Date): RenewalView {
  return {
    kind: t.kind,
    line: renewalLine(t, now),
    switchText: switchLine(t, now),
    endsAt: t.endsAt ? t.endsAt.toISOString() : null,
    renewsAt: t.renewsAt ? t.renewsAt.toISOString() : null,
    mismatch: t.mismatch,
  };
}

export async function renewalViews(rows: RenewalRow[], fees: FeePolicyInput, now: Date): Promise<Record<string, RenewalView>> {
  const stops = await loadStripeStops(rows.map((r) => r.stripeSubscriptionId));
  return Object.fromEntries(rows.map((r) => [r.id, viewOf(truthFor(r, stops, fees), now)]));
}

export const RENEWAL_SELECT = {
  id: true,
  status: true,
  price: true,
  autoRenew: true,
  endDate: true,
  currentPeriodEnd: true,
  paidThroughDate: true,
  canceledAt: true,
  expiredAt: true,
  stripeSubscriptionId: true,
} as const;
