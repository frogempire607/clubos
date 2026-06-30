"use client";

// Dashboard "command center" widget. Renders the permission-filtered,
// self-clearing action list from /api/dashboard/action-center. Each row deep
// links to the page where the work gets done; items vanish once resolved.
// Styling matches the other section widgets (bg-surface card, app-border).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, CheckCircle2 } from "lucide-react";

type ActionItem = {
  kind: string;
  label: string;
  count: number;
  severity: "high" | "medium" | "low";
  href: string;
};

function dotColor(severity: string): string {
  if (severity === "high") return "var(--color-warning, #FF6A00)";
  if (severity === "medium") return "var(--color-primary, #6D5DF6)";
  return "var(--color-muted, #6B7280)";
}

export default function ActionCenterWidget() {
  const [items, setItems] = useState<ActionItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/dashboard/action-center")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray(d.items)) setItems(d.items);
        else if (alive) setItems([]);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const total = items?.reduce((s, i) => s + i.count, 0) ?? 0;

  return (
    <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
      <div className="px-5 py-3.5 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Needs your attention</h2>
        {items && items.length > 0 && (
          <span className="text-xs text-text-muted tabular-nums">{total} items</span>
        )}
      </div>

      {items === null ? (
        <div className="p-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 rounded-lg bg-app-bg animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-8 text-center">
          <CheckCircle2
            className="h-8 w-8 mx-auto mb-2"
            style={{ color: "var(--color-success, #A3E635)" }}
            strokeWidth={2}
          />
          <p className="text-sm font-medium text-text-primary">You&apos;re all caught up</p>
          <p className="text-xs text-text-muted mt-0.5">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <div className="divide-y divide-app-border">
          {items.map((it) => (
            <Link
              key={it.kind}
              href={it.href}
              className="flex items-center gap-3 px-5 py-3 hover:bg-app-bg transition"
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: dotColor(it.severity) }}
                aria-hidden
              />
              <span className="flex-1 min-w-0 text-sm text-text-primary truncate">{it.label}</span>
              <span className="text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full bg-app-bg text-text-primary flex-shrink-0">
                {it.count}
              </span>
              <ChevronRight className="h-4 w-4 text-text-muted flex-shrink-0" strokeWidth={2} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
