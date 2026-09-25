"use client";

// Front-desk Sell (B10 handoff screen 2g). Grounded in the old SellModal +
// StaffDiscountPicker; the change is WHAT is sold: a variant, not a product.
// Left: one tile per variant with its stock (sold-out tiles disabled, low ones
// amber), read from the same ledger the editor and cards use. Right: member,
// quantity, note, discount, the two real payment paths, and a CTA that says
// which one it is. One line per sale — a multi-line cart is a later slice.

import { useEffect, useMemo, useState } from "react";
import StaffDiscountPicker from "@/components/StaffDiscountPicker";
import {
  checkStock, findVariant, normalizeProductSettings, stockMessage, unitPriceFor, unitPriceAtQuantity, variantStatus,
} from "@/lib/productSettings";

export type SellableProduct = {
  id: string;
  name: string;
  price: number | string;
  trackInventory: boolean;
  inventory: number | null;
  settings: unknown;
};

type Member = { id: string; firstName: string; lastName: string };
const money = (n: number) => `$${n.toFixed(2)}`;

export default function SellModal({ product, onClose, onSold }: { product: SellableProduct; onClose: () => void; onSold: () => void }) {
  const settings = useMemo(() => normalizeProductSettings(product.settings), [product.settings]);
  const hasVariants = settings.variants.length > 0;
  const [members, setMembers] = useState<Member[]>([]);
  const [memberId, setMemberId] = useState("");
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [manualSale, setManualSale] = useState(true);
  const [discountCode, setDiscountCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/members").then((r) => r.json()).then((d) => setMembers(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const variant = findVariant(settings, variantId);
  const listUnit = unitPriceFor(settings, product.price, variant, "STAFF");
  // Bulk pricing — same rule the sell route applies.
  const bulk = unitPriceAtQuantity(settings.quantityBreaks, listUnit, quantity);
  const unit = bulk.unit;
  const total = unit * quantity;
  const stock = checkStock(settings, product, variantId, quantity);
  const lineLabel = variant ? `${product.name} — ${variant.label}` : product.name;

  async function handleSell() {
    if (!stock.ok) { setError(stockMessage(stock)); return; }
    setError(""); setSaving(true);
    const res = await fetch(`/api/products/${product.id}/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: memberId || null, quantity, notes: notes || null, manualSale, discountCode, variantId }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(data.error?.toString() || "Failed"); return; }
    if (!manualSale && data.url) { window.location.href = data.url; return; }
    setDone(true);
  }

  if (done) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onSold}>
        <div className="bg-surface rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-8 text-center" onClick={(e) => e.stopPropagation()}>
          <div className="mx-auto mb-3 h-11 w-11 rounded-full flex items-center justify-center text-lg font-bold" style={{ background: "rgba(163,230,53,.25)", color: "#3F6212" }}>✓</div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Sale recorded</h3>
          <p className="text-sm text-text-muted mb-6">{quantity}× {lineLabel} — {money(total)}</p>
          <button onClick={onSold} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover min-h-[44px]">Done</button>
        </div>
      </div>
    );
  }

  const input = "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-brand min-h-[44px] md:min-h-0";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div className={`bg-surface rounded-t-2xl sm:rounded-2xl w-full ${hasVariants ? "sm:max-w-3xl" : "sm:max-w-md"} max-h-[92vh] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-app-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Sell — {product.name}</h2>
            <p className="text-xs text-text-muted">
              {hasVariants ? `${settings.variants.length} variants · pick one` : `${money(Number(product.price))} each`}
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none w-11 h-11 flex items-center justify-center -mr-2">×</button>
        </div>

        <div className={`overflow-y-auto p-5 ${hasVariants ? "grid gap-5 md:grid-cols-[1fr_300px]" : "space-y-4"}`}>
          {hasVariants && (
            <div>
              <p className="text-xs font-medium text-text-primary mb-2">What are they taking?</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {settings.variants.map((v) => {
                  const st = variantStatus(v, settings.lowStockAlertQuantity);
                  const sel = v.id === variantId;
                  const price = unitPriceFor(settings, product.price, v, "STAFF");
                  return (
                    <button
                      key={v.id} type="button" disabled={st === "OUT"}
                      onClick={() => { setVariantId(sel ? null : v.id); setError(""); }}
                      className={`text-left rounded-xl border p-3 min-h-[64px] transition ${sel ? "border-brand bg-brand/5" : st === "OUT" ? "border-app-border bg-app-bg opacity-60 cursor-not-allowed" : "border-app-border hover:bg-app-bg"}`}
                    >
                      <span className={`block text-sm font-semibold leading-tight ${sel ? "text-brand" : "text-text-primary"}`}>{v.label}</span>
                      <span className="block text-xs text-text-muted mt-0.5">{money(price)}{v.sku ? ` · ${v.sku}` : ""}</span>
                      <span className={`block text-[11px] mt-1 font-medium ${st === "OUT" ? "text-red-600" : st === "LOW" ? "text-amber-700" : "text-text-muted"}`}>
                        {st === "OUT" ? "Sold out" : `${v.stock} in stock`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Member (optional)</label>
              <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className={input}>
                <option value="">Walk-in / no member</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Quantity</label>
                <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))} className={input} />
              </div>
              <p className="text-xs text-text-muted pb-2.5">
                {hasVariants
                  ? variant ? `${variant.stock} in stock` : "—"
                  : product.trackInventory && product.inventory !== null ? `${product.inventory} in stock` : "Unlimited"}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Note (optional)</label>
              <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={hasVariants ? "Special instructions…" : "Size, color, special instructions…"} className={input} />
            </div>

            <StaffDiscountPicker itemType="PRODUCT" value={discountCode} onChange={(code) => setDiscountCode(code)} originalPrice={total} />

            <div className="border border-app-border rounded-lg p-3 space-y-2">
              <label className="block text-sm font-medium text-text-primary">Payment method</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setManualSale(true)} className={`flex-1 py-2 rounded-lg text-sm border transition min-h-[44px] ${manualSale ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>Cash / Manual</button>
                <button type="button" onClick={() => setManualSale(false)} className={`flex-1 py-2 rounded-lg text-sm border transition min-h-[44px] ${!manualSale ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>Stripe Checkout</button>
              </div>
              <p className="text-xs text-text-muted">{manualSale ? "Records the sale immediately without Stripe." : "Opens a Stripe payment link for the customer."}</p>
            </div>

            <div className="pt-2 border-t border-app-border space-y-1">
              <div className="flex items-center justify-between text-sm text-text-muted"><span>{quantity}× {variant ? variant.label : product.name}</span><span>{money(unit)} each{bulk.bulk ? ` (${bulk.bulk.minQty}+ bulk, was ${money(listUnit)})` : ""}</span></div>
              <div className="flex items-center justify-between"><span className="text-sm text-text-muted">Total</span><span className="text-lg font-semibold text-text-primary">{money(total)}</span></div>
            </div>

            {(error || (!stock.ok && (variantId || !hasVariants))) && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error || (!stock.ok ? stockMessage(stock) : "")}</div>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg min-h-[44px]">Cancel</button>
              <button type="button" onClick={handleSell} disabled={saving || !stock.ok} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 min-h-[44px]">
                {saving ? "Processing…" : manualSale ? "Record sale" : "Generate link"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
