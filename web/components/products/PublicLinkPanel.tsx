"use client";

// B10 slice 3 — the handoff's "Public link, QR & website embed" panel (2a).
// The link is /p/{slug}, minted from the name on the first save when blank.

import { useEffect, useState } from "react";
import Link from "next/link";
import QRModal from "@/components/QRModal";

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60);
}

export default function PublicLinkPanel({ productId, name, slug, onSlug, scanCount }: {
  productId: string | null;
  name: string;
  slug: string;
  onSlug: (s: string) => void;
  scanCount: number;
}) {
  const [origin, setOrigin] = useState("");
  const [qr, setQr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const shown = slug || slugify(name);
  const url = `${origin}/p/${shown}`;
  const snippet = `<a href="${url}" style="display:inline-block;padding:10px 18px;border-radius:9px;background:#111;color:#fff;font:600 14px system-ui;text-decoration:none">Buy ${name || "now"}</a>`;
  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(null), 1500); }, () => {});
  const saved = !!productId && !!slug;

  return (
    <div className="rounded-xl border border-app-border p-3 space-y-2.5">
      <div>
        <label className="block text-[12px] font-semibold text-text-primary mb-1" htmlFor="p-slug">Link address</label>
        <div className="flex items-center rounded-lg border border-app-border bg-surface overflow-hidden">
          <span className="px-2.5 text-[13px] text-text-muted border-r border-app-border bg-app-bg py-2">/p/</span>
          <input id="p-slug" value={slug} onChange={(e) => onSlug(slugify(e.target.value))} placeholder={slugify(name) || "team-hoodie"} className="flex-1 px-2.5 py-2 text-sm bg-transparent text-text-primary focus:outline-none" />
        </div>
        <p className="text-[11.5px] text-text-muted mt-1">
          {saved ? "Anyone with the link checks out with Stripe — no account needed. Members who sign in get the member price." : "The shareable link is generated when you save."}
        </p>
      </div>
      {saved && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-[12px] px-2 py-1 rounded bg-app-bg text-text-primary break-all">{url}</code>
            <button type="button" onClick={() => copy(url, "link")} className="text-[12px] text-brand font-medium">{copied === "link" ? "Copied" : "Copy"}</button>
            <a href={url} target="_blank" rel="noreferrer" className="text-[12px] text-brand font-medium">Open</a>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setQr(true)} className="text-[12.5px] px-3 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">QR code</button>
            <Link href={`/dashboard/products/${productId}/tags`} target="_blank" className="text-[12.5px] px-3 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">Print tag sheet · poster</Link>
            <Link href="/dashboard/announcements" className="text-[12.5px] px-3 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">Share in an announcement</Link>
          </div>
          <p className="text-[11.5px] text-text-muted tabular-nums">{scanCount} QR scan{scanCount === 1 ? "" : "s"} so far (counted when the page is opened from a printed code).</p>
          <div>
            <div className="text-[12px] font-semibold text-text-primary mb-1">Website button</div>
            <textarea readOnly rows={2} value={snippet} className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-[11.5px] font-mono bg-app-bg text-text-primary" />
            <button type="button" onClick={() => copy(snippet, "snippet")} className="text-[12px] text-brand font-medium">{copied === "snippet" ? "Copied" : "Copy snippet"}</button>
          </div>
          <QRModal open={qr} onClose={() => setQr(false)} url={`${url}?src=qr`} title={name} subtitle="Scan to buy" />
        </>
      )}
    </div>
  );
}
