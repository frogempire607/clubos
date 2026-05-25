"use client";

import { useRef, useState } from "react";

interface Props {
  value: string | null;
  onChange: (url: string) => void;
  label?: string;
  shape?: "square" | "circle";
  placeholder?: string;
}

export default function ImageUpload({ value, onChange, label, shape = "square", placeholder = "◉" }: Props) {
  const inputRef   = useRef<HTMLInputElement>(null);
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState("");

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr("");
    setBusy(true);

    const body = new FormData();
    body.append("file", file);
    body.append("type", "image");

    const res = await fetch("/api/upload", { method: "POST", body });
    setBusy(false);

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      // Defensive stringify — some upstream routes return Zod error arrays or
      // nested objects which would otherwise render as "[object Object]".
      const raw = d?.error;
      const msg =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? ((raw[0]?.message as string | undefined) ?? (raw.map((x) => (typeof x === "string" ? x : x?.message)).filter(Boolean).join(", ") || "Upload failed"))
            : raw && typeof raw === "object"
              ? (raw.message ?? JSON.stringify(raw))
              : "Upload failed";
      setErr(msg);
      return;
    }

    const { url } = await res.json();
    onChange(url);
    // reset so the same file can be re-chosen if needed
    e.target.value = "";
  }

  const radius = shape === "circle" ? "9999px" : "10px";

  return (
    <div>
      {label && (
        <label className="block text-sm font-medium text-text-primary mb-2">{label}</label>
      )}
      <div className="flex items-center gap-4">
        {/* Preview */}
        <div
          style={{
            width: 72, height: 72, borderRadius: radius, flexShrink: 0,
            background: "var(--color-bg)", border: "1px solid var(--color-border)",
            overflow: "hidden",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="Preview" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ color: "var(--color-muted)", fontSize: 26 }}>{placeholder}</span>
          )}
        </div>

        {/* Controls */}
        <div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="text-sm px-3 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50 transition-colors"
            >
              {busy ? "Uploading…" : value ? "Change photo" : "Choose photo"}
            </button>
            {value && (
              <button
                type="button"
                onClick={() => onChange("")}
                className="text-sm text-red-500 hover:text-red-700 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-xs text-text-muted mt-1.5">JPG, PNG, WebP — max 10 MB</p>
          {err && <p className="text-xs text-red-500 mt-1">{err}</p>}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={handleFile}
      />
    </div>
  );
}
