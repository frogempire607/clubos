"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Info, SlidersHorizontal, TrendingDown, TrendingUp } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type TopCat = {
  rank: number; category: string; label: string; behavior: "FIXED" | "VARIABLE";
  amount: number; percentOfRevenue: number; deltaPercent: number | null; deltaAmount: number | null; overridden: boolean;
};
type Vendor = { vendor: string; amount: number; transactionCount: number };
type LargeExp = { id: string; date: string; description: string; vendor: string | null; amount: number; href: string };

type Response = {
  range: { label: string };
  fixed: { total: number; monthlyAverage: number; percentOfRevenue: number; categories: string[] };
  variable: { total: number; monthlyAverage: number; percentOfRevenue: number; categories: string[] };
  topCategories: TopCat[];
  topVendors: Vendor[];
  largestExpenses: LargeExp[];
  attention: {
    uncategorized: { count: number; amount: number; href: string };
    missingReceipts: { count: number; amount: number; href: string };
    awaitingReview: { count: number; href: string };
    unusualIncreases: Array<{ category: string; label: string; currentAmount: number; averageAmount: number; percentAbove: number }>;
    recurringSubscriptions: { count: number; monthlyAmount: number; href: string };
    possibleDuplicates: Array<{ ids: string[]; vendor: string; amount: number; date: string }>;
  };
  overrides: Array<{ category: string; treatAs: "FIXED" | "VARIABLE"; updatedById: string | null }>;
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const moneyExact = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CostsTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TopCat | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    const res = await fetch(`/api/reports/costs?${params}`);
    const d = res.ok ? await res.json() : null;
    setData(d);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range, customFrom, customTo]);

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const total = data.fixed.total + data.variable.total;
  const fixedPct = total > 0 ? (data.fixed.total / total) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Split bar */}
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <div>
            <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Fixed vs variable</p>
            <p className="text-2xl font-semibold text-text-primary tabular-nums mt-1">{moneyExact(total)}</p>
            <p className="text-xs text-text-muted mt-0.5">{data.range.label}</p>
          </div>
          <div className="flex flex-col sm:items-end text-xs">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-sm bg-charcoal" />
              <span className="text-text-primary font-semibold">{money(data.fixed.total)}</span>
              <span className="text-text-muted">Fixed ({fixedPct.toFixed(0)}%)</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="inline-block w-2 h-2 rounded-sm bg-orange-accent" />
              <span className="text-text-primary font-semibold">{money(data.variable.total)}</span>
              <span className="text-text-muted">Variable ({(100 - fixedPct).toFixed(0)}%)</span>
            </div>
          </div>
        </div>
        <div className="h-8 rounded-lg overflow-hidden bg-app-bg flex">
          <div className="h-full bg-charcoal" style={{ width: `${fixedPct}%` }} title={`Fixed ${money(data.fixed.total)}`} />
          <div className="h-full bg-orange-accent" style={{ width: `${100 - fixedPct}%` }} title={`Variable ${money(data.variable.total)}`} />
        </div>
      </div>

      {/* Two metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MetricCard
          title="Fixed costs"
          amount={data.fixed.total}
          monthlyAverage={data.fixed.monthlyAverage}
          percentOfRevenue={data.fixed.percentOfRevenue}
          categories={data.fixed.categories}
          accentClass="bg-charcoal"
        />
        <MetricCard
          title="Variable costs"
          amount={data.variable.total}
          monthlyAverage={data.variable.monthlyAverage}
          percentOfRevenue={data.variable.percentOfRevenue}
          categories={data.variable.categories}
          accentClass="bg-orange-accent"
        />
      </div>

      {/* Top categories table */}
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Top expense categories</p>
        </div>
        {data.topCategories.length === 0 ? (
          <p className="text-sm text-text-muted">No expenses in this range.</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-text-muted uppercase tracking-wide font-semibold border-b border-app-border">
                    <th className="text-left py-2 pr-2 w-8">#</th>
                    <th className="text-left py-2 pr-3">Category</th>
                    <th className="text-left py-2 pr-3">Type</th>
                    <th className="text-right py-2 pr-3">Amount</th>
                    <th className="text-right py-2 pr-3">% of revenue</th>
                    <th className="text-right py-2 pr-3">vs prior</th>
                    <th className="text-right py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.topCategories.map((c) => (
                    <tr key={c.category} className="border-b border-app-border last:border-0">
                      <td className="py-2 pr-2 text-text-muted tabular-nums">{c.rank}</td>
                      <td className="py-2 pr-3 text-text-primary">{c.label}</td>
                      <td className="py-2 pr-3">
                        <span className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                          c.behavior === "FIXED" ? "bg-charcoal text-white" : "bg-orange-accent/25 text-orange-accent"
                        }`}>
                          {c.behavior}
                        </span>
                        {c.overridden && <span className="ml-1 text-[10px] text-text-muted">(overridden)</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums font-semibold text-text-primary">{moneyExact(c.amount)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-text-muted">{c.percentOfRevenue.toFixed(1)}%</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <DeltaBadge delta={c.deltaPercent} />
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setEditing(c)}
                          className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg min-h-[44px] md:min-h-0 inline-flex items-center gap-1"
                        >
                          <SlidersHorizontal size={12} /> Override
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile card list */}
            <ul className="md:hidden space-y-2">
              {data.topCategories.map((c) => (
                <li key={c.category} className="border border-app-border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{c.rank}. {c.label}</p>
                      <div className="flex items-center gap-1 mt-1">
                        <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                          c.behavior === "FIXED" ? "bg-charcoal text-white" : "bg-orange-accent/25 text-orange-accent"
                        }`}>{c.behavior}</span>
                        {c.overridden && <span className="text-[10px] text-text-muted">(overridden)</span>}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-text-primary tabular-nums">{moneyExact(c.amount)}</p>
                      <p className="text-[11px] text-text-muted">{c.percentOfRevenue.toFixed(1)}% of rev</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 gap-2">
                    <DeltaBadge delta={c.deltaPercent} />
                    <button
                      type="button"
                      onClick={() => setEditing(c)}
                      className="text-xs text-brand font-semibold h-9 min-h-[44px] flex items-center gap-1 px-2 rounded hover:bg-app-bg"
                    >
                      <SlidersHorizontal size={12} /> Override
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Top vendors + largest expenses */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TopVendorsCard rows={data.topVendors} />
        <LargestExpensesCard rows={data.largestExpenses} />
      </div>

      {/* Needs a look grid */}
      <NeedsALookGrid attention={data.attention} />

      {editing && (
        <ClassifyModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta == null) return <span className="text-xs text-text-muted">—</span>;
  const up = delta > 0.5;
  const down = delta < -0.5;
  const cls = up ? "text-red-700 bg-red-50" : down ? "text-green-700 bg-green-50" : "text-text-muted bg-app-bg";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 ${cls}`}>
      {up ? <TrendingUp size={11} strokeWidth={2.25} /> : down ? <TrendingDown size={11} strokeWidth={2.25} /> : null}
      {delta > 0 ? "+" : ""}{delta.toFixed(1)}%
    </span>
  );
}

function MetricCard({
  title, amount, monthlyAverage, percentOfRevenue, categories, accentClass,
}: {
  title: string; amount: number; monthlyAverage: number; percentOfRevenue: number; categories: string[]; accentClass: string;
}) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block w-2 h-2 rounded-sm ${accentClass}`} />
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">{title}</p>
      </div>
      <p className="text-2xl font-semibold text-text-primary tabular-nums">{moneyExact(amount)}</p>
      <p className="text-xs text-text-muted mt-1">
        {moneyExact(monthlyAverage)}/month · {percentOfRevenue.toFixed(1)}% of revenue
      </p>
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {categories.map((c) => (
            <span key={c} className="text-[11px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TopVendorsCard({ rows }: { rows: Vendor[] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Top vendors</p>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">No vendor data yet — add vendor names to your expenses.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.vendor} className="flex items-center justify-between text-sm min-h-[44px] md:min-h-0 py-1">
              <span className="text-text-primary truncate">{r.vendor}</span>
              <div className="text-right flex-shrink-0">
                <span className="text-sm font-semibold text-text-primary tabular-nums">{moneyExact(r.amount)}</span>
                <p className="text-[11px] text-text-muted">
                  {r.transactionCount} transaction{r.transactionCount === 1 ? "" : "s"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LargestExpensesCard({ rows }: { rows: LargeExp[] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Largest single expenses</p>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">No expenses in this range.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={r.href} className="flex items-start justify-between gap-2 border border-app-border rounded-lg px-3 py-2.5 hover:bg-app-bg min-h-[44px]">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary truncate">{r.description}</p>
                  <p className="text-[11px] text-text-muted">
                    {new Date(r.date + "T00:00:00").toLocaleDateString()} {r.vendor ? `· ${r.vendor}` : ""}
                  </p>
                </div>
                <span className="text-sm font-semibold text-text-primary tabular-nums flex-shrink-0">{moneyExact(r.amount)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NeedsALookGrid({ attention }: { attention: Response["attention"] }) {
  const tiles = [
    {
      key: "uncategorized",
      count: attention.uncategorized.count,
      label: "Uncategorized",
      detail: attention.uncategorized.count > 0 ? `${moneyExact(attention.uncategorized.amount)} total` : "All expenses categorized.",
      href: attention.uncategorized.href,
      severity: attention.uncategorized.count > 0 ? "warn" : "ok",
    },
    {
      key: "missingReceipts",
      count: attention.missingReceipts.count,
      label: "Missing receipts",
      detail: attention.missingReceipts.count > 0 ? `${moneyExact(attention.missingReceipts.amount)} total` : "Receipts on file.",
      href: attention.missingReceipts.href,
      severity: attention.missingReceipts.count > 0 ? "warn" : "ok",
    },
    {
      key: "unusualIncreases",
      count: attention.unusualIncreases.length,
      label: "Unusual increases",
      detail:
        attention.unusualIncreases.length > 0
          ? attention.unusualIncreases.map((u) => u.label).join(", ")
          : "No unusual spikes.",
      href: "/dashboard/financials?tab=out",
      severity: attention.unusualIncreases.length > 0 ? "warn" : "ok",
    },
    {
      key: "recurringSubscriptions",
      count: attention.recurringSubscriptions.count,
      label: "Recurring subscriptions",
      detail:
        attention.recurringSubscriptions.count > 0
          ? `${moneyExact(attention.recurringSubscriptions.monthlyAmount)}/month`
          : "No recurring expenses flagged.",
      href: attention.recurringSubscriptions.href,
      severity: "info",
    },
    {
      key: "possibleDuplicates",
      count: attention.possibleDuplicates.length,
      label: "Possible duplicates",
      detail:
        attention.possibleDuplicates.length > 0
          ? attention.possibleDuplicates.map((d) => d.vendor).slice(0, 2).join(", ") + (attention.possibleDuplicates.length > 2 ? ", …" : "")
          : "No obvious dupes.",
      href: "/dashboard/financials?tab=out",
      severity: attention.possibleDuplicates.length > 0 ? "warn" : "ok",
    },
    {
      key: "awaitingReview",
      count: attention.awaitingReview.count,
      label: "Bank rows awaiting review",
      detail: attention.awaitingReview.count > 0 ? "Categorize in Financials → Bank" : "All caught up.",
      href: attention.awaitingReview.href,
      severity: attention.awaitingReview.count > 0 ? "warn" : "ok",
    },
  ];
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Needs a look</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className="border border-app-border rounded-lg p-3 hover:bg-app-bg block min-h-[44px]"
          >
            <div className="flex items-center gap-2 mb-1">
              {t.severity === "warn" ? (
                <AlertTriangle size={14} className="text-orange-accent flex-shrink-0" strokeWidth={2.25} />
              ) : t.severity === "info" ? (
                <Info size={14} className="text-text-muted flex-shrink-0" strokeWidth={2.25} />
              ) : null}
              <p className="text-lg font-semibold text-text-primary tabular-nums">{t.count}</p>
            </div>
            <p className="text-xs font-medium text-text-primary">{t.label}</p>
            <p className="text-[11px] text-text-muted truncate">{t.detail}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function ClassifyModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: TopCat;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [treatAs, setTreatAs] = useState<"FIXED" | "VARIABLE">(initial.behavior);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setErr(null);
    const res = await fetch("/api/reports/costs/classification", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: initial.category, treatAs }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setErr(typeof d.error === "string" ? d.error : "Could not save");
      setSaving(false);
      return;
    }
    onSaved();
  }
  async function reset() {
    setSaving(true);
    await fetch(`/api/reports/costs/classification?category=${encodeURIComponent(initial.category)}`, { method: "DELETE" });
    onSaved();
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div
        className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">Override classification</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none w-9 h-9 min-w-[44px] min-h-[44px] flex items-center justify-center">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Category</p>
            <p className="text-sm font-medium text-text-primary">{initial.label}</p>
            <p className="text-[11px] text-text-muted mt-1">
              This overrides the default classification for every expense in this category that doesn&apos;t set its own kind.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setTreatAs("FIXED")}
              className={`h-12 min-h-[44px] rounded-lg border text-sm font-semibold ${
                treatAs === "FIXED" ? "bg-charcoal text-white border-charcoal" : "border-app-border text-text-primary hover:bg-app-bg"
              }`}
            >
              Fixed
            </button>
            <button
              type="button"
              onClick={() => setTreatAs("VARIABLE")}
              className={`h-12 min-h-[44px] rounded-lg border text-sm font-semibold ${
                treatAs === "VARIABLE" ? "bg-orange-accent text-white border-orange-accent" : "border-app-border text-text-primary hover:bg-app-bg"
              }`}
            >
              Variable
            </button>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-11 min-h-[44px] px-4 border border-app-border rounded-lg text-sm text-text-primary hover:bg-app-bg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="flex-1 h-11 min-h-[44px] px-4 bg-brand text-white rounded-lg text-sm font-semibold hover:bg-brand-hover disabled:opacity-50 inline-flex items-center justify-center gap-1"
            >
              {saving ? "Saving…" : <>Save <ChevronRight size={14} /></>}
            </button>
          </div>
          {initial.overridden && (
            <button
              type="button"
              onClick={reset}
              disabled={saving}
              className="w-full text-xs text-text-muted hover:text-text-primary underline pt-2"
            >
              Remove override and use the default
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
