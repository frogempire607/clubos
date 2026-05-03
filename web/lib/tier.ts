export type Tier = "starter" | "growth" | "pro" | "enterprise";

export const TIER_PRICES: Record<Tier, { monthly: number; setup: number; label: string }> = {
  starter:    { monthly: 0,   setup: 0,  label: "Starter" },
  growth:     { monthly: 49,  setup: 0,  label: "Growth" },
  pro:        { monthly: 99,  setup: 50, label: "Pro" },
  enterprise: { monthly: 199, setup: 50, label: "Enterprise" },
};

export const TIER_FEATURES = {
  starter: {
    maxMembers: 150,
    maxLocations: 1,
    directMessaging: true,
    emailSms: false,
    reports: false,
    plaid: false,
    brandedApp: false,
    multiLocation: false,
    transactionFeePercent: 2.5,
    announcements: true,
    documents: true,
    classes: true,
    attendance: true,
  },
  growth: {
    maxMembers: null,
    maxLocations: 3,
    directMessaging: true,
    emailSms: false,
    reports: true,
    plaid: true,
    brandedApp: false,
    multiLocation: false,
    transactionFeePercent: 1.25,
    announcements: true,
    documents: true,
    classes: true,
    attendance: true,
  },
  pro: {
    maxMembers: null,
    maxLocations: 5,
    directMessaging: true,
    emailSms: true,
    reports: true,
    plaid: true,
    brandedApp: true,
    multiLocation: false,
    transactionFeePercent: 0,
    announcements: true,
    documents: true,
    classes: true,
    attendance: true,
  },
  enterprise: {
    maxMembers: null,
    maxLocations: null,
    directMessaging: true,
    emailSms: true,
    reports: true,
    plaid: true,
    brandedApp: true,
    multiLocation: true,
    transactionFeePercent: 0,
    announcements: true,
    documents: true,
    classes: true,
    attendance: true,
  },
} as const;

export type TierFeatureKey = keyof (typeof TIER_FEATURES)["starter"];

export function getTierFeatures(tier: string) {
  return TIER_FEATURES[(tier as Tier)] ?? TIER_FEATURES.starter;
}

export function canUseFeature(tier: string, feature: TierFeatureKey): boolean {
  const f = getTierFeatures(tier);
  const val = f[feature];
  if (typeof val === "boolean") return val;
  return true; // numeric/null = caller checks the limit
}

export function getTierName(tier: string): string {
  return TIER_PRICES[(tier as Tier)]?.label ?? "Starter";
}

export function getTierFee(tier: string): number {
  return getTierFeatures(tier).transactionFeePercent;
}

export function upgradeRequired(tier: string, feature: TierFeatureKey): Tier | null {
  const tiers: Tier[] = ["starter", "growth", "pro", "enterprise"];
  for (const t of tiers) {
    const f = TIER_FEATURES[t];
    const val = f[feature];
    if (typeof val === "boolean" && val) return t;
    if (typeof val !== "boolean") return t;
  }
  return null;
}

/**
 * Standard JSON 403 body for tier-gated features. Caller turns this into
 * `NextResponse.json(body, { status: 403 })`.
 */
export function tierBlockedBody(args: {
  message: string;
  upgradeRequired?: Tier | null;
}) {
  return {
    error: args.message,
    code: "UPGRADE_REQUIRED",
    upgradeRequired: args.upgradeRequired ?? null,
  };
}
