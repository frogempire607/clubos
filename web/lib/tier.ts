// Single source of truth for AthletixOS plans. There is NO free/Starter tier —
// every club is on at least Growth. Never hardcode tier checks elsewhere;
// always go through these helpers.

export type Tier = "growth" | "pro" | "enterprise";

export const DEFAULT_TIER: Tier = "growth";

export const TIER_PRICES: Record<Tier, { monthly: number; setup: number; label: string; tagline: string }> = {
  growth: {
    monthly: 50,
    setup: 0,
    label: "Growth",
    tagline: "Everything you need to run your club.",
  },
  pro: {
    monthly: 99,
    setup: 0,
    label: "Pro",
    tagline: "Built for growing, professional organizations.",
  },
  enterprise: {
    monthly: 199,
    setup: 0,
    label: "Enterprise",
    tagline: "Powerful infrastructure for large-scale operations.",
  },
};

// AthletixOS takes NO per-transaction platform cut on any plan. Clubs may
// optionally pass Stripe's processing fee to the customer — that math lives in
// lib/fees.ts and is unrelated to this (always-0) platform fee.
export const TIER_FEATURES = {
  growth: {
    maxMembers: 200,
    maxLocations: 1,
    multiLocation: false,
    transactionFeePercent: 0,
    classes: true,
    attendance: true,
    documents: true,
    announcements: true,
    directMessaging: true,
    privateLessons: true,
    csvImport: true,
    reports: true,
    plaid: false,
    emailSms: false,
    brandedApp: false,
    advancedAnalytics: false,
    api: false,
    sso: false,
    advancedPermissions: false,
    prioritySupport: false,
  },
  pro: {
    maxMembers: null,
    maxLocations: 3,
    multiLocation: true,
    transactionFeePercent: 0,
    classes: true,
    attendance: true,
    documents: true,
    announcements: true,
    directMessaging: true,
    privateLessons: true,
    csvImport: true,
    reports: true,
    plaid: true,
    emailSms: true,
    brandedApp: true,
    advancedAnalytics: true,
    api: false,
    sso: false,
    advancedPermissions: false,
    prioritySupport: true,
  },
  enterprise: {
    maxMembers: null,
    maxLocations: null,
    multiLocation: true,
    transactionFeePercent: 0,
    classes: true,
    attendance: true,
    documents: true,
    announcements: true,
    directMessaging: true,
    privateLessons: true,
    csvImport: true,
    reports: true,
    plaid: true,
    emailSms: true,
    brandedApp: true,
    advancedAnalytics: true,
    api: true,
    sso: true,
    advancedPermissions: true,
    prioritySupport: true,
  },
} as const;

export type TierFeatureKey = keyof (typeof TIER_FEATURES)["growth"];

export function normalizeTier(tier: string | null | undefined): Tier {
  return tier === "growth" || tier === "pro" || tier === "enterprise" ? tier : DEFAULT_TIER;
}

export function getTierFeatures(tier: string) {
  return TIER_FEATURES[normalizeTier(tier)];
}

export function canUseFeature(tier: string, feature: TierFeatureKey): boolean {
  const val = getTierFeatures(tier)[feature];
  if (typeof val === "boolean") return val;
  return true; // numeric/null limits are checked by the caller
}

export function getTierName(tier: string): string {
  return TIER_PRICES[normalizeTier(tier)].label;
}

export function getTierFee(tier: string): number {
  return getTierFeatures(tier).transactionFeePercent;
}

// Lowest tier that unlocks a feature (for "upgrade required" CTAs).
export function upgradeRequired(_tier: string, feature: TierFeatureKey): Tier | null {
  const order: Tier[] = ["growth", "pro", "enterprise"];
  for (const t of order) {
    const val = TIER_FEATURES[t][feature];
    if (typeof val === "boolean" ? val : val !== 0 && val !== null) return t;
  }
  return null;
}

/**
 * Standard JSON 403 body for tier-gated features. Caller turns this into
 * `NextResponse.json(body, { status: 403 })`.
 */
export function tierBlockedBody(args: { message: string; upgradeRequired?: Tier | null }) {
  return {
    error: args.message,
    code: "UPGRADE_REQUIRED",
    upgradeRequired: args.upgradeRequired ?? null,
  };
}
