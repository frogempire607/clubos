"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonCard } from "@/components/LoadingSkeleton";

type Range = "month" | "last_month" | "last_30" | "last_90" | "ytd" | "year" | "all";

type ReportData = {
  range: { key: Range; label: string; start: string | null; end: string };
  revenue: {
    current: number;
    previous: number;
    deltaPercent: number | null;
    byType: Record<string, number>;
    platformFees: number;
  };
  members: {
    total: number;
    newInRange: number;
    byStatus: Record<string, number>;
    minors: number;
  };
  subscriptions: { active: number; pastDue: number; pending: number };
  attendance: { total: number; present: number; dropIn: number; trial: number; absent: number };
  expenses: { total: number; net: number; byCategory: Record<string, number> };
  topEvents: { id: string; name: string; type: string | null; bookings: number }[];
  revenueMonthly: { month: string; total: number }[];
};

const ranges: { key: Range; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_30", label: "Last 30 days" },
  { key: "last_90", label: "Last 90 days" },
  { key: "ytd", label: "YTD" },
  { key: "year", label: "Last 12 months" },
  { key: "all", label: "All time" },
];

const typeLabels: Record<string, string> = {
  CHARGE: "One-time charges",
  MEMBERSHIP: "Memberships",
  EVENT: "Events",
  CLASS: "Class drop-ins",
  PRODUCT: "Products",
  PRIVATE: "Private lessons",
  REFUND: "Refunds",
  OTHER: "Other",
};

function formatMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatMonthLabel(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export default function ReportsPage() {
  const [range, setRange] = useState<Range>("month");
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tierBlocked, setTierBlocked] = useState<{ message: string; upgradeTo: string | null } | null>(null);

  useEffect(() => {
    setLoading(true);
    setTierBlocked(null);
    fetch(`/api/reports/overview?range=${range}`)
      .then(async (r) => {
        if (r.status === 403) {
          const body = await r.json().catch(() => ({}));
          if (body.code === "UPGRADE_REQUIRED") {
            setTierBlocked({ message: body.error, upgradeTo: body.upgradeRequired });
          }
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [range]);

  const maxRevenue = useMemo(() => {
    if (!data) return 0;
    return Math.max(1, ...data.revenueMonthly.map((m) => m.total));
  }, [data]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <PageHeader
        title="Reports"
        description="Revenue, members, and attendance at a glance"
        actions={
          <div className="flex flex-wrap gap-1 bg-app-bg rounded-lg p-1">
            {ranges.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`text-xs px-3 py-1.5 rounded-md transition ${
                  range === r.key
                    ? "bg-surface shadow-sm text-text-primary font-medium"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {tierBlocked ? (
        <EmptyState
          icon="▦"
          title="Reports require a paid plan"
          description={tierBlocked.message}
          action={{
            label: `Upgrade to ${tierBlocked.upgradeTo ? tierBlocked.upgradeTo.charAt(0).toUpperCase() + tierBlocked.upgradeTo.slice(1) : "Growth"} →`,
            href: "/dashboard/settings/billing",
          }}
          className="bg-surface border border-app-border rounded-xl"
        />
      ) : loading || !data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Kpi
              label="Revenue"
              value={formatMoney(data.revenue.current)}
              hint={
                data.revenue.deltaPercent !== null
                  ? `${data.revenue.deltaPercent >= 0 ? "▲" : "▼"} ${Math.abs(data.revenue.deltaPercent).toFixed(0)}% vs previous`
                  : "No prior period"
              }
              hintColor={data.revenue.deltaPercent !== null && data.revenue.deltaPercent < 0 ? "text-red-600" : "text-green-700"}
            />
            <Kpi
              label="Net (after expenses)"
              value={formatMoney(data.expenses.net)}
              hint={`Expenses ${formatMoney(data.expenses.total)}`}
            />
            <Kpi
              label="New members"
              value={String(data.members.newInRange)}
              hint={`${data.members.total} total`}
            />
            <Kpi
              label="Attendance"
              value={String(data.attendance.total)}
              hint={`${data.attendance.dropIn} drop-ins`}
            />
          </div>

          {/* Revenue chart + breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <Card title="Revenue — last 12 months" className="lg:col-span-2">
              {data.revenueMonthly.length === 0 ? (
                <EmptyState icon="$" title="No revenue recorded yet." className="py-8" />
              ) : (
                <div className="flex items-end gap-2 h-40 mt-2">
                  {data.revenueMonthly.map((m) => {
                    const pct = (m.total / maxRevenue) * 100;
                    return (
                      <div key={m.month} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                        <div
                          className="w-full bg-brand rounded-t"
                          style={{ height: `${Math.max(pct, 2)}%` }}
                          title={formatMoney(m.total)}
                        />
                        <span className="text-[10px] text-text-muted truncate w-full text-center">
                          {formatMonthLabel(m.month)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Revenue by source">
              <BreakdownList
                rows={Object.entries(data.revenue.byType)
                  .map(([k, v]) => ({ label: typeLabels[k] || k, value: v }))
                  .sort((a, b) => b.value - a.value)}
                total={data.revenue.current}
                format={formatMoney}
              />
              {data.revenue.platformFees > 0 && (
                <p className="text-[11px] text-text-muted mt-3 pt-3 border-t border-app-border">
                  Platform fees collected: {formatMoney(data.revenue.platformFees)}
                </p>
              )}
            </Card>
          </div>

          {/* Members + Subscriptions + Attendance */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <Card title="Members">
              <BreakdownList
                rows={[
                  { label: "Active", value: data.members.byStatus.ACTIVE || 0 },
                  { label: "Prospect", value: data.members.byStatus.PROSPECT || 0 },
                  { label: "Paused", value: data.members.byStatus.PAUSED || 0 },
                  { label: "Inactive", value: data.members.byStatus.INACTIVE || 0 },
                ]}
                total={data.members.total}
              />
              {data.members.minors > 0 && (
                <p className="text-[11px] text-text-muted mt-3 pt-3 border-t border-app-border">
                  {data.members.minors} {data.members.minors === 1 ? "member is" : "members are"} minors
                </p>
              )}
            </Card>

            <Card title="Subscriptions">
              <BreakdownList
                rows={[
                  { label: "Active", value: data.subscriptions.active, accent: "green" },
                  { label: "Pending", value: data.subscriptions.pending },
                  { label: "Past due", value: data.subscriptions.pastDue, accent: "red" },
                ]}
                total={data.subscriptions.active + data.subscriptions.pastDue + data.subscriptions.pending}
              />
            </Card>

            <Card title="Attendance">
              <BreakdownList
                rows={[
                  { label: "Present", value: data.attendance.present, accent: "green" },
                  { label: "Drop-in", value: data.attendance.dropIn },
                  { label: "Trial", value: data.attendance.trial },
                  { label: "Absent", value: data.attendance.absent },
                ]}
                total={data.attendance.total}
              />
            </Card>
          </div>

          {/* Top events + Expenses */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <Card title="Top events by bookings">
              {data.topEvents.length === 0 ? (
                <p className="text-sm text-text-muted">No bookings in this range.</p>
              ) : (
                <ul className="space-y-2 mt-1">
                  {data.topEvents.map((e, i) => (
                    <li key={e.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-text-muted w-5">{i + 1}.</span>
                        <span className="text-text-primary truncate">{e.name}</span>
                        {e.type && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg text-text-muted flex-shrink-0">
                            {e.type}
                          </span>
                        )}
                      </div>
                      <span className="font-semibold text-text-primary flex-shrink-0">{e.bookings}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Expenses by category">
              {Object.keys(data.expenses.byCategory).length === 0 ? (
                <p className="text-sm text-text-muted">No expenses recorded in this range.</p>
              ) : (
                <BreakdownList
                  rows={Object.entries(data.expenses.byCategory)
                    .map(([k, v]) => ({ label: k, value: v }))
                    .sort((a, b) => b.value - a.value)}
                  total={data.expenses.total}
                  format={formatMoney}
                />
              )}
            </Card>
          </div>

          {/* Exports */}
          <div className="bg-surface border border-app-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-1">Export raw data</h3>
            <p className="text-xs text-text-muted mb-3">Download CSVs for accounting or further analysis.</p>
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/export/transactions"
                className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
              >
                Transactions CSV
              </a>
              <a
                href="/api/export/members"
                className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
              >
                Members CSV
              </a>
              <a
                href="/api/export/attendance"
                className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
              >
                Attendance CSV
              </a>
              <Link
                href="/dashboard/financials"
                className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
              >
                Full financials →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, hintColor }: { label: string; value: string; hint?: string; hintColor?: string }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className={`text-xs mt-1 ${hintColor || "text-text-muted"}`}>{hint}</p>}
    </div>
  );
}

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border border-app-border rounded-xl p-5 ${className}`}>
      <h3 className="text-sm font-semibold text-text-primary mb-3">{title}</h3>
      {children}
    </div>
  );
}

function BreakdownList({
  rows,
  total,
  format,
}: {
  rows: { label: string; value: number; accent?: "green" | "red" }[];
  total: number;
  format?: (n: number) => string;
}) {
  const fmt = format || ((n: number) => String(n));
  if (rows.every((r) => r.value === 0)) {
    return <p className="text-sm text-text-muted">No data yet.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const pct = total > 0 ? (r.value / total) * 100 : 0;
        const barColor =
          r.accent === "green" ? "bg-green-500" : r.accent === "red" ? "bg-red-500" : "bg-brand";
        return (
          <div key={r.label}>
            <div className="flex items-center justify-between text-xs mb-0.5">
              <span className="text-text-muted">{r.label}</span>
              <span className="font-medium text-text-primary">{fmt(r.value)}</span>
            </div>
            <div className="h-1.5 bg-app-bg rounded-full overflow-hidden">
              <div className={`h-full ${barColor} rounded-full`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
