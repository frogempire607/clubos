// Single source of truth for AthletixOS plans (2026-10-18 pricing overhaul).
//
// Model: base + platform fee. Every plan charges a per-transaction AthletixOS
// platform fee (a percentage only — no fixed per-transaction part since
// 2026-10-18 pm) collected as a Stripe Connect application fee on
// the club's connected account. The club chooses, in Member payments settings,
// whether it or the paying member absorbs (a) Stripe processing and (b) the
// platform fee — see lib/fees.ts for the math.
//
// Gating principle: NEVER gate a feature that increases a club's payment
// volume (memberships, checkout, events, products, private lessons, discounts
// all stay on Starter). Gate features that save a club LABOR.
//
// Never hardcode tier checks elsewhere; always go through these helpers.
// Server routes enforce gates with lib/tierGuard.ts — hiding UI is not gating.

export type Tier = "starter" | "pro" | "enterprise";

export const DEFAULT_TIER: Tier = "starter";
export const TIER_ORDER: Tier[] = ["starter", "pro", "enterprise"];

// ── Platform fee floor ──────────────────────────────────────────────────────
// HARD RULE: the platform rate may never be set below 1.4%. Serving a club
// costs AthletixOS ~1.21% of gross volume in Stripe Connect fees (1% of payout
// volume + 0.25% + $0.25 per payout + $2/active account/month), so any rate
// below 1.4% loses money on every transaction. Every place a rate is resolved
// or set must go through assertPlatformRate().
export const PLATFORM_RATE_FLOOR = 0.014;
// The AthletixOS platform fee is PERCENTAGE ONLY (Julian, 2026-10-18 pm). Kept
// as a field set to 0 so the fee math stays one formula; Stripe's own
// 2.9% + $0.30 is a separate constant in lib/fees.ts and is unchanged.
export const PLATFORM_FIXED_CENTS = 0;

export function assertPlatformRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < PLATFORM_RATE_FLOOR) {
    throw new Error(
      `Platform rate ${rate} is below the ${PLATFORM_RATE_FLOOR * 100}% floor — AthletixOS's own Stripe Connect cost is ~1.21% of volume.`,
    );
  }
  if (rate >= 0.2) throw new Error(`Platform rate ${rate} is implausibly high`);
  return rate;
}

export const TIER_PRICES: Record<Tier, { monthly: number; setup: number; label: string; tagline: string }> = {
  starter: {
    monthly: 0,
    setup: 0,
    label: "Starter",
    tagline: "Everything you need to take payments and run your club.",
  },
  pro: {
    monthly: 99,
    setup: 0,
    label: "Pro",
    tagline: "Automation that saves your staff hours every week.",
  },
  enterprise: {
    monthly: 199,
    setup: 0,
    label: "Enterprise",
    tagline: "Multiple entities, unlimited accounts, custom roles.",
  },
};

// Boolean feature = included or not. Numeric limit: null = unlimited.
export const TIER_FEATURES = {
  starter: {
    // money / limits
    platformRate: 0.02,
    platformFixedCents: PLATFORM_FIXED_CENTS,
    maxMembers: null,
    maxLocations: 1,
    maxEntities: 1,
    maxBankAccounts: 1,
    maxStaffSeats: 5,
    multiLocation: false,
    // Starter — never gated (volume or core)
    classes: true,
    attendance: true,
    privateLessons: true,
    announcements: true,
    // Email + group announcements are Starter. (Key kept as `emailSms` because
    // ~6 routes read it; there is no SMS sender today.)
    emailSms: true,
    csvImport: true,
    // Reports: Starter sees the Membership tab only. `reports` = Membership tab.
    reports: true,
    // Pro
    brandedApp: false,
    privateMessaging: false,
    eventToolkit: false,
    documents: false,
    payroll: false,
    calendarFeeds: false,
    plaid: false,
    fullFinancials: false,
    fullReports: false,
    actionCenter: false,
    advancedAnalytics: false,
    prioritySupport: false,
    // Enterprise
    consolidatedReporting: false,
    savedReportViews: false,
    scheduledReports: false,
    customRoles: false,
    api: false,
    dataExport: false,
    whiteGloveMigration: false,
    sso: false,
    advancedPermissions: false,
  },
  pro: {
    platformRate: 0.015,
    platformFixedCents: PLATFORM_FIXED_CENTS,
    maxMembers: null,
    maxLocations: 3,
    maxEntities: 1,
    maxBankAccounts: 2,
    maxStaffSeats: 25,
    multiLocation: true,
    classes: true,
    attendance: true,
    privateLessons: true,
    announcements: true,
    emailSms: true,
    csvImport: true,
    reports: true,
    brandedApp: true,
    privateMessaging: true,
    eventToolkit: true,
    documents: true,
    payroll: true,
    calendarFeeds: true,
    plaid: true,
    fullFinancials: true,
    fullReports: true,
    actionCenter: true,
    advancedAnalytics: true,
    prioritySupport: false,
    consolidatedReporting: false,
    savedReportViews: false,
    scheduledReports: false,
    customRoles: false,
    api: false,
    dataExport: false,
    whiteGloveMigration: false,
    sso: false,
    advancedPermissions: false,
  },
  enterprise: {
    platformRate: 0.014,
    platformFixedCents: PLATFORM_FIXED_CENTS,
    maxMembers: null,
    maxLocations: null,
    maxEntities: null,
    maxBankAccounts: null,
    maxStaffSeats: null,
    multiLocation: true,
    classes: true,
    attendance: true,
    privateLessons: true,
    announcements: true,
    emailSms: true,
    csvImport: true,
    reports: true,
    brandedApp: true,
    privateMessaging: true,
    eventToolkit: true,
    documents: true,
    payroll: true,
    calendarFeeds: true,
    plaid: true,
    fullFinancials: true,
    fullReports: true,
    actionCenter: true,
    advancedAnalytics: true,
    prioritySupport: true,
    consolidatedReporting: true,
    savedReportViews: true,
    scheduledReports: true,
    customRoles: true,
    api: true,
    dataExport: true,
    whiteGloveMigration: true,
    sso: true,
    advancedPermissions: true,
  },
} as const;

