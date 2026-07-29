"use client";

import { useEffect, useState } from "react";
import { Info, AlertTriangle } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type Response = {
  range: { label: string };
  athleteCount: number;
  perAthlete: {
    revenue: number | null; cost: number | null; grossProfit: number | null;
    operatingProfit: number | null; marginPercent: number | null;
  };
  margins: { grossMarginPercent: number | null; operatingMarginPercent: number | null };
  breakEven: {
    athletes: number | null;
    currentAthletes: number;
    gap: number | null;
    formula: { label: string; monthlyFixedCosts: number; contributionMarginPerAthlete: number | null };
    isEstimate: true;
    message: string | null;
  };
  acquisition: {
    cac: number | null; ltv: number | null; ltvToCacRatio: number | null;
    isEstimate: true; caveats: string[];
  };
};

const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const moneyRound = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);

export default function UnitEconomicsTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/unit-economics?${params}`)
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

  return (
    <div className="space-y-6">
      {/* Explanatory notice */}
      <div className="bg-brand/5 border border-brand/20 rounded-xl p-4 text-sm">
        <p className="text-text-primary font-semibold mb-1">Unit economics — the ratios behind the club</p>
        <p className="text-xs text-text-muted">
          Owner-first answers live on Snapshot and Membership. This is where CAC, LTV, break-even and per-athlete margins live for owners who want the underlying ratios.
        </p>
      </div>

      {/* 4 per-athlete KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Revenue / athlete" value={money(data.perAthlete.revenue)} hint={`${data.athleteCount} active athletes`} />
        <KpiCard label="Cost / athlete" value={money(data.perAthlete.cost)} hint="All expenses ÷ athletes" />
        <KpiCard label="Gross profit / athlete" value={money(data.perAthlete.grossProfit)} hint="After variable costs" />
        <KpiCard label="Operating profit / athlete" value={money(data.perAthlete.operatingProfit)} hint={`Margin ${fmtPct(data.perAthlete.marginPercent)}`} />
      </div>

      {/* Break-even card */}
      <BreakEvenCard breakEven={data.breakEven} />

      {/* Margins + Acquisition */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MarginsCard margins={data.margins} />
        <AcquisitionCard acquisition={data.acquisition} />
      </div>
    </div>
  );
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-4">
      <p className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">{label}</p>
      <p className="text-2xl font-semibold text-text-primary tabular-nums mt-1">{value}</p>
      <p className="text-[11px] text-text-muted mt-0.5">{hint}</p>
    </div>
  );
}

function BreakEvenCard({ breakEven }: { breakEven: Response["breakEven"] }) {
  const unreachable = breakEven.athletes == null;
  const gapPositive = breakEven.gap != null && breakEven.gap >= 0;

  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Break-even</p>
        <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-app-bg text-text-muted">
          Estimated
        </span>
      </div>

      {breakEven.message ? (
        <div className="border border-orange-accent/40 bg-orange-accent/10 rounded-lg p-3 flex items-start gap-2 mb-3">
          <AlertTriangle size={14} className="text-orange-accent flex-shrink-0 mt-0.5" strokeWidth={2.25} />
          <p className="text-xs text-text-primary">{breakEven.message}</p>
        </div>
      ) : null}

      {!unreachable && (
        <>
          <p className="text-4xl font-semibold text-text-primary tabular-nums leading-tight">
            {breakEven.athletes} athletes
          </p>
          <p className="text-xs text-text-muted mt-1 mb-4">
            Currently at {breakEven.currentAthletes}.{" "}
            {gapPositive ? (
              <span className="text-green-700 font-semibold">
                +{breakEven.gap} above break-even.
              </span>
            ) : (
              <span className="text-red-700 font-semibold">
                {breakEven.gap} to break-even.
              </span>
            )}
          </p>
          <div className="h-2 bg-app-bg rounded-full overflow-hidden relative mb-4">
            <div
              className={`h-full ${gapPositive ? "bg-lime-accent" : "bg-orange-accent"}`}
              style={{
                width: `${Math.min(100, (breakEven.currentAthletes / Math.max(1, breakEven.athletes!)) * 100)}%`,
              }}
            />
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-charcoal"
              style={{ left: "100%", transform: "translateX(-2px)" }}
              title="Break-even point"
            />
          </div>
        </>
      )}

      {/* Formula block */}
      <div className="bg-app-bg rounded-lg p-3">
        <p className="text-[11px] text-text-muted uppercase tracking-wide font-semibold mb-2">{breakEven.formula.label}</p>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-sm">
          <div>
            <p className="text-lg font-semibold text-text-primary tabular-nums">{moneyRound(breakEven.formula.monthlyFixedCosts)}</p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Monthly fixed</p>
          </div>
          <div className="text-lg text-text-muted">÷</div>
          <div>
            <p className={`text-lg font-semibold tabular-nums ${
              breakEven.formula.contributionMarginPerAthlete == null || breakEven.formula.contributionMarginPerAthlete <= 0
                ? "text-red-700" : "text-text-primary"
            }`}>{money(breakEven.formula.contributionMarginPerAthlete)}</p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Contribution margin / athlete</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MarginsCard({ margins }: { margins: Response["margins"] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Margins</p>
      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Gross margin" value={fmtPct(margins.grossMarginPercent)} hint="After variable costs" />
        <KpiCard label="Operating margin" value={fmtPct(margins.operatingMarginPercent)} hint="After all expenses" />
      </div>
    </div>
  );
}

function AcquisitionCard({ acquisition }: { acquisition: Response["acquisition"] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Acquisition</p>
        <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-app-bg text-text-muted">
          Estimated
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="CAC" value={moneyRound(acquisition.cac)} hint="Cost to acquire" />
        <KpiCard label="LTV" value={moneyRound(acquisition.ltv)} hint="Lifetime value" />
        <KpiCard
          label="LTV : CAC"
          value={acquisition.ltvToCacRatio == null ? "—" : `${acquisition.ltvToCacRatio.toFixed(1)}×`}
          hint="Ratio"
        />
      </div>
      {acquisition.caveats.length > 0 && (
        <div className="mt-4 border-t border-app-border pt-3 flex items-start gap-2 text-xs text-text-muted">
          <Info size={14} className="text-text-muted flex-shrink-0 mt-0.5" />
          <ul className="space-y-1">
            {acquisition.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
