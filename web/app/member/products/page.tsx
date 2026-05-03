"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: string | number;
  category: string;
  imageUrl: string | null;
  trackInventory: boolean;
  inventory: number | null;
};

const categoryLabel: Record<string, string> = {
  GEAR:     "Gear",
  APPAREL:  "Apparel",
  FACILITY: "Facility",
  SERVICE:  "Service",
  OTHER:    "Other",
};

function fmtPrice(p: string | number) {
  const n = typeof p === "string" ? parseFloat(p) : p;
  return Number.isNaN(n) ? "—" : n.toFixed(2);
}

export default function MemberProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [hasMemberProfile, setHasMemberProfile] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/member/products")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setProducts(d.products || []);
          setHasMemberProfile(d.hasMemberProfile);
        }
        setLoading(false);
      });
  }, []);

  async function buy(productId: string) {
    setBusy(productId);
    setError("");
    const res = await fetch(`/api/member/products/${productId}/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.url) {
      setBusy(null);
      setError(d.error || "Could not start checkout");
      return;
    }
    window.location.href = d.url;
  }

  // Group by category
  const grouped: Record<string, Product[]> = {};
  for (const p of products) {
    const cat = p.category || "OTHER";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }
  const orderedCats = ["GEAR", "APPAREL", "FACILITY", "SERVICE", "OTHER"].filter((c) => grouped[c]?.length);

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Shop</h1>
          <p className="text-sm text-stone-500">Gear, apparel, and other items from your club.</p>
        </div>
        <Link href="/member/shop" className="text-xs text-stone-500 hover:text-stone-900">All purchase options →</Link>
      </div>

      {!hasMemberProfile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          Your account isn't linked to a member profile yet. Contact your club to get added before buying.
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">{error}</div>}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : products.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">▤</p>
          <p className="text-base font-medium text-stone-900 mb-1">Nothing for sale right now</p>
          <p className="text-sm text-stone-500">Your club hasn't listed any products yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {orderedCats.map((cat) => (
            <div key={cat}>
              <h2 className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">{categoryLabel[cat] || cat}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {grouped[cat].map((p) => {
                  const outOfStock = p.trackInventory && p.inventory !== null && p.inventory <= 0;
                  const lowStock   = p.trackInventory && p.inventory !== null && p.inventory > 0 && p.inventory <= 3;
                  return (
                    <div key={p.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden">
                      {p.imageUrl ? (
                        <div className="aspect-[4/3] bg-stone-100">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div className="aspect-[4/3] bg-stone-100 flex items-center justify-center text-3xl text-stone-300">▤</div>
                      )}
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <h3 className="text-sm font-semibold text-stone-900">{p.name}</h3>
                          <span className="text-sm font-semibold text-stone-900 flex-shrink-0">${fmtPrice(p.price)}</span>
                        </div>
                        {p.description && (
                          <p className="text-xs text-stone-500 line-clamp-2 mb-3 whitespace-pre-wrap">{p.description}</p>
                        )}
                        <div className="flex items-center justify-between gap-2">
                          {outOfStock ? (
                            <span className="text-xs text-stone-400">Out of stock</span>
                          ) : lowStock ? (
                            <span className="text-xs text-amber-700">Only {p.inventory} left</span>
                          ) : (
                            <span />
                          )}
                          <button
                            disabled={!hasMemberProfile || outOfStock || busy === p.id}
                            onClick={() => buy(p.id)}
                            className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50"
                          >
                            {busy === p.id ? "…" : "Buy"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