export type TierFeatureKey = keyof (typeof TIER_FEATURES)["starter"];
export type TierBooleanFeature = {
  [K in TierFeatureKey]: (typeof TIER_FEATURES)["starter"][K] extends boolean ? K : never;
}[TierFeatureKey];
export type TierLimitKey = "maxMembers" | "maxLocations" | "maxEntities" | "maxBankAccounts" | "maxStaffSeats";

// Features that are gated by tier but NOT built yet. The pricing page renders
// these as "Coming soon"; the flags above are ready for when they ship.
export const GATED_NOT_BUILT: TierBooleanFeature[] = [
  "consolidatedReporting",
  "savedReportViews",
  "scheduledReports",
  "customRoles",
  "api",
  "dataExport",
];
// Sub-features of a built flag that themselves aren't built yet.
export const NOT_BUILT_SUBFEATURES = ["bulkRosterImport"] as const;

// "growth" was the pre-2026-10-18 entry tier; it maps to Starter so a row the
// data migration hasn't touched yet still resolves.
export function normalizeTier(tier: string | null | undefined): Tier {
  if (tier === "starter" || tier === "pro" || tier === "enterprise") return tier;
  return DEFAULT_TIER;
}

export function getTierFeatures(tier: string | null | undefined) {
  return TIER_FEATURES[normalizeTier(tier)];
}

export function canUseFeature(tier: string | null | undefined, feature: TierBooleanFeature): boolean {
  return getTierFeatures(tier)[feature] === true;
}

export function tierLimit(tier: string | null | undefined, key: TierLimitKey): number | null {
  return getTierFeatures(tier)[key];
}

export function getTierName(tier: string | null | undefined): string {
  return TIER_PRICES[normalizeTier(tier)].label;
}

/** The platform percentage (as a fraction, e.g. 0.02) for a tier. Floor-checked. */
export function getPlatformRate(tier: string | null | undefined): number {
  return assertPlatformRate(getTierFeatures(tier).platformRate);
}

/** Human label, e.g. "2%" (or "2% + $0.30" if a fixed part is ever set). */
export function describePlatformFee(tier: string | null | undefined): string {
  const f = getTierFeatures(tier);
  const pct = +(f.platformRate * 100).toFixed(2);
  return f.platformFixedCents > 0 ? `${pct}% + $${(f.platformFixedCents / 100).toFixed(2)}` : `${pct}%`;
}

// Lowest tier that unlocks a boolean feature, or that raises a limit above the
// current tier's.
export function upgradeRequired(tier: string | null | undefined, feature: TierBooleanFeature | TierLimitKey): Tier | null {
  const current = normalizeTier(tier);
  for (const t of TIER_ORDER) {
    const val = TIER_FEATURES[t][feature as TierFeatureKey];
    if (typeof val === "boolean") {
      if (val) return t;
    } else if (feature.startsWith("max")) {
      const cur = TIER_FEATURES[current][feature as TierLimitKey];
      const v = val as number | null;
      if (v === null || (cur !== null && v > cur)) return t;
    }
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

// Module-load self-check: a typo in TIER_FEATURES below the floor fails the
// build (every route imports this file) rather than silently undercharging.
for (const t of TIER_ORDER) assertPlatformRate(TIER_FEATURES[t].platformRate);
