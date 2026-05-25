export const PRIVATE_DURATION_OPTIONS = Array.from(
  { length: 16 },
  (_, i) => (i + 1) * 15,
);

export function isValidPrivateDuration(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 240 && minutes % 15 === 0;
}

export function privateDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export function packageLessonTypeIds(
  lessonTypeIds: unknown,
  legacyLessonTypeId?: string | null,
): string[] {
  if (Array.isArray(lessonTypeIds)) {
    return lessonTypeIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return legacyLessonTypeId ? [legacyLessonTypeId] : [];
}

export function packageAllowsLessonType(
  lessonTypeIds: unknown,
  legacyLessonTypeId: string | null | undefined,
  lessonTypeId: string,
): boolean {
  const ids = packageLessonTypeIds(lessonTypeIds, legacyLessonTypeId);
  return ids.length === 0 || ids.includes(lessonTypeId);
}

// ── Package pricing model ────────────────────────────────────────────────────
//
// FLAT    → the legacy behaviour: `price` is the total prepaid cost for the
//           full pack of credits.
// PERCENT → `discountValue` is a percentage (0-100) taken off each lesson's
//           tier price; total = (per-lesson tier price × (1 - d/100)) × credits.
// FIXED   → `discountValue` is a $ amount subtracted from each lesson's tier
//           price (floor 0); total = (per-lesson tier price - d) × credits.

export type PricingMode = "FLAT" | "PERCENT" | "FIXED";

export function normalizePricingMode(value: unknown): PricingMode {
  return value === "PERCENT" || value === "FIXED" ? value : "FLAT";
}

export type PackagePricingInputs = {
  pricingMode: unknown;
  discountValue: number | string | null | undefined;
  price: number | string;
  credits: number;
  bonusCredits?: number;
};

// Per-lesson price after the package's discount (applies to PERCENT/FIXED
// modes). For FLAT, this isn't meaningful — callers should use packageTotal()
// or fall back to (price / credits) for an estimate.
export function pricePerLessonAfterDiscount(
  pkg: PackagePricingInputs,
  basePerLessonPrice: number,
): number {
  const mode = normalizePricingMode(pkg.pricingMode);
  if (mode === "PERCENT") {
    const d = clamp(Number(pkg.discountValue) || 0, 0, 100);
    return round2(basePerLessonPrice * (1 - d / 100));
  }
  if (mode === "FIXED") {
    const d = Math.max(0, Number(pkg.discountValue) || 0);
    return round2(Math.max(0, basePerLessonPrice - d));
  }
  // FLAT: estimate per-lesson from total / credits.
  const credits = Math.max(1, pkg.credits + (pkg.bonusCredits ?? 0));
  return round2(Number(pkg.price) / credits);
}

// Total prepaid price for the package given the chosen tier price per lesson.
// For FLAT, `basePerLessonPrice` is ignored and the stored `price` wins.
export function packageTotalForBasePrice(
  pkg: PackagePricingInputs,
  basePerLessonPrice: number,
): number {
  const mode = normalizePricingMode(pkg.pricingMode);
  if (mode === "FLAT") return round2(Number(pkg.price));
  // Buyer pays for `credits` lessons; bonus lessons are free granted credits.
  const paidCredits = Math.max(1, pkg.credits);
  return round2(pricePerLessonAfterDiscount(pkg, basePerLessonPrice) * paidCredits);
}

// Display label for the package's pricing model — useful in selectors and
// the assign-package modal so owners see exactly how the price is computed.
export function pricingModeLabel(mode: PricingMode): string {
  if (mode === "PERCENT") return "Percentage discount per lesson";
  if (mode === "FIXED") return "Fixed $ discount per lesson";
  return "Flat total price";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
