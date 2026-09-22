"use client";

// Add / edit product — the products design handoff's screen 2a, slice 1.
//
// Collapsible cards, each stating its own answer when collapsed. Every list
// that used to be a "one per line" textarea (variants, tiers, durations,
// add-ons, questions) is a structured editor writing the typed v2 shape in
// lib/productSettings.ts — into the SAME `settings` JSON column, no migration.
// `Product.inventory` is written as the derived variant total so the sell and
// buy routes' stock checks keep working unchanged. Private lessons stay out
// (they have /dashboard/privates).

import { useMemo, useState, type ReactNode } from "react";
import { X, Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import ImageUpload from "@/components/ImageUpload";
import {
  DEFAULT_LOW_STOCK,
  STOREFRONT_LABELS,
  columnsForStorefronts,
  derivedInventory,
  isBookable,
  normalizeProductSettings,
  reconcileVariants,
  expandVariants,
  variantId,
  stockBehaviour,
  storefrontsFor,
  tierRange,
  variantLedger,
  variantStatus,
  type OptionGroup,
  type ProductSettings,
  type ProductType,
  type ShowLocation,
  type Storefront,
  type Visibility,
} from "@/lib/productSettings";

export type EditableProduct = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  productType: ProductType;
  imageUrl?: string | null;
  visibility: Visibility;
  showLocation: ShowLocation;
  taxable: boolean;
  internalNotes: string | null;
  settings: Record<string, unknown> | null;
  trackInventory: boolean;
  inventory: number | null;
};

const TYPE_LABELS: Record<ProductType, string> = {
  GEAR: "Gear / merch",
  FACILITY_RENTAL: "Facility rental",
  BIRTHDAY_PARTY: "Birthday party",
  DIGITAL: "Digital item",
  OTHER: "Other",
};

function productTypeToCategory(type: ProductType) {
  if (type === "GEAR") return "GEAR";
  if (type === "FACILITY_RENTAL" || type === "BIRTHDAY_PARTY") return "FACILITY";
  if (type === "DIGITAL") return "SERVICE";
  return "OTHER";
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);

const input = "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-brand";
const dense = "w-full px-2.5 py-1.5 border border-app-border rounded-lg text-[13.5px] bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-brand";
const label = "block text-[12px] font-semibold text-text-primary mb-1";

// ── Card ─────────────────────────────────────────────────────────────────────
function Card({ title, summary, open, onToggle, children, locked }: { title: string; summary: string; open: boolean; onToggle: () => void; children?: ReactNode; locked?: string | null }) {
  return (
    <section className="bg-surface border border-app-border rounded-[14px] overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full text-left px-4 py-3.5 flex items-start justify-between gap-3 hover:bg-app-bg/60">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text-primary">{title}</div>
          <div className="text-[12px] text-text-muted truncate">{summary}</div>
        </div>
        <span className="text-[11.5px] font-medium text-brand inline-flex items-center gap-0.5 flex-shrink-0 mt-0.5">
          {open ? <>Hide <ChevronUp size={13} /></> : <>Edit <ChevronDown size={13} /></>}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3.5">
          {locked ? <LockPanel>{locked}</LockPanel> : children}
        </div>
      )}
    </section>
  );
}

function LockPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl px-3.5 py-3 text-[12.5px] text-text-muted" style={{ background: "var(--color-inset-surface)", border: "1px dashed var(--color-inset-dashed)" }}>
      {children}
    </div>
  );
}

