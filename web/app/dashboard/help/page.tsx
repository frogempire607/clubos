"use client";

import { useEffect, useMemo, useState } from "react";

type Article = { id: string; title: string; category: string; keywords: string[]; body: string };

export default function HelpPage() {
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Article[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [cat, setCat] = useState<string>("all");
  const [results, setResults] = useState<Article[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial load: full knowledge base + categories.
  useEffect(() => {
    fetch("/api/help/search")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) { setAll(d.articles || []); setCategories(d.categories || []); }
        setLoading(false);
      });
  }, []);

  // Debounced retrieval search (same endpoint a future AI assistant uses).
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/help/search?q=${encodeURIComponent(term)}`);
      const d = await res.json().catch(() => ({ articles: [] }));
      setResults(d.articles || []);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const list = useMemo(() => {
    const base = results ?? all;
    return cat === "all" ? base : base.filter((a) => a.category === cat);
  }, [results, all, cat]);

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Help &amp; Support</h1>
        <p className="text-sm text-text-muted">
          Search guides for running your club. Need a person? Contact your account manager or reply to any
          AthletixOS email — this center organizes how-to answers, it isn&apos;t a replacement for support.
        </p>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search help — e.g. “record cash”, “add membership”, “substitute coach”…"
        className="w-full bg-surface border border-app-border rounded-lg px-4 h-11 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand mb-4"
      />

      <div className="flex flex-wrap gap-1.5 mb-6">
        <button
          onClick={() => setCat("all")}
          className={`text-xs px-3 py-1.5 rounded-full border transition ${
            cat === "all" ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
          }`}
        >
          All topics
        </button>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${
              cat === c ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted text-center py-10">Loading…</p>
      ) : list.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-10 text-center">
          <p className="text-sm text-text-primary font-medium mb-1">No articles matched “{q.trim()}”.</p>
          <p className="text-xs text-text-muted">Try fewer or different words, or browse a category above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((a) => {
            const open = openId === a.id;
            return (
              <div key={a.id} className="bg-surface border border-app-border rounded-xl overflow-hidden">
                <button
                  onClick={() => setOpenId(open ? null : a.id)}
                  className="w-full text-left px-5 py-4 flex items-center justify-between gap-4 hover:bg-app-bg"
                >
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{a.title}</p>
                    <p className="text-[11px] uppercase tracking-wider text-text-muted mt-0.5">{a.category}</p>
                  </div>
                  <span className="text-text-muted text-lg leading-none flex-shrink-0">{open ? "−" : "+"}</span>
                </button>
                {open && (
                  <div className="px-5 pb-5 -mt-1">
                    <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{a.body}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8 bg-brand/5 border border-brand/20 rounded-xl p-4">
        <p className="text-sm font-semibold text-text-primary mb-0.5">Coming soon: AI assistant</p>
        <p className="text-xs text-text-muted">
          An in-app assistant will answer “how do I…” questions and help with setup. It will use this same
          help library, so anything documented here will power it.
        </p>
      </div>
    </div>
  );
}
