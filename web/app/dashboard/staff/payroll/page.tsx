"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";

type BonusLine = {
  id: string;
  type: "ATTENDANCE" | "SIGNUP" | "REVENUE_SHARE";
  rate: number;
  basisLabel: string;
  basisCount: number;
  pay: number;
};

type Payout = {
  base: { type: "SALARY" | "PER_CLASS" | "HOURLY"; amount: number; detail: string; pay: number };
  bonuses: BonusLine[];
  classesCoached: number;
  hoursCoached: number;
  attendanceTotal: number;
  signupTotal: number;
  total: number;
};

type StaffPay = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  title: string | null;
  hasPlan: boolean;
  payout: Payout | null;
};

type PayrollResponse = {
  from: string;
  to: string;
  staff: StaffPay[];
  totals: { base: number; bonus: number; total: number };
};

function formatMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function toISODate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function presetRange(key: string): { from: string; to: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === "this_week") {
    const start = new Date(today);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { from: toISODate(start), to: toISODate(end) };
  }
  if (key === "last_week") {
    const start = new Date(today);
    start.setDate(start.getDate() - start.getDay() - 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { from: toISODate(start), to: toISODate(end) };
  }
  if (key === "this_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: toISODate(start), to: toISODate(end) };
  }
  if (key === "last_month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: toISODate(start), to: toISODate(end) };
  }
  const start = new Date(today);
  start.setDate(start.getDate() - 13);
  return { from: toISODate(start), to: toISODate(today) };
}

const BONUS_SHORT: Record<BonusLine["type"], string> = {
  ATTENDANCE: "Growth / retention",
  SIGNUP: "Signup next paycheck",
  REVENUE_SHARE: "Revenue share",
};

