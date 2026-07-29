"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, MoreHorizontal, ChevronRight, Clock } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";

type ActionItem = {
  id: string;
  kind: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  count: number | null;
  amount: number | null;
  href: string;
  action: { label: string; kind: string; permission: string } | null;
};

type ActionItemsPayload = {
  items: ActionItem[];
  counts: { high: number; medium: number; low: number };
  generatedAt: string;
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function severityBadge(severity: ActionItem["severity"]) {
  if (severity === "high") return { dot: "bg-red-500", icon: <AlertTriangle size={14} className="text-red-500" strokeWidth={2.25} /> };
  if (severity === "medium") return { dot: "bg-orange-accent", icon: <AlertCircle size={14} className="text-orange-accent" strokeWidth={2.25} /> };
  return { dot: "bg-app-bg border border-app-border", icon: <Clock size={14} className="text-text-muted" strokeWidth={2.25} /> };
}

export default function ActionItems() {
  const [data, setData] = useState<ActionItemsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/reports/action-items");
    const d = res.ok ? await res.json() : null;
    setData(d);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function snooze(item: ActionItem, days: number) {
    await fetch("/api/reports/action-items/snooze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: item.kind, days }),
    });
    setOpenMenuFor(null);
    load();
  }

  if (loading || !data) {
    return (
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Requires your attention</h2>
        <div className="grid grid-cols-1 gap-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  const items = filter === "all" ? data.items : data.items.filter((i) => i.severity === filter);

  if (data.items.length === 0) {
    return (
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Requires your attention</h2>
        <div className="bg-lime-accent/15 border border-lime-accent/40 rounded-xl p-5 flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-lime-accent/40 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 size={20} className="text-charcoal" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Nothing needs your attention today.</p>
            <p className="text-xs text-text-muted mt-0.5">
              Payments processed, memberships renewing, bank sync current. Well-run day.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Requires your attention</h2>
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1">
          {(["all", "high", "medium", "low"] as const).map((k) => {
            const label =
              k === "all" ? `All ${data.items.length}` : `${k.charAt(0).toUpperCase() + k.slice(1)} ${data.counts[k]}`;
            return (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition-colors min-h-[32px] ${
                  filter === k
                    ? "bg-charcoal text-white font-semibold"
                    : "bg-app-bg text-text-muted hover:text-text-primary"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <ul className="space-y-2">
        {items.map((item) => {
          const badge = severityBadge(item.severity);
          return (
            <li
              key={item.id}
              data-action-item-kind={item.kind}
              className="bg-surface border border-app-border rounded-xl p-3 sm:p-4"
            >
              <div className="flex items-start gap-3">
                <span className={`inline-block w-2 h-2 rounded-full mt-2 ${badge.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{item.title}</p>
                      <p className="text-xs text-text-muted mt-0.5">{item.detail}</p>
                    </div>
                    {item.amount != null && (
                      <span className="text-sm font-semibold text-text-primary tabular-nums flex-shrink-0">
                        {money(item.amount)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {item.action && (
                      <Link
                        href={item.href}
                        className="inline-flex items-center gap-1 h-9 min-h-[44px] sm:min-h-9 px-3 rounded-lg bg-charcoal text-white text-xs font-semibold"
                      >
                        {item.action.label}
                        <ChevronRight size={13} strokeWidth={2.25} />
                      </Link>
                    )}
                    <Link
                      href={item.href}
                      className="inline-flex items-center gap-1 h-9 min-h-[44px] sm:min-h-9 px-3 rounded-lg border border-app-border text-text-primary text-xs hover:bg-app-bg"
                    >
                      View
                    </Link>
                    <div className="relative ml-auto">
                      <button
                        onClick={() => setOpenMenuFor(openMenuFor === item.id ? null : item.id)}
                        aria-label="More"
                        className="h-9 w-9 min-h-[44px] min-w-[44px] sm:min-h-9 sm:min-w-9 rounded-lg border border-app-border flex items-center justify-center hover:bg-app-bg"
                      >
                        <MoreHorizontal size={15} className="text-text-muted" />
                      </button>
                      {openMenuFor === item.id && (
                        <div
                          className="absolute right-0 mt-1 w-44 bg-surface border border-app-border rounded-lg z-30 py-1"
                          style={{ boxShadow: "0 10px 30px rgba(17,17,17,0.12)" }}
                        >
                          <button
                            onClick={() => snooze(item, 1)}
                            className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-app-bg"
                          >
                            Snooze 1 day
                          </button>
                          <button
                            onClick={() => snooze(item, 7)}
                            className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-app-bg"
                          >
                            Snooze 7 days
                          </button>
                          <button
                            onClick={() => snooze(item, 30)}
                            className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-app-bg"
                          >
                            Snooze 30 days
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
