"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type RangeKey = "last_30" | "last_90" | "month" | "ytd";

type Kpi = {
  key: string;
  label: string;
  value: number;
  format: "number" | "money";
  delta: number | null;
  helper: string;
};

type SourceMetric = {
  key: string;
  label: string;
  count: number;
  recurringRevenue: number;
  totalRevenue: number;
  conversionRate: number;
};

type StageMetric = {
  key: string;
  label: string;
  count: number;
  progressionRate: number;
};

type CampaignSummary = {
  id: string;
  name: string;
  type: string;
  status: string;
  startAt: string | null;
  endAt: string | null;
  attributedRevenue: number;
  attributedLeads: number;
};

type CampaignOverview = {
  range: { key: RangeKey; label: string; start: string; end: string };
  kpis: Kpi[];
  sources: SourceMetric[];
  stages: StageMetric[];
  campaigns: CampaignSummary[];
  notes: string[];
};

const ranges: Array<{ key: RangeKey; label: string }> = [
  { key: "last_30", label: "30 days" },
  { key: "last_90", label: "90 days" },
  { key: "month", label: "This month" },
  { key: "ytd", label: "YTD" },
];

const sourceColors = [
  "var(--color-primary)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-charcoal)",
  "var(--color-primary-dk)",
  "var(--color-primary)",
  "var(--color-success)",
  "var(--color-border)",
];

const statusLabels: Record<string, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
};

