"use client";

// Member store — product detail (B10 handoff screen 2e).
//
// Everything on this screen is derived from ONE ledger the API projects from
// Product.settings (lib/productStore.storeView): the option pickers show
// per-variant stock, the banner sums it, the price follows the picked variant,
// and the checkout button disables itself the moment the chosen combination is
// at 0. Nothing here is typed twice.

import BulkPriceNote from "@/components/products/BulkPriceNote";
import { unitPriceAtQuantity } from "@/lib/productSettings";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ImageIcon, Minus, Plus, ShieldCheck } from "lucide-react";
import ProfileSwitcher, { type AccessibleProfile } from "@/components/ProfileSwitcher";
import type { StoreProduct, StoreVariant } from "@/lib/productStore";
import BookingFlow, { type BookingPayload } from "@/components/products/BookingFlow";

const money = (n: number) => `$${n.toFixed(2)}`;

export default function MemberProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<StoreProduct | null>(null);
  const [accessible, setAccessible] = useState<AccessibleProfile[]>([]);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [hasMemberProfile, setHasMemberProfile] = useState(true);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [photo, setPhoto] = useState(0);
  // One pick per option group, keyed by group name.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [discountCode, setDiscountCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/member/products/${id}`)
      .then(async (r) => {
        if (!r.ok) { setNotFound(true); return; }
        const d = await r.json();
        setProduct(d.product);
        setAccessible(d.accessible || []);
        setMemberId(d.defaultMemberId ?? d.accessible?.[0]?.id ?? null);
        setHasMemberProfile(d.hasMemberProfile);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const groups = useMemo(() => product?.optionGroups ?? [], [product]);
  const variants = useMemo(() => product?.variants ?? [], [product]);

  // The variant the picks name, once every group has a pick.
  const chosen: StoreVariant | null = useMemo(() => {
    if (!product?.hasVariants) return null;
    if (groups.some((g) => !picks[g.name])) return null;
    const key = groups.map((g) => picks[g.name]).join(" / ");
    return variants.find((v) => v.id === key) ?? null;
  }, [product, groups, picks, variants]);

  // Per-value stock for a picker: the sum over variants that carry this value
  // AND agree with the other groups' picks (so choosing Black greys out the
  // sizes Black has run out of).
  const stockForValue = (groupName: string, value: string): number =>
    variants
      .filter((v) => {
        const gi = groups.findIndex((g) => g.name === groupName);
        if (v.values[gi] !== value) return false;
        return groups.every((g, i) => g.name === groupName || !picks[g.name] || v.values[i] === picks[g.name]);
      })
      .reduce((s, v) => s + v.stock, 0);

  const unit = chosen ? chosen.price : product?.memberPrice ?? 0;
  const list = product?.price ?? 0;
  const saves = product && !chosen && product.memberPrice < list ? list - product.memberPrice : chosen && chosen.price < list ? list - chosen.price : 0;
  const available: number | null = product
    ? product.hasVariants ? (chosen ? chosen.stock : null) : product.available
    : null;
  const soldOut = available !== null && available <= 0;
  const needsPick = !!product?.hasVariants && !chosen;
  const maxQty = available == null ? 20 : Math.max(1, Math.min(20, available));
  // Bulk pricing lowers each unit at the club's quantity breaks.
  const bulkUnit = product ? unitPriceAtQuantity(product.quantityBreaks ?? [], unit, qty).unit : unit;
  const total = bulkUnit * qty;

  useEffect(() => { setQty((q) => Math.min(q, maxQty)); }, [maxQty]);

  // B10 slice 3 — a booking (rental / party).
  const [bookedMsg, setBookedMsg] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("booked")) setBookedMsg("Booked — you'll see it confirmed once the payment lands.");
  }, []);
  async function book(p: BookingPayload) {
    if (!product) return;
    setBusy(true); setError("");
    const res = await fetch(`/api/member/products/${product.id}/book`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...p, memberId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setBusy(false); setError(d.error || "Couldn't book that."); return; }
    if (d.url) { window.location.href = d.url; return; }
    setBusy(false);
    setBookedMsg(d.status === "PENDING" ? "Request sent — the club will confirm it." : "Booked. See you there!");
  }

  async function checkout() {
    if (!product) return;
    setBusy(true); setError("");
    const res = await fetch(`/api/member/products/${product.id}/buy`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: qty, memberId, discountCode: discountCode.trim() || null, variantId: chosen?.id ?? null }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status === 202) { setBusy(false); setError(d.message || "Sent to your parent for approval."); return; }
    if (!res.ok || !d.url) { setBusy(false); setError(d.error || "Could not start checkout"); return; }
    window.location.href = d.url;
  }

  if (loading) return <div className="pskeleton h-64 rounded-2xl" />;
  if (notFound || !product) {
    return (
      <div className="pcard p-8 text-center">
        <p className="text-base font-medium text-stone-900 mb-1">This item isn&apos;t available</p>
        <p className="text-sm text-stone-500 mb-4">It may have been removed from the store.</p>
        <Link href="/member/products" className="text-sm font-medium text-stone-900 underline">Back to the shop</Link>
      </div>
    );
  }

  const banner = product.hasVariants
    ? chosen
      ? chosen.stock <= 0 ? { tone: "out", text: "This combination is sold out." }
        : chosen.status === "LOW" ? { tone: "low", text: `Only ${chosen.stock} left in ${chosen.label}.` }
        : { tone: "ok", text: `${chosen.stock} in stock.` }
      : product.available === 0 ? { tone: "out", text: "Sold out in every size." }
        : { tone: "pick", text: `Pick ${groups.map((g) => g.name.toLowerCase()).join(" and ")} to see what's in stock.` }
    : product.available == null ? null
      : product.available <= 0 ? { tone: "out", text: "Out of stock." }
      : product.available <= 3 ? { tone: "low", text: `Only ${product.available} left.` }
      : null;

  return (
    <div className="pb-28 md:pb-0">
      <button type="button" onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900 mb-3 min-h-[44px]">
        <ArrowLeft size={16} /> Shop
      </button>

      <div className="md:grid md:grid-cols-[1fr_380px] md:gap-6">
        {/* Photos */}
        <div className="pcard overflow-hidden mb-4 md:mb-0">
          {product.photos.length > 0 ? (
            <>
              <div className="aspect-square bg-stone-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={chosen?.photoUrl ?? product.photos[photo]} alt={product.name} className="w-full h-full object-cover" />
              </div>
              {product.photos.length > 1 && (
                <div className="flex justify-center gap-1.5 py-2.5">
                  {product.photos.map((_, i) => (
                    <button key={i} type="button" aria-label={`Photo ${i + 1}`} onClick={() => setPhoto(i)}
                      className={`h-2 rounded-full transition-all ${i === photo ? "w-5 bg-stone-900" : "w-2 bg-stone-300"}`} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="aspect-[4/3] bg-stone-100 flex items-center justify-center text-stone-300"><ImageIcon className="h-10 w-10" strokeWidth={1.5} /></div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <span className="inline-block text-[11px] font-medium uppercase tracking-wider text-stone-500 bg-stone-100 rounded-full px-2 py-0.5 mb-2">{product.booking ? "Book" : "Shop"}</span>
            <h1 className="text-xl font-semibold text-stone-900 leading-tight">{product.name}</h1>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-lg font-semibold text-stone-900">{money(unit)}</span>
              {saves > 0 && <span className="text-sm text-stone-400 line-through">{money(list)}</span>}
              {saves > 0 && <span className="text-xs font-medium text-stone-700 bg-stone-100 rounded-full px-2 py-0.5">Members save {money(saves)}</span>}
            </div>
            {product.description && <p className="text-sm text-stone-600 mt-2 whitespace-pre-wrap">{product.description}</p>}
          </div>

          {accessible.length > 1 && (
            <ProfileSwitcher accessible={accessible} value={memberId} onChange={setMemberId} label="Buying for" />
          )}

          {!hasMemberProfile && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
              Your account isn&apos;t linked to a member profile yet. Contact your club before buying.
            </div>
          )}

          {bookedMsg && <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2 text-sm text-green-800">{bookedMsg}</div>}
          {product.booking && (
            <BookingFlow
              booking={product.booking}
              availabilityUrl={(date, len) => `/api/member/products/${product.id}/availability?date=${date}&length=${encodeURIComponent(len)}`}
              busy={busy}
              error={error}
              onSubmit={book}
            />
          )}

          {!product.booking && (<>
          {/* Option pickers with per-value stock */}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-sm font-medium text-stone-900">{g.name}</span>
                {picks[g.name] && <span className="text-xs text-stone-500">{picks[g.name]}</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.values.map((val) => {
                  const st = stockForValue(g.name, val);
                  const sel = picks[g.name] === val;
                  const out = st <= 0;
                  return (
                    <button
                      key={val} type="button"
                      onClick={() => setPicks((p) => ({ ...p, [g.name]: sel ? "" : val }))}
                      className={`min-h-[44px] px-3.5 rounded-xl border text-sm transition ${sel ? "border-stone-900 bg-stone-900 text-white" : out ? "border-stone-200 text-stone-400 line-through bg-stone-50" : "border-stone-300 text-stone-900 bg-white"}`}
                    >
                      <span className="block leading-tight">{val}</span>
                      <span className={`block text-[10px] leading-tight ${sel ? "text-white/70" : "text-stone-400"} no-underline`}>
                        {out ? "sold out" : st <= 3 ? `${st} left` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {banner && (
            <p className={`text-sm rounded-xl px-3 py-2 ${banner.tone === "out" ? "bg-red-50 text-red-700" : banner.tone === "low" ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-600"}`}>{banner.text}</p>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-stone-900">Quantity</span>
            <div className="inline-flex items-center border border-stone-300 rounded-xl overflow-hidden">
              <button type="button" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} className="w-11 h-11 flex items-center justify-center text-stone-700 disabled:opacity-30"><Minus size={16} /></button>
              <span className="w-8 text-center text-sm font-semibold text-stone-900">{qty}</span>
              <button type="button" aria-label="More" onClick={() => setQty((q) => Math.min(maxQty, q + 1))} disabled={qty >= maxQty} className="w-11 h-11 flex items-center justify-center text-stone-700 disabled:opacity-30"><Plus size={16} /></button>
            </div>
          </div>

          {product && <BulkPriceNote breaks={product.quantityBreaks ?? []} unit={unit} quantity={qty} onPick={(n) => setQty(Math.min(maxQty, n))} />}

          <label className="block">
            <span className="block text-xs text-stone-500 mb-1">Discount code</span>
            <input type="text" value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder="Optional — applied at checkout"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm font-mono uppercase placeholder:font-sans placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-stone-400 bg-white" />
          </label>

          {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">{error}</div>}

          {/* Desktop CTA lives in the column; on phones it is the sticky bar below. */}
          <div className="hidden md:block">
            <CheckoutButton total={total} disabled={busy || !hasMemberProfile || soldOut || needsPick || product.needsBookingFlow} soldOut={soldOut} needsPick={needsPick} busy={busy} onClick={checkout} />
          </div>
          </>)}
        </div>
      </div>

      {/* Sticky checkout above the 60px bottom nav */}
      {!product.booking && <div className="fixed left-0 right-0 md:hidden px-4 pt-2 pb-2" style={{ bottom: "calc(60px + env(safe-area-inset-bottom))", background: "linear-gradient(to top, #FAFAF9 70%, rgba(250,250,249,0))" }}>
        <CheckoutButton total={total} disabled={busy || !hasMemberProfile || soldOut || needsPick || product.needsBookingFlow} soldOut={soldOut} needsPick={needsPick} busy={busy} onClick={checkout} />
      </div>}
    </div>
  );
}

function CheckoutButton({ total, disabled, soldOut, needsPick, busy, onClick }: { total: number; disabled: boolean; soldOut: boolean; needsPick: boolean; busy: boolean; onClick: () => void }) {
  return (
    <div>
      <button type="button" onClick={onClick} disabled={disabled} className="w-full pbtn-accent rounded-xl py-3.5 text-sm font-semibold min-h-[48px]">
        {busy ? "Opening checkout…" : soldOut ? "Sold out" : needsPick ? "Pick your options" : `Checkout · ${money(total)}`}
      </button>
      <p className="mt-1.5 text-[11px] text-stone-500 flex items-center justify-center gap-1"><ShieldCheck size={12} /> Secure checkout by Stripe</p>
    </div>
  );
}
