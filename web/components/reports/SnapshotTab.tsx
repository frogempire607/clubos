"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import ActionItems from "@/components/reports/ActionItems";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type SnapshotResponse = {
  range: { key: RangeKey; label: string; isPartialPeriod: boolean; partialNote: string | null };
  reliability: Array<{
    key: string; label: string; state: string; detail: string; count: number | null; href: string;
  }>;
  didIMakeMoney: {
    netPosition: number;
    totalInflows: number;
    totalOutflows: number;
    comparison: {
      netPositionDelta: number | null;
      inflowsDelta: number | null;
      outflowsDelta: number | null;
    } | null;
    explanation: string;
  };
  whoOwesMe: {
    total: number;
    count: number;
    breakdown: Array<{ kind: string; label: string; amount: number; count: number; href: string }>;
  };
  membershipsGrowing: {
    netChange: number;
    newCount: number;
    canceledCount: number;
    topMovers: Array<{
      id: string; name: string; netChange: number; newCount: number; canceledCount: number; direction: "growing" | "shrinking";
    }>;
    reliability: "COMPLETE" | "ESTIMATED";
    reliabilityNote: string | null;
  };
  revenueDrivers: {
    byCoach: Array<{ id: string; name: string; amount: number; share: number; href: string }> | null;
    byClass: Array<{ id: string; name: string; kind: string; amount: number; share: number; href: string }>;
  };
  cash: {
    accounts: Array<{ id: string; label: string; balance: number; lastSyncedAt: string | null }>;
    stripePending: number;
    totalAvailable: number | null;
    lastUpdatedAt: string | null;
  };
  runway: { months: number | null; status: "healthy" | "tight" | "critical" | null; basisLabel: string };
  trend: Array<{ month: string; inflows: number; outflows: number; isPartial: boolean }>;
  burnBasis: { label: string; months: number };
  avgMonthlyBurn: number;
  avgWeeklyBurn: number;
  partialPeriodNote: string | null;
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const moneyExact = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function SnapshotTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/snapshot?${params}`)
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
      {/* Action items — the "What requires my attention today?" answer */}
      <ActionItems />

      {/* Q1: Did I make money? */}
      <DidIMakeMoneyCard data={data.didIMakeMoney} rangeLabel={data.range.label} partialNote={data.partialPeriodNote} />

      {/* Q2 + Q3 side-by-side (stacked on mobile) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WhoOwesMeCard data={data.whoOwesMe} />
        <MembershipsGrowingCard data={data.membershipsGrowing} rangeLabel={data.range.label} />
      </div>

      {/* Q4 Revenue drivers */}
      <RevenueDriversCard data={data.revenueDrivers} />

      {/* Cash + runway */}
      <CashRunwayCard cash={data.cash} runway={data.runway} />

      {/* Trend chart */}
      <MoneyInVsOutChart trend={data.trend} />
    </div>
  );
}

function DidIMakeMoneyCard({
  data,
  rangeLabel,
  partialNote,
}: {
  data: SnapshotResponse["didIMakeMoney"];
  rangeLabel: string;
  partialNote: string | null;
}) {
  const delta = data.comparison?.netPositionDelta ?? null;
  const positive = data.netPosition > 0;
  const negative = data.netPosition < 0;
  const badgeColor = positive ? "text-green-700 bg-green-50" : negative ? "text-red-700 bg-red-50" : "text-text-muted bg-app-bg";
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Did I make money?</p>
          {partialNote && (
            <p className="text-[11px] text-text-muted mt-0.5">{partialNote}</p>
          )}
        </div>
        <Link href="/dashboard/reports?tab=pnl" className="text-xs font-semibold text-brand hover:underline flex items-center gap-1">
          View P&amp;L <ArrowRight size={12} strokeWidth={2.25} />
        </Link>
      </div>
      <p className="text-lg sm:text-xl font-semibold text-text-primary leading-snug">
        {data.explanation}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <MetricInline label="Money in" value={money(data.totalInflows)} />
        <MetricInline label="Money out" value={money(data.totalOutflows)} />
        <MetricInline label="Net" value={money(data.netPosition)} accent={positive ? "green" : negative ? "red" : undefined} />
      </div>
      {delta != null && (
        <div className="mt-3 pt-3 border-t border-app-border flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${badgeColor}`}>
            {delta > 0 ? <TrendingUp size={11} strokeWidth={2.25} /> : delta < 0 ? <TrendingDown size={11} strokeWidth={2.25} /> : <Minus size={11} />}
            {delta === 0 ? "flat" : `${delta > 0 ? "+" : ""}${money(delta)}`}
          </span>
          <span className="text-text-muted">vs previous {rangeLabel.toLowerCase()}</span>
        </div>
      )}
    </div>
  );
}