export default function CampaignsPage() {
  const [range, setRange] = useState<RangeKey>("last_30");
  const [data, setData] = useState<CampaignOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/campaigns/overview?range=${range}`);
        const payload = await res.json().catch(() => null);
        if (!res.ok) throw new Error(payload?.error || "Campaign analytics could not be loaded.");
        if (!ignore) setData(payload);
      } catch (err) {
        if (!ignore) setError(err instanceof Error ? err.message : "Campaign analytics could not be loaded.");
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    load();
    return () => {
      ignore = true;
    };
  }, [range]);

  const topSource = useMemo(() => {
    if (!data) return null;
    return [...data.sources].sort((a, b) => b.totalRevenue - a.totalRevenue || b.count - a.count)[0] || null;
  }, [data]);

  return (
    <div className="p-6 md:p-8 max-w-7xl">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6">
        <div>
          <p className="text-xs uppercase tracking-wide text-text-muted font-medium mb-1">Communication</p>
          <h1 className="text-3xl font-semibold text-text-primary">Campaigns</h1>
          <p className="text-sm text-text-muted mt-1 max-w-2xl">
            Track lead conversion, intro offers, win-backs, and revenue attribution for sports club marketing.
          </p>
        </div>
        <div className="flex gap-1 bg-app-bg rounded-lg p-1 w-fit">
          {ranges.map((item) => (
            <button
              key={item.key}
              onClick={() => setRange(item.key)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                range === item.key
                  ? "bg-surface shadow-sm text-text-primary font-medium"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="bg-surface border border-app-border rounded-xl p-8 text-center">
          <p className="text-sm font-medium text-text-primary mb-1">Campaigns could not be loaded</p>
          <p className="text-sm text-text-muted">{error}</p>
        </div>
      ) : loading || !data ? (
        <div className="text-center py-16 text-text-muted text-sm">Loading campaign analytics...</div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {data.kpis.map((kpi) => (
              <KpiCard key={kpi.key} kpi={kpi} />
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <SectionCard
              title="Leads by Source"
              subtitle={topSource ? `${topSource.label} is currently the strongest source.` : "Source attribution will improve as owners classify leads."}
            >
              <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
                <SourceDonut sources={data.sources} />
                <SourceTable sources={data.sources} />
              </div>
            </SectionCard>

            <SectionCard
              title="Revenue Attribution"
              subtitle="Revenue is read from existing transactions and linked attribution records."
            >
              <div className="space-y-4">
                <div className="rounded-lg bg-app-bg border border-app-border p-4">
                  <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Top source revenue</p>
                  <p className="text-2xl font-semibold text-text-primary">
                    {topSource ? formatMoney(topSource.totalRevenue) : "$0"}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    {topSource ? `${topSource.count} leads from ${topSource.label}` : "No source data yet"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {["Announcements", "Email", "SMS future", "Push future"].map((label) => (
                    <div key={label} className="rounded-lg border border-app-border p-3">
                      <p className="text-sm font-medium text-text-primary">{label}</p>
                      <p className="text-xs text-text-muted mt-1">
                        {label.includes("future") ? "Ready for later hooks" : "Can be linked to campaigns"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1fr_0.95fr]">
            <SectionCard title="Leads by Stage" subtitle="A lightweight funnel for new, warm, hot, won, and lost leads.">
              <Funnel stages={data.stages} />
            </SectionCard>

            <SectionCard title="Campaign Activity" subtitle="Draft, scheduled, and active campaigns will appear here as owners build them.">
              {data.campaigns.length === 0 ? (
                <div className="rounded-lg border border-dashed border-app-border p-8 text-center">
                  <p className="text-sm font-medium text-text-primary mb-1">No linked campaigns yet</p>
                  <p className="text-sm text-text-muted">
                    The data layer is ready for win-back, intro offer, referral, tournament, and membership campaigns.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.campaigns.map((campaign) => (
                    <div key={campaign.id} className="rounded-lg border border-app-border p-4 flex items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-text-primary">{campaign.name}</p>
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">
                            {statusLabels[campaign.status] || campaign.status}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted mt-1">{campaign.type}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-text-primary">{formatMoney(campaign.attributedRevenue)}</p>
                        <p className="text-xs text-text-muted">{campaign.attributedLeads} leads</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <div className="bg-surface border border-app-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Attribution Notes</h3>
            <div className="grid gap-3 md:grid-cols-3">
              {data.notes.map((note) => (
                <p key={note} className="text-xs text-text-muted bg-app-bg border border-app-border rounded-lg p-3">
                  {note}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const positive = kpi.delta !== null && kpi.delta >= 0;
  return (
    <div className="bg-surface border border-app-border rounded-xl p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide mb-1">{kpi.label}</p>
      <p className="text-2xl font-semibold text-text-primary">{formatValue(kpi.value, kpi.format)}</p>
      <div className="flex items-center gap-2 mt-2">
        <span
          className="text-xs font-semibold"
          style={{ color: kpi.delta === null ? "var(--color-muted)" : positive ? "var(--color-success)" : "var(--color-danger)" }}
        >
          {kpi.delta === null ? "Baseline" : `${positive ? "+" : ""}${kpi.delta}%`}
        </span>
        <span className="text-xs text-text-muted">vs previous period</span>
      </div>
      <p className="text-[11px] text-text-muted mt-2 leading-relaxed">{kpi.helper}</p>
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="bg-surface border border-app-border rounded-xl p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {subtitle && <p className="text-xs text-text-muted mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function SourceDonut({ sources }: { sources: SourceMetric[] }) {
  const total = sources.reduce((sum, source) => sum + source.count, 0);
  let cursor = 0;
  const stops = sources.map((source, index) => {
    const start = cursor;
    const size = total ? (source.count / total) * 100 : 0;
    cursor += size;
    return `${sourceColors[index % sourceColors.length]} ${start}% ${cursor}%`;
  });
  const background = total ? `conic-gradient(${stops.join(", ")})` : "var(--color-bg)";

  return (
    <div className="flex flex-col items-center justify-center">
      <div
        className="relative h-48 w-48 rounded-full border border-app-border"
        style={{ background }}
        aria-label="Lead source distribution"
      >
        <div className="absolute inset-10 rounded-full bg-surface border border-app-border flex flex-col items-center justify-center text-center">
          <p className="text-3xl font-semibold text-text-primary">{total}</p>
          <p className="text-xs text-text-muted">total leads</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 w-full">
        {sources.map((source, index) => (
          <div key={source.key} className="flex items-center gap-2 min-w-0">
            <span
              className="h-2.5 w-2.5 rounded-full flex-shrink-0"
              style={{ background: sourceColors[index % sourceColors.length] }}
            />
            <span className="text-xs text-text-muted truncate">{source.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceTable({ sources }: { sources: SourceMetric[] }) {
  return (
    <div className="overflow-x-auto border border-app-border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-app-bg border-b border-app-border">
          <tr>
            {["Source", "Leads", "Recurring", "Revenue", "Conversion"].map((header) => (
              <th key={header} className="text-left text-xs font-medium text-text-muted uppercase tracking-wide px-3 py-2">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.key} className="border-b border-app-border last:border-b-0">
              <td className="px-3 py-2 font-medium text-text-primary">{source.label}</td>
              <td className="px-3 py-2 text-text-muted">{source.count}</td>
              <td className="px-3 py-2 text-text-muted">{formatMoney(source.recurringRevenue)}</td>
              <td className="px-3 py-2 text-text-primary font-medium">{formatMoney(source.totalRevenue)}</td>
              <td className="px-3 py-2 text-text-muted">{source.conversionRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Funnel({ stages }: { stages: StageMetric[] }) {
  const max = Math.max(1, ...stages.map((stage) => stage.count));
  return (
    <div className="space-y-4">
      {stages.map((stage, index) => {
        const width = Math.max(8, Math.round((stage.count / max) * 100));
        return (
          <div key={stage.key} className="grid gap-2 md:grid-cols-[90px_1fr_120px] md:items-center">
            <div>
              <p className="text-sm font-medium text-text-primary">{stage.label}</p>
              <p className="text-xs text-text-muted">{stage.progressionRate}% progression</p>
            </div>
            <div className="h-10 rounded-lg bg-app-bg border border-app-border overflow-hidden">
              <div
                className="h-full rounded-lg flex items-center justify-end px-3 text-xs font-semibold text-white"
                style={{
                  width: `${width}%`,
                  background:
                    index === 0
                      ? "var(--color-primary)"
                      : index === 1
                        ? "var(--color-primary-dk)"
                        : index === 2
                          ? "var(--color-warning)"
                          : index === 3
                            ? "var(--color-success)"
                            : "var(--color-charcoal)",
                  color: index === 3 ? "var(--color-charcoal)" : "#fff",
                }}
              >
                {stage.count}
              </div>
            </div>
            <div className="text-sm text-text-muted md:text-right">
              {stage.count} lead{stage.count === 1 ? "" : "s"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatValue(value: number, format: "number" | "money") {
  return format === "money" ? formatMoney(value) : value.toLocaleString();
}

function formatMoney(value: number) {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
