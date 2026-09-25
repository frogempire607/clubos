"use client";

// B10 slice 3 — QR outputs (handoff 2h): a 6-to-a-page shelf-tag sheet
// (3 × 4 in) and a gym-door poster, both pointing at /p/{slug}?src=qr so scans
// are counted. Codes come from the same generator as QRModal (qrcode, EC "M").

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { normalizeProductSettings, tierRange } from "@/lib/productSettings";
import { lengthOptions, minsLabel } from "@/lib/productBooking";

type P = { id: string; name: string; price: number; productType: string; publicSlug: string | null; settings: unknown; description: string | null };

export default function ProductTagsPage() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<P | null>(null);
  const [club, setClub] = useState("");
  const [qr, setQr] = useState("");
  const [mode, setMode] = useState<"tags" | "poster">("tags");
  const url = typeof window !== "undefined" && p?.publicSlug ? `${window.location.origin}/p/${p.publicSlug}` : "";

  useEffect(() => {
    fetch("/api/products").then((r) => (r.ok ? r.json() : [])).then((list: P[]) => setP(list.find((x) => x.id === id) ?? null));
    fetch("/api/club/info").then((r) => (r.ok ? r.json() : null)).then((d) => d && setClub(d.name ?? d.club?.name ?? ""));
  }, [id]);
  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(`${url}?src=qr`, { width: 320, margin: 2, errorCorrectionLevel: "M" }).then(setQr).catch(() => setQr(""));
  }, [url]);

  if (!p) return <div className="p-8 text-sm text-text-muted">Loading…</div>;
  if (!p.publicSlug) return <div className="p-8 text-sm text-text-muted">Turn on “Public checkout link” for this product and save it first — the tags point at its public page.</div>;

  const s = normalizeProductSettings(p.settings);
  const range = s.tiersEnabled ? tierRange(s.tiers) : null;
  const opts = lengthOptions(s, Number(p.price));
  const from = range ? range.min : Math.min(...opts.map((o) => o.price), Number(p.price));
  const lengths = opts.map((o) => o.mins);
  const priceLine = s.variants.length || !range ? `$${Number(p.price).toFixed(2)}` : `From $${from.toFixed(0)}`;
  const posterLine = ["BOOKABLE", "FACILITY_RENTAL", "BIRTHDAY_PARTY"].includes(p.productType)
    ? `From $${from.toFixed(0)} · ${lengths.length > 1 ? `${Math.min(...lengths)}–${Math.max(...lengths)} minutes` : minsLabel(lengths[0] ?? 60)}`
    : priceLine;
  const hint = s.optionGroups.length ? `Scan to buy · pick your ${s.optionGroups.map((g) => g.name.toLowerCase()).join(" & ")}` : "Scan to buy";

  return (
    <div className="p-6">
      <style>{`@media print { .no-print { display: none !important } body { background: #fff } @page { margin: 0.4in } }`}</style>
      <div className="no-print flex items-center gap-2 mb-4">
        <button type="button" onClick={() => setMode("tags")} className={`text-sm px-3 py-1.5 rounded-lg border ${mode === "tags" ? "border-brand text-brand" : "border-app-border"}`}>Shelf tags (6 per page)</button>
        <button type="button" onClick={() => setMode("poster")} className={`text-sm px-3 py-1.5 rounded-lg border ${mode === "poster" ? "border-brand text-brand" : "border-app-border"}`}>Poster</button>
        <button type="button" onClick={() => window.print()} className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white ml-2">Print</button>
      </div>
      {mode === "tags" ? (
        <div className="grid grid-cols-2 gap-[0.2in] w-[6.4in]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-[3in] h-[4in] border border-dashed border-stone-300 rounded-lg p-3 flex flex-col items-center justify-between text-center bg-white text-black">
              <div className="text-[15px] font-semibold leading-tight">{p.name}</div>
              <div className="text-[20px] font-bold">{priceLine}</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr && <img src={qr} alt="QR code" className="w-[1.8in] h-[1.8in]" />}
              <div className="text-[11px]">{hint}</div>
              <div className="text-[8px] text-stone-500 break-all">{url}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="w-[7.5in] h-[10in] border border-stone-300 rounded-xl p-10 flex flex-col items-center justify-between text-center bg-white text-black">
          <div className="text-[20px] font-semibold uppercase tracking-wide">{club}</div>
          <div>
            <div className="text-[44px] font-bold leading-tight">{p.name}</div>
            {p.description && <div className="text-[18px] mt-2">{p.description}</div>}
            <div className="text-[24px] font-semibold mt-4">{posterLine}</div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr && <img src={qr} alt="QR code" className="w-[3.5in] h-[3.5in]" />}
          <div className="text-[16px]">Scan to {["BOOKABLE", "FACILITY_RENTAL", "BIRTHDAY_PARTY"].includes(p.productType) ? "book" : "buy"} · no account needed</div>
          <div className="text-[11px] text-stone-500 break-all">{url}</div>
        </div>
      )}
    </div>
  );
}
