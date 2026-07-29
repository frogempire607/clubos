"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Info, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type Response = {
  range: { label: string };
  movement: {
    startingActive: number; new: number; reactivated: number; canceled: number; expired: number;
    endingActive: number; planChanges: number;
  };
  rates: {
    churnRate: number | null;
    revenueChurnRate: number | null;
    retentionRate: number | null;
    trialToPaidRate: number | null;
    avgMembershipDurationMonths: number | null;
    avgLifetimeValue: number | null;
    avgMonthlyRevenuePerAthlete: number | null;
    avgMonthlyRevenuePerFamily: number | null;
  };
  formula: { label: string; numerator: number; denominator: number; result: number | null };
  trend: Array<{ period: string; label: string; churnRate: number | null }>;
  breakdown: Array<{ key: string; name: string; active: number; lost: number; churnRate: number | null; revenue: number }>;
  topMovers: Array<{ id: string; name: string; netChange: number; newCount: number; canceledCount: number; direction: "growing" | "shrinking" }>;
  reliability: "COMPLETE" | "ESTIMATED";
  reliabilityNotes: string[];
  notes: string[];
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);

export default function MembershipTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "growing" | "shrinking">("all");

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/membership?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }, [range, customFrom, customTo]);

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const filteredMovers =
    filter === "all"
      ? data.topMovers
      : data.topMovers.filter((m) => (filter === "growing" ? m.netChange >= 0 : m.netChange < 0));

  return (
    <div className="space-y-6">
      {/* Movement card */}
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
          <div>
            <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Membership movement</p>
            <p className="text-xs text-text-muted mt-0.5">{data.range.label}</p>
          </div>
          <p className={`text-2xl font-semibold tabular-nums ${
            data.movement.endingActive - data.movement.startingActive > 0
              ? "text-green-700"
              : data.movement.endingActive - data.movement.startingActive < 0
                ? "text-red-700"
                : "text-text-primary"
          }`}>
            {data.movement.startingActive} → {data.movement.endingActive}
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MovementBox label="New" value={data.movement.new} tone="green" />
          <MovementBox label="Canceled" value={data.movement.canceled} tone="red" />
          <MovementBox label="Plan changes" value={data.movement.planChanges} tone="neutral" note="Not counted as churn" />
          <MovementBox label="Net change" value={data.movement.endingActive - data.movement.startingActive} tone="signed" />
        </div>
      </div>

      {/* Churn rates + formula */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RatesCard rates={data.rates} formula={data.formula} />
        <FormulaCard formula={data.formula} />
      </div>

      {/* Trend */}
      <TrendCard trend={data.trend} />

      {/* Top movers */}
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Top movers</p>
          <div className="flex gap-1 overflow-x-auto">
            {(["all", "growing", "shrinking"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1 rounded-full whitespace-nowrap min-h-[32px] ${
                  filter === f
                    ? "bg-charcoal text-white font-semibold"
                    : "bg-app-bg text-text-muted"
                }`}
              >
                {f === "all" ? "All" : f === "growing" ? "Growing" : "Shrinking"}
              </button>
            ))}
          </div>
        </div>
        {filteredMovers.length === 0 ? (
          <p className="text-sm text-text-muted">No movement in this range.</p>
        ) : (
          <ul className="space-y-2">
            {filteredMovers.map((m) => (
              <li key={m.id} className="flex items-center justify-between text-sm border border-app-border rounded-lg px-3 py-2.5 min-h-[44px]">
                <div className="min-w-0">
                  <p className="text-text-primary truncate">{m.name}</p>
                  <p className="text-[11px] text-text-muted">
                    +{m.newCount} new, −{m.canceledCount} canceled
                  </p>
                </div>
                <span className={`text-base font-semibold tabular-nums flex-shrink-0 flex items-center gap-1 ${
                  m.netChange > 0 ? "text-green-700" : m.netChange < 0 ? "text-red-700" : "text-text-muted"
                }`}>
                  {m.netChange > 0 ? <TrendingUp size={14} strokeWidth={2.25} /> :
                   m.netChange < 0 ? <TrendingDown size={14} strokeWidth={2.25} /> :
                   <Minus size={14} strokeWidth={2.25} />}
                  {m.netChange > 0 ? "+" : ""}{m.netChange}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Breakdown */}
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">By plan</p>
        {data.breakdown.length === 0 ? (
          <p className="text-sm text-text-muted">No plan-level breakdown available.</p>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-text-muted uppercase tracking-wide font-semibold border-b border-app-border">
                    <th className="text-left py-2 pr-3">Plan</th>
                    <th className="text-right py-2 pr-3">Active</th>
                    <th className="text-right py-2 pr-3">Lost</th>
                    <th className="text-right py-2 pr-3">Churn</th>
                    <th className="text-right py-2">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown.map((row) => (
                    <tr key={row.key} className="border-b border-app-border last:border-0">
                      <td className="py-2 pr-3 text-text-primary">{row.name}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.active}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.lost}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-text-muted">{fmtPct(row.churnRate)}</td>
                      <td className="py-2 text-right tabular-nums font-semibold text-text-primary">{money(row.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden space-y-2">
              {data.breakdown.map((row) => (
                <li key={row.key} className="border border-app-border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-text-primary truncate">{row.name}</p>
                    <span className="text-sm font-semibold text-text-primary tabular-nums">{money(row.revenue)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                    <div>
                      <p className="text-[10px] text-text-muted uppercase">Active</p>
                      <p className="text-text-primary font-semibold tabular-nums">{row.active}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-muted uppercase">Lost</p>
                      <p className="text-text-primary font-semibold tabular-nums">{row.lost}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-muted uppercase">Churn</p>
                      <p className="text-text-primary font-semibold tabular-nums">{fmtPct(row.churnRate)}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Notes + reliability */}
      <div className="border border-app-border rounded-xl p-3 flex items-start gap-2 text-xs text-text-muted">
        <Info size={14} className="text-text-muted flex-shrink-0 mt-0.5" />
        <div>
          {data.reliabilityNotes.map((n, i) => (
            <p key={i} className="mb-1">{n}</p>
          ))}
          {data.notes.map((n, i) => (
            <p key={`note-${i}`}>{n}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function MovementBox({ label, value, tone, note }: { label: string; value: number; tone: "green" | "red" | "signed" | "neutral"; note?: string }) {
  const cls =
    tone === "green" ? "text-green-700" :
    tone === "red" ? "text-red-700" :
    tone === "signed"
      ? value > 0 ? "text-green-700" : value < 0 ? "text-red-700" : "text-text-primary"
    : "text-text-primary";
  return (
    <div>
      <p className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${cls}`}>
        {tone === "signed" && value > 0 ? "+" : ""}
        {value}
      </p>
      {note && <p className="text-[11px] text-text-muted">{note}</p>}
    </div>
  );
}

function RatesCard({ rates }: { rates: Response["rates"]; formula: Response["formula"] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Rates</p>
      <div className="grid grid-cols-2 gap-3">
        <MetricTile label="Churn rate" value={fmtPct(rates.churnRate)} accent={rates.churnRate != null && rates.churnRate > 5 ? "warn" : "ok"} />
        <MetricTile label="Retention" value={fmtPct(rates.retentionRate)} accent={rates.retentionRate != null && rates.retentionRate > 90 ? "ok" : "warn"} />
        <MetricTile label="Revenue churn" value={fmtPct(rates.revenueChurnRate)} />
        <MetricTile label="Trial → paid" value={rates.trialToPaidRate == null ? "—" : fmtPct(rates.trialToPaidRate)} />
      </div>
      <p className="text-[11px] text-text-muted mt-3">
        Trial conversion + duration + LTV precision ships with the subscription-event history in Phase 4.5.
      </p>
    </div>
  );
}

function FormulaCard({ formula }: { formula: Response["formula"] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">How churn is calculated</p>
      <p className="text-sm text-text-primary mb-3">{formula.label}</p>
      <div className="bg-app-bg rounded-lg p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 text-center">
          <div className="flex-1">
            <p className="text-2xl font-semibold text-text-primary tabular-nums">{formula.numerator}</p>
            <p className="text-[11px] text-text-muted uppercase tracking-wide">Lost</p>
          </div>
          <div className="text-2xl text-text-muted">÷</div>
          <div className="flex-1">
            <p className="text-2xl font-semibold text-text-primary tabular-nums">{formula.denominator}</p>
            <p className="text-[11px] text-text-muted uppercase tracking-wide">Starting active</p>
          </div>
          <div className="text-2xl text-text-muted hidden sm:block">=</div>
          <div className="flex-1 border-t sm:border-t-0 sm:border-l border-app-border pt-2 sm:pt-0 sm:pl-3">
            <p className={`text-2xl font-semibold tabular-nums ${
              formula.result != null && formula.result > 5 ? "text-red-700" : "text-text-primary"
            }`}>{fmtPct(formula.result)}</p>
            <p className="text-[11px] text-text-muted uppercase tracking-wide">Churn</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrendCard({ trend }: { trend: Response["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.churnRate ?? 0));
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Churn trend — last 6 months</p>
      {trend.every((t) => t.churnRate == null) ? (
        <p className="text-sm text-text-muted">Not enough history to draw a trend.</p>
      ) : (
        <div className="flex items-end gap-2 h-32 overflow-x-auto">
          {trend.map((t) => {
            const rate = t.churnRate ?? 0;
            const h = Math.max(2, (rate / max) * 100);
            return (
              <div key={t.period} className="flex-1 min-w-[24px] flex flex-col items-center gap-1">
                <div
                  className={`w-full rounded-t ${rate > 5 ? "bg-red-400" : "bg-brand"}`}
                  style={{ height: `${h}%` }}
                  title={`${t.label}: ${fmtPct(t.churnRate)}`}
                />
                <span className="text-[10px] text-text-muted whitespace-nowrap">{t.label.split(" ")[0]}</span>
                <span className="text-[10px] text-text-muted tabular-nums">{fmtPct(t.churnRate)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value, accent }: { label: string; value: string; accent?: "ok" | "warn" }) {
  const cls = accent === "warn" ? "text-red-700" : accent === "ok" ? "text-green-700" : "text-text-primary";
  return (
    <div>
      <p className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</p>
    </div>
  );
}
