"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import ExportMenu from "@/components/ExportMenu";

type Transaction = {
  id: string;
  amount: number;
  platformFee: number | null;
  status: string;
  description: string | null;
  createdAt: string;
  member: { id: string; firstName: string; lastName: string } | null;
};

type TxData = {
  transactions: Transaction[];
  totals: { revenue: number; platformFees: number; net: number };
};

type Expense = {
  id: string;
  description: string;
  amount: string;
  category: string;
  date: string;
  isRecurring: boolean;
  notes: string | null;
  createdAt: string;
};

type BankAccount = {
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  balances: { available: number | null; current: number | null; iso_currency_code: string };
};

type BankTx = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number;
  category: string[] | null;
};

const EXPENSE_CATEGORIES = [
  "RENT", "UTILITIES", "INSURANCE", "SOFTWARE", "PAYROLL",
  "EQUIPMENT", "EVENTS", "MARKETING", "OTHER",
];

const categoryColors: Record<string, { bg: string; fg: string }> = {
  RENT: { bg: "var(--color-warning)", fg: "#fff" },
  UTILITIES: { bg: "var(--color-warning)", fg: "#fff" },
  INSURANCE: { bg: "var(--color-primary)", fg: "#fff" },
  SOFTWARE: { bg: "var(--color-primary)", fg: "#fff" },
  PAYROLL: { bg: "var(--color-success)", fg: "var(--color-text)" },
  EQUIPMENT: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  EVENTS: { bg: "var(--color-warning)", fg: "#fff" },
  MARKETING: { bg: "var(--color-warning)", fg: "#fff" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

const statusColors: Record<string, { bg: string; fg: string }> = {
  SUCCEEDED: { bg: "var(--color-success)", fg: "var(--color-text)" },
  PENDING: { bg: "var(--color-warning)", fg: "#fff" },
  FAILED: { bg: "#FCE4E0", fg: "#7B2415" },
  REFUNDED: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

export default function FinancialsPage() {
  const [tab, setTab] = useState<"overview" | "expenses" | "stripe" | "bank">("overview");

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Financials</h1>
          <p className="text-sm text-text-muted">Revenue, expenses, and your P&L at a glance.</p>
        </div>
        <ExportMenu baseUrl="/api/export/transactions" label="Export transactions" />
      </div>

      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-6 w-fit">
        {(["overview", "expenses", "stripe", "bank"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-1.5 rounded-md transition ${
              tab === t ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"
            }`}
          >
            {t === "overview" ? "P&L Overview" : t === "expenses" ? "Expenses" : t === "stripe" ? "Stripe Payments" : "Bank Account"}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "expenses" && <ExpensesTab />}
      {tab === "stripe" && <StripeTab />}
      {tab === "bank" && <BankTab />}
    </div>
  );
}

/* ─── P&L Overview ─── */

function OverviewTab() {
  const [txData, setTxData] = useState<TxData | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/transactions").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/expenses").then((r) => (r.ok ? r.json() : [])),
    ]).then(([tx, exp]) => {
      setTxData(tx);
      setExpenses(exp);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;

  const revenue = txData?.totals.net || 0;
  const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
  const profit = revenue - totalExpenses;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const byCategory = EXPENSE_CATEGORIES.map((cat) => {
    const total = expenses
      .filter((e) => e.category === cat)
      .reduce((sum, e) => sum + parseFloat(e.amount), 0);
    return { category: cat, total };
  }).filter((c) => c.total > 0).sort((a, b) => b.total - a.total);

  const monthlyRevenue: Record<string, number> = {};
  const monthlyExpenses: Record<string, number> = {};

  (txData?.transactions || []).filter((t) => t.status === "SUCCEEDED").forEach((t) => {
    const key = new Date(t.createdAt).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    monthlyRevenue[key] = (monthlyRevenue[key] || 0) + Number(t.amount);
  });
  expenses.forEach((e) => {
    const key = new Date(e.date).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    monthlyExpenses[key] = (monthlyExpenses[key] || 0) + parseFloat(e.amount);
  });

  const allMonths = Array.from(new Set([...Object.keys(monthlyRevenue), ...Object.keys(monthlyExpenses)])).slice(-6);

  return (
    <>
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Net revenue"
          value={`$${revenue.toFixed(2)}`}
          hint="Stripe payments minus fees"
          accent="green"
        />
        <StatCard
          label="Total expenses"
          value={`$${totalExpenses.toFixed(2)}`}
          hint="All tracked costs"
          accent="red"
        />
        <StatCard
          label="Net profit"
          value={`$${profit.toFixed(2)}`}
          hint="Revenue minus expenses"
          accent={profit >= 0 ? "green" : "red"}
        />
        <StatCard
          label="Profit margin"
          value={`${margin.toFixed(1)}%`}
          hint="Net profit / revenue"
          accent={margin >= 0 ? "green" : "red"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Monthly trend */}
        {allMonths.length > 0 && (
          <div className="bg-white rounded-xl border border-app-border p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Monthly trend</h3>
            <div className="space-y-3">
              {allMonths.map((month) => {
                const rev = monthlyRevenue[month] || 0;
                const exp = monthlyExpenses[month] || 0;
                const maxVal = Math.max(...allMonths.map((m) => Math.max(monthlyRevenue[m] || 0, monthlyExpenses[m] || 0)), 1);
                return (
                  <div key={month}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">{month}</span>
                      <span className={`text-xs font-medium ${rev - exp >= 0 ? "text-text-primary" : "text-red-700"}`}>
                        {rev - exp >= 0 ? "+" : ""}${(rev - exp).toFixed(0)}
                      </span>
                    </div>
                    <div className="flex gap-1 h-2">
                      <div
                        className="bg-lime-accent rounded-sm"
                        style={{ width: `${(rev / maxVal) * 100}%`, minWidth: rev > 0 ? 4 : 0 }}
                      />
                      <div
                        className="bg-red-300 rounded-sm"
                        style={{ width: `${(exp / maxVal) * 100}%`, minWidth: exp > 0 ? 4 : 0 }}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-4 mt-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-lime-accent" />
                  <span className="text-[10px] text-text-muted">Revenue</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-red-300" />
                  <span className="text-[10px] text-text-muted">Expenses</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Expense breakdown */}
        {byCategory.length > 0 && (
          <div className="bg-white rounded-xl border border-app-border p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Cost breakdown</h3>
            <div className="space-y-2">
              {byCategory.map(({ category, total }) => {
                const pct = totalExpenses > 0 ? (total / totalExpenses) * 100 : 0;
                const c = categoryColors[category] || categoryColors.OTHER;
                return (
                  <div key={category}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                          style={{ background: c.bg, color: c.fg }}
                        >
                          {category}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted">{pct.toFixed(0)}%</span>
                        <span className="text-xs font-medium text-text-primary">${total.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-app-bg rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: c.fg }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {allMonths.length === 0 && byCategory.length === 0 && (
          <div className="col-span-2 bg-white rounded-xl border border-app-border p-8 text-center">
            <p className="text-sm text-text-muted">Add expenses and collect payments to see your P&L here.</p>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Expenses ─── */

function ExpensesTab() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/expenses");
    if (res.ok) setExpenses(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this expense?")) return;
    await fetch(`/api/expenses/${id}`, { method: "DELETE" });
    load();
  }

  const total = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <p className="text-sm text-text-muted">
            {expenses.length} expense{expenses.length !== 1 ? "s" : ""} · total{" "}
            <span className="font-semibold text-text-primary">${total.toFixed(2)}</span>
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
        >
          + Add expense
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : expenses.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="text-4xl mb-2 text-text-muted">$</div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No expenses yet</h3>
          <p className="text-sm text-text-muted mb-4">Track rent, payroll, utilities, and other costs.</p>
          <button onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            Add first expense
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Category</Th>
                <Th>Recurring</Th>
                <Th>Amount</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => {
                const c = categoryColors[e.category] || categoryColors.OTHER;
                return (
                  <tr key={e.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <Td><span className="text-xs text-text-muted">{new Date(e.date).toLocaleDateString()}</span></Td>
                    <Td>
                      <div>
                        <span className="text-sm text-text-primary">{e.description}</span>
                        {e.notes && <p className="text-xs text-text-muted mt-0.5">{e.notes}</p>}
                      </div>
                    </Td>
                    <Td>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                        style={{ background: c.bg, color: c.fg }}
                      >
                        {e.category}
                      </span>
                    </Td>
                    <Td>
                      <span className={`text-xs ${e.isRecurring ? "text-text-muted" : "text-text-muted"}`}>
                        {e.isRecurring ? "Recurring" : "—"}
                      </span>
                    </Td>
                    <Td><span className="text-sm font-medium text-text-primary">${parseFloat(e.amount).toFixed(2)}</span></Td>
                    <Td>
                      <div className="flex gap-1">
                        <button onClick={() => setEditing(e)}
                          className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                          Edit
                        </button>
                        <button onClick={() => handleDelete(e.id)}
                          className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
                          Delete
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(showAdd || editing) && (
        <ExpenseModal
          expense={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}
    </>
  );
}

function ExpenseModal({
  expense,
  onClose,
  onSaved,
}: {
  expense: Expense | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!expense;
  const [description, setDescription] = useState(expense?.description || "");
  const [amount, setAmount] = useState(expense ? String(parseFloat(expense.amount)) : "");
  const [category, setCategory] = useState(expense?.category || "OTHER");
  const [date, setDate] = useState(expense ? expense.date.split("T")[0] : new Date().toISOString().split("T")[0]);
  const [isRecurring, setIsRecurring] = useState(expense?.isRecurring || false);
  const [notes, setNotes] = useState(expense?.notes || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const url = isEdit ? `/api/expenses/${expense!.id}` : "/api/expenses";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description,
        amount: parseFloat(amount),
        category,
        date,
        isRecurring,
        notes: notes || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit expense" : "Add expense"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} required
              placeholder="Monthly rent payment"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Amount ($)</label>
              <input type="number" min="0" step="0.01" value={amount}
                onChange={(e) => setAmount(e.target.value)} required placeholder="0.00"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes (optional)</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Invoice #, vendor, etc."
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)}
              className="w-4 h-4 accent-stone-900" />
            <span className="text-sm text-text-primary">Recurring expense (monthly)</span>
          </label>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add expense"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Stripe ─── */

function StripeTab() {
  const [data, setData] = useState<TxData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/transactions")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }, []);

  return (
    <>
      {!loading && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard label="Total revenue" value={`$${(data?.totals.revenue || 0).toFixed(2)}`} hint="All time, paid" />
          <StatCard label="Platform fees" value={`$${(data?.totals.platformFees || 0).toFixed(2)}`} hint="Paid to AthletixOS" />
          <StatCard label="Net revenue" value={`$${(data?.totals.net || 0).toFixed(2)}`} hint="What you keep" />
        </div>
      )}

      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border">
          <h2 className="text-sm font-semibold text-text-primary">Stripe transactions</h2>
        </div>

        {loading ? (
          <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
        ) : !data?.transactions.length ? (
          <div className="p-12 text-center">
            <div className="text-3xl mb-2 text-text-muted">$</div>
            <p className="text-sm text-text-muted">No transactions yet.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>Date</Th>
                <Th>Member</Th>
                <Th>Description</Th>
                <Th>Status</Th>
                <Th>Amount</Th>
                <Th>Fee</Th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => {
                const c = statusColors[t.status] || statusColors.PENDING;
                return (
                  <tr key={t.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <Td><span className="text-xs text-text-muted">{new Date(t.createdAt).toLocaleDateString()}</span></Td>
                    <Td>
                      {t.member ? (
                        <span className="text-sm text-text-primary">{t.member.firstName} {t.member.lastName}</span>
                      ) : (
                        <span className="text-sm text-text-muted">—</span>
                      )}
                    </Td>
                    <Td><span className="text-sm text-text-primary">{t.description || "Payment"}</span></Td>
                    <Td>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
                        {t.status.charAt(0) + t.status.slice(1).toLowerCase()}
                      </span>
                    </Td>
                    <Td><span className="text-sm font-medium text-text-primary">${Number(t.amount).toFixed(2)}</span></Td>
                    <Td><span className="text-xs text-text-muted">{t.platformFee ? `$${Number(t.platformFee).toFixed(2)}` : "—"}</span></Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ─── Bank ─── */

function BankTab() {
  const [bankData, setBankData] = useState<{
    connected: boolean;
    accounts: BankAccount[];
    transactions: BankTx[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [plaidConfigured, setPlaidConfigured] = useState(true);

  async function loadBankData() {
    const res = await fetch("/api/plaid/transactions");
    if (res.ok) {
      const data = await res.json();
      if (data.error === "Plaid not configured") {
        setPlaidConfigured(false);
      } else {
        setBankData(data);
      }
    }
    setLoading(false);
  }

  useEffect(() => { loadBankData(); }, []);

  async function startPlaidLink() {
    setConnecting(true);
    const res = await fetch("/api/plaid/link-token", { method: "POST" });
    const data = await res.json();
    setConnecting(false);
    if (data.error) {
      if (data.error === "Plaid not configured") setPlaidConfigured(false);
      return;
    }
    setLinkToken(data.linkToken);
  }

  const onSuccess = useCallback(async (publicToken: string) => {
    setLoading(true);
    await fetch("/api/plaid/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    setLinkToken(null);
    loadBankData();
  }, []);

  const { open: openPlaid, ready: plaidReady } = usePlaidLink({
    token: linkToken || "",
    onSuccess,
  });

  useEffect(() => {
    if (linkToken && plaidReady) openPlaid();
  }, [linkToken, plaidReady, openPlaid]);

  async function disconnect() {
    if (!confirm("Disconnect your bank account?")) return;
    await fetch("/api/plaid/transactions", { method: "DELETE" });
    setBankData(null);
    loadBankData();
  }

  if (loading) return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;

  if (!plaidConfigured) {
    return (
      <div className="bg-white rounded-xl border border-app-border p-8 text-center">
        <h3 className="text-base font-semibold text-text-primary mb-2">Plaid not configured</h3>
        <p className="text-sm text-text-muted mb-4 max-w-sm mx-auto">
          Add your Plaid credentials to <code className="bg-app-bg px-1 py-0.5 rounded">.env</code> to enable bank integration.
        </p>
        <div className="text-left bg-app-bg rounded-lg p-4 text-xs font-mono text-text-muted max-w-sm mx-auto">
          <p>PLAID_CLIENT_ID=your_client_id</p>
          <p>PLAID_SECRET=your_secret</p>
          <p>PLAID_ENV=sandbox</p>
        </div>
      </div>
    );
  }

  if (!bankData?.connected) {
    return (
      <div className="bg-white rounded-xl border border-app-border p-8 text-center">
        <h3 className="text-base font-semibold text-text-primary mb-2">Connect your bank account</h3>
        <p className="text-sm text-text-muted mb-6 max-w-sm mx-auto">
          Link your club's bank account to see balances and transactions alongside your Stripe revenue.
        </p>
        <button
          onClick={startPlaidLink}
          disabled={connecting}
          className="px-6 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {connecting ? "Opening…" : "Connect bank account"}
        </button>
        <p className="text-xs text-text-muted mt-3">Secured by Plaid · Read-only access</p>
      </div>
    );
  }

  const totalBalance = bankData.accounts.reduce((sum, a) => sum + (a.balances.current || 0), 0);

  return (
    <>
      <div className="grid grid-cols-3 gap-4 mb-6">
        {bankData.accounts.map((a) => (
          <div key={a.account_id} className="bg-white rounded-xl border border-app-border p-5">
            <div className="text-xs text-text-muted uppercase tracking-wider mb-1">{a.name}</div>
            <div className="text-2xl font-semibold text-text-primary mb-1">
              ${(a.balances.current || 0).toFixed(2)}
            </div>
            <div className="text-xs text-text-muted">
              {a.subtype} · {a.balances.iso_currency_code}
            </div>
          </div>
        ))}
        <div className="bg-brand rounded-xl p-5">
          <div className="text-xs text-text-muted uppercase tracking-wider mb-1">Total balance</div>
          <div className="text-2xl font-semibold text-white mb-1">${totalBalance.toFixed(2)}</div>
          <div className="text-xs text-text-muted">Across all accounts</div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Bank transactions (last 30 days)</h2>
          <button onClick={disconnect} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
            Disconnect
          </button>
        </div>
        {bankData.transactions.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-sm">No transactions in the last 30 days.</div>
        ) : (
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Category</Th>
                <Th>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {bankData.transactions.map((t) => (
                <tr key={t.transaction_id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <Td><span className="text-xs text-text-muted">{new Date(t.date).toLocaleDateString()}</span></Td>
                  <Td><span className="text-sm text-text-primary">{t.name}</span></Td>
                  <Td><span className="text-xs text-text-muted">{t.category?.[0] || "—"}</span></Td>
                  <Td>
                    <span className={`text-sm font-medium ${t.amount > 0 ? "text-red-700" : "text-text-primary"}`}>
                      {t.amount > 0 ? "-" : "+"}${Math.abs(t.amount).toFixed(2)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ─── Shared ─── */

function StatCard({ label, value, hint, accent }: { label: string; value: string; hint: string; accent?: string }) {
  const accentClass = accent === "green" ? "text-text-primary" : accent === "red" ? "text-red-700" : "text-text-primary";
  return (
    <div className="bg-white rounded-xl border border-app-border p-5">
      <div className="text-xs text-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-semibold mb-1 ${accentClass}`}>{value}</div>
      <div className="text-xs text-text-muted">{hint}</div>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-3">{children}</td>;
}
