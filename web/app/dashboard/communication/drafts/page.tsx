"use client";

// Saved bulk-email drafts. Before this, a half-written send lived only in
// one browser's localStorage — invisible to anyone else, gone if you cleared
// the browser, and with no record of who it was addressed to.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileEdit } from "lucide-react";

interface Draft {
  id: string;
  title: string;
  previewText: string | null;
  mode: string;
  recipientCount: number;
  savedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function EmailDraftsPage() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    fetch("/api/emails/drafts")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load");
        return r.json();
      })
      .then((d) => setDrafts(d.drafts))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const discard = async (d: Draft) => {
    if (!confirm(`Discard "${d.title}"?\n\nThis cannot be undone.`)) return;
    setBusy(d.id);
    const r = await fetch(`/api/emails/drafts/${d.id}`, { method: "DELETE" });
    setBusy(null);
    if (r.ok) load();
    else setError((await r.json().catch(() => ({}))).error ?? "Could not discard.");
  };

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl">
      <h1 className="text-2xl sm:text-3xl font-semibold text-text-primary mb-1">Drafts</h1>
      <p className="text-sm text-text-muted mb-6">
        Unsent emails, with the people they were addressed to. Drafts are saved for the whole club,
        not just your browser.
      </p>

      {!drafts ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : drafts.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-8 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <FileEdit className="h-7 w-7" strokeWidth={2} />
          </div>
          <div className="text-sm font-medium text-text-primary mb-1">No drafts</div>
          <div className="text-sm text-text-muted">
            Select members on the Members tab, choose Email, and use “Save as draft”.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {drafts.map((d) => (
            <div key={d.id} className="bg-surface border border-app-border rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">{d.title}</div>
                  <div className="text-xs text-text-muted">
                    {d.recipientCount} recipient{d.recipientCount === 1 ? "" : "s"}
                    {" · saved "}{new Date(d.updatedAt).toLocaleString()}
                    {d.savedByName && <> · by {d.savedByName}</>}
                  </div>
                  {d.previewText && (
                    <div className="text-xs text-text-muted italic mt-0.5 truncate">{d.previewText}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => router.push(`/dashboard/members?draft=${encodeURIComponent(d.id)}`)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover font-medium"
                  >
                    Open
                  </button>
                  <button
                    disabled={busy === d.id}
                    onClick={() => discard(d)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-muted hover:bg-app-bg disabled:opacity-50"
                  >
                    {busy === d.id ? "…" : "Discard"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