export default function StaffPayrollPage() {
  const [preset, setPreset] = useState("this_month");
  const [from, setFrom] = useState(() => presetRange("this_month").from);
  const [to, setTo] = useState(() => presetRange("this_month").to);
  const [data, setData] = useState<PayrollResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/staff/payroll?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [from, to]);

  function applyPreset(key: string) {
    setPreset(key);
    const r = presetRange(key);
    setFrom(r.from);
    setTo(r.to);
  }

  function downloadCsv() {
    if (!data) return;
    const headers = [
      "Staff", "Email", "Title", "Plan", "Base type", "Base pay",
      "Classes coached", "Hours coached", "Attendance total", "Signup total",
      "Bonus pay", "Total",
    ];
    const rows = data.staff.map((s) => {
      const p = s.payout;
      const bonusPay = p ? p.bonuses.reduce((a, b) => a + b.pay, 0) : 0;
      return [
        `${s.firstName} ${s.lastName}`,
        s.email,
        s.title ?? "",
        s.hasPlan ? "Yes" : "No plan",
        p?.base.type ?? "",
        p ? p.base.pay.toFixed(2) : "0.00",
        p ? String(p.classesCoached) : "0",
        p ? p.hoursCoached.toFixed(2) : "0",
        p ? String(p.attendanceTotal) : "0",
        p ? String(p.signupTotal) : "0",
        bonusPay.toFixed(2),
        p ? p.total.toFixed(2) : "0.00",
      ];
    });
    const csv = [headers, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `payroll-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Payroll &amp; Payouts</h1>
          <p className="text-sm text-text-muted mt-1">
            Calculated from each staff member&apos;s compensation plan (base + bonuses) over the selected period.
          </p>
        </div>
        <button
          onClick={downloadCsv}
          disabled={!data || data.staff.length === 0}
          className="text-sm px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>

      {/* Range selector */}
      <div className="bg-surface border border-app-border rounded-xl p-4 mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1 bg-app-bg rounded-lg p-1">
          {[
            { key: "this_week", label: "This week" },
            { key: "last_week", label: "Last week" },
            { key: "this_month", label: "This month" },
            { key: "last_month", label: "Last month" },
          ].map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={`text-xs px-3 py-1.5 rounded-md transition ${
                preset === p.key ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted hover:text-text-primary"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-0.5">From</label>
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreset("custom"); }}
              className="px-2 py-1 border border-app-border rounded text-sm bg-surface" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-0.5">To</label>
            <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreset("custom"); }}
              className="px-2 py-1 border border-app-border rounded text-sm bg-surface" />
          </div>
        </div>
      </div>

      {loading || !data ? (
        <p className="text-sm text-text-muted text-center py-16">Loading…</p>
      ) : data.staff.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-12 text-center">
          <p className="text-base font-medium text-text-primary mb-1">No staff yet</p>
          <p className="text-sm text-text-muted">Add staff first.</p>
        </div>
      ) : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Total label="Base pay" value={formatMoney(data.totals.base)} />
            <Total label="Bonus pay" value={formatMoney(data.totals.bonus)} />
            <Total label="Total payout" value={formatMoney(data.totals.total)} accent />
          </div>

          {/* Table */}
          <div className="bg-surface border border-app-border rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-app-bg border-b border-app-border">
                  <th className="text-left px-4 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Staff</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Base</th>
                  <th className="text-right px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Classes</th>
                  <th className="text-right px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Attendance</th>
                  <th className="text-right px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Signups</th>
                  <th className="text-right px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Base pay</th>
                  <th className="text-right px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Bonuses</th>
                  <th className="text-right px-3 py-2 font-medium text-text-muted uppercase tracking-wider text-[11px]">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.staff.map((s) => {
                  const p = s.payout;
                  const bonusPay = p ? p.bonuses.reduce((a, b) => a + b.pay, 0) : 0;
                  return (
                    <Fragment key={s.id}>
                      <tr className="border-b border-app-border last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-medium text-text-primary">{s.firstName} {s.lastName}</p>
                          <p className="text-xs text-text-muted">{s.title || (s.role === "OWNER" ? "Owner" : "Staff")}</p>
                        </td>
                        <td className="px-3 py-3">
                          {p ? (
                            <span className="text-xs text-text-primary">
                              {p.base.type === "SALARY" ? "Salary" : p.base.type === "PER_CLASS" ? "Per class" : "Hourly"}
                              <span className="text-text-muted"> · {p.base.detail}</span>
                            </span>
                          ) : (
                            <span className="text-xs text-text-muted">No plan set</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right text-text-primary">{p ? p.classesCoached : "—"}</td>
                        <td className="px-3 py-3 text-right text-text-primary">{p ? p.attendanceTotal : "—"}</td>
                        <td className="px-3 py-3 text-right text-text-primary">{p ? p.signupTotal : "—"}</td>
                        <td className="px-3 py-3 text-right text-text-primary">{p ? formatMoney(p.base.pay) : "—"}</td>
                        <td className="px-3 py-3 text-right text-text-primary">{p ? formatMoney(bonusPay) : "—"}</td>
                        <td className="px-3 py-3 text-right font-semibold text-text-primary">{p ? formatMoney(p.total) : formatMoney(0)}</td>
                        <td className="px-3 py-3 text-right">
                          {p && (p.bonuses.length > 0 || p.classesCoached > 0) && (
                            <button
                              onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                              className="text-xs text-brand hover:underline"
                            >
                              {expanded === s.id ? "Hide" : "Details"}
                            </button>
                          )}
                          {!s.hasPlan && (
                            <Link href="/dashboard/staff" className="text-xs text-brand hover:underline">Set up</Link>
                          )}
                        </td>
                      </tr>
                      {expanded === s.id && p && (
                        <tr className="bg-app-bg">
                          <td colSpan={9} className="px-4 py-3 space-y-3">
                            <div>
                              <p className="text-xs uppercase tracking-wider text-text-muted font-medium mb-1.5">Payout breakdown</p>
                              <ul className="text-xs space-y-1">
                                <li className="flex justify-between text-text-primary">
                                  <span>
                                    Base ·{" "}
                                    {p.base.type === "SALARY" ? "Salary" : p.base.type === "PER_CLASS" ? "Per class" : "Hourly"}
                                    <span className="text-text-muted"> ({p.base.detail})</span>
                                  </span>
                                  <span>{formatMoney(p.base.pay)}</span>
                                </li>
                                {p.bonuses.map((b) => (
                                  <li key={b.id} className="flex justify-between text-text-primary">
                                    <span>
                                      {BONUS_SHORT[b.type]}
                                      <span className="text-text-muted"> ({b.basisLabel})</span>
                                    </span>
                                    <span>{formatMoney(b.pay)}</span>
                                  </li>
                                ))}
                                <li className="flex justify-between font-semibold text-text-primary border-t border-app-border pt-1 mt-1">
                                  <span>Total</span>
                                  <span>{formatMoney(p.total)}</span>
                                </li>
                              </ul>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              <Mini label="Classes coached" value={String(p.classesCoached)} />
                              <Mini label="Hours coached" value={p.hoursCoached.toFixed(2)} />
                              <Mini label="Attendance total" value={String(p.attendanceTotal)} />
                              <Mini label="Signup total" value={String(p.signupTotal)} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-text-muted mt-3">
            Set or change a staff member&apos;s compensation plan from the{" "}
            <Link href="/dashboard/staff" className="underline">Staff directory</Link> → Edit.
          </p>
        </>
      )}
    </div>
  );
}

function Total({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-brand bg-brand/5" : "border-app-border bg-surface"}`}>
      <p className="text-xs uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className={`text-xl font-semibold ${accent ? "text-brand" : "text-text-primary"}`}>{value}</p>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-app-border rounded-lg p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="text-sm font-semibold text-text-primary">{value}</p>
    </div>
  );
}
