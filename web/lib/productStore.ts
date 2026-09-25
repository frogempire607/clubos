// B10 slice 2 — what the member store is allowed to know about a product.
//
// The dashboard sees the whole `settings` blob (SKUs, low-stock thresholds,
// internal notes live next to it). The store sees a projection: photos, the
// member price, the option groups, and per-variant label/stock/price — read
// from the same ledger the editor, cards and Sell tiles read, so "2 left" on a
// phone is the number the front desk sees.

import { normalizeProductSettings, unitPriceFor, variantStatus, isBookable, PRODUCT_TYPE_LABELS, type ProductSettings, type ProductType } from "@/lib/productSettings";
import { publicMediaUrl } from "@/lib/publicMedia";
import { lengthOptions, effectiveWindows, type LengthOption } from "@/lib/productBooking";

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
  /** Bulk pricing — "2+ $35 each"; empty = one price at any quantity. */
  quantityBreaks: { minQty: number; price: number }[];
  hasVariants: boolean;
  /** Units across variants (or the plain count); null = untracked. */
  available: number | null;
  needsBookingFlow: boolean;
  typeLabel: string;
  /** B10 slice 3 — what the booking flow (2f) needs; null when not bookable. */
  booking: {
    options: LengthOption[];
    addOns: { label: string; price: number; perGuest: boolean }[];
    maxGuests: number | null;
    questions: { label: string; kind: string; required: boolean }[];
    mode: ProductSettings["depositMode"];
    depositAmount: number | null;
    requiresApproval: boolean;
    bookingWindowDays: number;
    /** Weekdays with any time window ("Mon"…), and closed dates. */
    openDays: string[];
    blackoutDates: string[];
  } | null;
};

type Row = {
  id: string; name: string; description: string | null; price: unknown; category: string; productType: string;
  imageUrl: string | null; trackInventory: boolean; inventory: number | null; settings: unknown;
};

export function storeView(row: Row): StoreProduct {
  const settings: ProductSettings = normalizeProductSettings(row.settings);
  const base = Number(row.price) || 0;
  // Photos go out through the public media route so they load for a buyer
  // who is not signed in to staff (the /api/files path is session-gated).
  const photos = (settings.photos.length ? settings.photos : row.imageUrl ? [row.imageUrl] : [])
    .map((u) => publicMediaUrl("product", row.id, u))
    .filter((u): u is string => !!u);
  const variants: StoreVariant[] = settings.variants.map((v) => ({
    id: v.id,
    label: v.label,
    values: v.id.split(" / "),
    stock: v.stock,
    price: unitPriceFor(settings, base, v, "MEMBER_PORTAL"),
    status: variantStatus(v, settings.lowStockAlertQuantity),
    photoUrl: publicMediaUrl("product", row.id, v.photoUrl),
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
    quantityBreaks: settings.quantityBreaks,
    hasVariants,
    available,
    needsBookingFlow: isBookable(row.productType),
    typeLabel: PRODUCT_TYPE_LABELS[row.productType as ProductType] ?? "Other",
    booking: isBookable(row.productType)
      ? {
          options: lengthOptions(settings, base),
          addOns: settings.addOns.filter((a) => a.price != null).map((a) => ({ label: a.label, price: a.price!, perGuest: a.perGuest })),
          maxGuests: settings.maxGuests,
          questions: settings.questions,
          mode: settings.depositMode,
          depositAmount: settings.depositMode === "DEPOSIT" ? settings.depositAmount : null,
          requiresApproval: settings.requiresApproval,
          bookingWindowDays: settings.bookingWindowDays ?? 60,
          openDays: Array.from(new Set(effectiveWindows(settings).flatMap((w) => w.days))),
          blackoutDates: settings.blackoutDates,
        }
      : null,
  };
}
