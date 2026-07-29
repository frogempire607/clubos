"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCircle2, ChevronRight, Info, Sliders, X } from "lucide-react";
import { SkeletonCard } from "@/components/LoadingSkeleton";

type Alert = {
  kind: string;
  severity: "high" | "medium" | "low";
  state: "TRIGGERED" | "OK";
  title: string;
  detail: string;
  href: string;
  threshold: number | null;
  currentValue: number | null;
  unit: string;
};
type Setting = { kind: string; threshold: number | null; enabled: boolean };
type Response = { alerts: Alert[]; settings: Setting[]; generatedAt: string };

const KIND_LABELS: Record<string, string> = {
  RUNWAY_BELOW: "Runway below",
  EXPENSES_EXCEED_REVENUE: "Expenses exceed revenue",
  CHURN_SPIKE: "Churn spike",
  UNCATEGORIZED_COUNT: "Uncategorized bank rows",
  BANK_SYNC_STALE: "Bank sync stale",
  REFUND_RATE: "Refund rate",
  RECURRING_REVENUE_DECLINE: "Recurring revenue decline",
  PAYROLL_ABOVE_AVERAGE: "Payroll above average",
  UPCOMING_RENEWAL_LARGE: "Large upcoming renewal",
  UNCATEGORIZED_LARGE_BANK: "Uncategorized bank row size",
};
const KIND_UNITS: Record<string, string> = {
  RUNWAY_BELOW: "months",
  CHURN_SPIKE: "%",
  UNCATEGORIZED_COUNT: "rows",
  BANK_SYNC_STALE: "hours",
  REFUND_RATE: "%",
  RECURRING_REVENUE_DECLINE: "%",
  PAYROLL_ABOVE_AVERAGE: "%",
  UPCOMING_RENEWAL_LARGE: "$",
  UNCATEGORIZED_LARGE_BANK: "$",
  EXPENSES_EXCEED_REVENUE: "",
};

