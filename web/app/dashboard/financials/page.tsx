"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  REVENUE_CATEGORIES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  revenueCategoryLabel,
  expenseCategoryLabel,
  paymentMethodLabel,
  FINANCIAL_DISCLAIMER,
  TAX_SUMMARY_NOTE,
} from "@/lib/financials";
import { REPORT_TYPES, REPORT_LABELS, type ReportType } from "@/lib/financialReports";
import PageHeader from "@/components/PageHeader";
import { SkeletonList, SkeletonCard } from "@/components/LoadingSkeleton";

type Entity = { id: string; name: string; entityType: string };
type Money = {
  moneyIn: number; moneyOut: number; net: number; cashIn: number; cardIn: number;
  stripeFees: number; donationsTotal: number; contractorTotal: number;
};
type Summary = {
  entities: Entity[];
  money: Money;
  nonprofit: { donationsTotal: number; restrictedTotal: number; unrestrictedTotal: number; sponsorshipTotal: number };
  needsReview: { uncategorized: number; receiptsMissing: number; unpaidInvoices: { count: number; total: number } };
  revenueByCategory: { key: string; label: string; amount: number }[];
  expensesByCategory: { key: string; label: string; amount: number }[];
  topSources: { label: string; amount: number }[];
};
type Tx = {
  id: string; amount: string | number; platformFee: string | number | null; status: string;
  description: string | null; category: string | null; paymentMethod: string | null;
  manual: boolean; type: string; createdAt: string; txDate: string | null;
  member: { firstName: string; lastName: string } | null;
  legalEntity: { id: string; name: string } | null;
};
type Expense = {
  id: string; description: string; amount: string; category: string; date: string;
  isRecurring: boolean; notes: string | null; vendor: string | null;
  paymentMethod: string | null; legalEntityId: string | null; reimbursable: boolean;
  receiptUrl: string | null; legalEntity: { id: string; name: string } | null;
};
type Donation = {
  id: string; donorName: string; donorEmail: string | null; amount: string; fund: string | null;
  restricted: boolean; sponsorship: boolean; paymentMethod: string; date: string;
  receiptUrl: string | null; notes: string | null; legalEntityId: string | null;
  legalEntity: { id: string; name: string; entityType: string } | null;
};
type BankAccount = { account_id: string; name: string; type: string; subtype: string; balances: { available: number | null; current: number | null; iso_currency_code: string }; connectionId?: string; connectionLabel?: string };
type BankTx = { transaction_id: string; date: string; name: string; amount: number; category: string[] | null; connectionId?: string; connectionLabel?: string };
type BankConnection = { id: string; label: string | null; institutionName: string | null };

const DATE_PRESETS = [
  { key: "ytd", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "last_90", label: "Last 90 days" },
  { key: "all", label: "All time" },
];
function rangeFor(preset: string): { from: string; to: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (preset === "ytd") return { from: `${now.getFullYear()}-01-01`, to: iso(now) };
  if (preset === "last_year") return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
  if (preset === "last_90") return { from: iso(new Date(now.getTime() - 90 * 86400000)), to: iso(now) };
  return { from: "", to: "" };
}
const money = (n: number | string) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "in", label: "Money In" },
  { key: "out", label: "Money Out" },
  { key: "donations", label: "Donations" },
  { key: "tax", label: "Tax Summary" },
  { key: "stripe", label: "Stripe" },
  { key: "bank", label: "Bank" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function FinancialsPage() {
  const [tab, setTab] = useState<TabKey>("overview");
  const [entities, setEntities] = useState<Entity[]>([]);
  const [entity, setEntity] = useState("all");
  const [preset, setPreset] = useState("ytd");
  // Bank filter — shared across every Financials tab. Empty/"all" means
  // include transactions/expenses from every bank connection.
  const [bankConnections, setBankConnections] = useState<BankConnection[]>([]);
  const [bank, setBank] = useState("all");
  const { from, to } = rangeFor(preset);

  useEffect(() => {
    fetch("/api/club/legal-entities")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setEntities(Array.isArray(d) ? d : []));
    // Load Plaid connections so the bank dropdown can render labels. We
    // tolerate 403 (Plaid tier-gated off) and just show no dropdown.
    fetch("/api/plaid/connections")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.connections) setBankConnections(d.connections);
      })
      .catch(() => {});
  }, []);

  const qs = `entity=${entity}&from=${from}&to=${to}&bank=${bank}`;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      <PageHeader
        title="Financials"
        description="Track money in, money out, receipts, entities, and tax-ready summaries."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
          >
            <option value="all">All entities</option>
            {entities.map((en) => (
              <option key={en.id} value={en.id}>{en.name}{en.entityType === "NONPROFIT" ? " (Nonprofit)" : ""}</option>
            ))}
          </select>
          {/* Bank filter — only shown when 2+ Plaid connections exist.
              Scopes every Financials tab (Money In, Money Out, Donations,
              Tax) to a single bank account via ?bank=<connectionId>. */}
          {bankConnections.length > 1 && (
            <select
              value={bank}
              onChange={(e) => setBank(e.target.value)}
              className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
            >
              <option value="all">All bank accounts</option>
              {bankConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || c.institutionName || "Bank"}
                </option>
              ))}
            </select>
          )}
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
          >
            {DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          </div>
        }
      />

      <p className="text-[11px] text-text-muted mb-5">{FINANCIAL_DISCLAIMER}</p>

      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-6 w-fit flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm px-4 py-1.5 rounded-md transition ${
              tab === t.key ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab qs={qs} />}
      {tab === "in" && <MoneyInTab qs={qs} entity={entity} entities={entities} />}
      {tab === "out" && <MoneyOutTab entity={entity} entities={entities} bank={bank} bankConnections={bankConnections} />}
      {tab === "donations" && <DonationsTab qs={qs} entity={entity} entities={entities} />}
      {tab === "tax" && <TaxSummaryTab qs={qs} />}
      {tab === "stripe" && <StripeTab />}
      {tab === "bank" && <BankTab />}
    </div>
  );
}

