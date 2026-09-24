// B10 slice 2 — what the member store is allowed to know about a product.
//
// The dashboard sees the whole `settings` blob (SKUs, low-stock thresholds,
// internal notes live next to it). The store sees a projection: photos, the
// member price, the option groups, and per-variant label/stock/price — read
// from the same ledger the editor, cards and Sell tiles read, so "2 left" on a
// phone is the number the front desk sees.

import { normalizeProductSettings, unitPriceFor, variantStatus, type ProductSettings } from "@/lib/productSettings";

export type StoreVariant = { id: string; label: string; values: string[]; stock: number; price: number; status: "OUT" | "LOW" | "OK"; photoUrl: string | null };

export type StoreProduct = {
  id: string;
  name: string;
  description: string | null;
  /** List price (the product's base price). */
  price: number;
  /** What a member pays for a unit with no variant price — memberPrice if set. */
  memberPrice: number;
  category: string;
  productType: string;
  photos: string[];
  trackInventory: boolean;
  inventory: number | null;
  optionGroups: { name: string; values: string[] }[];
  variants: StoreVariant[];
  hasVariants: boolean;
  /** Units across variants (or the plain count); null = untracked. */
  available: number | null;
  needsBookingFlow: boolean;
};

type Row = {
  id: string; name: string; description: string | null; price: unknown; category: string; productType: string;
  imageUrl: string | null; trackInventory: boolean; inventory: number | null; settings: unknown;
};

export function storeView(row: Row): StoreProduct {
  const settings: ProductSettings = normalizeProductSettings(row.settings);
  const base = Number(row.price) || 0;
  const photos = settings.photos.length ? settings.photos : row.imageUrl ? [row.imageUrl] : [];
  const variants: StoreVariant[] = settings.variants.map((v) => ({
    id: v.id,
    label: v.label,
    values: v.id.split(" / "),
    stock: v.stock,
    price: unitPriceFor(settings, base, v, "MEMBER_PORTAL"),
    status: variantStatus(v, settings.lowStockAlertQuantity),
    photoUrl: v.photoUrl,
  }));
  const hasVariants = variants.length > 0;
  const available = hasVariants
    ? variants.reduce((s, v) => s + v.stock, 0)
    : row.trackInventory && row.inventory != null
      ? row.inventory
      : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: base,
    memberPrice: unitPriceFor(settings, base, null, "MEMBER_PORTAL"),
    category: row.category,
    productType: row.productType,
    photos,
    trackInventory: row.trackInventory,
    inventory: row.inventory,
    optionGroups: settings.optionGroups.filter((g) => g.values.length > 0),
    variants,
    hasVariants,
    available,
    needsBookingFlow: row.productType === "FACILITY_RENTAL" || row.productType === "BIRTHDAY_PARTY",
  };
}
