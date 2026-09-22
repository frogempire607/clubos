"use client";

import { useEffect, useMemo, useState } from "react";
import { Package } from "lucide-react";
import StaffDiscountPicker from "@/components/StaffDiscountPicker";
import ProductEditor from "@/components/products/ProductEditor";
import ProductCard, { deriveCard } from "@/components/products/ProductCard";

type Category = "GEAR" | "APPAREL" | "FACILITY" | "SERVICE" | "OTHER";
type ProductType = "GEAR" | "FACILITY_RENTAL" | "BIRTHDAY_PARTY" | "DIGITAL" | "OTHER";
type Visibility = "MEMBERS_ONLY" | "PUBLIC_ONLY" | "MEMBERS_AND_PUBLIC" | "INTERNAL_ONLY";
type ShowLocation = "MEMBER_PORTAL" | "PUBLIC_CHECKOUT" | "INTERNAL_ONLY";

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: Category;
  productType: ProductType;
  imageUrl?: string | null;
  active: boolean;
  visibility: Visibility;
  showLocation: ShowLocation;
  taxable: boolean;
  internalNotes: string | null;
  settings: Record<string, any> | null;
  trackInventory: boolean;
  inventory: number | null;
  _count: { sales: number };
};

type Member = { id: string; firstName: string; lastName: string };

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [selling, setSelling] = useState<Product | null>(null);
  const [filter, setFilter] = useState<"all" | "gear" | "bookable" | "attention" | "inactive">("all");
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    const res = await fetch("/api/products");
    if (res.ok) setProducts(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Remove this product?")) return;
    await fetch(`/api/products/${id}`, { method: "DELETE" });
    load();
  }

  async function handleToggleActive(p: Product) {
    await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !p.active }),
    });
    load();
  }

  // One derivation per product feeds the cards, the filter counts and the
  // subtitle — the handoff's "nothing that appears twice is stored twice".
  const derived = useMemo(() => products.map((p) => ({ p, d: deriveCard(p) })), [products]);
  const counts = {
    all: derived.length,
    gear: derived.filter((x) => x.p.productType === "GEAR").length,
    bookable: derived.filter((x) => x.d.bookable).length,
    attention: derived.filter((x) => x.d.needsAttention).length,
    inactive: derived.filter((x) => !x.p.active).length,
  };
  const retail = derived.reduce((s, x) => s + x.d.ledger.retailValue, 0);
  const q = query.trim().toLowerCase();
  const shown = derived.filter((x) =>
    (filter === "all" ? true : filter === "gear" ? x.p.productType === "GEAR" : filter === "bookable" ? x.d.bookable : filter === "attention" ? x.d.needsAttention : !x.p.active) &&
    (!q || x.p.name.toLowerCase().includes(q) || (x.p.description ?? "").toLowerCase().includes(q)),
  );
  const FILTERS: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" }, { key: "gear", label: "Gear" }, { key: "bookable", label: "Bookable" }, { key: "attention", label: "Low or out" }, { key: "inactive", label: "Inactive" },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      <div className="flex items-start justify-between gap-3 mb-5 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Products</h1>
          <p className="text-sm text-text-muted tabular-nums">
            {products.length} product{products.length === 1 ? "" : "s"}
            {retail > 0 ? ` · $${retail.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} inventory at retail` : ""}
            {counts.attention > 0 ? ` · ${counts.attention} need${counts.attention === 1 ? "s" : ""} attention` : ""}
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Add product
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex gap-1 bg-app-bg rounded-lg p-1 w-fit flex-wrap">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={`text-xs px-3 py-1.5 rounded-md transition tabular-nums ${filter === f.key ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}>
              {f.label} · {counts[f.key]}
            </button>
          ))}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products" aria-label="Search products" className="text-sm px-3 py-2 border border-app-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-brand min-w-[200px]" />
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : products.length === 0 ? (
        <div className="bg-surface rounded-xl border border-app-border p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Package className="h-7 w-7" strokeWidth={2} />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No products yet</h3>
          <p className="text-sm text-text-muted mb-4">Add items to sell — gear, apparel, facility rentals, or anything else.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add product
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div className="bg-surface rounded-xl border border-app-border p-10 text-center text-sm text-text-muted">Nothing matches this filter.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map(({ p }) => (
            <ProductCard
              key={p.id}
              product={p}
              onSell={() => setSelling(p)}
              onEdit={() => setEditing(p)}
              onToggleActive={() => handleToggleActive(p)}
              onRemove={() => handleDelete(p.id)}
            />
          ))}
        </div>
      )}

      {(showAdd || editing) && (
        <ProductEditor
          product={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {selling && (
        <SellModal product={selling} onClose={() => setSelling(null)} onSold={() => { setSelling(null); load(); }} />
      )}
    </div>
  );
}

// ── Sell Modal ────────────────────────────────────────────────────────────────
function SellModal({ product, onClose, onSold }: { product: Product; onClose: () => void; onSold: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [memberId, setMemberId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [manualSale, setManualSale] = useState(true);
  const [discountCode, setDiscountCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/members").then((r) => r.json()).then((d) => setMembers(Array.isArray(d) ? d : []));
  }, []);

  const total = Number(product.price) * quantity;

  async function handleSell() {
    setError("");
    setSaving(true);
    const res = await fetch(`/api/products/${product.id}/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: memberId || null, quantity, notes: notes || null, manualSale, discountCode }),
    });
    const data = await res.json();
    setSaving(false);

    if (!res.ok) { setError(data.error?.toString() || "Failed"); return; }

    if (!manualSale && data.url) {
      window.location.href = data.url;
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
        <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-sm p-8 text-center">
          <div className="text-3xl mb-2">✓</div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Sale recorded</h3>
          <p className="text-sm text-text-muted mb-6">
            {quantity}× {product.name} — ${total.toFixed(2)}
          </p>
          <button onClick={onSold} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Sell — {product.name}</h2>
            <p className="text-sm text-text-muted">${Number(product.price).toFixed(2)} each</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Member (optional)</label>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="">Walk-in / no member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Quantity</label>
            <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            {product.trackInventory && product.inventory !== null && (
              <p className="text-xs text-text-muted mt-1">{product.inventory} in stock</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes (optional)</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Size, color, special instructions…" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <StaffDiscountPicker
            itemType="PRODUCT"
            value={discountCode}
            onChange={(code) => setDiscountCode(code)}
            originalPrice={total}
          />


          <div className="border border-app-border rounded-lg p-3 space-y-2">
            <label className="block text-sm font-medium text-text-primary">Payment method</label>
            <div className="flex gap-3">
              <button type="button" onClick={() => setManualSale(true)} className={`flex-1 py-2 rounded-lg text-sm border transition ${manualSale ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                Cash / Manual
              </button>
              <button type="button" onClick={() => setManualSale(false)} className={`flex-1 py-2 rounded-lg text-sm border transition ${!manualSale ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                Stripe Checkout
              </button>
            </div>
            <p className="text-xs text-text-muted">{manualSale ? "Records the sale immediately without Stripe." : "Opens a Stripe payment link for the customer."}</p>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-app-border">
            <span className="text-sm text-text-muted">Total</span>
            <span className="text-lg font-semibold text-text-primary">${total.toFixed(2)}</span>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="button" onClick={handleSell} disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Processing…" : manualSale ? "Record sale" : "Generate link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
