import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// AthletixOS takes NO per-transaction platform cut on any plan — every tier is
// a flat monthly subscription. Kept as a function so existing Connect
// application_fee call sites stay valid (they just resolve to 0).
export function platformFeeBps(_tier: string): number {
  return 0;
}

export function calculatePlatformFee(_amountInCents: number, _tier: string): number {
  return 0;
}

// Convert our billingPeriod enum -> Stripe recurring config
export function billingPeriodToStripeInterval(period: string): {
  interval: "day" | "week" | "month" | "year";
  interval_count: number;
} | null {
  switch (period) {
    case "WEEKLY": return { interval: "week", interval_count: 1 };
    case "MONTHLY": return { interval: "month", interval_count: 1 };
    case "QUARTERLY": return { interval: "month", interval_count: 3 };
    case "SEMI_ANNUAL": return { interval: "month", interval_count: 6 };
    case "ANNUAL": return { interval: "year", interval_count: 1 };
    case "ONE_TIME": return null;
    default: return null;
  }
}
