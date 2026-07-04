import { prisma } from "@/lib/prisma";

// Discount validation + price application across every purchase type.
//
// Scope model:
//   - appliesTo (JSON array of DiscountItemType) — [] = every purchase type.
//   - membershipIds (JSON array) — when the code covers MEMBERSHIP purchases,
//     [] = every plan, otherwise only the listed plans.
//   - Back-compat: a legacy code with plan-narrowed membershipIds and an empty
//     appliesTo is treated as memberships-only (the migration backfills
//     appliesTo=["MEMBERSHIP"] for those, and this guard covers rows written
//     before the column existed).

export type DiscountItemType = "MEMBERSHIP" | "EVENT" | "CLASS" | "PRODUCT" | "PRIVATE_PACK";

export const DISCOUNT_ITEM_TYPES: { key: DiscountItemType; label: string }[] = [
  { key: "MEMBERSHIP", label: "Memberships" },
  { key: "EVENT", label: "Events" },
  { key: "CLASS", label: "Class drop-ins" },
  { key: "PRODUCT", label: "Products (gear, rentals, parties)" },
  { key: "PRIVATE_PACK", label: "Private lesson packs" },
];

const ITEM_TYPE_LABEL: Record<DiscountItemType, string> = {
  MEMBERSHIP: "memberships",
  EVENT: "events",
  CLASS: "class bookings",
  PRODUCT: "products",
  PRIVATE_PACK: "lesson packs",
};

export type ValidDiscount = {
  id: string;
  code: string;
  type: "PERCENT" | "FIXED";
  value: number;
};

export type DiscountCheck =
  | { ok: true; discount: ValidDiscount }
  | { ok: false; error: string };

export async function findValidDiscountFor(
  clubId: string,
  rawCode: string,
  item: { type: DiscountItemType; membershipId?: string | null },
): Promise<DiscountCheck> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, error: "Enter a discount code." };

  const d = await prisma.discount.findUnique({
    where: { clubId_code: { clubId, code } },
  });
  if (!d) return { ok: false, error: "That discount code doesn't exist." };
  if (!d.active) return { ok: false, error: "That discount code is no longer active." };
  if (d.expiresAt && d.expiresAt < new Date()) {
    return { ok: false, error: "That discount code has expired." };
  }
  if (d.maxUses != null && d.usedCount >= d.maxUses) {
    return { ok: false, error: "That discount code has reached its usage limit." };
  }

  const planScope: string[] = Array.isArray(d.membershipIds) ? (d.membershipIds as string[]) : [];
  const rawAppliesTo = (d as { appliesTo?: unknown }).appliesTo;
  let typeScope: DiscountItemType[] = Array.isArray(rawAppliesTo)
    ? (rawAppliesTo as DiscountItemType[])
    : [];
  // Legacy guard: plan-narrowed codes written before appliesTo existed stay
  // memberships-only.
  if (typeScope.length === 0 && planScope.length > 0) typeScope = ["MEMBERSHIP"];

  if (typeScope.length > 0 && !typeScope.includes(item.type)) {
    return { ok: false, error: `That discount code doesn't apply to ${ITEM_TYPE_LABEL[item.type]}.` };
  }
  if (item.type === "MEMBERSHIP" && planScope.length > 0) {
    if (!item.membershipId || !planScope.includes(item.membershipId)) {
      return { ok: false, error: "That discount code doesn't apply to this membership." };
    }
  }

  return {
    ok: true,
    discount: {
      id: d.id,
      code: d.code,
      type: d.type === "FIXED" ? "FIXED" : "PERCENT",
      value: Number(d.value),
    },
  };
}

/** Back-compat wrapper for the membership-purchase call sites. */
export async function findValidDiscount(
  clubId: string,
  rawCode: string,
  membershipId: string,
): Promise<DiscountCheck> {
  return findValidDiscountFor(clubId, rawCode, { type: "MEMBERSHIP", membershipId });
}

/** Apply a discount to a price. Never goes below $0; rounded to cents. */
export function discountedPrice(price: number, d: ValidDiscount): number {
  const cut = d.type === "PERCENT" ? (price * d.value) / 100 : d.value;
  return Math.max(0, Math.round((price - cut) * 100) / 100);
}

/** Count a real use (purchase created / checkout started / request approved). */
export async function recordDiscountUse(discountId: string): Promise<void> {
  await prisma.discount
    .update({ where: { id: discountId }, data: { usedCount: { increment: 1 } } })
    .catch(() => {});
}
