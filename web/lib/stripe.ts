import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

export function platformFeeBps(tier: string): number {
  switch (tier) {
    case "starter": return 250;
    case "growth": return 125;
    case "pro": return 0;
    case "enterprise": return 0;
    default: return 250;
  }
}

export function calculatePlatformFee(amountInCents: number, tier: string): number {
  const bps = platformFeeBps(tier);
  return Math.round((amountInCents * bps) / 10000);
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
