import Stripe from "stripe";

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
