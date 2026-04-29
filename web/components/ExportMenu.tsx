"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  baseUrl: string;
  label?: string;
};

export default function ExportMenu({ baseUrl, label = "Export" }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function urlFor(format: "csv" | "xlsx" | "pdf") {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}format=${format}`;
  }

  async function download(format: "csv" | "xlsx" | "pdf") {
    setError(null);
    setOpen(false);
    setBusy(true);
    try {
      const res = await fetch(urlFor(format));
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 403) {
          setError(text || "This export tier is not available on your plan.");
        } else {
          setError(text || `Export failed (${res.status})`);
        }
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const match = /filename="?([^";]+)"?/.exec(cd);
      const filename = match?.[1] || `export.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg flex items-center gap-1 disabled:opacity-50"
      >
        {busy ? "Exporting…" : label}
        <span className="text-text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-white border border-app-border rounded-lg shadow-lg z-30 overflow-hidden">
          <button onClick={() => download("csv")} className="block w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-app-bg">
            CSV (.csv)
          </button>
          <button onClick={() => download("xlsx")} className="block w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-app-bg">
            Excel (.xlsx)
          </button>
          <button onClick={() => download("pdf")} className="block w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-app-bg">
            PDF (.pdf)
          </button>
        </div>
      )}
      {error && (
        <div className="absolute right-0 mt-1 w-72 z-40 bg-orange-accent/10 border border-orange-accent/40 text-orange-accent text-xs rounded-lg p-2 shadow-sm">
          <div className="flex items-start gap-2">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-orange-accent hover:text-orange-accent">×</button>
          </div>
          <a href="/dashboard/settings/billing" className="block mt-1 underline text-white">
            View plan options →
          </a>
        </div>
      )}
    </div>
  );
}