function MetricInline({ label, value, accent }: { label: string; value: string; accent?: "green" | "red" }) {
  const cls = accent === "green" ? "text-green-700" : accent === "red" ? "text-red-700" : "text-text-primary";
  return (
    <div>
      <p className="text-[11px] text-text-muted uppercase tracking-wide">{label}</p>
      <p className={`text-base sm:text-lg font-semibold tabular-nums ${cls}`}>{value}</p>
    </div>
  );
}

function WhoOwesMeCard({ data }: { data: SnapshotResponse["whoOwesMe"] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Who owes me money?</p>
          <p className="text-2xl font-semibold text-text-primary tabular-nums mt-1">{moneyExact(data.total)}</p>
          <p className="text-xs text-text-muted mt-0.5">
            {data.count === 0
              ? "Nothing outstanding."
              : `${data.count} outstanding item${data.count === 1 ? "" : "s"}.`}
          </p>
        </div>
      </div>
      {data.breakdown.length === 0 ? (
        <p className="text-xs text-text-muted">Nothing outstanding — every payer is current.</p>
      ) : (
        <ul className="space-y-2">
          {data.breakdown.map((row) => (
            <li key={row.kind}>
              <Link
                href={row.href}
                className="flex items-center justify-between gap-2 border border-app-border rounded-lg px-3 py-2.5 hover:bg-app-bg min-h-[44px]"
              >
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{row.label}</p>
                  <p className="text-xs text-text-muted">
                    {row.count} row{row.count === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-sm font-semibold text-text-primary tabular-nums">{moneyExact(row.amount)}</span>
                  <ArrowRight size={13} strokeWidth={2.25} className="text-text-muted" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MembershipsGrowingCard({ data, rangeLabel }: { data: SnapshotResponse["membershipsGrowing"]; rangeLabel: string }) {
  const arrow = data.netChange > 0 ? <TrendingUp size={14} className="text-green-700" strokeWidth={2.25} /> : data.netChange < 0 ? <TrendingDown size={14} className="text-red-700" strokeWidth={2.25} /> : <Minus size={14} className="text-text-muted" />;
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Which memberships are growing?</p>
          <div className="flex items-baseline gap-2 mt-1">
            <p className={`text-2xl font-semibold tabular-nums ${data.netChange > 0 ? "text-green-700" : data.netChange < 0 ? "text-red-700" : "text-text-primary"}`}>
              {data.netChange >= 0 ? "+" : ""}{data.netChange}
            </p>
            {arrow}
            <span className="text-xs text-text-muted">{rangeLabel.toLowerCase()}</span>
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            {data.newCount} new, {data.canceledCount} canceled.
          </p>
        </div>
      </div>
      {data.reliability === "ESTIMATED" && data.reliabilityNote && (
        <p className="text-[11px] text-text-muted italic mb-2 border-l-2 border-app-border pl-2">
          {data.reliabilityNote}
        </p>
      )}
      {data.topMovers.length === 0 ? (
        <p className="text-xs text-text-muted">No membership activity in this range.</p>
      ) : (
        <ul className="space-y-1.5">
          {data.topMovers.map((mover) => (
            <li key={mover.id} className="flex items-center justify-between text-sm">
              <span className="text-text-primary truncate">{mover.name}</span>
              <span className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-text-muted">
                  +{mover.newCount} / −{mover.canceledCount}
                </span>
                <span className={`text-sm font-semibold tabular-nums ${mover.netChange > 0 ? "text-green-700" : mover.netChange < 0 ? "text-red-700" : "text-text-muted"}`}>
                  {mover.netChange >= 0 ? "+" : ""}{mover.netChange}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RevenueDriversCard({ data }: { data: SnapshotResponse["revenueDrivers"] }) {
  const hasCoach = data.byCoach && data.byCoach.length > 0;
  const hasClass = data.byClass.length > 0;
  if (!hasCoach && !hasClass) {
    return (
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
          Which coaches / classes are driving revenue?
        </p>
        <p className="text-sm text-text-muted mt-1">Not enough activity in this range yet.</p>
      </div>
    );
  }
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">
        Which coaches / classes are driving revenue?
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {hasCoach && (
          <div>
            <p className="text-xs text-text-muted mb-2">Top coaches</p>
            <ul className="space-y-1.5">
              {data.byCoach!.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link href={c.href} className="flex items-center justify-between text-sm hover:bg-app-bg -mx-2 px-2 py-1 rounded min-h-[44px] md:min-h-0">
                    <span className="text-text-primary truncate">{c.name}</span>
                    <span className="text-sm font-semibold text-text-primary tabular-nums flex-shrink-0">{money(c.amount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasClass && (
          <div>
            <p className="text-xs text-text-muted mb-2">Top classes &amp; events</p>
            <ul className="space-y-1.5">
              {data.byClass.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link href={c.href} className="flex items-center justify-between text-sm hover:bg-app-bg -mx-2 px-2 py-1 rounded min-h-[44px] md:min-h-0">
                    <span className="text-text-primary truncate">{c.name}</span>
                    <span className="text-sm font-semibold text-text-primary tabular-nums flex-shrink-0">{money(c.amount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function CashRunwayCard({ cash, runway }: { cash: SnapshotResponse["cash"]; runway: SnapshotResponse["runway"] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Cash on hand &amp; runway</p>
      </div>
      {cash.accounts.length === 0 ? (
        <div className="border border-app-border bg-app-bg rounded-lg p-4">
          <p className="text-sm text-text-primary">
            Connect a bank to see cash on hand and runway.
          </p>
          <Link href="/dashboard/financials?tab=bank" className="text-xs font-semibold text-brand hover:underline mt-1 inline-block">
            Connect bank →
          </Link>
        </div>
      ) : (
        <>
          <ul className="space-y-1.5 mb-3">
            {cash.accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm">
                <span className="text-text-primary truncate">{a.label}</span>
                <span className="text-text-primary font-semibold tabular-nums">{moneyExact(a.balance)}</span>
              </li>
            ))}
          </ul>
          <div className="bg-lime-accent/20 rounded-lg -mx-2 sm:mx-0 px-4 py-3 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">Total available</span>
              <span className="text-base font-bold text-text-primary tabular-nums">{moneyExact(cash.totalAvailable ?? 0)}</span>
            </div>
          </div>
        </>
      )}
      {runway.months == null ? (
        <p className="text-xs text-text-muted">Runway will appear once a bank account is connected.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2 mb-1">
            <p className="text-base font-semibold text-text-primary tabular-nums">{runway.months} mo runway</p>
            <span className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${runway.status === "healthy" ? "bg-lime-accent/25 text-lime-800" : runway.status === "tight" ? "bg-orange-accent/25 text-orange-accent" : "bg-red-50 text-red-700"}`}>
              {runway.status}
            </span>
          </div>
          <div className="h-1.5 bg-app-bg rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${runway.status === "healthy" ? "bg-lime-accent" : runway.status === "tight" ? "bg-orange-accent" : "bg-red-500"}`}
              style={{ width: `${Math.min(100, ((runway.months ?? 0) / 12) * 100)}%` }}
            />
          </div>
          <p className="text-[11px] text-text-muted mt-2">{runway.basisLabel}</p>
        </>
      )}
    </div>
  );
}

function MoneyInVsOutChart({ trend }: { trend: SnapshotResponse["trend"] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(() => {
    // Below sm show last 6 with toggle.
    if (typeof window !== "undefined" && window.innerWidth < 640 && !showAll) {
      return trend.slice(-6);
    }
    return trend;
  }, [trend, showAll]);
  const maxVal = Math.max(1, ...trend.map((b) => Math.max(b.inflows, b.outflows)));

  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Money in vs money out</p>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-brand rounded-sm" /> Money in
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-brand/30 rounded-sm" /> Money out
          </span>
          {trend.length > 6 && (
            <button
              className="sm:hidden text-brand font-semibold"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show recent" : "Show all"}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-end gap-2 h-40 overflow-x-auto">
        {visible.map((b, i) => {
          const inH = Math.max(2, (b.inflows / maxVal) * 100);
          const outH = Math.max(2, (b.outflows / maxVal) * 100);
          return (
            <div key={b.month + i} className={`flex-1 min-w-[24px] flex flex-col items-center gap-1 ${b.isPartial ? "opacity-55" : ""}`}>
              <div className="flex-1 w-full flex items-end gap-0.5">
                <div className="flex-1 bg-brand rounded-t" style={{ height: `${inH}%` }} title={`In ${moneyExact(b.inflows)}`} />
                <div className="flex-1 bg-brand/30 rounded-t" style={{ height: `${outH}%` }} title={`Out ${moneyExact(b.outflows)}`} />
              </div>
              <span className="text-[10px] text-text-muted whitespace-nowrap">
                {new Date(b.month).toLocaleDateString("en-US", { month: "short" })}
                {b.isPartial && "*"}
              </span>
            </div>
          );
        })}
      </div>
      {visible.some((b) => b.isPartial) && (
        <p className="text-[10px] text-text-muted mt-2">* Partial period — not yet complete.</p>
      )}
    </div>
  );
}
