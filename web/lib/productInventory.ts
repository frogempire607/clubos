// B10 slice 3 — the Inventory screen (2c). PURE. One row per tracked variant
// (or per product with a plain count), read from the same ledger every other
// screen reads — so the number adjusted here is the number the store sells.

import { normalizeProductSettings, stockBehaviour, variantStatus, DEFAULT_LOW_STOCK, type ProductSettings, type ProductType } from "@/lib/productSettings";

export type InventoryRow = {
  productId: string;
  productName: string;
  variantId: string | null;
  label: string;
  sku: string;
  photoUrl: string | null;
  stock: number;
  threshold: number;
  sold30: number;
  price: number;
  value: number;
  status: "OUT" | "LOW" | "OK";
  active: boolean;
};

export type InventoryView = {
  rows: InventoryRow[];
  tiles: { units: number; retailValue: number; low: number; soldOut: number };
};

type P = { id: string; name: string; price: unknown; productType: string; active: boolean; trackInventory: boolean; inventory: number | null; settings: unknown; imageUrl?: string | null };

const RANK = { OUT: 0, LOW: 1, OK: 2 } as const;

export function inventoryRows(products: P[], sold30: (productId: string, variantId: string | null) => number): InventoryView {
  const rows: InventoryRow[] = [];
  for (const p of products) {
    const s = normalizeProductSettings(p.settings);
    const base = Number(p.price) || 0;
    const threshold = s.lowStockAlertQuantity ?? DEFAULT_LOW_STOCK;
    const cover = s.photos[0] ?? p.imageUrl ?? null;
    if (s.variants.length > 0) {
      for (const v of s.variants) {
        const price = v.price ?? base;
        rows.push({
          productId: p.id, productName: p.name, variantId: v.id, label: v.label, sku: v.sku, photoUrl: v.photoUrl ?? cover,
          stock: v.stock, threshold, sold30: sold30(p.id, v.id), price, value: Math.round(v.stock * price * 100) / 100,
          status: variantStatus(v, threshold), active: p.active,
        });
      }
    } else if (p.trackInventory && p.inventory != null && stockBehaviour(p.productType as ProductType).holdsStock) {
      rows.push({
        productId: p.id, productName: p.name, variantId: null, label: p.name, sku: "", photoUrl: cover,
        stock: p.inventory, threshold, sold30: sold30(p.id, null), price: base, value: Math.round(p.inventory * base * 100) / 100,
        status: variantStatus({ stock: p.inventory }, threshold), active: p.active,
      });
    }
  }
  // Worst first: sold out, then low (fewest left first), then the rest by name.
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.status !== "OK" ? a.stock - b.stock : 0) || a.productName.localeCompare(b.productName) || a.label.localeCompare(b.label));
  const live = rows.filter((r) => r.active);
  return {
    rows,
    tiles: {
      units: live.reduce((s, r) => s + r.stock, 0),
      retailValue: Math.round(live.reduce((s, r) => s + r.value, 0) * 100) / 100,
      low: live.filter((r) => r.status === "LOW").length,
      soldOut: live.filter((r) => r.status === "OUT").length,
    },
  };
}

/** A stock change: the −/+ stepper and Receive stock (delta) or a count (set). Never below 0. */
export function adjustStock(
  settings: ProductSettings,
  product: { inventory: number | null; trackInventory: boolean },
  change: { variantId: string | null; delta?: number; set?: number },
): { ok: true; settings: ProductSettings | null; inventory: number | null; stock: number } | { ok: false; message: string } {
  const next = (cur: number) => Math.max(0, change.set !== undefined ? change.set : cur + (change.delta ?? 0));
  if (settings.variants.length > 0) {
    if (!change.variantId) return { ok: false, message: "Pick which variant." };
    const v = settings.variants.find((x) => x.id === change.variantId);
    if (!v) return { ok: false, message: "That variant doesn't exist any more." };
    const stock = next(v.stock);
    return { ok: true, settings: { ...settings, variants: settings.variants.map((x) => (x.id === v.id ? { ...x, stock } : x)) }, inventory: null, stock };
  }
  const stock = next(product.inventory ?? 0);
  return { ok: true, settings: null, inventory: stock, stock };
}
