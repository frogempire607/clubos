"use client";

// B10 slice 3 — the public product page (handoff 2h), mirroring /e/{slug}.
// Anyone with the link (or a scanned QR tag) buys or books with Stripe — no
// account needed. Members are pointed at signing in for the member price.

import BulkPriceNote from "@/components/products/BulkPriceNote";
import { unitPriceAtQuantity } from "@/lib/productSettings";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ImageIcon, Minus, Plus, ShieldCheck } from "lucide-react";
import BookingFlow, { type BookingPayload } from "@/components/products/BookingFlow";
import type { StoreProduct, StoreVariant } from "@/lib/productStore";

type Data = { product: StoreProduct; memberSaves: number; club: { name: string; slug: string | null; logoUrl: string | null; primaryColor: string | null }; canPay: boolean };
const money = (n: number) => `$${n.toFixed(2)}`;

export default function PublicProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const search = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [missing, setMissing] = useState(false);
  const [photo, setPhoto] = useState(0);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    const src = search.get("src") === "qr" ? "?src=qr" : "";
    fetch(`/api/public/products/${slug}${src}`).then(async (r) => {
      if (!r.ok) { setMissing(true); return; }
      setData(await r.json());
    });
    if (search.get("bought")) setDone("Thanks — your order is paid. The club will have it ready.");
    if (search.get("booked")) setDone("Booked — you'll get a receipt from Stripe. The club has your details.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const availabilityUrl = useCallback((date: string, len: string) => `/api/public/products/${slug}/availability?date=${date}&length=${encodeURIComponent(len)}`, [slug]);
  const p = data?.product ?? null;
  const chosen: StoreVariant | null = useMemo(() => p?.variants.find((v) => v.id === variantId) ?? null, [p, variantId]);
  if (missing) return <Shell accent="#1C1917"><div className="pcard p-8 text-center text-sm text-stone-600">This item isn&apos;t available.</div></Shell>;
  if (!data || !p) return <Shell accent="#1C1917"><div className="pskeleton h-64 rounded-2xl" /></Shell>;

  // The public price is the list price (or the variant's own).
  const listUnit = chosen ? chosen.price : p.price;
  // Bulk pricing lowers each unit at the club's quantity breaks.
  const unit = unitPriceAtQuantity(p.quantityBreaks ?? [], listUnit, qty).unit;
  const available = p.hasVariants ? (chosen ? chosen.stock : null) : p.available;
  const soldOut = available !== null && available <= 0;
  const maxQty = available == null ? 20 : Math.max(1, Math.min(20, available));
  const accent = data.club.primaryColor || "#1C1917";

  async function buy() {
    setBusy(true); setError("");
    const res = await fetch(`/api/public/products/${slug}/checkout`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "buy", variantId, quantity: qty, name, email }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.url) { setBusy(false); setError(d.error || "Couldn't open checkout."); return; }
    window.location.href = d.url;
  }
  async function book(b: BookingPayload) {
    setBusy(true); setError("");
    const res = await fetch(`/api/public/products/${slug}/checkout`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "book", ...b }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setBusy(false); setError(d.error || "Couldn't book that."); return; }
    if (d.url) { window.location.href = d.url; return; }
    setBusy(false);
    setDone(d.status === "PENDING" ? "Request sent — the club will confirm it by email." : "Booked. See you there!");
  }

  return (
    <Shell accent={accent}>
      <div className="flex items-center gap-2 mb-4">
        {data.club.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.club.logoUrl} alt="" className="h-8 w-8 rounded-lg object-cover" />
        )}
        <span className="text-sm font-semibold text-stone-900">{data.club.name}</span>
      </div>
      {done && <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2 text-sm text-green-800 mb-3">{done}</div>}
      <div className="md:grid md:grid-cols-[1fr_380px] md:gap-6">
        <div className="pcard overflow-hidden mb-4 md:mb-0">
          {p.photos.length > 0 ? (
            <>
              <div className="aspect-square bg-stone-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={chosen?.photoUrl ?? p.photos[photo]} alt={p.name} className="w-full h-full object-cover" />
              </div>
              {p.photos.length > 1 && (
                <div className="flex justify-center gap-1.5 py-2.5">
                  {p.photos.map((_, i) => <button key={i} type="button" aria-label={`Photo ${i + 1}`} onClick={() => setPhoto(i)} className={`h-2 rounded-full ${i === photo ? "w-5 bg-stone-900" : "w-2 bg-stone-300"}`} />)}
                </div>
              )}
            </>
          ) : (
            <div className="aspect-[4/3] bg-stone-100 flex items-center justify-center text-stone-300"><ImageIcon className="h-10 w-10" strokeWidth={1.5} /></div>
          )}
        </div>
        <div className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold text-stone-900 leading-tight">{p.name}</h1>
            {!p.booking && <div className="text-lg font-semibold text-stone-900 mt-1">{money(unit)}{unit < listUnit && <span className="ml-2 text-sm font-normal text-stone-400 line-through">{money(listUnit)}</span>}</div>}
            {data.memberSaves > 0 && (
              <p className="text-xs mt-1"><span className="font-medium text-stone-700 bg-stone-100 rounded-full px-2 py-0.5">Members save {money(data.memberSaves)}</span> <Link href={`/login?callbackUrl=${encodeURIComponent(`/member/products/${p.id}`)}`} className="underline text-stone-600">Sign in</Link></p>
            )}
            {p.description && <p className="text-sm text-stone-600 mt-2 whitespace-pre-wrap">{p.description}</p>}
          </div>

          {!data.canPay && <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">Online payment isn&apos;t set up yet — contact {data.club.name}.</div>}

          {p.booking ? (
            <BookingFlow booking={p.booking} availabilityUrl={availabilityUrl} guest busy={busy} error={error} onSubmit={book} />
          ) : (
            <>
              {p.hasVariants && (
                <div>
                  <span className="block text-sm font-medium text-stone-900 mb-1.5">Choose</span>
                  <div className="flex flex-wrap gap-2">
                    {p.variants.map((v) => {
                      const sel = v.id === variantId, out = v.stock <= 0;
                      return (
                        <button key={v.id} type="button" disabled={out} onClick={() => setVariantId(sel ? null : v.id)} className={`min-h-[44px] px-3 rounded-xl border text-sm ${sel ? "border-stone-900 bg-stone-900 text-white" : out ? "border-stone-200 text-stone-400 line-through bg-stone-50" : "border-stone-300 text-stone-900 bg-white"}`}>
                          <span className="block leading-tight">{v.label}</span>
                          <span className={`block text-[10px] ${sel ? "text-white/70" : "text-stone-400"}`}>{out ? "sold out" : v.stock <= 3 ? `${v.stock} left` : ""}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-stone-900">Quantity</span>
                <div className="inline-flex items-center border border-stone-300 rounded-xl overflow-hidden">
                  <button type="button" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} className="w-11 h-11 flex items-center justify-center disabled:opacity-30"><Minus size={16} /></button>
                  <span className="w-8 text-center text-sm font-semibold">{qty}</span>
                  <button type="button" aria-label="More" onClick={() => setQty((q) => Math.min(maxQty, q + 1))} disabled={qty >= maxQty} className="w-11 h-11 flex items-center justify-center disabled:opacity-30"><Plus size={16} /></button>
                </div>
              </div>
              <BulkPriceNote breaks={p.quantityBreaks ?? []} unit={listUnit} quantity={qty} onPick={(n) => setQty(Math.min(maxQty, n))} />
              <div className="space-y-2">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm bg-white" />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email for the receipt" className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm bg-white" />
              </div>
              {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">{error}</div>}
              <button type="button" onClick={buy} disabled={busy || !data.canPay || soldOut || (p.hasVariants && !chosen) || !name.trim() || !email.trim()} className="w-full pbtn-accent rounded-xl py-3.5 text-sm font-semibold min-h-[48px]">
                {busy ? "Opening checkout…" : soldOut ? "Sold out" : p.hasVariants && !chosen ? "Pick an option" : `Checkout · ${money(unit * qty)}`}
              </button>
            </>
          )}
          <p className="text-[11px] text-stone-500 flex items-center justify-center gap-1"><ShieldCheck size={12} /> No account needed · secure checkout by Stripe</p>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <div className="member-portal min-h-screen" style={{ background: "#FAFAF9", ["--club-accent" as string]: accent, ["--club-accent-contrast" as string]: "#FFFFFF" } as React.CSSProperties}>
      <div className="max-w-4xl mx-auto px-4 py-6">{children}</div>
    </div>
  );
}
