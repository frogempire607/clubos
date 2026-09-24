"use client";

// The event's public page link, as the FULL url a family can paste, with one
// tap to copy. Julian: "make the public link easier to copy, and the full
// link, not just /e/…" (2026-09-24). Used by the editor's "Who can sign up"
// card and the event row's ⋯ menu; both read the same slug.

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

export function publicEventUrl(slug: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/e/${slug}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari / non-secure contexts: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

export default function PublicLinkBox({ slug, compact = false }: { slug: string; compact?: boolean }) {
  const [url, setUrl] = useState(`/e/${slug}`);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setUrl(publicEventUrl(slug)); }, [slug]);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(t); }, [copied]);

  return (
    <div className={`flex items-center gap-2 ${compact ? "" : "rounded-xl border border-app-border bg-surface px-3 py-2"}`}>
      <input
        readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Public page link"
        className="min-w-0 flex-1 bg-transparent text-[12.5px] font-mono text-text-primary outline-none"
      />
      <button
        type="button"
        onClick={async () => { if (await copyText(url)) setCopied(true); }}
        className={`shrink-0 inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-lg text-xs font-medium ${copied ? "bg-lime-accent/25 text-[#3F6212]" : "bg-brand text-white hover:bg-brand-hover"}`}
      >
        {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
      </button>
      <a href={url} target="_blank" rel="noreferrer" aria-label="Open the public page" className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-app-border text-text-muted hover:text-text-primary hover:bg-app-bg">
        <ExternalLink size={14} />
      </a>
    </div>
  );
}
