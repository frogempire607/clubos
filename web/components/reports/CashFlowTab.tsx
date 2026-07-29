"use client";

import { useEffect, useState } from "react";
import { Info, AlertCircle } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type Response = {
  range: { label: string };
  beginningCash: number | null;
  cashReceived: number;
  cashSpent: number;
  netMovement: number;
  endingCash: number | null;
  operating: { inflows: number; outflows: number };
  investing: Array<{ label: string; amount: number }>;
  financing: Array<{ label: string; amount: number; kind: string }>;
  excluded: {
    accountTransfers: { count: number; amount: number };
    matchedStripePayouts: { count: number; amount: number };
  };
  forecast: {
    expectedMembershipRevenue: number; expectedRecurringRevenue: number;
    upcomingPayroll: number; upcomingRecurringExpenses: number;
    expectedStripePayouts: number; projectedMonthEndCash: number | null;
    estimatedRunwayMonths: number | null; breakEvenProgress: number | null;
    isEstimate: true; basis: string;
  } | null;
  reliability: string;
  reliabilityNotes: string[];
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const moneyExact = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CashFlowTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/cash-flow?${params}`)
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
      {/* Waterfall */}
      <div className="bg-surface border border-app-border rounded-xl p-5">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-4">
          Cash flow — {data.range.label}
        </p>
        <Waterfall
          beginningCash={data.beginningCash}
          cashReceived={data.cashReceived}
          cashSpent={data.cashSpent}
          netMovement={data.netMovement}
          endingCash={data.endingCash}
        />
      </div>

      {/* Grouped table */}
      <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border">
          <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Where the cash went</p>
        </div>
        <GroupedTable data={data} />
      </div>

      {/* Forecast + alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {data.forecast ? (
          <ForecastCard forecast={data.forecast} />
        ) : (
          <div className="bg-surface border border-app-border rounded-xl p-5">
            <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-2">Forecast</p>
            <p className="text-sm text-text-muted">
              Forecast requires at least 3 complete months of bank history. Connect a bank and sync a few weeks to unlock this section.
            </p>
          </div>
        )}
        <AlertsCard notes={data.reliabilityNotes} />
      </div>
    </div>
  );
}

function Waterfall({
  beginningCash,
  cashReceived,
  cashSpent,
  netMovement,
  endingCash,
}: {
  beginningCash: number | null;
  cashReceived: number;
  cashSpent: number;
  netMovement: number;
  endingCash: number | null;
}) {
  // Height scale — cash bars sized proportionally with a floor for
  // readability. All bars ≥ 32px so labels have room.
  const maxVal = Math.max(1, cashReceived, cashSpent, Math.abs(beginningCash ?? 0), Math.abs(endingCash ?? 0));
  const h = (v: number) => Math.max(32, Math.round((v / maxVal) * 160));
  const items: Array<{ label: string; value: number | null; bg: string; text: string }> = [
    { label: "Beginning", value: beginningCash, bg: "bg-brand/25", text: "text-text-primary" },
    { label: "Received", value: cashReceived, bg: "bg-lime-accent", text: "text-charcoal" },
    { label: "Spent", value: -Math.abs(cashSpent), bg: "bg-red-200", text: "text-red-800" },
    { label: "Net", value: netMovement, bg: netMovement >= 0 ? "bg-lime-accent/50" : "bg-red-200", text: "text-charcoal" },
    { label: "Ending", value: endingCash, bg: "bg-charcoal", text: "text-white" },
  ];
  return (
    <div className="overflow-x-auto">
      <div className="flex items-end justify-around gap-3 min-w-[480px] py-2">
        {items.map((it) => (
          <div key={it.label} className="flex-1 flex flex-col items-center gap-1.5 min-w-[70px]">
            {it.value == null ? (
              <div className="w-full h-8 border-dashed border-2 border-app-border rounded flex items-center justify-center text-[10px] text-text-muted">
                needs bank
              </div>
            ) : (
              <div
                className={`w-full rounded ${it.bg} flex items-center justify-center px-1`}
                style={{ height: `${h(Math.abs(it.value))}px` }}
              >
                <span className={`text-xs font-semibold ${it.text} tabular-nums text-center`}>
                  {it.value < 0 ? `−${money(Math.abs(it.value))}` : money(it.value)}
                </span>
              </div>
            )}
            <span className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">{it.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupedTable({ data }: { data: Response }) {
  return (
    <div className="divide-y divide-app-border">
      <GroupRow
        title="Operating"
        rows={[
          { label: "Inflows", amount: data.operating.inflows },
          { label: "Outflows", amount: -Math.abs(data.operating.outflows) },
        ]}
      />
      {data.investing.length > 0 && <GroupRow title="Investing" rows={data.investing.map((i) => ({ label: i.label, amount: -Math.abs(i.amount) }))} />}
      {data.financing.length > 0 && (
        <GroupRow
          title="Financing"
          rows={data.financing.map((i) => ({
            label: `${i.label} · ${prettyKind(i.kind)}`,
            amount: i.kind === "LOAN_PROCEEDS" || i.kind === "OWNER_CONTRIBUTION" ? Math.abs(i.amount) : -Math.abs(i.amount),
          }))}
        />
      )}
      <GroupRow
        title="Excluded from profit & loss"
        muted
        rows={[
          {
            label: `Account transfers · ${data.excluded.accountTransfers.count} pair${data.excluded.accountTransfers.count === 1 ? "" : "s"}`,
            amount: data.excluded.accountTransfers.amount,
          },
          {
            label: `Matched Stripe payouts · ${data.excluded.matchedStripePayouts.count}`,
            amount: data.excluded.matchedStripePayouts.amount,
          },
        ]}
      />
    </div>
  );
}

function prettyKind(kind: string): string {
  switch (kind) {
    case "LOAN_PROCEEDS": return "loan proceeds";
    case "LOAN_PAYMENT": return "loan payment";
    case "OWNER_CONTRIBUTION": return "owner contribution";
    case "OWNER_DISTRIBUTION": return "owner distribution";
    default: return kind.toLowerCase().replace(/_/g, " ");
  }
}

function GroupRow({ title, rows, muted }: { title: string; rows: Array<{ label: string; amount: number }>; muted?: boolean }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div className={`p-4 ${muted ? "bg-app-bg" : ""}`}>
      <div className="flex items-baseline justify-between mb-2">
        <p className={`text-xs uppercase tracking-wide font-semibold ${muted ? "text-text-muted" : "text-text-primary"}`}>{title}</p>
        <span className={`text-sm font-semibold tabular-nums ${total < 0 ? "text-red-700" : muted ? "text-text-muted" : "text-text-primary"}`}>
          {total < 0 ? `(${moneyExact(Math.abs(total))})` : moneyExact(total)}
        </span>
      </div>
      <ul className="space-y-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between text-xs">
            <span className={muted ? "text-text-muted" : "text-text-primary"}>{r.label}</span>
            <span className={`tabular-nums font-medium ${r.amount < 0 ? "text-red-700" : muted ? "text-text-muted" : "text-text-primary"}`}>
              {r.amount < 0 ? `(${moneyExact(Math.abs(r.amount))})` : moneyExact(r.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ForecastCard({ forecast }: { forecast: NonNullable<Response["forecast"]> }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs text-text-muted uppercase tracking-wide font-semibold">Forecast</p>
        <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-app-bg text-text-muted">Estimated</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <MetricTile label="Expected recurring rev" value={money(forecast.expectedRecurringRevenue)} />
        <MetricTile label="Upcoming payroll" value={money(forecast.upcomingPayroll)} />
        <MetricTile label="Upcoming recurring exp" value={money(forecast.upcomingRecurringExpenses)} />
        <MetricTile
          label="Projected month-end cash"
          value={forecast.projectedMonthEndCash == null ? "—" : money(forecast.projectedMonthEndCash)}
        />
      </div>
      <p className="text-[11px] text-text-muted mt-3">{forecast.basis}</p>
    </div>
  );
}

function AlertsCard({ notes }: { notes: string[] }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-3">Notes</p>
      {notes.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing to flag.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-text-primary">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted mt-1.5 flex-shrink-0" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">{label}</p>
      <p className="text-lg font-semibold text-text-primary tabular-nums">{value}</p>
    </div>
  );
}