export default function AlertsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"alerts" | "settings">("alerts");
  const [dirty, setDirty] = useState<Setting[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/reports/alerts");
    if (res.ok) {
      const d = await res.json();
      setData(d);
      setDirty(d.settings);
    }
    setLoading(false);
  }
  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const triggered = data?.alerts.filter((a) => a.state === "TRIGGERED") ?? [];
  const ok = data?.alerts.filter((a) => a.state === "OK") ?? [];

  function updateSetting(kind: string, patch: Partial<Setting>) {
    if (!dirty) return;
    setDirty(dirty.map((s) => (s.kind === kind ? { ...s, ...patch } : s)));
    setMsg(null);
  }

  async function save() {
    if (!dirty) return;
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/reports/alerts/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: dirty }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setMsg(typeof d.error === "string" ? d.error : "Could not save");
      return;
    }
    setMsg("Saved.");
    load();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-stretch justify-end p-0 sm:p-0">
      <div
        className="bg-surface w-full sm:max-w-md h-[92vh] sm:h-full rounded-t-2xl sm:rounded-none flex flex-col overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-app-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell size={18} className="text-brand" strokeWidth={2} />
            <h2 className="text-lg font-semibold text-text-primary">Alerts</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-text-muted hover:bg-app-bg">
            <X size={20} />
          </button>
        </div>

        <div className="flex gap-1 bg-app-bg m-3 rounded-lg p-1">
          <button
            onClick={() => setTab("alerts")}
            className={`flex-1 min-h-[44px] rounded text-sm font-semibold ${
              tab === "alerts" ? "bg-surface shadow-sm text-text-primary" : "text-text-muted"
            }`}
          >
            Status {triggered.length > 0 && <span className="ml-1 text-orange-accent">({triggered.length})</span>}
          </button>
          <button
            onClick={() => setTab("settings")}
            className={`flex-1 min-h-[44px] rounded text-sm font-semibold ${
              tab === "settings" ? "bg-surface shadow-sm text-text-primary" : "text-text-muted"
            } inline-flex items-center justify-center gap-1`}
          >
            <Sliders size={13} /> Thresholds
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-6">
          {loading || !data ? (
            <div className="space-y-3">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : tab === "alerts" ? (
            <>
              {triggered.length === 0 ? (
                <div className="bg-lime-accent/15 border border-lime-accent/40 rounded-xl p-5 flex items-start gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-lime-accent/40 flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 size={20} className="text-charcoal" strokeWidth={2.25} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">All alerts OK</p>
                    <p className="text-xs text-text-muted mt-0.5">No thresholds breached right now.</p>
                  </div>
                </div>
              ) : (
                <div className="mb-4">
                  <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-2">Triggered</p>
                  <ul className="space-y-2">
                    {triggered.map((a) => (
                      <AlertRow key={a.kind} alert={a} />
                    ))}
                  </ul>
                </div>
              )}
              {ok.length > 0 && (
                <div>
                  <p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-2">Healthy</p>
                  <ul className="space-y-2">
                    {ok.map((a) => (
                      <AlertRow key={a.kind} alert={a} />
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted mb-3">
                Turn alerts on or off and adjust thresholds. Owner-only.
              </p>
              <ul className="space-y-3">
                {(dirty ?? []).map((s) => {
                  const label = KIND_LABELS[s.kind] ?? s.kind;
                  const unit = KIND_UNITS[s.kind] ?? "";
                  return (
                    <li key={s.kind} className="border border-app-border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-text-primary">{label}</p>
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onChange={(e) => updateSetting(s.kind, { enabled: e.target.checked })}
                            className="w-5 h-5"
                          />
                          <span className="text-xs text-text-muted">
                            {s.enabled ? "Enabled" : "Off"}
                          </span>
                        </label>
                      </div>
                      {s.enabled && (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            value={s.threshold ?? ""}
                            onChange={(e) => updateSetting(s.kind, { threshold: e.target.value === "" ? null : Number(e.target.value) })}
                            className="w-32 h-11 min-h-[44px] px-3 border border-app-border rounded-lg text-sm text-text-primary tabular-nums"
                            step={unit === "%" || unit === "months" ? "0.1" : "1"}
                          />
                          <span className="text-xs text-text-muted">{unit}</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4 flex items-center justify-between gap-2">
                {msg && <p className="text-xs text-text-muted">{msg}</p>}
                <button
                  onClick={save}
                  disabled={saving}
                  className="ml-auto h-11 min-h-[44px] px-4 rounded-lg bg-brand text-white text-sm font-semibold hover:bg-brand-hover disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save thresholds"}
                </button>
              </div>
              <div className="mt-3 flex items-start gap-2 text-[11px] text-text-muted">
                <Info size={12} className="flex-shrink-0 mt-0.5" />
                <p>These thresholds also drive the Action Items feed on Snapshot.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const triggered = alert.state === "TRIGGERED";
  const badgeCls = triggered
    ? alert.severity === "high"
      ? "bg-red-50 border-red-300 text-red-700"
      : alert.severity === "medium"
        ? "bg-orange-accent/10 border-orange-accent/40 text-orange-accent"
        : "bg-app-bg border-app-border text-text-muted"
    : "bg-lime-accent/10 border-lime-accent/40 text-lime-800";
  const Icon = triggered ? AlertTriangle : CheckCircle2;
  return (
    <li>
      <Link
        href={alert.href}
        className={`block border ${badgeCls} rounded-lg p-3 min-h-[44px]`}
      >
        <div className="flex items-start gap-2">
          <Icon size={14} strokeWidth={2.25} className="flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">{alert.title}</p>
            <p className="text-xs text-text-muted mt-0.5">{alert.detail}</p>
          </div>
          <ChevronRight size={14} strokeWidth={2} className="flex-shrink-0 text-text-muted mt-0.5" />
        </div>
      </Link>
    </li>
  );
}
