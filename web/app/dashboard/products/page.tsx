"use client";

import { useEffect, useState } from "react";
import ImageUpload from "@/components/ImageUpload";

type Category = "GEAR" | "APPAREL" | "FACILITY" | "SERVICE" | "OTHER";

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: Category;
  active: boolean;
  trackInventory: boolean;
  inventory: number | null;
  _count: { sales: number };
};

type Member = { id: string; firstName: string; lastName: string };

const categoryLabels: Record<Category, string> = {
  GEAR: "Gear",
  APPAREL: "Apparel",
  FACILITY: "Facility",
  SERVICE: "Service",
  OTHER: "Other",
};

const categoryColors: Record<Category, string> = {
  GEAR: "bg-brand text-white",
  APPAREL: "bg-brand text-white",
  FACILITY: "bg-orange-accent text-white",
  SERVICE: "bg-lime-accent text-text-primary",
  OTHER: "bg-app-bg text-text-primary",
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [selling, setSelling] = useState<Product | null>(null);

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

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Products</h1>
          <p className="text-sm text-text-muted">{products.length} item{products.length === 1 ? "" : "s"} — gear, services, facility rentals</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Add product
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : products.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="text-4xl mb-2">◈</div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No products yet</h3>
          <p className="text-sm text-text-muted mb-4">Add items to sell — gear, apparel, facility rentals, private lessons, or anything else.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add product
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                {["Product", "Category", "Price", "Inventory", "Sales", "Status", ""].map((h) => (
                  <th key={h} className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <td className="px-5 py-3">
                    <div className="text-sm font-medium text-text-primary">{p.name}</div>
                    {p.description && <div className="text-xs text-text-muted line-clamp-1">{p.description}</div>}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryColors[p.category]}`}>
                      {categoryLabels[p.category]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm font-medium text-text-primary">${Number(p.price).toFixed(2)}</td>
                  <td className="px-5 py-3 text-sm text-text-muted">
                    {p.trackInventory ? (p.inventory ?? 0) : "—"}
                  </td>
                  <td className="px-5 py-3 text-sm text-text-muted">{p._count.sales}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.active ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted"}`}>
                      {p.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setSelling(p)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg font-medium">
                        Sell
                      </button>
                      <button onClick={() => handleToggleActive(p)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                      <button onClick={() => setEditing(p)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                      <button onClick={() => handleDelete(p.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(showAdd || editing) && (
        <ProductModal
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

// ── Product Modal ─────────────────────────────────────────────────────────────
function ProductModal({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!product;
  const [name, setName] = useState(product?.name || "");
  const [description, setDescription] = useState(product?.description || "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [category, setCategory] = useState<Category>(product?.category || "OTHER");
  const [trackInventory, setTrackInventory] = useState(product?.trackInventory || false);
  const [inventory, setInventory] = useState(product?.inventory != null ? String(product.inventory) : "");
  const [imageUrl, setImageUrl] = useState((product as any)?.imageUrl || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      name,
      description: description || null,
      price: parseFloat(price),
      category,
      trackInventory,
      inventory: trackInventory && inventory !== "" ? parseInt(inventory, 10) : null,
      imageUrl: imageUrl || null,
    };

    const url = isEdit ? `/api/products/${product!.id}` : "/api/products";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit product" : "Add product"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <ImageUpload
            label="Product image (optional)"
            value={imageUrl || null}
            onChange={setImageUrl}
            shape="square"
          />

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Product name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Rashguard, Private lesson, Mat rental" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description (optional)</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">$</span>
                <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="0.00" className="w-full pl-7 pr-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                <option value="GEAR">Gear</option>
                <option value="APPAREL">Apparel</option>
                <option value="FACILITY">Facility</option>
                <option value="SERVICE">Service</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
            <input type="checkbox" id="trackInventory" checked={trackInventory} onChange={(e) => setTrackInventory(e.target.checked)} className="rounded" />
            <label htmlFor="trackInventory" className="text-sm font-medium text-text-primary cursor-pointer select-none">Track inventory</label>
          </div>

          {trackInventory && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Current stock</label>
              <input type="number" min="0" value={inventory} onChange={(e) => setInventory(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add product"}
            </button>
          </div>
        </form>
      </div>
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
      body: JSON.stringify({ memberId: memberId || null, quantity, notes: notes || null, manualSale }),
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
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl w-full max-w-sm p-8 text-center">
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md">
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