/* ── Receipt / document upload ── */
function ReceiptUpload({ value, onChange }: { value: string | null; onChange: (url: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function up(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true); setErr("");
    const body = new FormData();
    body.append("file", file);
    body.append("type", "document");
    const res = await fetch("/api/upload", { method: "POST", body });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(d.error || "Upload failed"); return; }
    onChange(d.url);
  }
  return (
    <div>
      {value ? (
        <div className="flex items-center gap-2 text-sm">
          <a href={value} target="_blank" rel="noreferrer" className="text-brand hover:underline">Receipt attached ✓</a>
          <button type="button" onClick={() => onChange(null)} className="text-xs text-text-muted hover:text-text-primary">Remove</button>
        </div>
      ) : (
        <label className="inline-block text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg cursor-pointer">
          {busy ? "Uploading…" : "Upload receipt (image / PDF)"}
          <input type="file" accept="application/pdf,image/*" className="hidden" onChange={up} disabled={busy} />
        </label>
      )}
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
    </div>
  );
}

/* ── Overview (entity-aware Money In / Money Out) ── */
function OverviewTab({ qs }: { qs: string }) {
  const [s, setS] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    fetch(`/api/financials/summary?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setS(d); setLoading(false); });
  }, [qs]);

  if (loading || !s) return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
    </div>
  );
  const m = s.money;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard label="Money In" value={money(m.moneyIn)} hint="Payments + donations" accent="green" />
        <StatCard label="Money Out" value={money(m.moneyOut)} hint="Tracked expenses" accent="red" />
        <StatCard label="Net" value={money(m.net)} hint="In minus out" accent={m.net >= 0 ? "green" : "red"} />
        <StatCard label="Donations" value={money(m.donationsTotal)} hint="Recorded gifts" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Cash collected" value={money(m.cashIn)} hint="Cash / check" />
        <StatCard label="Card / online" value={money(m.cardIn)} hint="Stripe & card" />
        <StatCard label="Stripe fees" value={money(m.stripeFees)} hint="Recorded platform fees" />
        <StatCard label="Contractor payouts" value={money(m.contractorTotal)} hint="Guest coaches / contractors" />
      </div>

      {/* Needs review */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-app-border p-5">
          <p className="text-xs text-text-muted uppercase tracking-wider mb-1">Uncategorized</p>
          <p className="text-2xl font-semibold text-text-primary">{s.needsReview.uncategorized}</p>
          <p className="text-xs text-text-muted">transactions need a category</p>
        </div>
        <div className="bg-white rounded-xl border border-app-border p-5">
          <p className="text-xs text-text-muted uppercase tracking-wider mb-1">Receipts missing</p>
          <p className="text-2xl font-semibold text-text-primary">{s.needsReview.receiptsMissing}</p>
          <p className="text-xs text-text-muted">expenses without a receipt</p>
        </div>
        <div className="bg-white rounded-xl border border-app-border p-5">
          <p className="text-xs text-text-muted uppercase tracking-wider mb-1">Unpaid invoices</p>
          <p className="text-2xl font-semibold text-text-primary">{s.needsReview.unpaidInvoices.count}</p>
          <p className="text-xs text-text-muted">{money(s.needsReview.unpaidInvoices.total)} outstanding</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BreakdownCard title="Top revenue sources" rows={s.topSources.map((r) => ({ label: r.label, amount: r.amount }))} total={m.moneyIn} barClass="bg-lime-accent" />
        <BreakdownCard title="Expenses by category" rows={s.expensesByCategory.map((r) => ({ label: r.label, amount: r.amount }))} total={m.moneyOut} barClass="bg-red-300" />
      </div>
    </>
  );
}

function BreakdownCard({ title, rows, total, barClass }: { title: string; rows: { label: string; amount: number }[]; total: number; barClass: string }) {
  return (
    <div className="bg-white rounded-xl border border-app-border p-5">
      <h3 className="text-sm font-semibold text-text-primary mb-4">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing here yet.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const pct = total > 0 ? (r.amount / total) * 100 : 0;
            return (
              <div key={r.label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-text-primary">{r.label}</span>
                  <span className="text-xs font-medium text-text-primary">{money(r.amount)}</span>
                </div>
                <div className="h-1.5 bg-app-bg rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Money In (transactions + manual/cash entry + entity assign) ── */
function MoneyInTab({ qs, entity, entities }: { qs: string; entity: string; entities: Entity[] }) {
  const [data, setData] = useState<{ transactions: Tx[]; totals: { revenue: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRecord, setShowRecord] = useState(false);
  const [edit, setEdit] = useState<Tx | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/transactions?${qs}`).then((r) => (r.ok ? r.json() : null)).then((d) => { setData(d); setLoading(false); });
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  async function markPaid(id: string) {
    await fetch("/api/financials/manual-payment", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: id }),
    });
    load();
  }
  async function del(id: string) {
    if (!confirm("Delete this manual entry? Stripe records can't be deleted.")) return;
    const res = await fetch(`/api/transactions/${id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(typeof d.error === "string" ? d.error : "Could not delete"); }
    load();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-muted">Payments received — Stripe, cash, and manual invoices.</p>
        <button onClick={() => setShowRecord(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Record payment / invoice
        </button>
      </div>
      {loading ? (
        <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
      ) : !data?.transactions.length ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center text-sm text-text-muted">No payments in this period.</div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr><Th>Date</Th><Th>Source</Th><Th>Category</Th><Th>Method</Th><Th>Entity</Th><Th>Status</Th><Th>Amount</Th><Th></Th></tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <Td><span className="text-xs text-text-muted">{new Date(t.txDate || t.createdAt).toLocaleDateString()}</span></Td>
                  <Td><span className="text-sm text-text-primary">{t.member ? `${t.member.firstName} ${t.member.lastName}` : (t.description || "Payment")}</span></Td>
                  <Td><span className={`text-xs ${t.category ? "text-text-primary" : "text-orange-accent"}`}>{t.category ? revenueCategoryLabel(t.category) : "Uncategorized"}</span></Td>
                  <Td><span className="text-xs text-text-muted">{paymentMethodLabel(t.paymentMethod)}</span></Td>
                  <Td><span className="text-xs text-text-muted">{t.legalEntity?.name || "—"}</span></Td>
                  <Td><span className={`text-xs px-2 py-0.5 rounded-full ${t.status === "SUCCEEDED" ? "bg-lime-accent/25" : t.status === "PENDING" ? "bg-orange-accent/15" : "bg-app-bg"} text-text-primary`}>{t.status === "PENDING" && t.manual ? "Unpaid" : t.status.charAt(0) + t.status.slice(1).toLowerCase()}</span></Td>
                  <Td><span className="text-sm font-medium text-text-primary">{money(t.amount)}</span></Td>
                  <Td>
                    <div className="flex gap-1">
                      <button onClick={() => setEdit(t)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Assign</button>
                      {t.manual && t.status === "PENDING" && (
                        <button onClick={() => markPaid(t.id)} className="text-xs text-brand px-2 py-1 rounded hover:bg-brand/10">Mark paid</button>
                      )}
                      {t.manual && (
                        <button onClick={() => del(t.id)} className="text-xs text-red-600 px-2 py-1 rounded hover:bg-red-50">Delete</button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showRecord && <RecordPaymentModal entities={entities} defaultEntity={entity} onClose={() => setShowRecord(false)} onSaved={() => { setShowRecord(false); load(); }} />}
      {edit && <AssignTxModal tx={edit} entities={entities} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

function RecordPaymentModal({ entities, defaultEntity, onClose, onSaved }: { entities: Entity[]; defaultEntity: string; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("cash_payment");
  const [method, setMethod] = useState("CASH");
  const [source, setSource] = useState("");
  const [legalEntityId, setLegalEntityId] = useState(defaultEntity !== "all" ? defaultEntity : "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [unpaid, setUnpaid] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr("");
    const res = await fetch("/api/financials/manual-payment", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: parseFloat(amount), category, paymentMethod: method, source: source || null,
        legalEntityId: legalEntityId || null, date, unpaidInvoice: unpaid, notes: notes || null,
        description: source ? `${unpaid ? "Invoice" : "Payment"} — ${source}` : null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not save"); return; }
    onSaved();
  }
  return (
    <Modal title="Record payment / invoice" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Amount ($)"><input type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className="inp" /></Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="inp" /></Field>
        </div>
        <Field label="Who paid (source)"><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Member, sponsor, walk-in…" className="inp" /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="inp">
              {REVENUE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="inp">
              {PAYMENT_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Legal entity">
          <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)} className="inp">
            <option value="">— None —</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </Field>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} className="inp" /></Field>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} />
          This is an unpaid invoice (track as outstanding until paid)
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <ModalActions saving={saving} label="Record" onClose={onClose} />
      </form>
    </Modal>
  );
}

function AssignTxModal({ tx, entities, onClose, onSaved }: { tx: Tx; entities: Entity[]; onClose: () => void; onSaved: () => void }) {
  const [category, setCategory] = useState(tx.category || "");
  const [method, setMethod] = useState(tx.paymentMethod || "STRIPE");
  const [legalEntityId, setLegalEntityId] = useState(tx.legalEntity?.id || "");
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/transactions/${tx.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: category || null, paymentMethod: method, legalEntityId: legalEntityId || null }),
    });
    setSaving(false);
    onSaved();
  }
  return (
    <Modal title="Categorize transaction" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="inp">
            <option value="">Uncategorized</option>
            {REVENUE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Payment method">
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="inp">
            {PAYMENT_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Legal entity">
          <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)} className="inp">
            <option value="">— None —</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </Field>
        <ModalActions saving={saving} label="Save" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ── Money Out (expenses + receipts) ── */
function MoneyOutTab({ entity, entities, bank, bankConnections }: { entity: string; entities: Entity[]; bank: string; bankConnections: BankConnection[] }) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/expenses?entity=${entity}&bank=${bank}`).then((r) => (r.ok ? r.json() : [])).then((d) => { setExpenses(Array.isArray(d) ? d : []); setLoading(false); });
  }, [entity, bank]);
  useEffect(() => { load(); }, [load]);

  async function del(id: string) {
    if (!confirm("Delete this expense?")) return;
    await fetch(`/api/expenses/${id}`, { method: "DELETE" });
    load();
  }
  const total = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const missing = expenses.filter((e) => !e.receiptUrl).length;

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-muted">
          {expenses.length} expense(s) · {money(total)} · <span className={missing ? "text-orange-accent" : ""}>{missing} missing receipts</span>
        </p>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Add expense</button>
      </div>
      {loading ? (
        <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
      ) : expenses.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <p className="text-sm text-text-muted mb-4">Track rent, payroll, gear, software, and other costs — attach receipts for tax time.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Add first expense</button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr><Th>Date</Th><Th>Description</Th><Th>Vendor</Th><Th>Category</Th><Th>Entity</Th><Th>Receipt</Th><Th>Amount</Th><Th></Th></tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <Td><span className="text-xs text-text-muted">{new Date(e.date).toLocaleDateString()}</span></Td>
                  <Td><span className="text-sm text-text-primary">{e.description}</span>{e.reimbursable && <span className="ml-1 text-[10px] text-brand">reimbursable</span>}</Td>
                  <Td><span className="text-xs text-text-muted">{e.vendor || "—"}</span></Td>
                  <Td><span className="text-xs text-text-primary">{expenseCategoryLabel(e.category)}</span></Td>
                  <Td><span className="text-xs text-text-muted">{e.legalEntity?.name || "—"}</span></Td>
                  <Td>{e.receiptUrl ? <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">View</a> : <span className="text-xs text-orange-accent">Missing</span>}</Td>
                  <Td><span className="text-sm font-medium text-text-primary">{money(e.amount)}</span></Td>
                  <Td>
                    <div className="flex gap-1">
                      <button onClick={() => setEditing(e)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                      <button onClick={() => del(e.id)} className="text-xs text-red-600 px-2 py-1 rounded hover:bg-red-50">Delete</button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(showAdd || editing) && (
        <ExpenseModal expense={editing} entities={entities} bankConnections={bankConnections} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={() => { setShowAdd(false); setEditing(null); load(); }} />
      )}
    </>
  );
}

