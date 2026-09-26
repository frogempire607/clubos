"use client";

// B10 slice 3 — Inventory across all products (handoff 2c). Four computed
// tiles, then every tracked variant worst first. The −/+ stepper and Receive
// stock write the same ledger the member store and the Sell tiles read.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Minus, Plus } from "lucide-react";
import type { InventoryView, InventoryRow } from "@/lib/productInventory";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PILL: Record<InventoryRow["status"], { label: string; style: React.CSSProperties }> = {
  OUT: { label: "Out of stock", style: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" } },
  LOW: { label: "Low — reorder", style: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" } },
  OK: { label: "In stock", style: { background: "var(--color-success-surface)", color: "var(--color-success-text)" } },
};

export default function InventoryPage() {
  const [view, setView] = useState<InventoryView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  const load = () => fetch("/api/products/inventory").then((r) => (r.ok ? r.json() : null)).then((d) => d && setView(d));
  useEffect(() => { load(); }, []);

  const key = (r: InventoryRow) => `${r.productId}|${r.variantId ?? ""}`;
  async function change(r: InventoryRow, body: { delta?: number; set?: number }) {
    setBusy(key(r)); setErr("");
    const res = await fetch(`/api/products/${r.productId}/stock`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variantId: r.variantId, ...body }) });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setErr(d.error || "Couldn't change the count."); return; }
    setReceiving((m) => { const n = { ...m }; delete n[key(r)]; return n; });
    load();
  }

  const rows = (view?.rows ?? []).filter((r) => !q.trim() || `${r.productName} ${r.label} ${r.sku}`.toLowerCase().includes(q.trim().toLowerCase()));
  const tiles = view?.tiles;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl">
      <Link href="/dashboard/products" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-3"><ArrowLeft size={15} /> Products</Link>
      <div className="flex items-start justify-between gap-3 mb-5 flex-wrap">
        <div>
          <h1 className="text-[20px] font-semibold text-text-primary">Inventory</h1>
          <p className="text-sm text-text-muted">Every tracked item and size in one place, worst first.</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item, size or SKU" className="text-sm px-3 py-2 border border-app-border rounded-lg bg-surface text-text-primary min-w-[220px]" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          ["Units on hand", tiles ? String(tiles.units) : "—"],
          ["Retail value", tiles ? money(tiles.retailValue) : "—"],
          ["Low stock", tiles ? String(tiles.low) : "—"],
          ["Sold out", tiles ? String(tiles.soldOut) : "—"],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface border border-app-border rounded-[14px] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted">{k}</div>
            <div className="text-[22px] font-semibold text-text-primary tabular-nums mt-1">{v}</div>
          </div>
        ))}
      </div>

      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{err}</div>}

      <div className="bg-surface border border-app-border rounded-[14px] overflow-x-auto">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[.05em] text-text-muted" style={{ background: "var(--color-table-chrome)" }}>
              <th className="px-3 py-2 font-semibold">Item</th>
              <th className="px-3 py-2 font-semibold">SKU</th>
              <th className="px-3 py-2 font-semibold">On hand</th>
              <th className="px-3 py-2 font-semibold">Alert at</th>
              <th className="px-3 py-2 font-semibold">Sold 30 d</th>
              <th className="px-3 py-2 font-semibold">Value</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Receive</th>
            </tr>
          </thead>
          <tbody>
            {view && rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-text-muted">No tracked stock yet — turn on Track inventory on a product.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={key(r)} className={`border-t border-app-border ${r.active ? "" : "opacity-60"}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-[34px] w-[34px] rounded-lg shrink-0" style={r.photoUrl ? { backgroundImage: `url(${r.photoUrl})`, backgroundSize: "cover" } : { background: "var(--color-inset-surface)" }} />
                    <div className="min-w-0">
                      <div className="font-medium text-text-primary truncate">{r.variantId ? r.label : r.productName}</div>
                      {r.variantId && <div className="text-[11.5px] text-text-muted truncate">{r.productName}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-text-muted">{r.sku || "—"}</td>
                <td className="px-3 py-2">
                  <div className="inline-flex items-center border border-app-border rounded-lg overflow-hidden">
                    <button type="button" aria-label="One less" disabled={busy === key(r) || r.stock <= 0} onClick={() => change(r, { delta: -1 })} className="w-8 h-8 flex items-center justify-center hover:bg-app-bg disabled:opacity-30"><Minus size={13} /></button>
                    <span className="w-10 text-center font-semibold tabular-nums">{r.stock}</span>
                    <button type="button" aria-label="One more" disabled={busy === key(r)} onClick={() => change(r, { delta: 1 })} className="w-8 h-8 flex items-center justify-center hover:bg-app-bg disabled:opacity-30"><Plus size={13} /></button>
                  </div>
                </td>
                <td className="px-3 py-2 tabular-nums text-text-muted">{r.threshold}</td>
                <td className="px-3 py-2 tabular-nums">{r.sold30}</td>
                <td className="px-3 py-2 tabular-nums">{money(r.value)}</td>
                <td className="px-3 py-2"><span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={PILL[r.status].style}>{PILL[r.status].label}</span></td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <input aria-label="Units received" inputMode="numeric" value={receiving[key(r)] ?? ""} onChange={(e) => setReceiving((m) => ({ ...m, [key(r)]: e.target.value.replace(/[^0-9]/g, "") }))} placeholder="+ qty" className="w-16 px-2 py-1 border border-app-border rounded-lg text-[13px] bg-surface" />
                    {receiving[key(r)] && <button type="button" disabled={busy === key(r)} onClick={() => change(r, { delta: Number(receiving[key(r)]) })} className="text-[12px] font-semibold text-brand">Add</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] text-text-muted mt-2">Adjusting here changes the number the member store, the public link and the Sell screen use. Sold 30 d counts paid sales.</p>
    </div>
  );
}