function Switch({ on, onChange, id }: { on: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="relative w-11 h-[26px] rounded-full transition flex-shrink-0" style={{ background: on ? "var(--color-brand)" : "var(--color-inset-dashed)" }}>
      <span className="absolute top-0.5 w-[22px] h-[22px] rounded-full bg-white shadow transition-[left]" style={{ left: on ? 20 : 2, boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
    </button>
  );
}

function ChipRow({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const add = () => { const v = draft.trim(); if (!v || values.includes(v)) { setDraft(""); return; } onChange([...values, v]); setDraft(""); };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-full" style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}>
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="hover:text-text-primary"><X size={12} /></button>
        </span>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} onBlur={add} placeholder={placeholder} className="text-[12px] px-2 py-1 border border-dashed border-app-border rounded-full bg-transparent text-text-primary focus:outline-none focus:border-brand min-w-[90px]" />
    </div>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Editor ───────────────────────────────────────────────────────────────────
export default function ProductEditor({ product, onClose, onSaved }: { product: EditableProduct | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!product;
  const [name, setName] = useState(product?.name || "");
  const [description, setDescription] = useState(product?.description || "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [productType, setProductType] = useState<ProductType>(product?.productType || "GEAR");
  const [taxable, setTaxable] = useState(product?.taxable || false);
  const [internalNotes, setInternalNotes] = useState(product?.internalNotes || "");
  const [trackInventory, setTrackInventory] = useState(product?.trackInventory || false);
  const [inventory, setInventory] = useState(product?.inventory != null ? String(product.inventory) : "");
  const [storefronts, setStorefronts] = useState<Storefront[]>(product ? storefrontsFor(product.visibility, product.showLocation) : ["MEMBER_PORTAL"]);
  const [s, setS] = useState<ProductSettings>(() => {
    const base = normalizeProductSettings(product?.settings);
    // The single legacy imageUrl is photo #1 until the owner adds more.
    if (base.photos.length === 0 && product?.imageUrl) base.photos = [product.imageUrl];
    return base;
  });
  const patch = (p: Partial<ProductSettings>) => setS((prev) => ({ ...prev, ...p }));
  const [open, setOpen] = useState<Record<string, boolean>>({ basics: !isEdit, pricing: false, inventory: false, booking: false, digital: false, sold: false, advanced: false });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const basePrice = Number(price) || 0;
  const ledger = useMemo(() => variantLedger(s, { price: basePrice, trackInventory, inventory: numOrNull(inventory) }), [s, basePrice, trackInventory, inventory]);
  const stock = stockBehaviour(productType);
  const bookable = isBookable(productType);
  const range = tierRange(s.tiers);
  const threshold = s.lowStockAlertQuantity ?? DEFAULT_LOW_STOCK;
  const producedIds = useMemo(() => new Set(expandVariants(s.optionGroups).map(variantId)), [s.optionGroups]);

  // Derived summaries — the collapsed card states its own answer.
  const pricingSummary = s.tiersEnabled && s.tiers.length
    ? `${s.tiers.length} tier${s.tiers.length === 1 ? "" : "s"}${range ? ` · ${money(range.min)} to ${money(range.max)}` : ""}`
    : `${price ? money(basePrice) : "No price yet"}${s.memberPrice != null ? ` · members ${money(s.memberPrice)}` : ""}${taxable ? " · taxable" : ""}`;
  const inventorySummary = !stock.holdsStock
    ? "No stock — " + (bookable ? "booked into slots" : "nothing to count")
    : !trackInventory
      ? "Not tracked"
      : s.variants.length
        ? `${s.variants.length} variants · ${ledger.units} units · ${money(ledger.retailValue)} at retail${ledger.soldOut ? ` · ${ledger.soldOut} sold out` : ""}${ledger.low ? ` · ${ledger.low} low` : ""}`
        : `${ledger.units} in stock`;
  const bookingSummary = !bookable
    ? "Not a bookable item"
    : [
        s.availableDays.length ? `${s.availableDays.length} days` : "no days set",
        s.durations.length ? `${s.durations.length} lengths` : null,
        s.depositMode === "DEPOSIT" ? `${s.depositAmount != null ? money(s.depositAmount) : "a"} deposit` : s.depositMode === "REQUEST_ONLY" ? "request first" : "pay in full",
        s.requiresApproval ? "staff approves" : null,
      ].filter(Boolean).join(" · ");
  const soldSummary = storefronts.map((f) => STOREFRONT_LABELS[f].label).join(" · ");
  const headerSummary = `${TYPE_LABELS[productType]} · ${s.tiersEnabled && s.tiers.length ? `${s.tiers.length} tiers` : price ? money(basePrice) : "no price"} · ${soldSummary}`;

  const recap = (() => {
    const bits: string[] = [];
    if (stock.holdsStock && trackInventory && s.variants.length) {
      if (ledger.soldOut) bits.push(`${ledger.soldOut} variant${ledger.soldOut === 1 ? "" : "s"} will show as sold out`);
      if (ledger.low) bits.push(`${ledger.low} at or below the ${threshold}-unit alert`);
      if (!ledger.soldOut && !ledger.low) bits.push(`all ${s.variants.length} variants in stock`);
    }
    if (bookable) {
      bits.push(`${s.tiersEnabled && s.tiers.length ? `${s.tiers.length} tiers` : "one price"} on ${s.availableDays.length || "no"} day${s.availableDays.length === 1 ? "" : "s"}`);
      bits.push(s.depositMode === "DEPOSIT" ? `a ${s.depositAmount != null ? money(s.depositAmount) : "—"} deposit` : s.depositMode === "REQUEST_ONLY" ? "no money at request" : "paid in full at booking");
      if (s.requiresApproval) bits.push("each request waits on staff");
    }
    if (storefronts.includes("STAFF_ONLY")) bits.push("hidden from every store — front desk only");
    return bits.length ? bits.join(", ") + "." : "Set a price and choose where it's sold.";
  })();

  function setGroups(groups: OptionGroup[]) {
    patch({ optionGroups: groups, variants: reconcileVariants(groups, s.variants) });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Give the product a name."); setOpen((o) => ({ ...o, basics: true })); return; }
    if (numOrNull(price) == null) { setError("Set a base price (0 is fine for tier-only items)."); setOpen((o) => ({ ...o, pricing: true })); return; }
    setSaving(true);
    const cols = columnsForStorefronts(storefronts);
    const settings: ProductSettings = {
      ...s,
      // Non-stock types never carry a matrix; a switched-off tracker drops it too.
      optionGroups: stock.holdsStock && trackInventory ? s.optionGroups : [],
      variants: stock.holdsStock && trackInventory ? s.variants : [],
      tiers: s.tiersEnabled ? s.tiers.filter((t) => t.name.trim()) : [],
      durations: bookable ? s.durations.filter((d) => d.mins > 0) : [],
      addOns: bookable ? s.addOns.filter((a) => a.label.trim()) : [],
      questions: s.questions.filter((q) => q.label.trim()),
      depositAmount: s.depositMode === "DEPOSIT" ? s.depositAmount : null,
    };
    const payload = {
      name: name.trim(),
      description: description || null,
      price: Number(price),
      category: productTypeToCategory(productType),
      productType,
      visibility: cols.visibility,
      showLocation: cols.showLocation,
      taxable,
      internalNotes: internalNotes || null,
      settings,
      trackInventory: stock.holdsStock ? trackInventory : false,
      inventory: stock.holdsStock && trackInventory ? derivedInventory(settings, numOrNull(inventory)) : null,
      imageUrl: settings.photos[0] ?? null,
    };
    const res = await fetch(isEdit ? `/api/products/${product!.id}` : "/api/products", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-[940px] max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl" style={{ background: "var(--color-bg)" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={isEdit ? "Edit product" : "Add product"}>
        <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3 border-b border-app-border bg-surface rounded-t-2xl">
          <div className="min-w-0">
            <h2 className="text-[16px] sm:text-[20px] font-semibold text-text-primary leading-tight">{isEdit ? "Edit product" : "Add product"}</h2>
            <p className="text-[12.5px] text-text-muted truncate">{headerSummary}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">Cancel</button>
            <button type="submit" form="product-editor-form" disabled={saving} className="text-sm font-semibold px-3.5 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50">{saving ? "Saving…" : "Save product"}</button>
          </div>
        </div>

        <form id="product-editor-form" onSubmit={handleSubmit} className="overflow-y-auto p-3.5 sm:p-4 space-y-2.5">
          {/* Type picker */}
          <div className="rounded-[14px] p-3.5" style={{ background: "var(--color-table-chrome)", border: "1px solid var(--color-app-border)" }}>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(TYPE_LABELS) as ProductType[]).map((t) => (
                <button key={t} type="button" onClick={() => setProductType(t)} aria-pressed={productType === t} className={`text-[13px] px-3 py-1.5 rounded-full border transition ${productType === t ? "border-brand text-brand font-semibold" : "border-app-border text-text-primary hover:bg-app-bg"}`} style={productType === t ? { background: "var(--color-info-surface)" } : undefined}>
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-text-muted mt-2">
              {stock.reason}{bookable ? " Private lessons stay out of products — they keep their own Privates surface." : ""}
            </p>
          </div>

          {/* Basics & photos */}
          <Card title="Basics & photos" summary={name ? `${name}${s.photos.length ? ` · ${s.photos.length} photo${s.photos.length === 1 ? "" : "s"}` : " · no photo"}` : "Name it and add up to 4 photos"} open={open.basics} onToggle={() => toggle("basics")}>
            <div>
              <label className={label} htmlFor="p-name">Name</label>
              <input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team hoodie, Mat rental" className={input} />
            </div>
            <div>
              <label className={label} htmlFor="p-desc">Short description</label>
              <input id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={input} />
            </div>
            <div>
              <div className={label}>Photos</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="relative">
                    <ImageUpload value={s.photos[i] ?? null} onChange={(url) => { const p = [...s.photos]; p[i] = url; patch({ photos: p.filter(Boolean).slice(0, 4) }); }} shape="square" />
                    {i === 0 && s.photos[0] && <span className="absolute top-1 left-1 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded bg-black text-white">Cover</span>}
                    {s.photos[i] && <button type="button" aria-label="Remove photo" onClick={() => patch({ photos: s.photos.filter((_, j) => j !== i) })} className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center"><X size={12} /></button>}
                  </div>
                ))}
              </div>
              <p className="text-[11.5px] text-text-muted mt-1">JPG, PNG, WebP — max 10 MB each. The first is the cover.</p>
            </div>
          </Card>

          {/* Pricing */}
          <Card title="Pricing" summary={pricingSummary} open={open.pricing} onToggle={() => toggle("pricing")}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={label} htmlFor="p-price">Price</label>
                <input id="p-price" type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} className={input} />
              </div>
              <div>
                <label className={label} htmlFor="p-member-price">Member price</label>
                <input id="p-member-price" type="number" step="0.01" min="0" value={s.memberPrice ?? ""} onChange={(e) => patch({ memberPrice: numOrNull(e.target.value) })} placeholder="same as price" className={input} />
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm text-text-primary"><input type="checkbox" id="p-taxable" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} className="rounded" /> Taxable</label>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-app-border px-3 py-2.5">
              <div>
                <div className="text-sm font-medium text-text-primary">Sell this as tiers</div>
                <div className="text-[11.5px] text-text-muted">Families choose one at checkout — Basic / Plus / Premium.</div>
              </div>
              <Switch id="p-tiers" on={s.tiersEnabled} onChange={(v) => patch({ tiersEnabled: v, tiers: v && s.tiers.length === 0 ? [{ name: "", includes: "", length: "", price: null }] : s.tiers })} />
            </div>
            {s.tiersEnabled && (
              <div className="space-y-1.5">
                <div className="grid gap-2 text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted px-1" style={{ gridTemplateColumns: "1.2fr 1.6fr 1fr .8fr 28px" }}>
                  <div>Tier</div><div>What's included</div><div>Length</div><div>Price</div><div />
                </div>
                {s.tiers.map((t, i) => (
                  <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1.2fr 1.6fr 1fr .8fr 28px" }}>
                    <input aria-label="Tier name" value={t.name} onChange={(e) => patch({ tiers: s.tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Basic" className={dense} />
                    <input aria-label="What's included" value={t.includes} onChange={(e) => patch({ tiers: s.tiers.map((x, j) => (j === i ? { ...x, includes: e.target.value } : x)) })} placeholder="mat time, 1 coach" className={dense} />
                    <input aria-label="Length" value={t.length} onChange={(e) => patch({ tiers: s.tiers.map((x, j) => (j === i ? { ...x, length: e.target.value } : x)) })} placeholder="60 minutes" className={dense} />
                    <input aria-label="Price" type="number" step="0.01" min="0" value={t.price ?? ""} onChange={(e) => patch({ tiers: s.tiers.map((x, j) => (j === i ? { ...x, price: numOrNull(e.target.value) } : x)) })} className={`${dense} tabular-nums`} />
                    <button type="button" aria-label="Remove tier" onClick={() => patch({ tiers: s.tiers.filter((_, j) => j !== i) })} className="w-7 h-7 rounded-lg hover:bg-app-bg text-text-muted flex items-center justify-center"><Trash2 size={14} /></button>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-1">
                  <button type="button" onClick={() => patch({ tiers: [...s.tiers, { name: "", includes: "", length: "", price: null }] })} className="text-[12.5px] font-medium text-brand inline-flex items-center gap-1"><Plus size={13} /> Add tier</button>
                  <span className="text-[12px] text-text-muted">{range ? `Families choose one at checkout · ${money(range.min)} to ${money(range.max)}` : "Add a price to each tier"}</span>
                </div>
              </div>
            )}
          </Card>

          {/* Inventory & variants */}
          <Card title="Inventory & variants" summary={inventorySummary} open={open.inventory} onToggle={() => toggle("inventory")} locked={stock.holdsStock ? null : stock.reason}>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-app-border px-3 py-2.5">
              <div>
                <div className="text-sm font-medium text-text-primary">Track inventory</div>
                <div className="text-[11.5px] text-text-muted">Sold-out variants disappear from the store and the Sell screen.</div>
              </div>
              <Switch id="p-track" on={trackInventory} onChange={setTrackInventory} />
            </div>
            {trackInventory && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {s.variants.length === 0 && (
                    <div>
                      <label className={label} htmlFor="p-inventory">Stock on hand</label>
                      <input id="p-inventory" type="number" min="0" value={inventory} onChange={(e) => setInventory(e.target.value)} className={input} />
                    </div>
                  )}
                  <div>
                    <label className={label} htmlFor="p-low">Low-stock alert at</label>
                    <input id="p-low" type="number" min="0" value={s.lowStockAlertQuantity ?? ""} onChange={(e) => patch({ lowStockAlertQuantity: numOrNull(e.target.value) })} placeholder={String(DEFAULT_LOW_STOCK)} className={input} />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className={label}>Option groups</div>
                  {s.optionGroups.map((g, gi) => (
                    <div key={gi} className="rounded-xl border border-app-border p-2.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <input aria-label="Group name" value={g.name} onChange={(e) => setGroups(s.optionGroups.map((x, j) => (j === gi ? { ...x, name: e.target.value } : x)))} placeholder="Size" className={`${dense} max-w-[160px]`} />
                        <button type="button" aria-label="Remove group" onClick={() => setGroups(s.optionGroups.filter((_, j) => j !== gi))} className="w-7 h-7 rounded-lg hover:bg-app-bg text-text-muted flex items-center justify-center"><Trash2 size={14} /></button>
                      </div>
                      <ChipRow values={g.values} onChange={(values) => setGroups(s.optionGroups.map((x, j) => (j === gi ? { ...x, values } : x)))} placeholder="+ value" />
                    </div>
                  ))}
                  <button type="button" onClick={() => setGroups([...s.optionGroups, { name: s.optionGroups.length === 0 ? "Size" : s.optionGroups.length === 1 ? "Color" : "", values: [] }])} className="text-[12.5px] font-medium text-brand inline-flex items-center gap-1"><Plus size={13} /> Add option group</button>
                </div>
                {s.variants.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className={label}>Variants</div>
                      <div className="flex gap-3 text-[12px]">
                        <button type="button" className="text-brand font-medium" onClick={() => { const n = Number(prompt("Set every variant's stock to:", "10")); if (Number.isFinite(n) && n >= 0) patch({ variants: s.variants.map((v) => ({ ...v, stock: Math.round(n) })) }); }}>Set all stock…</button>
                        <button type="button" className="text-brand font-medium" onClick={() => patch({ variants: s.variants.map((v) => ({ ...v, price: null })) })}>Apply base price to all</button>
                      </div>
                    </div>
                    <div className="rounded-xl border border-app-border overflow-hidden">
                      <div className="grid gap-2 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted" style={{ gridTemplateColumns: "1.4fr 1fr .8fr .7fr 1fr", background: "var(--color-table-chrome)" }}>
                        <div>Variant</div><div>SKU</div><div>Price</div><div>Stock</div><div>Status</div>
                      </div>
                      {s.variants.map((v, i) => {
                        const st = variantStatus(v, threshold);
                        return (
                          <div key={v.id} className="grid gap-2 items-center px-2.5 py-1.5 border-t" style={{ gridTemplateColumns: "1.4fr 1fr .8fr .7fr 1fr", borderColor: "var(--color-hairline)" }}>
                            <div className="min-w-0">
                              <div className="text-[13.5px] font-medium text-text-primary truncate">{v.label}</div>
                              {!producedIds.has(v.id) && <div className="text-[10.5px]" style={{ color: "var(--color-warn-text)" }}>No longer an option — set to 0 to drop</div>}
                            </div>
                            <input aria-label={`${v.label} SKU`} value={v.sku} onChange={(e) => patch({ variants: s.variants.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)) })} placeholder="—" className={dense} />
                            <input aria-label={`${v.label} price`} type="number" step="0.01" min="0" value={v.price ?? ""} onChange={(e) => patch({ variants: s.variants.map((x, j) => (j === i ? { ...x, price: numOrNull(e.target.value) } : x)) })} placeholder={price ? money(basePrice).slice(1) : "base"} className={`${dense} tabular-nums`} />
                            <input aria-label={`${v.label} stock`} type="number" min="0" value={v.stock} onChange={(e) => patch({ variants: s.variants.map((x, j) => (j === i ? { ...x, stock: Math.max(0, Math.round(Number(e.target.value) || 0)) } : x)) })} className={`${dense} tabular-nums`} style={{ borderColor: st === "OUT" ? "var(--color-danger)" : st === "LOW" ? "var(--color-warn-text)" : undefined }} />
                            <StockPill status={st} />
                          </div>
                        );
                      })}
                    </div>
                    <div className="text-[12px] text-text-muted tabular-nums">{ledger.units} units · {money(ledger.retailValue)} at retail</div>
                  </div>
                )}
              </>
            )}
          </Card>

          {/* Booking & availability */}
          <Card title="Booking & availability" summary={bookingSummary} open={open.booking} onToggle={() => toggle("booking")} locked={bookable ? null : "Only rentals and parties are booked into time slots."}>
            <div>
              <div className={label}>Bookable days</div>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d) => {
                  const on = s.availableDays.includes(d);
                  return <button key={d} type="button" aria-pressed={on} onClick={() => patch({ availableDays: on ? s.availableDays.filter((x) => x !== d) : [...s.availableDays, d] })} className={`px-3 py-1.5 rounded-full text-xs border ${on ? "bg-brand text-white border-brand" : "border-app-border text-text-muted hover:bg-app-bg"}`}>{d}</button>;
                })}
              </div>
            </div>
            <div>
              <label className={label} htmlFor="p-windows">Time windows</label>
              <textarea id="p-windows" rows={2} value={s.timeWindows.join("\n")} onChange={(e) => patch({ timeWindows: e.target.value.split("\n") })} placeholder={"Mon-Fri 4:00 PM-8:00 PM\nSat 9:00 AM-1:00 PM"} className={input} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className={label} htmlFor="p-buffer">Buffer (min)</label><input id="p-buffer" type="number" min="0" value={s.bufferMinutes ?? ""} onChange={(e) => patch({ bufferMinutes: numOrNull(e.target.value) })} className={input} /></div>
              <div><label className={label} htmlFor="p-cap">Bookings per slot</label><input id="p-cap" type="number" min="0" value={s.capacityLimit ?? ""} onChange={(e) => patch({ capacityLimit: numOrNull(e.target.value) })} className={input} /></div>
              <div><label className={label} htmlFor="p-guests">Max guests</label><input id="p-guests" type="number" min="0" value={s.maxGuests ?? ""} onChange={(e) => patch({ maxGuests: numOrNull(e.target.value) })} className={input} /></div>
            </div>
            <div className="space-y-1.5">
              <div className={label}>Length & price</div>
              {s.durations.map((d, i) => (
                <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1fr 1fr 28px" }}>
                  <div className="relative"><input aria-label="Minutes" type="number" min="0" value={d.mins || ""} onChange={(e) => patch({ durations: s.durations.map((x, j) => (j === i ? { ...x, mins: Math.round(Number(e.target.value) || 0) } : x)) })} className={dense} /><span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-text-muted">min</span></div>
                  <input aria-label="Price" type="number" step="0.01" min="0" value={d.price ?? ""} onChange={(e) => patch({ durations: s.durations.map((x, j) => (j === i ? { ...x, price: numOrNull(e.target.value) } : x)) })} placeholder="$" className={`${dense} tabular-nums`} />
                  <button type="button" aria-label="Remove length" onClick={() => patch({ durations: s.durations.filter((_, j) => j !== i) })} className="w-7 h-7 rounded-lg hover:bg-app-bg text-text-muted flex items-center justify-center"><Trash2 size={14} /></button>
                </div>
              ))}
              <button type="button" onClick={() => patch({ durations: [...s.durations, { mins: s.durations.length ? s.durations[s.durations.length - 1].mins + 30 : 60, price: null }] })} className="text-[12.5px] font-medium text-brand inline-flex items-center gap-1"><Plus size={13} /> Add length</button>
            </div>
            <div>
              <div className={label}>Payment at booking</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([["FULL", "Pay in full", "Charged when they book."], ["DEPOSIT", "Deposit", "Part now, the rest at the event."], ["REQUEST_ONLY", "Request first", "No money until staff confirm."]] as const).map(([k, t, sub]) => (
                  <button key={k} type="button" aria-pressed={s.depositMode === k} onClick={() => patch({ depositMode: k })} className={`text-left rounded-xl border px-3 py-2.5 ${s.depositMode === k ? "border-brand" : "border-app-border hover:bg-app-bg"}`} style={s.depositMode === k ? { background: "var(--color-info-surface)" } : undefined}>
                    <div className={`text-sm font-semibold ${s.depositMode === k ? "text-brand" : "text-text-primary"}`}>{t}</div>
                    <div className="text-[11.5px] text-text-muted">{sub}</div>
                  </button>
                ))}
              </div>
              {s.depositMode === "DEPOSIT" ? (
                <div className="mt-2 max-w-[220px]"><label className={label} htmlFor="p-deposit">Deposit amount</label><input id="p-deposit" type="number" step="0.01" min="0" value={s.depositAmount ?? ""} onChange={(e) => patch({ depositAmount: numOrNull(e.target.value) })} className={input} /></div>
              ) : (
                <div className="mt-2"><LockPanel>{s.depositMode === "FULL" ? "No deposit — the full price is charged at booking." : "No deposit — nothing is charged until staff confirm the request."}</LockPanel></div>
              )}
            </div>
            <div className="space-y-1.5">
              <div className={label}>Add-ons</div>
              {s.addOns.map((a, i) => (
                <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1.6fr .9fr .8fr 28px" }}>
                  <input aria-label="Add-on" value={a.label} onChange={(e) => patch({ addOns: s.addOns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="Extra coach" className={dense} />
                  <select aria-label="Pricing" value={a.perGuest ? "GUEST" : "FLAT"} onChange={(e) => patch({ addOns: s.addOns.map((x, j) => (j === i ? { ...x, perGuest: e.target.value === "GUEST" } : x)) })} className={dense}><option value="FLAT">Flat</option><option value="GUEST">Per guest</option></select>
                  <input aria-label="Price" type="number" step="0.01" min="0" value={a.price ?? ""} onChange={(e) => patch({ addOns: s.addOns.map((x, j) => (j === i ? { ...x, price: numOrNull(e.target.value) } : x)) })} placeholder="$" className={`${dense} tabular-nums`} />
                  <button type="button" aria-label="Remove add-on" onClick={() => patch({ addOns: s.addOns.filter((_, j) => j !== i) })} className="w-7 h-7 rounded-lg hover:bg-app-bg text-text-muted flex items-center justify-center"><Trash2 size={14} /></button>
                </div>
              ))}
              <button type="button" onClick={() => patch({ addOns: [...s.addOns, { label: "", price: null, perGuest: false }] })} className="text-[12.5px] font-medium text-brand inline-flex items-center gap-1"><Plus size={13} /> Add add-on</button>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-app-border px-3 py-2.5 text-sm text-text-primary">
              Staff approves each booking
              <Switch id="p-approve" on={s.requiresApproval} onChange={(v) => patch({ requiresApproval: v })} />
            </label>
            <div>
              <div className={label}>Blackout dates</div>
              <ChipRow values={s.blackoutDates} onChange={(v) => patch({ blackoutDates: v })} placeholder="+ 2026-12-25" />
            </div>
          </Card>

          {/* Questions at checkout — every type; digital delivery for DIGITAL */}
          <Card title={productType === "DIGITAL" ? "Delivery & questions" : "Questions at checkout"} summary={s.questions.length ? `${s.questions.length} question${s.questions.length === 1 ? "" : "s"}${s.questions.some((q) => q.required) ? " · some required" : ""}` : productType === "DIGITAL" ? (s.digitalInstructions ? "Delivery note set" : "No delivery note") : "None"} open={open.digital} onToggle={() => toggle("digital")}>
            {productType === "DIGITAL" && (
              <>
                <div><label className={label} htmlFor="p-digital">Delivery instructions (sent after purchase)</label><textarea id="p-digital" rows={2} value={s.digitalInstructions ?? ""} onChange={(e) => patch({ digitalInstructions: e.target.value || null })} className={input} /></div>
                <div><label className={label} htmlFor="p-access">File / access note</label><input id="p-access" value={s.digitalAccess ?? ""} onChange={(e) => patch({ digitalAccess: e.target.value || null })} placeholder="Existing private upload id or access instructions" className={input} /></div>
              </>
            )}
            <div className="space-y-1.5">
              {s.questions.map((q, i) => (
                <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1.8fr .9fr .9fr 28px" }}>
                  <input aria-label="Question" value={q.label} onChange={(e) => patch({ questions: s.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="Allergies?" className={dense} />
                  <select aria-label="Answer type" value={q.kind} onChange={(e) => patch({ questions: s.questions.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof q.kind } : x)) })} className={dense}><option value="SHORT">Short text</option><option value="LONG">Long text</option><option value="NUMBER">Number</option></select>
                  <select aria-label="Required" value={q.required ? "R" : "O"} onChange={(e) => patch({ questions: s.questions.map((x, j) => (j === i ? { ...x, required: e.target.value === "R" } : x)) })} className={dense}><option value="O">Optional</option><option value="R">Required</option></select>
                  <button type="button" aria-label="Remove question" onClick={() => patch({ questions: s.questions.filter((_, j) => j !== i) })} className="w-7 h-7 rounded-lg hover:bg-app-bg text-text-muted flex items-center justify-center"><Trash2 size={14} /></button>
                </div>
              ))}
              <button type="button" onClick={() => patch({ questions: [...s.questions, { label: "", kind: "SHORT", required: false }] })} className="text-[12.5px] font-medium text-brand inline-flex items-center gap-1"><Plus size={13} /> Add question</button>
            </div>
            {productType === "OTHER" && (
              <label className="flex items-center justify-between gap-3 rounded-xl border border-app-border px-3 py-2.5 text-sm text-text-primary">
                Staff approves before fulfilling
                <Switch id="p-other-approve" on={s.otherRequiresApproval} onChange={(v) => patch({ otherRequiresApproval: v })} />
              </label>
            )}
          </Card>

          {/* Where it's sold */}
          <Card title="Where it's sold" summary={soldSummary} open={open.sold} onToggle={() => toggle("sold")}>
            <div className="space-y-1.5">
              {(Object.keys(STOREFRONT_LABELS) as Storefront[]).map((f) => {
                const on = storefronts.includes(f);
                return (
                  <label key={f} className="flex items-start gap-3 rounded-xl border border-app-border px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={on} onChange={() => {
                      let next = on ? storefronts.filter((x) => x !== f) : [...storefronts, f];
                      // Front desk only is exclusive: it means "nowhere else".
                      if (f === "STAFF_ONLY" && !on) next = ["STAFF_ONLY"];
                      else if (f !== "STAFF_ONLY" && !on) next = next.filter((x) => x !== "STAFF_ONLY");
                      if (next.length === 0) next = ["STAFF_ONLY"];
                      setStorefronts(next);
                    }} className="rounded mt-0.5" />
                    <span>
                      <span className="block text-sm font-medium text-text-primary">{STOREFRONT_LABELS[f].label}</span>
                      <span className="block text-[11.5px] text-text-muted">{STOREFRONT_LABELS[f].hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {storefronts.includes("PUBLIC_LINK") && <LockPanel>The shareable link and QR tag are generated when you save — a dedicated public product page (/p/…) is coming; today the public link widens who sees it in the member store.</LockPanel>}
            {productType === "GEAR" ? (
              <div><label className={label} htmlFor="p-fulfil">Fulfillment</label><select id="p-fulfil" value={s.fulfillment} onChange={(e) => patch({ fulfillment: e.target.value })} className={input}><option value="PICKUP">Pickup at the gym</option><option value="SHIPPING_FUTURE">Shipping (later)</option></select></div>
            ) : (
              <LockPanel>Nothing to hand over for this type — no fulfillment step.</LockPanel>
            )}
            <div><label className={label} htmlFor="p-notes">Internal note (staff only)</label><textarea id="p-notes" rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} className={input} /></div>
          </Card>

          {/* Recap */}
          <div className="rounded-[14px] px-4 py-3 text-[13px] text-text-primary" style={{ background: "var(--color-info-surface)", border: "1px solid var(--color-info-border)" }}>
            <span className="text-[11px] font-semibold uppercase tracking-[.05em] text-brand mr-2">With these settings</span>{recap}
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        </form>
      </div>
    </div>
  );
}

export function StockPill({ status }: { status: "OUT" | "LOW" | "OK" }) {
  const map = {
    OUT: { label: "Out of stock", style: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" } },
    LOW: { label: "Low — reorder", style: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" } },
    OK: { label: "In stock", style: { background: "var(--color-success-surface)", color: "var(--color-success-text)" } },
  } as const;
  return <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={map[status].style}>{map[status].label}</span>;
}
