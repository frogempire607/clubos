"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Download, FileText, X } from "lucide-react";
import Link from "next/link";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import type { RangeKey } from "@/components/reports/RangeDropdown";

type Column = { key: string; label: string; start: string; end: string; isPartial: boolean };
type Line = { key: string; label: string; values: number[]; drillHref: string };
type Section = { key: "income" | "cost_of_sales" | "operating_expenses"; label: string; lines: Line[]; total: { label: string; values: number[] } };
type Summary = { grossIncome: number; grossProfit: number; grossMarginPercent: number | null; totalOperatingExpenses: number; operatingProfit: number; netProfit: number; profitMarginPercent: number | null };

type PnlResponse = {
  period: "monthly" | "weekly";
  basis: "cash" | "accrual";
  columns: Column[];
  sections: Section[];
  summary: Summary[];
  rollingAverage: { label: string; values: number[] } | null;
  accrualCoverage: { supported: boolean; unsupportedPurchaseCount: number } | null;
  warnings: Array<{ kind: string; message: string; href: string }>;
};

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const s = `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `(${s})` : s;
}
function fmtPercent(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export default function PnlTab({ range, customFrom, customTo }: { range: RangeKey; customFrom?: string; customTo?: string }) {
  const [period, setPeriod] = useState<"monthly" | "weekly">("monthly");
  const [basis, setBasis] = useState<"cash" | "accrual">("cash");
  const [data, setData] = useState<PnlResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{ lineKey: string; columnKey: string | null; lineLabel: string; columnLabel: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ range, period, basis });
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/pnl?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [range, period, basis, customFrom, customTo]);

  const exportParams = new URLSearchParams({ range, period, basis });
  if (range === "custom") {
    if (customFrom) exportParams.set("from", customFrom);
    if (customTo) exportParams.set("to", customTo);
  }

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2 flex-wrap">
          <Segmented value={period} onChange={setPeriod} options={[{ v: "monthly", label: "Monthly" }, { v: "weekly", label: "Weekly" }]} />
          <Segmented value={basis} onChange={setBasis} options={[{ v: "cash", label: "Cash basis" }, { v: "accrual", label: "Accrual" }]} />
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/reports/pnl/export?${new URLSearchParams({ ...Object.fromEntries(exportParams), format: "csv" })}`}
            className="h-10 min-h-[44px] sm:min-h-10 inline-flex items-center gap-1.5 px-3 border border-app-border rounded-lg bg-surface text-sm text-text-primary hover:bg-app-bg"
          >
            <Download size={14} strokeWidth={2} />
            CSV
          </a>
          <a
            href={`/api/reports/pnl/export?${new URLSearchParams({ ...Object.fromEntries(exportParams), format: "pdf" })}`}
            className="h-10 min-h-[44px] sm:min-h-10 inline-flex items-center gap-1.5 px-3 border border-app-border rounded-lg bg-surface text-sm text-text-primary hover:bg-app-bg"
          >
            <FileText size={14} strokeWidth={2} />
            PDF
          </a>
        </div>
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="space-y-2">
          {data.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 border border-orange-accent/40 bg-orange-accent/10 rounded-lg p-3">
              <AlertTriangle size={14} className="text-orange-accent flex-shrink-0 mt-0.5" strokeWidth={2.25} />
              <div className="text-xs text-text-primary">
                <p>{w.message}</p>
                {w.href && (
                  <Link href={w.href} className="text-brand hover:underline">
                    Fix →
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block bg-surface border border-app-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-text-muted uppercase tracking-wide font-semibold border-b border-app-border bg-app-bg">
              <th className="text-left py-2 pl-4 pr-3 sticky left-0 bg-app-bg z-10 min-w-[180px]">Line</th>
              {data.columns.map((c) => (
                <th key={c.key} className={`text-right py-2 pr-3 min-w-[100px] ${c.isPartial ? "text-orange-accent" : ""}`}>
                  {c.label}
                  {c.isPartial && <span title="Partial period">*</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.sections.map((section) => (
              <SectionRows
                key={section.key}
                section={section}
                columns={data.columns}
                onDrill={(lineKey, lineLabel, columnKey, columnLabel) =>
                  setDrill({ lineKey, columnKey, lineLabel, columnLabel })
                }
              />
            ))}
            {/* Net profit row */}
            <tr className="border-t-2 border-charcoal bg-lime-accent/10">
              <td className="py-3 pl-4 pr-3 sticky left-0 bg-lime-accent/10 z-10 font-bold text-text-primary">Net profit</td>
              {data.summary.map((s, i) => (
                <td key={i} className={`py-3 pr-3 text-right tabular-nums font-bold ${s.netProfit < 0 ? "text-red-700" : "text-text-primary"}`}>
                  {fmtMoney(s.netProfit)}
                </td>
              ))}
            </tr>
            <tr className="bg-app-bg">
              <td className="py-2 pl-4 pr-3 sticky left-0 bg-app-bg z-10 text-xs text-text-muted">Profit margin</td>
              {data.summary.map((s, i) => (
                <td key={i} className="py-2 pr-3 text-right tabular-nums text-xs text-text-muted">
                  {fmtPercent(s.profitMarginPercent)}
                </td>
              ))}
            </tr>
            {data.rollingAverage && (
              <tr>
                <td className="py-2 pl-4 pr-3 sticky left-0 bg-surface z-10 text-xs text-text-muted italic">{data.rollingAverage.label}</td>
                {data.rollingAverage.values.map((v, i) => (
                  <td key={i} className="py-2 pr-3 text-right tabular-nums text-xs text-text-muted">
                    {v !== 0 ? fmtMoney(v) : "—"}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked card layout */}
      <div className="md:hidden space-y-3">
        {data.sections.map((section) => (
          <div key={section.key} className="bg-surface border border-app-border rounded-xl overflow-hidden">
            <div className="bg-app-bg px-3 py-2 text-[11px] uppercase tracking-wide font-semibold text-text-muted">
              {section.label}
            </div>
            <ul className="divide-y divide-app-border">
              {section.lines.map((line) => (
                <li key={line.key} className="p-3">
                  <p className="text-sm text-text-primary mb-1">{line.label}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {data.columns.map((col, i) => (
                      <button
                        key={col.key}
                        onClick={() => setDrill({ lineKey: line.key, columnKey: col.key, lineLabel: line.label, columnLabel: col.label })}
                        className="text-left border border-app-border rounded p-2 hover:bg-app-bg min-h-[44px]"
                      >
                        <p className="text-[10px] text-text-muted">
                          {col.label}
                          {col.isPartial && <span className="ml-1 text-orange-accent">*</span>}
                        </p>
                        <p className="text-sm font-semibold text-text-primary tabular-nums">{fmtMoney(line.values[i] ?? 0)}</p>
                      </button>
                    ))}
                  </div>
                </li>
              ))}
              <li className="p-3 bg-app-bg font-semibold text-sm text-text-primary">
                <div className="flex items-center justify-between">
                  <span>{section.total.label}</span>
                  <span className="tabular-nums">{fmtMoney(section.total.values[data.columns.length - 1] ?? 0)}</span>
                </div>
                <p className="text-[10px] text-text-muted mt-1">Latest column shown; use desktop for the full grid.</p>
              </li>
            </ul>
          </div>
        ))}
        <div className="bg-lime-accent/15 border-2 border-charcoal rounded-xl p-4">
          <div className="flex items-center justify-between text-base font-bold text-text-primary">
            <span>Net profit</span>
            <span className="tabular-nums">{fmtMoney(data.summary[data.summary.length - 1]?.netProfit ?? 0)}</span>
          </div>
          <p className="text-xs text-text-muted mt-1">Margin {fmtPercent(data.summary[data.summary.length - 1]?.profitMarginPercent ?? null)}</p>
        </div>
      </div>

      {drill && (
        <DrillSheet
          lineKey={drill.lineKey}
          lineLabel={drill.lineLabel}
          columnKey={drill.columnKey}
          columnLabel={drill.columnLabel}
          period={period}
          range={range}
          customFrom={customFrom}
          customTo={customTo}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

function SectionRows({
  section,
  columns,
  onDrill,
}: {
  section: Section;
  columns: Column[];
  onDrill: (lineKey: string, lineLabel: string, columnKey: string, columnLabel: string) => void;
}) {
  return (
    <>
      <tr className="bg-app-bg">
        <td colSpan={columns.length + 1} className="py-2 pl-4 text-[11px] uppercase tracking-wide font-semibold text-text-muted">
          {section.label}
        </td>
      </tr>
      {section.lines.map((line) => (
        <tr key={line.key} className="border-b border-app-border hover:bg-app-bg/50">
          <td className="py-2 pl-4 pr-3 sticky left-0 bg-surface z-10 text-text-primary">{line.label}</td>
          {line.values.map((v, i) => (
            <td key={i} className="py-0 pr-0 text-right tabular-nums">
              <button
                onClick={() => onDrill(line.key, line.label, columns[i].key, columns[i].label)}
                className="w-full h-full py-2 pr-3 hover:bg-brand/10 text-text-primary tabular-nums text-right"
              >
                {v === 0 ? <span className="text-text-muted">—</span> : fmtMoney(v)}
              </button>
            </td>
          ))}
        </tr>
      ))}
      <tr className="border-b border-app-border bg-app-bg/50">
        <td className="py-2 pl-4 pr-3 sticky left-0 bg-app-bg/50 z-10 font-semibold text-text-primary">{section.total.label}</td>
        {section.total.values.map((v, i) => (
          <td key={i} className="py-2 pr-3 text-right tabular-nums font-semibold text-text-primary">
            {fmtMoney(v)}
          </td>
        ))}
      </tr>
    </>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; label: string }>;
}) {
  return (
    <div className="inline-flex bg-app-bg border border-app-border rounded-lg p-0.5">
      {options.map((opt) => (
        <button
          key={opt.v}
          onClick={() => onChange(opt.v)}
          className={`px-3 py-1.5 min-h-[44px] sm:min-h-8 rounded text-sm ${
            value === opt.v ? "bg-surface shadow-sm text-text-primary font-semibold" : "text-text-muted"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

type DrillResponse = {
  line: { key: string; label: string };
  total: number;
  transactions: Array<{ id: string; date: string; description: string; counterparty: string | null; amount: number; source: string; href: string }>;
};

function DrillSheet({
  lineKey,
  lineLabel,
  columnKey,
  columnLabel,
  period,
  range,
  customFrom,
  customTo,
  onClose,
}: {
  lineKey: string;
  lineLabel: string;
  columnKey: string | null;
  columnLabel: string;
  period: "monthly" | "weekly";
  range: RangeKey;
  customFrom?: string;
  customTo?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<DrillResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams({ line: lineKey, period, range });
    if (columnKey) params.set("column", columnKey);
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    fetch(`/api/reports/pnl/drill?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }, [lineKey, columnKey, period, range, customFrom, customTo]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="bg-surface w-full sm:max-w-2xl h-[92vh] sm:h-auto sm:max-h-[90vh] rounded-t-2xl sm:rounded-xl flex flex-col overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <div className="min-w-0">
            <p className="text-xs text-text-muted">{columnLabel}</p>
            <h2 className="text-lg font-semibold text-text-primary truncate">{lineLabel}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-muted hover:text-text-primary w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-app-bg"
          >
            <X size={20} strokeWidth={2} />
          </button>
        </div>
        {loading || !data ? (
          <div className="p-6 space-y-3">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : (
          <>
            <div className="px-4 sm:px-6 py-3 border-b border-app-border bg-app-bg">
              <p className="text-xs text-text-muted">Total</p>
              <p className="text-2xl font-semibold text-text-primary tabular-nums">{fmtMoney(data.total)}</p>
              <p className="text-xs text-text-muted mt-1">
                {data.transactions.length} transaction{data.transactions.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="overflow-y-auto flex-1">
              {data.transactions.length === 0 ? (
                <p className="p-6 text-sm text-text-muted">No transactions in this cell.</p>
              ) : (
                <ul className="divide-y divide-app-border">
                  {data.transactions.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={t.href}
                        className="flex items-start justify-between gap-2 p-4 hover:bg-app-bg min-h-[44px]"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-text-primary truncate">{t.description}</p>
                          <p className="text-[11px] text-text-muted">
                            {new Date(t.date + "T00:00:00").toLocaleDateString()}
                            {t.counterparty ? ` · ${t.counterparty}` : ""}
                            {" · "}{t.source}
                          </p>
                        </div>
                        <span className="text-sm font-semibold text-text-primary tabular-nums flex-shrink-0">{fmtMoney(t.amount)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
