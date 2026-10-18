import Stripe from "stripe";
import { applicationFeeCents, applicationFeePercent, feePolicyFor, type ClubFeeFields } from "@/lib/fees";

// Lazy singleton. `next build` imports every route module to collect page data,
// so a top-level `new Stripe(process.env.STRIPE_SECRET_KEY!)` — or a top-level
// throw when the key is absent — fails the build in any environment that doesn't
// have STRIPE_SECRET_KEY set (e.g. a local `npm run build` without a .env, or a
// preview build). We defer creation (and the missing-key error) to first real
// use at RUNTIME, where the key is present. Behavior is identical once the key
// is set; the client is still created exactly once.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key, { apiVersion: "2023-10-16" });
  }
  return _stripe;
}

// A Proxy so every existing `import { stripe } from "@/lib/stripe"` call site
// (`stripe.subscriptions.cancel(...)`, `stripe.checkout.sessions.create(...)`,
// `stripe.webhooks.constructEvent(...)`, …) keeps working unchanged, while the
// underlying client is instantiated lazily on first property access.
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const client = getStripe();
    const value = Reflect.get(client as object, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// The AthletixOS platform fee (2026-10-18): tier rate, percentage only,
// collected as `application_fee_amount` (one-time) or `application_fee_percent`
// (subscriptions) on the club's connected account. All math lives in
// lib/fees.ts — these wrappers exist so every Stripe call site states the
// club's fee policy explicitly.
//
// `netCents` is the CLUB'S price after discounts, BEFORE any gross-up — NOT
// the total the member is charged. Passing the grossed-up total would charge
// the platform fee on the platform fee.

export function calculatePlatformFee(netCents: number, club: ClubFeeFields): number {
  return applicationFeeCents(netCents, feePolicyFor(club));
}

/** application_fee_percent for a subscription whose club price is `netCents`. */
export function calculatePlatformFeePercent(netCents: number, club: ClubFeeFields): number {
  return applicationFeePercent(netCents, feePolicyFor(club));
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
    case "QUADRIMESTRAL": return { interval: "month", interval_count: 4 };
    case "SEMI_ANNUAL": return { interval: "month", interval_count: 6 };
    case "ANNUAL": return { interval: "year", interval_count: 1 };
    case "ONE_TIME": return null;
    default: return null;
  }
}
