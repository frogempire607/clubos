import { prisma } from "@/lib/prisma";

// Discount validation + price application. The Discount model stores
// membershipIds as a JSON array — [] means the code applies to every
// membership / purchase option (the default).

export type ValidDiscount = {
  id: string;
  code: string;
  type: "PERCENT" | "FIXED";
  value: number;
};

export type DiscountCheck =
  | { ok: true; discount: ValidDiscount }
  | { ok: false; error: string };

export async function findValidDiscount(
  clubId: string,
  rawCode: string,
  membershipId: string,
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

  let scoped: string[] = [];
  if (Array.isArray(d.membershipIds)) scoped = d.membershipIds as string[];
  if (scoped.length > 0 && !scoped.includes(membershipId)) {
    return { ok: false, error: "That discount code doesn't apply to this membership." };
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
