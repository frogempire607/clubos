"use client";

// Product list card — the products design handoff's screen 2b. Every stock
// number reads from the variant ledger (lib/productSettings.variantLedger);
// nothing here is typed twice.

import { MoreVertical } from "lucide-react";
import {
  isBookable,
  PRODUCT_TYPE_LABELS,
  normalizeProductSettings,
  storefrontsFor,
  tierRange,
  variantLedger,
  type ProductType,
  type ShowLocation,
  type Visibility,
} from "@/lib/productSettings";

export type CardProduct = {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  productType: ProductType;
  imageUrl?: string | null;
  active: boolean;
  visibility: Visibility;
  showLocation: ShowLocation;
  settings: Record<string, unknown> | null;
  trackInventory: boolean;
  inventory: number | null;
  _count: { sales: number };
};

const TYPE_LABELS = PRODUCT_TYPE_LABELS;

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type CardDerived = ReturnType<typeof deriveCard>;

/** Everything the card, the filter chips and the page subtitle read. One place. */
export function deriveCard(p: CardProduct) {
  const s = normalizeProductSettings(p.settings);
  const ledger = variantLedger(s, { price: p.price, trackInventory: p.trackInventory, inventory: p.inventory });
  const bookable = isBookable(p.productType);
  const fronts = storefrontsFor(p.visibility, p.showLocation);
  const range = s.tiersEnabled ? tierRange(s.tiers) : null;
  const cover = s.photos[0] ?? p.imageUrl ?? null;
  const needsAttention = !p.active ? false : ledger.tracked && (ledger.soldOut > 0 || ledger.low > 0);
  const badge: { label: string; tone: "ok" | "warn" | "danger" | "muted" } = !p.active
    ? { label: "Inactive", tone: "muted" }
    : bookable
      ? { label: "Bookable", tone: "ok" }
      : !ledger.tracked
        ? { label: "Unlimited", tone: "muted" }
        : ledger.units <= 0
          ? { label: "Out of stock", tone: "danger" }
          : { label: `${ledger.units} in stock`, tone: ledger.low > 0 || ledger.soldOut > 0 ? "warn" : "ok" };
  const chips: string[] = [];
  if (ledger.tracked && ledger.soldOut > 0) chips.push(`${ledger.soldOut} sold out`);
  if (ledger.tracked && ledger.low > 0) chips.push(`${ledger.low} low`);
  if (ledger.variantCount > 0) chips.push(`${ledger.variantCount} variants`);
  if (range) chips.push(`${s.tiers.length} tiers`);
  if (fronts.length === 1 && fronts[0] === "STAFF_ONLY") chips.push("Hidden from store");
  const priceLine = range ? `${money(range.min)} – ${money(range.max)}` : `${money(Number(p.price))}${s.memberPrice != null ? ` · members ${money(s.memberPrice)}` : ""}`;
  const primary: "Sell" | "Restock" | "Bookings" | "Activate" = !p.active ? "Activate" : bookable ? "Bookings" : ledger.tracked && ledger.units <= 0 ? "Restock" : "Sell";
  return { settings: s, ledger, bookable, fronts, cover, badge, chips, priceLine, primary, needsAttention };
}

export default function ProductCard({ product: p, onSell, onEdit, onToggleActive, onRemove, onBookings, onRestock, pending = 0 }: {
  product: CardProduct;
  onSell: () => void;
  onEdit: () => void;
  onToggleActive: () => void;
  onRemove: () => void;
  onBookings?: () => void;
  onRestock?: () => void;
  /** B10 slice 3 — bookings of this product waiting on staff. */
  pending?: number;
}) {
  const d = deriveCard(p);
  if (pending > 0) d.chips.push(`${pending} pending`);
  const badgeStyle = {
    ok: { background: "var(--color-success-surface)", color: "var(--color-success-text)" },
    warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
    danger: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
    muted: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  }[d.badge.tone];
  const primaryAction = d.primary === "Activate" ? onToggleActive : d.primary === "Bookings" ? onBookings ?? onEdit : d.primary === "Restock" ? onRestock ?? onEdit : onSell;

  return (
    <div className={`bg-surface rounded-[14px] border border-app-border overflow-hidden flex flex-col ${p.active ? "" : "opacity-70"}`}>
      <div
        className="h-[104px] relative"
        style={d.cover ? { backgroundImage: `url(${d.cover})`, backgroundSize: "cover", backgroundPosition: "center" } : { backgroundImage: "repeating-linear-gradient(135deg, var(--color-inset-surface), var(--color-inset-surface) 6px, var(--color-hairline) 6px, var(--color-hairline) 12px)" }}
        role="img"
        aria-label={d.cover ? `${p.name} photo` : "No photo"}
      >
        <span className="absolute bottom-2 left-2 text-[10.5px] font-semibold px-2 py-0.5 rounded-full tabular-nums" style={badgeStyle}>{d.badge.label}</span>
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1.5">
        <div>
          <div className="text-[14.5px] font-semibold text-text-primary leading-tight" style={{ textWrap: "balance" }}>{p.name}</div>
          <div className="text-[11.5px] text-text-muted">{TYPE_LABELS[p.productType]}{p.description ? ` · ${p.description}` : ""}</div>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[14px] font-semibold text-text-primary tabular-nums">{d.priceLine}</div>
          <div className="text-[11.5px] text-text-muted tabular-nums">{p._count.sales} sold</div>
        </div>
        {d.chips.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {d.chips.map((c) => (
              <span key={c} className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-full" style={/sold out/.test(c) ? { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" } : /low/.test(c) ? { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" } : { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}>{c}</span>
            ))}
          </div>
        )}
        <div className="mt-auto pt-2 flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--color-hairline)" }}>
          <button type="button" onClick={primaryAction} className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${d.primary === "Sell" ? "bg-brand text-white hover:bg-brand-hover" : "border border-app-border text-text-primary hover:bg-app-bg"}`}>{d.primary}</button>
          <details className="relative">
            <summary className="list-none cursor-pointer w-8 h-8 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted" aria-label="More actions"><MoreVertical size={16} /></summary>
            <div className="absolute right-0 bottom-9 z-20 w-44 bg-surface border border-app-border rounded-xl shadow-lg p-1 text-sm">
              <button type="button" onClick={onEdit} className="block w-full text-left px-3 py-2 rounded-lg hover:bg-app-bg text-text-primary">Edit</button>
              {p.active && !d.bookable && <button type="button" onClick={onSell} className="block w-full text-left px-3 py-2 rounded-lg hover:bg-app-bg text-text-primary">Sell</button>}
              <button type="button" onClick={onToggleActive} className="block w-full text-left px-3 py-2 rounded-lg hover:bg-app-bg text-text-primary">{p.active ? "Deactivate" : "Activate"}</button>
              <button type="button" onClick={onRemove} className="block w-full text-left px-3 py-2 rounded-lg hover:bg-red-50 text-red-600">Remove</button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
