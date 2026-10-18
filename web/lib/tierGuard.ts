// Server-side tier enforcement. Every tier-gated API route calls one of these
// BEFORE doing work — hiding a nav item is not gating (pricing overhaul,
// 2026-10-18). Returns a 403 NextResponse when blocked, or null to proceed.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getTierFeatures,
  getTierName,
  tierBlockedBody,
  upgradeRequired,
  TIER_PRICES,
  type TierBooleanFeature,
  type TierLimitKey,
} from "@/lib/tier";

export async function clubTier(clubId: string): Promise<string> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { tier: true } });
  return club?.tier ?? "starter";
}

const FEATURE_LABEL: Partial<Record<TierBooleanFeature, string>> = {
  brandedApp: "The branded mobile app",
  privateMessaging: "Private messaging",
  eventToolkit: "The full event toolkit (participant categories, roster grid, private links)",
  documents: "Documents and e-sign",
  payroll: "Pay plans and payroll",
  calendarFeeds: "Coach calendar feeds",
  plaid: "Bank connections",
  fullFinancials: "Full financials",
  fullReports: "This report",
  actionCenter: "The Action Center",
  advancedAnalytics: "Excel and PDF exports",
  customRoles: "Custom permission roles",
  api: "API access",
  dataExport: "Full data export",
};

export function featureBlocked(tier: string | null | undefined, feature: TierBooleanFeature): NextResponse | null {
  if (getTierFeatures(tier)[feature] === true) return null;
  const need = upgradeRequired(tier, feature);
  const what = FEATURE_LABEL[feature] ?? "This feature";
  return NextResponse.json(
    tierBlockedBody({
      message: `${what} is included on ${need ? TIER_PRICES[need].label : "a higher plan"}. You're on ${getTierName(tier)}.`,
      upgradeRequired: need,
    }),
    { status: 403 },
  );
}

/** Look up the club's tier and 403 if the feature isn't included. */
export async function requireTierFeature(clubId: string, feature: TierBooleanFeature): Promise<NextResponse | null> {
  return featureBlocked(await clubTier(clubId), feature);
}

const LIMIT_NOUN: Record<TierLimitKey, [string, string]> = {
  maxMembers: ["member", "members"],
  maxLocations: ["location", "locations"],
  maxEntities: ["entity", "entities"],
  maxBankAccounts: ["bank account", "bank accounts"],
  maxStaffSeats: ["staff seat", "staff seats"],
};

/** 403 when adding one more would exceed the tier's limit. */
export function limitBlocked(tier: string | null | undefined, key: TierLimitKey, currentCount: number): NextResponse | null {
  const max = getTierFeatures(tier)[key];
  if (max === null || currentCount < max) return null;
  const [one, many] = LIMIT_NOUN[key];
  const need = upgradeRequired(tier, key);
  return NextResponse.json(
    tierBlockedBody({
      message: `Your ${getTierName(tier)} plan includes ${max} ${max === 1 ? one : many}.${need ? ` Upgrade to ${TIER_PRICES[need].label} for more.` : ""}`,
      upgradeRequired: need,
    }),
    { status: 403 },
  );
}
