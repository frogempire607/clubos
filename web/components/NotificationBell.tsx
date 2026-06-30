"use client";

// Top-bar notification bell. Reuses /api/dashboard/action-center (same data as
// the dashboard Action Center widget) so the badge + dropdown stay in sync with
// the dashboard. `variant` adapts the icon color to the charcoal mobile topbar
// vs. the light desktop topbar. Self-clearing: counts come from live queries.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, ChevronRight, CheckCircle2 } from "lucide-react";

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

export default function NotificationBell({
  variant = "onSurface",
}: {
  variant?: "onSurface" | "onDark";
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [badge, setBadge] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  function load() {
    fetch("/api/dashboard/action-center")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.items)) {
          setItems(d.items);
          setBadge(typeof d.badge === "number" ? d.badge : 0);
        } else {
          setItems([]);
          setBadge(0);
        }
      })
      .catch(() => {
        setItems([]);
        setBadge(0);
      });
  }

  useEffect(() => {
    load();
  }, []);

  // Refresh on open + close on outside click.
  useEffect(() => {
    if (!open) return;
    load();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const iconClasses =
    variant === "onDark"
      ? "text-white/80 hover:text-white hover:bg-white/10"
      : "text-text-muted hover:text-text-primary hover:bg-app-bg";

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={badge > 0 ? `Notifications, ${badge} need attention` : "Notifications"}
        className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition ${iconClasses}`}
      >
        <Bell className="h-5 w-5" strokeWidth={2} />
        {badge > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center text-white tabular-nums"
            style={{ background: "var(--color-warning, #FF6A00)" }}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-24px)] bg-surface border border-app-border rounded-xl shadow-lg overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-app-border flex items-center justify-between">
            <span className="text-sm font-semibold text-text-primary">Needs your attention</span>
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              Dashboard →
            </Link>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items === null ? (
              <div className="p-4 space-y-2">
                {[0, 1].map((i) => (
                  <div key={i} className="h-9 rounded-lg bg-app-bg animate-pulse" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="p-6 text-center">
                <CheckCircle2
                  className="h-7 w-7 mx-auto mb-2"
                  style={{ color: "var(--color-success, #A3E635)" }}
                  strokeWidth={2}
                />
                <p className="text-sm font-medium text-text-primary">You&apos;re all caught up</p>
              </div>
            ) : (
              <div className="divide-y divide-app-border">
                {items.map((it) => (
                  <Link
                    key={it.kind}
                    href={it.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-app-bg transition"
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: dotColor(it.severity) }}
                      aria-hidden
                    />
                    <span className="flex-1 min-w-0 text-sm text-text-primary truncate">
                      {it.label}
                    </span>
                    <span className="text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full bg-app-bg text-text-primary flex-shrink-0">
                      {it.count}
                    </span>
                    <ChevronRight className="h-4 w-4 text-text-muted flex-shrink-0" strokeWidth={2} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
