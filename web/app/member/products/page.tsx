"use client";

// Member store — list (B10). Cards read the same store projection as the
// detail screen (lib/productStore); tapping one opens /member/products/[id],
// where sizes, colours, quantity and checkout live.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package, ImageIcon } from "lucide-react";
import type { StoreProduct } from "@/lib/productStore";

const categoryLabel: Record<string, string> = {
  GEAR:     "Gear / Merchandise",
  APPAREL:  "Apparel",
  FACILITY_RENTAL: "Facility Rentals",
  BIRTHDAY_PARTY: "Birthday Parties",
  DIGITAL: "Digital Items",
  FACILITY: "Facility",
  SERVICE: "Services",
  OTHER:    "Other",
};

const money = (n: number) => `$${n.toFixed(2)}`;

export default function MemberProductsPage() {
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [hasMemberProfile, setHasMemberProfile] = useState(true);
  const [loading, setLoading] = useState(true);

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

  const grouped: Record<string, StoreProduct[]> = {};
  for (const p of products) {
    const cat = p.productType || p.category || "OTHER";
    (grouped[cat] ||= []).push(p);
  }
  const orderedCats = ["GEAR", "FACILITY_RENTAL", "BIRTHDAY_PARTY", "DIGITAL", "APPAREL", "FACILITY", "SERVICE", "OTHER"].filter((c) => grouped[c]?.length);

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
          Your account isn&apos;t linked to a member profile yet. Contact your club to get added before buying.
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="pskeleton aspect-[4/5] rounded-2xl" />)}</div>
      ) : products.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Package className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">Nothing for sale right now</p>
          <p className="text-sm text-stone-500">Your club hasn&apos;t listed any products yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {orderedCats.map((cat) => (
            <div key={cat}>
              <h2 className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">{categoryLabel[cat] || cat}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {grouped[cat].map((p) => {
                  const soldOut = p.available !== null && p.available <= 0;
                  const low = p.available !== null && p.available > 0 && p.available <= 3;
                  const soldOutVariants = p.variants.filter((v) => v.stock <= 0).length;
                  const cover = p.photos[0] ?? null;
                  const saves = p.memberPrice < p.price ? p.price - p.memberPrice : 0;
                  return (
                    <Link key={p.id} href={`/member/products/${p.id}`} className="pcard pcard-hover overflow-hidden block">
                      {cover ? (
                        <div className="aspect-square bg-stone-100 relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={cover} alt={p.name} className={`w-full h-full object-cover ${soldOut ? "opacity-50" : ""}`} />
                          {soldOut && <span className="absolute top-2 left-2 text-[11px] font-medium bg-white/90 text-stone-700 rounded-full px-2 py-0.5">Sold out</span>}
                        </div>
                      ) : (
                        <div className="aspect-square bg-stone-100 flex items-center justify-center text-stone-300"><ImageIcon className="h-8 w-8" strokeWidth={1.5} /></div>
                      )}
                      <div className="p-3">
                        <h3 className="text-sm font-semibold text-stone-900 leading-snug line-clamp-2">{p.name}</h3>
                        <div className="mt-1 flex items-baseline gap-1.5">
                          <span className="text-sm font-semibold text-stone-900">{money(p.memberPrice)}</span>
                          {saves > 0 && <span className="text-xs text-stone-400 line-through">{money(p.price)}</span>}
                        </div>
                        <p className="mt-1 text-[11px] text-stone-500">
                          {p.needsBookingFlow
                            ? "Book a time"
                            : soldOut ? "Out of stock"
                            : p.hasVariants
                              ? `${p.variants.length} options${soldOutVariants ? ` · ${soldOutVariants} sold out` : ""}`
                              : low ? `Only ${p.available} left` : "In stock"}
                        </p>
                      </div>
                    </Link>
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
