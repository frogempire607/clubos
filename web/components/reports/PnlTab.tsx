"use client";

import { useEffect, useRef, useState } from "react";
import { ScrollTable, useBodyScrollLock } from "@/components/reports/responsive";
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
      <ScrollTable stickyFirst={false} className="hidden md:block bg-surface border border-app-border rounded-xl overflow-hidden">
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
      </ScrollTable>

      {/* Phones: one period at a time, label/value rows (2.5.12.4). */}
      <MobilePnl data={data} onDrill={(lineKey, lineLabel, columnKey, columnLabel) => setDrill({ lineKey, columnKey, lineLabel, columnLabel })} />

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

function MobilePnl({ data, onDrill }: { data: PnlResponse; onDrill: (lineKey: string, lineLabel: string, columnKey: string, columnLabel: string) => void }) {
  // Default to the latest column; the chip row picks another period. The
  // chosen chip scrolls into view so the latest month is visible on open.
  const last = Math.max(0, data.columns.length - 1);
  const [col, setCol] = useState(last);
  useEffect(() => { setCol(Math.max(0, data.columns.length - 1)); }, [data.columns.length]);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { chipRefs.current[col]?.scrollIntoView({ block: "nearest", inline: "center" }); }, [col]);
  const c = data.columns[col];
  if (!c) return <p className="md:hidden text-sm text-text-muted">No periods in this range.</p>;
  const sum = data.summary[col];
  return (
    <div className="md:hidden space-y-3">
      {data.columns.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }} role="tablist" aria-label="Period">
          {data.columns.map((cc, i) => (
            <button
              key={cc.key}
              ref={(el) => { chipRefs.current[i] = el; }}
              role="tab"
              aria-selected={i === col}
              onClick={() => setCol(i)}
              className={`shrink-0 px-3 min-h-[44px] rounded-full border text-sm whitespace-nowrap ${i === col ? "bg-charcoal text-white border-charcoal font-semibold" : "bg-surface border-app-border text-text-primary"}`}
            >
              {cc.label}{cc.isPartial && <span className="ml-0.5 text-orange-accent">*</span>}
            </button>
          ))}
        </div>
      )}
      {c.isPartial && <p className="text-[11px] text-orange-accent">* {c.label} is still in progress.</p>}
      {data.sections.map((section) => (
        <div key={section.key} className="bg-surface border border-app-border rounded-xl overflow-hidden">
          <div className="bg-app-bg px-3 py-2 text-[11px] uppercase tracking-wide font-semibold text-text-muted">{section.label}</div>
          <ul className="divide-y divide-app-border">
            {section.lines.map((line) => (
              <li key={line.key}>
                <button
                  onClick={() => onDrill(line.key, line.label, c.key, c.label)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2.5 min-h-[44px] text-left hover:bg-app-bg"
                >
                  <span className="text-sm text-text-primary min-w-0 break-words">{line.label}</span>
                  <span className={`text-sm font-semibold tabular-nums shrink-0 ${(line.values[col] ?? 0) < 0 ? "text-red-700" : "text-text-primary"}`}>{fmtMoney(line.values[col] ?? 0)}</span>
                </button>
              </li>
            ))}
            <li className="px-3 py-2.5 bg-app-bg flex items-center justify-between gap-3 text-sm font-semibold text-text-primary">
              <span className="min-w-0">{section.total.label}</span>
              <span className="tabular-nums shrink-0">{fmtMoney(section.total.values[col] ?? 0)}</span>
            </li>
          </ul>
        </div>
      ))}
      <div className="bg-lime-accent/15 border-2 border-charcoal rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 text-base font-bold text-text-primary">
          <span>Net profit · {c.label}</span>
          <span className={`tabular-nums shrink-0 ${(sum?.netProfit ?? 0) < 0 ? "text-red-700" : ""}`}>{fmtMoney(sum?.netProfit ?? 0)}</span>
        </div>
        <p className="text-xs text-text-muted mt-1">Margin {fmtPercent(sum?.profitMarginPercent ?? null)}</p>
        {data.rollingAverage && (data.rollingAverage.values[col] ?? 0) !== 0 && (
          <p className="text-xs text-text-muted mt-0.5 italic">{data.rollingAverage.label}: {fmtMoney(data.rollingAverage.values[col])}</p>
        )}
      </div>
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
  useBodyScrollLock(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={lineLabel}>
      {/* Phones: full-screen sheet (2.5.12.5); larger screens: centered panel. */}
      <div
        className="bg-surface w-full sm:max-w-2xl h-[100dvh] sm:h-auto sm:max-h-[90vh] rounded-none sm:rounded-xl flex flex-col overflow-hidden"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
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
