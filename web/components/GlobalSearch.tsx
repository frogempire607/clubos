"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Hit = { id: string; label: string; sub?: string; href: string };
type Group = { type: string; label: string; items: Hit[] };

const RECENT_KEY = "athletixos-recent-search";
const MAX_RECENT = 6;

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export default function GlobalSearch() {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => { setRecent(loadRecent()); }, []);

  // Cmd/Ctrl+K focuses the search; Esc clears & closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes the dropdown.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setGroups([]); setLoading(false); return; }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        const d = await res.json();
        setGroups(d.groups || []);
      } catch {
        /* aborted / network — ignore */
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const rememberTerm = useCallback((term: string) => {
    if (!term.trim()) return;
    const next = [term.trim(), ...loadRecent().filter((r) => r !== term.trim())].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    setRecent(next);
  }, []);

  function go(hit: Hit) {
    rememberTerm(q);
    setOpen(false);
    setQ("");
    setGroups([]);
    router.push(hit.href);
  }

  const hasResults = groups.some((g) => g.items.length > 0);
  const showRecent = open && q.trim().length < 2 && recent.length > 0;

  return (
    <div ref={wrapRef} className="relative w-full max-w-xl">
      <div className="flex items-center gap-2 bg-surface border border-app-border rounded-lg px-3 h-9">
        <span className="text-text-muted text-sm select-none">⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search members, classes, events, documents…"
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <kbd className="hidden sm:inline text-[10px] text-text-muted border border-app-border rounded px-1.5 py-0.5">
          ⌘K
        </kbd>
      </div>

      {open && (q.trim().length >= 2 || showRecent) && (
        <div className="absolute z-50 mt-1.5 left-0 right-0 bg-surface border border-app-border rounded-lg shadow-lg max-h-[70vh] overflow-y-auto">
          {showRecent ? (
            <div className="p-2">
              <p className="text-[10px] uppercase tracking-wider text-text-muted px-2 py-1">Recent searches</p>
              {recent.map((r) => (
                <button
                  key={r}
                  onClick={() => { setQ(r); inputRef.current?.focus(); }}
                  className="w-full text-left px-2 py-1.5 rounded-md text-sm text-text-primary hover:bg-app-bg"
                >
                  {r}
                </button>
              ))}
            </div>
          ) : loading ? (
            <p className="text-sm text-text-muted text-center py-6">Searching…</p>
          ) : !hasResults ? (
            <p className="text-sm text-text-muted text-center py-6">No matches for “{q.trim()}”.</p>
          ) : (
            <div className="p-2">
              {groups.map((g) => (
                <div key={g.type} className="mb-1.5 last:mb-0">
                  <p className="text-[10px] uppercase tracking-wider text-text-muted px-2 py-1">{g.label}</p>
                  {g.items.map((it) => (
                    <button
                      key={`${g.type}-${it.id}`}
                      onClick={() => go(it)}
                      className="w-full text-left px-2 py-2 rounded-md hover:bg-app-bg flex items-center justify-between gap-3"
                    >
                      <span className="text-sm text-text-primary truncate">{it.label}</span>
                      {it.sub && <span className="text-xs text-text-muted flex-shrink-0 truncate max-w-[40%]">{it.sub}</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
