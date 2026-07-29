"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type ByItem = { id: string; label: string; category: string; kind: string; units: number; amount: number; percentOfTotal: number; href: string };
type ByCoach = { id: string; name: string; amount: number; percentOfTotal: number; reliability: string; href: string };
type ByLocation = { id: string; name: string; amount: number; percentOfTotal: number; href: string };
type BySource = { source: string; label: string; amount: number; percentOfTotal: number };

type Response = {
  range: { key: RangeKey; label: string; start: string | null; end: string };
  total: number;
  primary: {
    mix: { recurring: number; variable: number; recurringPercent: number; variablePercent: number };
    byItem: ByItem[];
    byCoach: ByCoach[] | null;
    byLocation: ByLocation[] | null;
    bySource: BySource[];
  };
  recurring: {
    activeMemberships: number; mrr: number; arr: number; arpa: number; arpMembership: number;
    newMemberships: number; renewedMemberships: number; endedMemberships: number;
    upgrades: number; downgrades: number; amount: number; percentOfTotal: number;
  };
  variable: {
    amount: number; percentOfTotal: number;
    byCategory: Array<{ key: string; label: string; amount: number; percentOfTotal: number }>;
  };
  reliability: "COMPLETE" | "ESTIMATED";
  reliabilityNotes: string[];
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const moneyExact = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function RevenueTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [recurringOpen, setRecurringOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/revenue?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }, [range, customFrom, customTo]);

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Primary answer #1: mix bar */}
      <MixCard mix={data.primary.mix} total={data.total} rangeLabel={data.range.label} />

      {/* Primary answer #2: top revenue by item */}
      <ByItemCard rows={data.primary.byItem} />

      {/* Primary answer #3 + #4: coach + class/event driver breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ByCoachCard rows={data.primary.byCoach} />
        <ByLocationCard rows={data.primary.byLocation} />
      </div>

      {/* Source chips */}
      <BySourceCard rows={data.primary.bySource} />

      {/* Secondary — collapsible recurring / SaaS block */}
      <div className="bg-surface border border-app-border rounded-xl">
        <button
          onClick={() => setRecurringOpen((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 min-h-[44px] hover:bg-app-bg rounded-xl transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">Recurring revenue metrics</span>
            <span className="hidden sm:inline text-[11px] text-text-muted italic">SaaS-style: MRR, ARR, ARPA</span>
          </div>
          {recurringOpen ? <ChevronUp size={16} className="text-text-muted" /> : <ChevronDown size={16} className="text-text-muted" />}
        </button>
        {recurringOpen && <RecurringBlock r={data.recurring} />}
      </div>

      {data.reliability === "ESTIMATED" && data.reliabilityNotes.length > 0 && (
        <div className="border border-app-border rounded-xl p-3 flex items-start gap-2 text-xs text-text-muted">
          <Info size={14} className="text-text-muted flex-shrink-0 mt-0.5" />
          <div>
            {data.reliabilityNotes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MixCard({ mix, total, rangeLabel }: { mix: Response["primary"]["mix"]; total: number; rangeLabel: string }) {
  const recurringPct = Math.max(0, Math.min(100, mix.recurringPercent));
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Revenue mix</p>
          <p className="text-2xl font-semibold text-text-primary tabular-nums mt-1">{moneyExact(total)}</p>
          <p className="text-xs text-text-muted mt-0.5">{rangeLabel}</p>
        </div>
        <div className="flex flex-col sm:items-end text-xs">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-sm bg-brand" />
            <span className="text-text-primary font-semibold">{money(mix.recurring)}</span>
            <span className="text-text-muted">Recurring ({recurringPct.toFixed(0)}%)</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-lime-accent" />
            <span className="text-text-primary font-semibold">{money(mix.variable)}</span>
            <span className="text-text-muted">Variable ({mix.variablePercent.toFixed(0)}%)</span>
          </div>
        </div>
      </div>
      <div className="h-8 rounded-lg overflow-hidden bg-app-bg flex">
        <div className="h-full bg-brand" style={{ width: `${recurringPct}%` }} title={`Recurring ${money(mix.recurring)}`} />
        <div className="h-full bg-lime-accent" style={{ width: `${100 - recurringPct}%` }} title={`Variable ${money(mix.variable)}`} />
      </div>
    </div>
  );
}

function ByItemCard({ rows }: { rows: ByItem[] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Top revenue items</p>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing to show yet.</p>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-text-muted uppercase tracking-wide font-semibold border-b border-app-border">
                  <th className="text-left py-2 pr-3">Item</th>
                  <th className="text-left py-2 pr-3">Kind</th>
                  <th className="text-right py-2 pr-3">Units</th>
                  <th className="text-right py-2 pr-3">Amount</th>
                  <th className="text-right py-2">%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-app-border last:border-0">
                    <td className="py-2 pr-3">
                      <Link href={r.href} className="text-text-primary hover:underline">{r.label}</Link>
                    </td>
                    <td className="py-2 pr-3 text-xs text-text-muted uppercase">{r.kind}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.units}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-semibold text-text-primary">{moneyExact(r.amount)}</td>
                    <td className="py-2 text-right tabular-nums text-text-muted">{r.percentOfTotal.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile: card list */}
          <ul className="md:hidden space-y-2">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={r.href} className="block border border-app-border rounded-lg p-3 hover:bg-app-bg min-h-[44px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{r.label}</p>
                      <p className="text-[11px] text-text-muted uppercase mt-0.5">{r.kind} · {r.units} unit{r.units === 1 ? "" : "s"}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-text-primary tabular-nums">{moneyExact(r.amount)}</p>
                      <p className="text-[11px] text-text-muted tabular-nums">{r.percentOfTotal.toFixed(1)}%</p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ByCoachCard({ rows }: { rows: ByCoach[] | null }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-2">Top coaches</p>
        <p className="text-sm text-text-muted">Assign coaches to events to see this breakdown.</p>
      </div>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Top coaches</p>
      <ul className="space-y-2">
        {rows.slice(0, 5).map((r) => (
          <li key={r.id}>
            <Link href={r.href} className="block hover:bg-app-bg -mx-2 px-2 py-1.5 rounded min-h-[44px] md:min-h-0">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-text-primary truncate">{r.name}</span>
                <span className="font-semibold text-text-primary tabular-nums flex-shrink-0">{moneyExact(r.amount)}</span>
              </div>
              <div className="h-1 bg-app-bg rounded overflow-hidden">
                <div className="h-full bg-brand" style={{ width: `${(r.amount / max) * 100}%` }} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ByLocationCard({ rows }: { rows: ByLocation[] | null }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-2">Top locations</p>
        <p className="text-sm text-text-muted">Multi-location breakdown appears when you have more than one location.</p>
      </div>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Top locations</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={r.href} className="block hover:bg-app-bg -mx-2 px-2 py-1.5 rounded min-h-[44px] md:min-h-0">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-text-primary truncate">{r.name}</span>
                <span className="font-semibold text-text-primary tabular-nums flex-shrink-0">{moneyExact(r.amount)}</span>
              </div>
              <div className="h-1 bg-app-bg rounded overflow-hidden">
                <div className="h-full bg-lime-accent" style={{ width: `${(r.amount / max) * 100}%` }} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BySourceCard({ rows }: { rows: BySource[] }) {
  if (rows.length === 0) return null;
  const dotColors: Record<string, string> = {
    STRIPE: "bg-brand",
    CASH: "bg-lime-accent",
    CHECK: "bg-orange-accent",
    EXTERNAL_READER: "bg-purple-500",
    COMP: "bg-gray-400",
    MANUAL_ADJUSTMENT: "bg-gray-500",
    ATHLETIXOS: "bg-brand",
    PREVIOUS_SOFTWARE: "bg-orange-accent",
    MANUAL_IMPORT: "bg-gray-500",
    BANK: "bg-charcoal",
    OTHER: "bg-gray-400",
  };
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Revenue by source</p>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <div
            key={r.source}
            className="flex items-center gap-2 rounded-full border border-app-border bg-app-bg px-3 py-1.5"
          >
            <span className={`inline-block w-2 h-2 rounded-full ${dotColors[r.source] ?? "bg-gray-300"}`} />
            <span className="text-xs text-text-primary font-semibold">{moneyExact(r.amount)}</span>
            <span className="text-[11px] text-text-muted">
              {r.label} · {r.percentOfTotal.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecurringBlock({ r }: { r: Response["recurring"] }) {
  return (
    <div className="border-t border-app-border p-5">
      <p className="text-[11px] text-text-muted italic mb-3 sm:hidden">SaaS-style: MRR, ARR, ARPA</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MetricTile label="MRR" value={moneyExact(r.mrr)} hint="Monthly recurring revenue" />
        <MetricTile label="ARR" value={money(r.arr)} hint="Annualized run rate" />
        <MetricTile label="ARPA" value={moneyExact(r.arpa)} hint="Avg. revenue per athlete" />
        <MetricTile label="ARPM" value={moneyExact(r.arpMembership)} hint="Avg. per membership" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <MetricTile label="Active" value={String(r.activeMemberships)} hint="Memberships" />
        <MetricTile label="New" value={String(r.newMemberships)} hint="In range" />
        <MetricTile label="Ended" value={String(r.endedMemberships)} hint="In range" />
        <MetricTile label="Upgrades" value={String(r.upgrades)} hint="Est." />
        <MetricTile label="Downgrades" value={String(r.downgrades)} hint="Est." />
      </div>
      <p className="text-[11px] text-text-muted mt-3">
        Recurring revenue is {money(r.amount)} — {r.percentOfTotal.toFixed(0)}% of total.
        Upgrade/downgrade counts are estimated until subscription-event history ships (Phase 4.5).
      </p>
    </div>
  );
}

function MetricTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">{label}</p>
      <p className="text-lg font-semibold text-text-primary tabular-nums">{value}</p>
      <p className="text-[11px] text-text-muted">{hint}</p>
    </div>
  );
}