function ExpenseModal({ expense, entities, bankConnections, onClose, onSaved }: { expense: Expense | null; entities: Entity[]; bankConnections: BankConnection[]; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!expense;
  const [description, setDescription] = useState(expense?.description || "");
  const [amount, setAmount] = useState(expense ? String(parseFloat(expense.amount)) : "");
  const [category, setCategory] = useState(expense?.category || "OTHER");
  const [vendor, setVendor] = useState(expense?.vendor || "");
  const [method, setMethod] = useState(expense?.paymentMethod || "CARD");
  const [legalEntityId, setLegalEntityId] = useState(expense?.legalEntityId || "");
  // Optional Plaid bank tag — lets the owner say which account this
  // expense actually came out of. Empty = unset.
  const [plaidConnectionId, setPlaidConnectionId] = useState<string>(
    (expense as { plaidConnectionId?: string | null } | null)?.plaidConnectionId || "",
  );
  const [date, setDate] = useState(expense ? expense.date.split("T")[0] : new Date().toISOString().split("T")[0]);
  const [isRecurring, setIsRecurring] = useState(expense?.isRecurring || false);
  const [kind, setKind] = useState<string>((expense as { kind?: string | null } | null)?.kind || "");
  const [reimbursable, setReimbursable] = useState(expense?.reimbursable || false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(expense?.receiptUrl || null);
  const [notes, setNotes] = useState(expense?.notes || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError("");
    const res = await fetch(isEdit ? `/api/expenses/${expense!.id}` : "/api/expenses", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description, amount: parseFloat(amount), category, date, isRecurring,
        notes: notes || null, vendor: vendor || null, paymentMethod: method,
        legalEntityId: legalEntityId || null, reimbursable, receiptUrl,
        kind: kind || null,
        plaidConnectionId: plaidConnectionId || null,
      }),
    });
    setSaving(false);
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(typeof d.error === "string" ? d.error : "Save failed"); return; }
    onSaved();
  }

  return (
    <Modal title={isEdit ? "Edit expense" : "Add expense"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Description"><input required value={description} onChange={(e) => setDescription(e.target.value)} className="inp" placeholder="Monthly rent" /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Amount ($)"><input type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className="inp" /></Field>
          <Field label="Date"><input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="inp" /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="inp">
              {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Payment method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="inp">
              {PAYMENT_METHODS.filter((m) => m.key !== "STRIPE").map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Cost type">
          <div className="flex gap-2">
            {([
              { v: "", label: "Unset" },
              { v: "FIXED", label: "Fixed — same every period" },
              { v: "VARIABLE", label: "Variable — fluctuates" },
            ] as const).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setKind(opt.v)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                  kind === opt.v
                    ? "border-brand bg-brand text-white"
                    : "border-app-border text-text-muted hover:bg-app-bg"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Vendor"><input value={vendor} onChange={(e) => setVendor(e.target.value)} className="inp" placeholder="Who you paid" /></Field>
          <Field label="Legal entity">
            <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)} className="inp">
              <option value="">— None —</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </Field>
        </div>
        {bankConnections.length > 0 && (
          <Field label="Bank account (optional)">
            <select value={plaidConnectionId} onChange={(e) => setPlaidConnectionId(e.target.value)} className="inp">
              <option value="">— Not assigned —</option>
              {bankConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || c.institutionName || "Bank"}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Receipt"><ReceiptUpload value={receiptUrl} onChange={setReceiptUrl} /></Field>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} className="inp" placeholder="Invoice #, etc." /></Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} /> Recurring</label>
          <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={reimbursable} onChange={(e) => setReimbursable(e.target.checked)} /> Reimbursable</label>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <ModalActions saving={saving} label={isEdit ? "Save changes" : "Add expense"} onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ── Donations (nonprofit / foundation) ── */
function DonationsTab({ qs, entity, entities }: { qs: string; entity: string; entities: Entity[] }) {
  const [data, setData] = useState<{ donations: Donation[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Donation | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/donations?${qs}`).then((r) => (r.ok ? r.json() : null)).then((d) => { setData(d); setLoading(false); });
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  async function del(id: string) {
    if (!confirm("Delete this donation record?")) return;
    await fetch(`/api/donations/${id}`, { method: "DELETE" });
    load();
  }
  const restricted = (data?.donations || []).filter((d) => d.restricted).reduce((s, d) => s + parseFloat(d.amount), 0);

  return (
    <>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <p className="text-sm text-text-muted">
          {data?.donations.length ?? 0} gift(s) · {money(data?.total ?? 0)} total · {money(restricted)} restricted
        </p>
        <div className="flex gap-2">
          <a href={`/api/donations/export?${qs}`} className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Donor export</a>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Record donation</button>
        </div>
      </div>
      {loading ? (
        <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
      ) : !data?.donations.length ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center text-sm text-text-muted">
          No donations recorded. Track gifts, sponsorships, donor info, funds, and receipts for your nonprofit / foundation entity.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr><Th>Date</Th><Th>Donor</Th><Th>Fund</Th><Th>Type</Th><Th>Entity</Th><Th>Receipt</Th><Th>Amount</Th><Th></Th></tr>
            </thead>
            <tbody>
              {data.donations.map((d) => (
                <tr key={d.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <Td><span className="text-xs text-text-muted">{new Date(d.date).toLocaleDateString()}</span></Td>
                  <Td><span className="text-sm text-text-primary">{d.donorName}</span>{d.donorEmail && <p className="text-xs text-text-muted">{d.donorEmail}</p>}</Td>
                  <Td><span className="text-xs text-text-muted">{d.fund || "General"}</span></Td>
                  <Td><span className="text-xs text-text-muted">{d.sponsorship ? "Sponsorship" : d.restricted ? "Restricted" : "Unrestricted"}</span></Td>
                  <Td><span className="text-xs text-text-muted">{d.legalEntity?.name || "—"}</span></Td>
                  <Td>{d.receiptUrl ? <a href={d.receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">View</a> : <span className="text-xs text-text-muted">—</span>}</Td>
                  <Td><span className="text-sm font-medium text-text-primary">{money(d.amount)}</span></Td>
                  <Td>
                    <div className="flex gap-1">
                      <button onClick={() => setEditing(d)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                      <button onClick={() => del(d.id)} className="text-xs text-red-600 px-2 py-1 rounded hover:bg-red-50">Delete</button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(showAdd || editing) && (
        <DonationModal donation={editing} entities={entities} defaultEntity={entity} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={() => { setShowAdd(false); setEditing(null); load(); }} />
      )}
    </>
  );
}

function DonationModal({ donation, entities, defaultEntity, onClose, onSaved }: { donation: Donation | null; entities: Entity[]; defaultEntity: string; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!donation;
  const [donorName, setDonorName] = useState(donation?.donorName || "");
  const [donorEmail, setDonorEmail] = useState(donation?.donorEmail || "");
  const [amount, setAmount] = useState(donation ? String(parseFloat(donation.amount)) : "");
  const [fund, setFund] = useState(donation?.fund || "");
  const [restricted, setRestricted] = useState(donation?.restricted || false);
  const [sponsorship, setSponsorship] = useState(donation?.sponsorship || false);
  const [method, setMethod] = useState(donation?.paymentMethod || "CASH");
  const [date, setDate] = useState(donation ? donation.date.split("T")[0] : new Date().toISOString().slice(0, 10));
  const [legalEntityId, setLegalEntityId] = useState(donation?.legalEntityId || (defaultEntity !== "all" ? defaultEntity : ""));
  const [receiptUrl, setReceiptUrl] = useState<string | null>(donation?.receiptUrl || null);
  const [notes, setNotes] = useState(donation?.notes || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr("");
    const res = await fetch(isEdit ? `/api/donations/${donation!.id}` : "/api/donations", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        donorName, donorEmail: donorEmail || "", amount: parseFloat(amount), fund: fund || null,
        restricted, sponsorship, paymentMethod: method, date, legalEntityId: legalEntityId || null,
        receiptUrl, notes: notes || null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Save failed"); return; }
    onSaved();
  }
  return (
    <Modal title={isEdit ? "Edit donation" : "Record donation"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Donor name"><input required value={donorName} onChange={(e) => setDonorName(e.target.value)} className="inp" /></Field>
          <Field label="Donor email"><input type="email" value={donorEmail} onChange={(e) => setDonorEmail(e.target.value)} className="inp" /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Amount ($)"><input type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className="inp" /></Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="inp" /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Fund / purpose"><input value={fund} onChange={(e) => setFund(e.target.value)} placeholder="General, scholarship…" className="inp" /></Field>
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="inp">
              {PAYMENT_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Legal entity (nonprofit / foundation)">
          <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)} className="inp">
            <option value="">— None —</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}{en.entityType === "NONPROFIT" ? " (Nonprofit)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Receipt"><ReceiptUpload value={receiptUrl} onChange={setReceiptUrl} /></Field>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} className="inp" /></Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /> Restricted fund</label>
          <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={sponsorship} onChange={(e) => setSponsorship(e.target.checked)} /> Sponsorship</label>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <ModalActions saving={saving} label={isEdit ? "Save" : "Record donation"} onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ── Tax Summary ── */
function TaxSummaryTab({ qs }: { qs: string }) {
  const [type, setType] = useState<ReportType>("pnl");
  const [report, setReport] = useState<{ title: string; columns: string[]; rows: (string | number)[][] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/financials/report?type=${type}&${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setReport(d); setLoading(false); });
  }, [type, qs]);

  return (
    <>
      <div className="bg-brand/5 border border-brand/20 rounded-xl p-4 mb-5 text-sm text-text-primary">
        <p className="font-semibold mb-0.5">{TAX_SUMMARY_NOTE}</p>
        <p className="text-xs text-text-muted">{FINANCIAL_DISCLAIMER}</p>
      </div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex flex-wrap gap-1.5">
          {REPORT_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${
                type === t ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
              }`}
            >
              {REPORT_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <a href={`/api/financials/export?type=${type}&${qs}`} className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Export CSV</a>
          <a href={`/api/financials/export?type=year_end&${qs}`} className="text-sm px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover">Year-end package</a>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border">
          <h2 className="text-sm font-semibold text-text-primary">{report?.title || REPORT_LABELS[type]}</h2>
        </div>
        {loading ? (
          <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
        ) : !report || report.rows.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-sm">No data for this period.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-app-bg border-b border-app-border">
                <tr>{report.columns.map((c) => <Th key={c}>{c}</Th>)}</tr>
              </thead>
              <tbody>
                {report.rows.map((row, i) => (
                  <tr key={i} className="border-b border-app-border last:border-0">
                    {row.map((cell, j) => <Td key={j}><span className="text-sm text-text-primary">{cell}</span></Td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ── Stripe (unchanged) ── */
function StripeTab() {
  const [data, setData] = useState<{ transactions: Tx[]; totals: { revenue: number; platformFees: number; net: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/transactions").then((r) => (r.ok ? r.json() : null)).then((d) => { setData(d); setLoading(false); });
  }, []);
  return (
    <>
      {!loading && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard label="Total revenue" value={money(data?.totals.revenue || 0)} hint="All time, paid" />
          <StatCard label="Platform fees" value={money(data?.totals.platformFees || 0)} hint="Paid to AthletixOS" />
          <StatCard label="Net revenue" value={money(data?.totals.net || 0)} hint="What you keep" />
        </div>
      )}
      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border"><h2 className="text-sm font-semibold text-text-primary">Stripe transactions</h2></div>
        {loading ? (
          <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
        ) : !data?.transactions.length ? (
          <div className="p-12 text-center text-sm text-text-muted">No transactions yet.</div>
        ) : (
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr><Th>Date</Th><Th>Member</Th><Th>Description</Th><Th>Status</Th><Th>Amount</Th><Th>Fee</Th></tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <Td><span className="text-xs text-text-muted">{new Date(t.createdAt).toLocaleDateString()}</span></Td>
                  <Td><span className="text-sm text-text-primary">{t.member ? `${t.member.firstName} ${t.member.lastName}` : "—"}</span></Td>
                  <Td><span className="text-sm text-text-primary">{t.description || "Payment"}</span></Td>
                  <Td><span className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-primary">{t.status.charAt(0) + t.status.slice(1).toLowerCase()}</span></Td>
                  <Td><span className="text-sm font-medium text-text-primary">{money(t.amount)}</span></Td>
                  <Td><span className="text-xs text-text-muted">{t.platformFee ? money(t.platformFee) : "—"}</span></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ── Bank / Plaid (unchanged) ── */
function BankTab() {
  const [bankData, setBankData] = useState<{
    connected: boolean;
    accounts: BankAccount[];
    transactions: BankTx[];
    connections?: BankConnection[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [plaidError, setPlaidError] = useState<string | null>(null);
  const [plaidConfigured, setPlaidConfigured] = useState(true);
  // Owner-selected filter — when set, transactions/accounts are scoped
  // to just that bank connection. null = "All accounts".
  const [connectionFilter, setConnectionFilter] = useState<string | null>(null);

  async function loadBankData(filterId: string | null = connectionFilter) {
    const qs = filterId ? `?connectionId=${encodeURIComponent(filterId)}` : "";
    const res = await fetch(`/api/plaid/transactions${qs}`);
    if (res.ok) {
      const data = await res.json();
      if (data.error === "Plaid not configured") setPlaidConfigured(false);
      else setBankData(data);
    }
    setLoading(false);
  }
  useEffect(() => { loadBankData(null); }, []);

  async function startPlaidLink() {
    setConnecting(true);
    setPlaidError(null);
    const res = await fetch("/api/plaid/link-token", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setConnecting(false);
    if (data.error) {
      if (data.error === "Plaid not configured") setPlaidConfigured(false);
      else setPlaidError(data.error);
      return;
    }
    setLinkToken(data.linkToken);
  }
  const onSuccess = useCallback(async (publicToken: string) => {
    setLoading(true);
    // Use the new connections endpoint so the bank is stored as a
    // PlaidConnection row. The legacy exchange endpoint still works for
    // older clients but the new flow gives us per-bank labels.
    await fetch("/api/plaid/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    setLinkToken(null);
    loadBankData(null);
  }, []);
  const { open: openPlaid, ready: plaidReady } = usePlaidLink({ token: linkToken || "", onSuccess });
  useEffect(() => { if (linkToken && plaidReady) openPlaid(); }, [linkToken, plaidReady, openPlaid]);

  async function disconnectAll() {
    if (!confirm("Disconnect ALL bank accounts? Manual entry will still work.")) return;
    await fetch("/api/plaid/transactions", { method: "DELETE" });
    setBankData(null);
    setConnectionFilter(null);
    loadBankData(null);
  }

  async function disconnectOne(id: string, label: string) {
    if (!confirm(`Disconnect "${label}"? Other bank accounts stay connected.`)) return;
    await fetch(`/api/plaid/connections/${id}`, { method: "DELETE" });
    if (connectionFilter === id) setConnectionFilter(null);
    loadBankData(connectionFilter === id ? null : connectionFilter);
  }

  async function renameConnection(id: string, current: string) {
    const next = window.prompt("Rename this bank account", current);
    if (next == null) return;
    await fetch(`/api/plaid/connections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: next.trim() || null }),
    });
    loadBankData(connectionFilter);
  }

  function applyFilter(id: string | null) {
    setConnectionFilter(id);
    setLoading(true);
    loadBankData(id);
  }

  if (loading) return <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>;
  if (!plaidConfigured) {
    return (
      <div className="bg-white rounded-xl border border-app-border p-8 text-center">
        <h3 className="text-base font-semibold text-text-primary mb-2">Plaid not configured</h3>
        <p className="text-sm text-text-muted mb-2 max-w-sm mx-auto">Manual income & expense tracking works without Plaid. Add Plaid credentials to enable bank sync.</p>
        <div className="text-left bg-app-bg rounded-lg p-4 text-xs font-mono text-text-muted max-w-sm mx-auto">
          <p>PLAID_CLIENT_ID=…</p><p>PLAID_SECRET=…</p><p>PLAID_ENV=sandbox</p>
        </div>
      </div>
    );
  }
  if (!bankData?.connected) {
    return (
      <div className="bg-white rounded-xl border border-app-border p-8 text-center">
        <h3 className="text-base font-semibold text-text-primary mb-2">Connect your bank account</h3>
        <p className="text-sm text-text-muted mb-6 max-w-sm mx-auto">Link your club's bank to see balances and transactions alongside your revenue. Manual entry always works too.</p>
        <button onClick={startPlaidLink} disabled={connecting} className="px-6 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
          {connecting ? "Opening…" : "Connect bank account"}
        </button>
        {plaidError && (
          <p className="text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mt-4 max-w-sm mx-auto">{plaidError}</p>
        )}
        <p className="text-xs text-text-muted mt-3">Secured by Plaid · Read-only access</p>
      </div>
    );
  }
  const totalBalance = bankData.accounts.reduce((s, a) => s + (a.balances.current || 0), 0);
  const connections = bankData.connections ?? [];
  return (
    <>
      {/* Per-bank manager — list of connected accounts with rename /
          disconnect, plus an "Add another bank" CTA. Filtering happens via
          the dropdown below so adding doesn't reset the user's view. */}
      <div className="bg-white rounded-xl border border-app-border p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">Connected bank accounts</h2>
          <button
            onClick={startPlaidLink}
            disabled={connecting}
            className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {connecting ? "Opening…" : "+ Add bank"}
          </button>
        </div>
        {plaidError && (
          <p className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mb-3">{plaidError}</p>
        )}
        {connections.length === 0 ? (
          <p className="text-xs text-text-muted">
            None labelled yet — connect a second bank to organize operating, foundation, savings, etc.
          </p>
        ) : (
          <ul className="divide-y divide-app-border">
            {connections.map((c) => {
              const display = c.label || c.institutionName || "Bank";
              return (
                <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="min-w-0">
                    <div className="text-text-primary font-medium truncate">{display}</div>
                    {c.institutionName && c.label && (
                      <div className="text-[11px] text-text-muted">{c.institutionName}</div>
                    )}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => renameConnection(c.id, display)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => disconnectOne(c.id, display)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded"
                    >
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Bank-account filter — drives the accounts grid + transaction list. */}
      {connections.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-text-muted">Showing</span>
          <select
            value={connectionFilter ?? ""}
            onChange={(e) => applyFilter(e.target.value || null)}
            className="text-sm px-3 py-1.5 border border-app-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand"
          >
            <option value="">All bank accounts</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.label || c.institutionName || "Bank"}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        {bankData.accounts.map((a) => (
          <div key={a.account_id} className="bg-white rounded-xl border border-app-border p-5">
            <div className="text-xs text-text-muted uppercase tracking-wider mb-1">{a.name}</div>
            <div className="text-2xl font-semibold text-text-primary mb-1">{money(a.balances.current || 0)}</div>
            <div className="text-xs text-text-muted">
              {a.subtype} · {a.balances.iso_currency_code}
              {a.connectionLabel ? ` · ${a.connectionLabel}` : ""}
            </div>
          </div>
        ))}
        <div className="bg-brand rounded-xl p-5">
          <div className="text-xs text-white/70 uppercase tracking-wider mb-1">Total balance</div>
          <div className="text-2xl font-semibold text-white mb-1">{money(totalBalance)}</div>
          <div className="text-xs text-white/70">
            {connectionFilter ? "In the selected bank" : "Across all accounts"}
          </div>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">
            Bank transactions (last 30 days)
            {connectionFilter && connections.length > 1 ? (
              <span className="ml-2 text-xs font-normal text-text-muted">
                — {connections.find((c) => c.id === connectionFilter)?.label || "filtered"}
              </span>
            ) : null}
          </h2>
          <button onClick={disconnectAll} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
            Disconnect all
          </button>
        </div>
        {bankData.transactions.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-sm">No transactions in the last 30 days.</div>
        ) : (
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border"><tr><Th>Date</Th><Th>Description</Th><Th>Bank</Th><Th>Category</Th><Th>Amount</Th></tr></thead>
            <tbody>
              {bankData.transactions.map((t) => (
                <tr key={t.transaction_id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <Td><span className="text-xs text-text-muted">{new Date(t.date).toLocaleDateString()}</span></Td>
                  <Td><span className="text-sm text-text-primary">{t.name}</span></Td>
                  <Td><span className="text-xs text-text-muted">{t.connectionLabel || "—"}</span></Td>
                  <Td><span className="text-xs text-text-muted">{t.category?.[0] || "—"}</span></Td>
                  <Td><span className={`text-sm font-medium ${t.amount > 0 ? "text-red-700" : "text-text-primary"}`}>{t.amount > 0 ? "-" : "+"}{money(Math.abs(t.amount))}</span></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ── Shared ── */
function StatCard({ label, value, hint, accent }: { label: string; value: string; hint: string; accent?: string }) {
  const cls = accent === "red" ? "text-red-700" : "text-text-primary";
  return (
    <div className="bg-white rounded-xl border border-app-border p-5">
      <div className="text-xs text-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-semibold mb-1 ${cls}`}>{value}</div>
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
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1">{label}</label>
      {children}
    </div>
  );
}
function ModalActions({ saving, label, onClose }: { saving: boolean; label: string; onClose: () => void }) {
  return (
    <div className="flex gap-2 pt-2">
      <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
      <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">{saving ? "Saving…" : label}</button>
    </div>
  );
}
