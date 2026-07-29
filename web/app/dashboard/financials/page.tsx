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
import { todayLocalISO } from "@/lib/datetime";
import PageHeader from "@/components/PageHeader";
import { SkeletonList, SkeletonCard } from "@/components/LoadingSkeleton";

type Entity = { id: string; name: string; entityType: string };
type Money = {
  moneyIn: number; moneyOut: number; net: number; cashIn: number; cardIn: number;
  checkIn: number; externalReaderIn: number; netAfterFees: number; platformFees: number;
  stripeFees: number; donationsTotal: number; contractorTotal: number; compTotal?: number;
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
  stripeFeeAmount: string | number | null; netAmount: string | number | null;
  paymentSource: string | null; reconciliationStatus: string | null;
  description: string | null; category: string | null; paymentMethod: string | null;
  source: string | null; notes: string | null;
  manual: boolean; type: string; createdAt: string; txDate: string | null;
  refundedAmount: string | number | null; refundedAt: string | null;
  refundReason: string | null; receiptUrl: string | null;
  discountCode: string | null; discountAmount: string | number | null;
  member: { id: string; firstName: string; lastName: string } | null;
  legalEntity: { id: string; name: string } | null;
  recordedBy: { id: string; name: string } | null;
  athlete: { id: string; firstName: string; lastName: string } | null;
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
type BankTx = {
  id?: string; // PlaidTransaction row id (server-side identifier)
  transaction_id: string;
  date: string;
  name: string;
  merchantName?: string | null;
  amount: number;
  category: string[] | null;
  connectionId?: string;
  connectionLabel?: string;
  // Review state (Phase 1C)
  reviewedAt?: string | null;
  categorizedExpenseId?: string | null;
  categoryOverride?: string | null;
  markedAsTransfer?: boolean;
  excludedFromTax?: boolean;
  notes?: string | null;
  suggestedCategory?: string | null;
};
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
  { key: "offline", label: "Cash & Offline" },
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
      {tab === "stripe" && <StripeTab qs={qs} />}
      {tab === "offline" && <CashOfflineTab qs={qs} entities={entities} />}
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard label="Verified card (Stripe)" value={money(m.cardIn)} hint="Confirmed by Stripe" />
        <StatCard label="Cash" value={money(m.cashIn)} hint="Offline, recorded here" />
        <StatCard label="Check" value={money(m.checkIn)} hint="Offline, recorded here" />
        <StatCard label="External reader" value={money(m.externalReaderIn)} hint="Record only — not verified by Stripe" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Stripe fees" value={money(m.stripeFees)} hint="Exact processing fees" />
        <StatCard label="Net after fees" value={money(m.netAfterFees)} hint="Money in minus all fees" />
        <StatCard label="Comped" value={money(m.compTotal ?? 0)} hint="No charge — never revenue" />
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
  const [date, setDate] = useState(expense ? expense.date.split("T")[0] : todayLocalISO());
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
type BankTaxSummary = {
  income: { stripeGross: number; stripeFees: number; stripeNet: number; stripeRefunded: number; cashRecorded: number; checkRecorded: number; compRecorded: number; bankOtherIncome: number };
  expenses: { categorized: { key: string; amount: number }[]; total: number; needsReview: { count: number; amount: number }; excluded: number; transfers: number };
  totals: { grossIncome: number; refunds: number; processingFees: number; netIncome: number; categorizedExpenses: number; estimatedTaxableProfit: number };
  notes: string[];
};

function TaxSummaryTab({ qs }: { qs: string }) {
  const [type, setType] = useState<ReportType>("pnl");
  const [report, setReport] = useState<{ title: string; columns: string[]; rows: (string | number)[][] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [bank, setBank] = useState<BankTaxSummary | null>(null);
  const [loadingBank, setLoadingBank] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/financials/report?type=${type}&${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setReport(d); setLoading(false); });
  }, [type, qs]);
  useEffect(() => {
    setLoadingBank(true);
    fetch(`/api/financials/tax-summary?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setBank(d); setLoadingBank(false); });
  }, [qs]);

  return (
    <>
      <div className="bg-brand/5 border border-brand/20 rounded-xl p-4 mb-5 text-sm text-text-primary">
        <p className="font-semibold mb-0.5">{TAX_SUMMARY_NOTE}</p>
        <p className="text-xs text-text-muted">{FINANCIAL_DISCLAIMER}</p>
      </div>

      {/* Bank-based Tax Summary — the primary view. Uses bank data +
          Stripe money in AthletixOS; avoids double-counting Stripe payouts
          into the bank. */}
      {loadingBank ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : bank ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <StatCard label="Gross income" value={money(bank.totals.grossIncome)} hint="Stripe + non-Stripe recorded + bank credits" />
            <StatCard label="Refunds" value={money(bank.totals.refunds)} hint="Stripe refunds/reversals" />
            <StatCard label="Processing fees" value={money(bank.totals.processingFees)} hint="Exact Stripe fees" />
            <StatCard label="Net income" value={money(bank.totals.netIncome)} hint="Gross − refunds − fees" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <StatCard label="Categorized expenses" value={money(bank.totals.categorizedExpenses)} hint="Reviewed bank outflows" />
            <StatCard label="Uncategorized" value={money(bank.expenses.needsReview.amount)} hint={`${bank.expenses.needsReview.count} bank rows need review`} accent={bank.expenses.needsReview.count > 0 ? "red" : undefined} />
            <StatCard label="Transfers" value={money(bank.expenses.transfers)} hint="Between the club's own accounts" />
            <StatCard label="Excluded" value={money(bank.expenses.excluded)} hint="Kept out of tax by owner" />
          </div>
          <div className="bg-white rounded-xl border border-app-border p-5 mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-text-primary">Estimated taxable profit</h3>
              <span className="text-2xl font-semibold text-text-primary tabular-nums">{money(bank.totals.estimatedTaxableProfit)}</span>
            </div>
            <ul className="text-xs text-text-muted list-disc pl-5 space-y-0.5">
              {bank.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>
        </>
      ) : null}
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

/* ── Stripe (paymentSource=STRIPE only — never mixes cash / offline) ── */
function StripeTab({ qs }: { qs: string }) {
  const [data, setData] = useState<{ transactions: Tx[]; totals: { revenue: number; stripeFees: number; platformFees: number; refunded: number; net: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    // Server filter: paymentSource=stripe means "Stripe-source rows only".
    // Cash/check/comp/external-reader are no longer surfaced here.
    fetch(`/api/transactions?${qs}&paymentSource=stripe`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }, [qs]);
  return (
    <>
      <p className="text-xs text-text-muted mb-3">
        Only Stripe-processed card payments. For cash, check, external-reader
        or comp records, see the <span className="font-medium text-text-primary">Cash &amp; Offline</span> tab.
      </p>
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <StatCard label="Stripe revenue" value={money(data?.totals.revenue || 0)} hint="In the selected range" />
          <StatCard label="Stripe fees" value={money(data?.totals.stripeFees || 0)} hint="Exact processing fees" />
          <StatCard label="Refunded" value={money(data?.totals.refunded || 0)} hint="Recorded refunds" />
          <StatCard label="Net" value={money(data?.totals.net || 0)} hint="Revenue − fees − refunds" />
        </div>
      )}
      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border"><h2 className="text-sm font-semibold text-text-primary">Stripe transactions</h2></div>
        {loading ? (
          <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
        ) : !data?.transactions.length ? (
          <div className="p-12 text-center text-sm text-text-muted">No Stripe transactions in this period.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-app-bg border-b border-app-border">
                <tr><Th>Date</Th><Th>Member</Th><Th>Description</Th><Th>Status</Th><Th>Amount</Th><Th>Fee</Th></tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <Td><span className="text-xs text-text-muted">{new Date(t.txDate || t.createdAt).toLocaleDateString()}</span></Td>
                    <Td><span className="text-sm text-text-primary">{t.member ? `${t.member.firstName} ${t.member.lastName}` : "—"}</span></Td>
                    <Td><span className="text-sm text-text-primary">{t.description || "Payment"}</span></Td>
                    <Td>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${t.refundedAt ? "bg-red-100 text-red-800" : "bg-app-bg text-text-primary"}`}>
                        {t.refundedAt ? "Refunded" : t.status.charAt(0) + t.status.slice(1).toLowerCase()}
                      </span>
                    </Td>
                    <Td><span className="text-sm font-medium text-text-primary">{money(t.amount)}</span></Td>
                    <Td><span className="text-xs text-text-muted">{t.stripeFeeAmount ? money(t.stripeFeeAmount) : "—"}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ReconciliationCard />
    </>
  );
}

/* ── Cash & Offline (every non-Stripe money record) ── */
function CashOfflineTab({ qs, entities }: { qs: string; entities: Entity[] }) {
  const [data, setData] = useState<{ transactions: Tx[]; totals: { revenue: number; refunded: number; net: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "CASH" | "CHECK" | "EXTERNAL_READER" | "COMP" | "MANUAL_ADJUSTMENT">("all");
  const [edit, setEdit] = useState<Tx | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const src = filter === "all" ? "offline" : filter;
    fetch(`/api/transactions?${qs}&paymentSource=${src}&limit=500`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }, [qs, filter]);
  useEffect(() => { load(); }, [load]);

  const filters: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All offline" },
    { key: "CASH", label: "Cash" },
    { key: "CHECK", label: "Check" },
    { key: "EXTERNAL_READER", label: "External reader" },
    { key: "COMP", label: "Comp" },
    { key: "MANUAL_ADJUSTMENT", label: "Manual" },
  ];

  return (
    <>
      <p className="text-xs text-text-muted mb-3">
        Every non-Stripe payment record — cash, check, comp, or an external card
        reader we recorded but never charged. Stripe payments are on the previous tab.
      </p>
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          <StatCard label="Offline received" value={money(data?.totals.revenue || 0)} hint="In the selected range" />
          <StatCard label="Refunded" value={money(data?.totals.refunded || 0)} hint="Recorded refunds/reversals" />
          <StatCard label="Net" value={money(data?.totals.net || 0)} hint="Received minus refunded" />
        </div>
      )}
      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-4 w-fit flex-wrap">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1 rounded-md transition ${
              filter === f.key ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={5} /></div>
      ) : !data?.transactions.length ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center text-sm text-text-muted">No offline payments in this period.</div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>Date</Th>
                <Th>Payer</Th>
                <Th>Athlete</Th>
                <Th>Item</Th>
                <Th>Method</Th>
                <Th>Amount</Th>
                <Th>Recorded by</Th>
                <Th>State</Th>
                <Th>Receipt</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => {
                const isRefunded = !!t.refundedAt || Number(t.refundedAmount || 0) > 0;
                const state = isRefunded
                  ? { label: "Refunded", cls: "bg-red-100 text-red-800" }
                  : t.status === "PENDING"
                    ? { label: "Awaiting", cls: "bg-orange-accent/15 text-text-primary" }
                    : t.status === "SUCCEEDED"
                      ? { label: "Received", cls: "bg-lime-accent/25 text-text-primary" }
                      : { label: t.status, cls: "bg-app-bg text-text-muted" };
                const payer = t.member ? `${t.member.firstName} ${t.member.lastName}` : t.source || "—";
                const athlete = t.athlete
                  ? `${t.athlete.firstName} ${t.athlete.lastName}`
                  : t.member
                    ? "" /* same as payer */
                    : "—";
                return (
                  <tr key={t.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <Td><span className="text-xs text-text-muted">{new Date(t.txDate || t.createdAt).toLocaleDateString()}</span></Td>
                    <Td><span className="text-sm text-text-primary">{payer}</span></Td>
                    <Td><span className="text-xs text-text-muted">{athlete || "—"}</span></Td>
                    <Td><span className="text-xs text-text-primary">{t.description || t.category || "—"}</span></Td>
                    <Td><span className="text-xs text-text-muted">{t.paymentSource ?? t.paymentMethod ?? "—"}</span></Td>
                    <Td><span className="text-sm font-medium text-text-primary">{money(t.amount)}</span></Td>
                    <Td><span className="text-xs text-text-muted">{t.recordedBy?.name || "—"}</span></Td>
                    <Td><span className={`text-xs px-2 py-0.5 rounded-full ${state.cls}`}>{state.label}</span></Td>
                    <Td>
                      {t.receiptUrl ? (
                        <a href={t.receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">View</a>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      <button onClick={() => setEdit(t)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                        Manage
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <OfflineTxManageModal
          tx={edit}
          entities={entities}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }}
        />
      )}
    </>
  );
}

function OfflineTxManageModal({ tx, entities, onClose, onSaved }: { tx: Tx; entities: Entity[]; onClose: () => void; onSaved: () => void }) {
  const alreadyRefunded = !!tx.refundedAt || Number(tx.refundedAmount || 0) > 0;
  const [markRefunded, setMarkRefunded] = useState(alreadyRefunded);
  const [refundAmt, setRefundAmt] = useState(String(tx.refundedAmount ?? tx.amount ?? ""));
  const [refundReason, setRefundReason] = useState(tx.refundReason || "manual");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(tx.receiptUrl);
  const [legalEntityId, setLegalEntityId] = useState(tx.legalEntity?.id || "");
  const [notes, setNotes] = useState(tx.notes || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr("");
    const body: Record<string, unknown> = {
      legalEntityId: legalEntityId || null,
      notes: notes || null,
      receiptUrl,
    };
    if (markRefunded && !alreadyRefunded) {
      body.refundedAmount = parseFloat(refundAmt) || Number(tx.amount);
      body.refundReason = refundReason;
    } else if (!markRefunded && alreadyRefunded) {
      body.refundedAmount = 0;
      body.refundedAt = null;
      body.refundReason = null;
    } else if (markRefunded && alreadyRefunded) {
      body.refundedAmount = parseFloat(refundAmt) || Number(tx.refundedAmount ?? 0);
      body.refundReason = refundReason;
    }
    const res = await fetch(`/api/transactions/${tx.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not save"); return; }
    onSaved();
  }

  return (
    <Modal title="Manage offline payment" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="bg-app-bg rounded-lg p-3 space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-text-muted">Amount</span><span className="font-medium text-text-primary">{money(tx.amount)}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Method</span><span>{tx.paymentSource ?? tx.paymentMethod ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Payer</span><span>{tx.member ? `${tx.member.firstName} ${tx.member.lastName}` : tx.source ?? "—"}</span></div>
          {tx.recordedBy && <div className="flex justify-between"><span className="text-text-muted">Recorded by</span><span>{tx.recordedBy.name}</span></div>}
        </div>
        <Field label="Legal entity">
          <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm">
            <option value="">— None —</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
        </Field>
        <Field label="Receipt">
          <ReceiptUpload value={receiptUrl} onChange={setReceiptUrl} />
        </Field>
        <div className="border-t border-app-border pt-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={markRefunded} onChange={(e) => setMarkRefunded(e.target.checked)} />
            <span className="text-text-primary">Mark as refunded / reversed</span>
          </label>
          <p className="text-[11px] text-text-muted mt-1">
            Owner-declared flag — this does not process a Stripe refund. For Stripe
            refunds, use the Stripe dashboard.
          </p>
          {markRefunded && (
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Field label="Refund amount">
                <input type="number" step="0.01" min={0} max={Number(tx.amount)}
                  value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
              </Field>
              <Field label="Reason">
                <select value={refundReason} onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm">
                  <option value="manual">Manual refund</option>
                  <option value="duplicate">Duplicate</option>
                  <option value="chargeback">Chargeback</option>
                  <option value="other">Other</option>
                </select>
              </Field>
            </div>
          )}
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <ModalActions saving={saving} label="Save" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ── Stripe ↔ AthletixOS reconciliation ── */
type ChargeReport = {
  ok: boolean;
  error?: string;
  scannedCharges: number;
  matched: number;
  missingLocal: { chargeId: string; amount: number; fee: number | null; net: number | null; customerEmail: string | null; description: string | null; created: string }[];
  unmatchedLocal: { transactionId: string; amount: number; description: string | null; createdAt: string }[];
  feeGaps: { transactionId: string; chargeId: string; fee: number; net: number }[];
  duplicates: { key: string; transactionIds: string[] }[];
  unrecordedRefunds: { chargeId: string; amountRefunded: number }[];
};

function ReconciliationCard() {
  const [report, setReport] = useState<ChargeReport | null>(null);
  const [openSubs, setOpenSubs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [filling, setFilling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setRunning(true); setMsg(null);
    try {
      const [charges, subs] = await Promise.all([
        fetch("/api/stripe/reconcile/charges").then((r) => r.json()),
        fetch("/api/stripe/reconcile").then((r) => (r.ok ? r.json() : null)),
      ]);
      setReport(charges);
      setOpenSubs(subs?.openCount ?? null);
      if (!charges.ok) setMsg(charges.error || "Comparison failed");
    } finally { setRunning(false); }
  }
  async function fillFees() {
    setFilling(true); setMsg(null);
    try {
      const r = await fetch("/api/stripe/reconcile/charges", { method: "POST" }).then((x) => x.json());
      setMsg(r.ok ? `Filled exact fee/net on ${r.filled} transaction(s).` : r.error || "Failed");
      await run();
    } finally { setFilling(false); }
  }

  return (
    <div className="bg-white rounded-xl border border-app-border mt-6 overflow-hidden">
      <div className="px-5 py-3 border-b border-app-border flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Reconciliation</h2>
          <p className="text-xs text-text-muted">Compare every Stripe charge against AthletixOS. Read-only — nothing changes without your action.</p>
        </div>
        <button onClick={run} disabled={running}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-charcoal text-white hover:bg-charcoal-hover disabled:opacity-50">
          {running ? "Comparing…" : "Run Stripe comparison"}
        </button>
      </div>
      {msg && <p className="px-5 pt-3 text-xs text-text-primary">{msg}</p>}
      {report?.ok && (
        <div className="p-5 space-y-4">
          <p className="text-xs text-text-muted">
            Scanned {report.scannedCharges} Stripe charge(s) · {report.matched} matched
            {openSubs != null ? ` · ${openSubs} subscription(s) awaiting review` : ""}
          </p>
          {report.missingLocal.length > 0 && (
            <div className="border border-orange-300 bg-orange-50 rounded-lg p-3">
              <p className="text-xs font-semibold text-orange-800 mb-1">
                {report.missingLocal.length} Stripe payment(s) missing from Financials
              </p>
              {report.missingLocal.map((m) => (
                <p key={m.chargeId} className="text-xs text-orange-900">
                  {new Date(m.created).toLocaleDateString()} · {money(m.amount)} ({m.customerEmail || m.description || m.chargeId})
                  {m.fee != null ? ` · fee ${money(m.fee)}` : ""}
                </p>
              ))}
              <p className="text-[11px] text-orange-700 mt-1">
                Recovered only via the owner-approved backfill (dedup-safe) — never created automatically.
              </p>
            </div>
          )}
          {report.unmatchedLocal.length > 0 && (
            <div className="border border-red-300 bg-red-50 rounded-lg p-3">
              <p className="text-xs font-semibold text-red-800 mb-1">
                {report.unmatchedLocal.length} local card record(s) with NO Stripe match
              </p>
              {report.unmatchedLocal.map((u) => (
                <p key={u.transactionId} className="text-xs text-red-900">
                  {new Date(u.createdAt).toLocaleDateString()} · {money(u.amount)} · {u.description || u.transactionId}
                </p>
              ))}
              <p className="text-[11px] text-red-700 mt-1">These claim Stripe money AthletixOS can&apos;t verify — review before counting them.</p>
            </div>
          )}
          {report.duplicates.length > 0 && (
            <div className="border border-red-300 bg-red-50 rounded-lg p-3">
              <p className="text-xs font-semibold text-red-800">
                {report.duplicates.length} duplicate group(s): multiple transactions share one Stripe payment
              </p>
              {report.duplicates.map((d) => (
                <p key={d.key} className="text-xs text-red-900">{d.key}: {d.transactionIds.join(", ")}</p>
              ))}
            </div>
          )}
          {report.unrecordedRefunds.length > 0 && (
            <div className="border border-amber-300 bg-amber-50 rounded-lg p-3">
              <p className="text-xs font-semibold text-amber-800">
                {report.unrecordedRefunds.length} Stripe refund(s) not recorded locally
              </p>
              {report.unrecordedRefunds.map((r) => (
                <p key={r.chargeId} className="text-xs text-amber-900">{r.chargeId}: {money(r.amountRefunded)} refunded</p>
              ))}
            </div>
          )}
          {report.feeGaps.length > 0 && (
            <div className="flex items-center justify-between border border-app-border rounded-lg p-3">
              <p className="text-xs text-text-primary">
                {report.feeGaps.length} matched transaction(s) missing exact Stripe fee/net.
              </p>
              <button onClick={fillFees} disabled={filling}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50">
                {filling ? "Filling…" : "Fill from Stripe"}
              </button>
            </div>
          )}
          {report.missingLocal.length === 0 && report.unmatchedLocal.length === 0 && report.duplicates.length === 0 &&
            report.unrecordedRefunds.length === 0 && report.feeGaps.length === 0 && (
            <p className="text-xs text-text-muted">Everything matches — Stripe and AthletixOS agree. ✓</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Bank / Plaid — persistent ledger + date-range filters ── */
type BankRange = "30" | "60" | "90" | "ytd" | "year" | "all" | "custom";
const BANK_RANGES: { key: BankRange; label: string }[] = [
  { key: "30", label: "30 days" },
  { key: "60", label: "60 days" },
  { key: "90", label: "90 days" },
  { key: "ytd", label: "Year to date" },
  { key: "year", label: "12 months" },
  { key: "all", label: "All time" },
];
type SyncStatusRow = { connectionId: string; lastSyncedAt: string | null; lastSyncError: string | null };
type BankDataV2 = {
  connected: boolean;
  accounts: BankAccount[];
  transactions: BankTx[];
  connections?: BankConnection[];
  earliestAvailableDate?: string | null;
  syncStatus?: SyncStatusRow[];
  pagination?: { total: number; page: number; pageSize: number };
};

function BankTab() {
  const [bankData, setBankData] = useState<BankDataV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [plaidError, setPlaidError] = useState<string | null>(null);
  const [plaidConfigured, setPlaidConfigured] = useState(true);
  // Owner-selected filter — when set, transactions/accounts are scoped
  // to just that bank connection. null = "All accounts".
  const [connectionFilter, setConnectionFilter] = useState<string | null>(null);
  const [range, setRange] = useState<BankRange>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const pageSize = 100;

  async function loadBankData(
    filterId: string | null = connectionFilter,
    rangeKey: BankRange = range,
    pageNum: number = page,
  ) {
    const params = new URLSearchParams();
    if (filterId) params.set("connectionId", filterId);
    params.set("range", rangeKey);
    if (rangeKey === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    params.set("page", String(pageNum));
    params.set("pageSize", String(pageSize));
    const res = await fetch(`/api/plaid/transactions?${params}`);
    if (res.ok) {
      const data = await res.json();
      if (data.error === "Plaid not configured") setPlaidConfigured(false);
      else setBankData(data);
    }
    setLoading(false);
  }
  useEffect(() => { loadBankData(null, range, 1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function applyRange(next: BankRange) {
    setRange(next);
    setPage(1);
    setLoading(true);
    loadBankData(connectionFilter, next, 1);
  }
  function applyCustom() {
    setPage(1);
    setLoading(true);
    loadBankData(connectionFilter, "custom", 1);
  }
  function goPage(next: number) {
    setPage(next);
    setLoading(true);
    loadBankData(connectionFilter, range, next);
  }

  async function runSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/plaid/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectionFilter ? { connectionId: connectionFilter } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncMsg(typeof data.error === "string" ? data.error : "Sync failed");
      } else {
        const total = (data.results || []).reduce(
          (s: number, r: { added: number; modified: number }) => s + r.added + r.modified,
          0,
        );
        setSyncMsg(`Synced ${total} update(s) from Plaid.`);
      }
      await loadBankData(connectionFilter, range, page);
    } finally {
      setSyncing(false);
    }
  }

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
    const res = await fetch("/api/plaid/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    setLinkToken(null);
    // Kick off the initial sync (full history) so the transaction table is
    // populated immediately. Ignoring the response body — the follow-up load
    // renders whatever landed.
    if (res.ok) {
      try {
        await fetch("/api/plaid/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch { /* non-fatal */ }
    }
    loadBankData(null, range, 1);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [range]);
  const { open: openPlaid, ready: plaidReady } = usePlaidLink({ token: linkToken || "", onSuccess });
  useEffect(() => { if (linkToken && plaidReady) openPlaid(); }, [linkToken, plaidReady, openPlaid]);

  async function disconnectAll() {
    if (!confirm("Disconnect ALL bank accounts? Manual entry will still work.")) return;
    await fetch("/api/plaid/transactions", { method: "DELETE" });
    setBankData(null);
    setConnectionFilter(null);
    loadBankData(null, range, 1);
  }

  async function disconnectOne(id: string, label: string) {
    if (!confirm(`Disconnect "${label}"? Other bank accounts stay connected.`)) return;
    await fetch(`/api/plaid/connections/${id}`, { method: "DELETE" });
    if (connectionFilter === id) setConnectionFilter(null);
    loadBankData(connectionFilter === id ? null : connectionFilter, range, 1);
  }

  async function renameConnection(id: string, current: string) {
    const next = window.prompt("Rename this bank account", current);
    if (next == null) return;
    await fetch(`/api/plaid/connections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: next.trim() || null }),
    });
    loadBankData(connectionFilter, range, page);
  }

  function applyFilter(id: string | null) {
    setConnectionFilter(id);
    setPage(1);
    setLoading(true);
    loadBankData(id, range, 1);
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
      {/* Date-range filter row + Sync CTA + earliest-available note. */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="flex gap-1 bg-app-bg rounded-lg p-1 flex-wrap">
          {BANK_RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => applyRange(r.key)}
              className={`text-xs px-3 py-1 rounded-md transition ${
                range === r.key ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={() => applyRange("custom")}
            className={`text-xs px-3 py-1 rounded-md transition ${
              range === "custom" ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"
            }`}
          >
            Custom
          </button>
        </div>
        <button
          onClick={runSync}
          disabled={syncing}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync from Plaid"}
        </button>
        {syncMsg && <span className="text-xs text-text-muted">{syncMsg}</span>}
      </div>
      {range === "custom" && (
        <div className="flex items-center gap-2 mb-3">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
            className="text-xs px-2 py-1 border border-app-border rounded" />
          <span className="text-xs text-text-muted">to</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
            className="text-xs px-2 py-1 border border-app-border rounded" />
          <button onClick={applyCustom} className="text-xs font-semibold px-3 py-1 rounded bg-charcoal text-white">
            Apply
          </button>
        </div>
      )}
      {bankData.earliestAvailableDate && range === "all" && (
        <p className="text-xs text-text-muted mb-3">
          We have bank history back to {new Date(bankData.earliestAvailableDate + "T00:00:00").toLocaleDateString()}.
          Older transactions aren&apos;t available from your bank.
        </p>
      )}
      {bankData.syncStatus && bankData.syncStatus.some((s) => s.lastSyncError) && (
        <div className="border border-red-300 bg-red-50 rounded-lg p-3 mb-3 text-xs text-red-800">
          Sync error on one or more banks — try again, or reconnect the bank.
        </div>
      )}

      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">
            Bank transactions
            {connectionFilter && connections.length > 1 ? (
              <span className="ml-2 text-xs font-normal text-text-muted">
                — {connections.find((c) => c.id === connectionFilter)?.label || "filtered"}
              </span>
            ) : null}
            {bankData.pagination && bankData.pagination.total > 0 && (
              <span className="ml-2 text-xs font-normal text-text-muted">
                — {bankData.pagination.total.toLocaleString()} row{bankData.pagination.total === 1 ? "" : "s"} in range
              </span>
            )}
          </h2>
          <button onClick={disconnectAll} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
            Disconnect all
          </button>
        </div>
        {bankData.transactions.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-sm">
            No transactions in this range.{" "}
            <button onClick={runSync} className="text-brand hover:underline">Sync from Plaid</button> to pull the latest.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-app-bg border-b border-app-border">
                <tr><Th>Date</Th><Th>Description</Th><Th>Bank</Th><Th>Category</Th><Th>Amount</Th><Th>Status</Th><Th></Th></tr>
              </thead>
              <tbody>
                {bankData.transactions.map((t) => (
                  <BankRow
                    key={t.id || t.transaction_id}
                    tx={t}
                    onReload={() => loadBankData(connectionFilter, range, page)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {bankData.pagination && bankData.pagination.total > pageSize && (
          <div className="px-5 py-3 border-t border-app-border flex items-center justify-between text-xs">
            <span className="text-text-muted">
              Page {page} of {Math.max(1, Math.ceil(bankData.pagination.total / pageSize))}
            </span>
            <div className="flex gap-1">
              <button disabled={page <= 1} onClick={() => goPage(page - 1)}
                className="px-3 py-1 rounded border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-40">
                Previous
              </button>
              <button
                disabled={page * pageSize >= bankData.pagination.total}
                onClick={() => goPage(page + 1)}
                className="px-3 py-1 rounded border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ── Bank row + Manage modal ── */
function bankRowStatus(t: BankTx): { label: string; cls: string } {
  if (t.markedAsTransfer) return { label: "Transfer", cls: "bg-app-bg text-text-muted" };
  if (t.excludedFromTax) return { label: "Excluded", cls: "bg-app-bg text-text-muted" };
  if (t.categorizedExpenseId) return { label: "Matched", cls: "bg-lime-accent/25 text-text-primary" };
  if (t.reviewedAt) return { label: "Categorized", cls: "bg-lime-accent/25 text-text-primary" };
  if (t.suggestedCategory) return { label: "Suggested", cls: "bg-brand/20 text-brand" };
  return { label: "Needs review", cls: "bg-orange-accent/15 text-orange-accent" };
}

function BankRow({ tx, onReload }: { tx: BankTx; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const status = bankRowStatus(tx);
  return (
    <>
      <tr className="border-b border-app-border last:border-0 hover:bg-app-bg">
        <Td><span className="text-xs text-text-muted">{new Date(tx.date + "T00:00:00").toLocaleDateString()}</span></Td>
        <Td>
          <div>
            <span className="text-sm text-text-primary">{tx.name}</span>
            {tx.merchantName && tx.merchantName !== tx.name && (
              <span className="text-[11px] text-text-muted block">{tx.merchantName}</span>
            )}
          </div>
        </Td>
        <Td><span className="text-xs text-text-muted">{tx.connectionLabel || "—"}</span></Td>
        <Td>
          <span className="text-xs text-text-muted">
            {tx.categoryOverride || tx.category?.[0] || "—"}
          </span>
        </Td>
        <Td><span className={`text-sm font-medium ${tx.amount > 0 ? "text-red-700" : "text-text-primary"}`}>{tx.amount > 0 ? "-" : "+"}{money(Math.abs(tx.amount))}</span></Td>
        <Td><span className={`text-xs px-2 py-0.5 rounded-full ${status.cls}`}>{status.label}</span></Td>
        <Td>
          <button onClick={() => setOpen(true)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
            Manage
          </button>
        </Td>
      </tr>
      {open && <BankRowManageModal tx={tx} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onReload(); }} />}
    </>
  );
}

function BankRowManageModal({ tx, onClose, onSaved }: { tx: BankTx; onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<"categorize" | "match">("categorize");
  const [category, setCategory] = useState<string>(tx.categoryOverride || tx.suggestedCategory || "OTHER");
  const [markTransfer, setMarkTransfer] = useState<boolean>(tx.markedAsTransfer || false);
  const [excludeTax, setExcludeTax] = useState<boolean>(tx.excludedFromTax || false);
  const [notes, setNotes] = useState(tx.notes || "");
  const [suggestions, setSuggestions] = useState<{ id: string; label: string; date: string; amount: number; score: number }[]>([]);
  const [loadingSug, setLoadingSug] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (tab !== "match" || !tx.id) return;
    setLoadingSug(true);
    fetch(`/api/plaid/transactions/${tx.id}/match`).then((r) => r.json()).then((d) => {
      setSuggestions(d.suggestions || []);
      setLoadingSug(false);
    });
  }, [tab, tx.id]);

  async function saveCategorize() {
    if (!tx.id) return;
    setSaving(true); setErr("");
    const res = await fetch(`/api/plaid/transactions/${tx.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryOverride: category || null,
        markedAsTransfer: markTransfer,
        excludedFromTax: excludeTax,
        notes,
        reviewed: true,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not save"); return; }
    onSaved();
  }

  async function confirmMatch(expenseId: string) {
    if (!tx.id) return;
    setSaving(true); setErr("");
    const res = await fetch(`/api/plaid/transactions/${tx.id}/match`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expenseId }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not match"); return; }
    onSaved();
  }

  async function createNewExpense() {
    if (!tx.id) return;
    setSaving(true); setErr("");
    const res = await fetch(`/api/plaid/transactions/${tx.id}/match`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        createExpense: {
          category,
          description: tx.name,
          vendor: tx.merchantName || undefined,
        },
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not create expense"); return; }
    onSaved();
  }

  return (
    <Modal title={`Manage · ${tx.name}`} onClose={onClose}>
      <div className="bg-app-bg rounded-lg p-3 space-y-1 text-xs mb-4">
        <div className="flex justify-between"><span className="text-text-muted">Date</span><span>{new Date(tx.date + "T00:00:00").toLocaleDateString()}</span></div>
        <div className="flex justify-between"><span className="text-text-muted">Amount</span>
          <span className={`font-medium ${tx.amount > 0 ? "text-red-700" : "text-text-primary"}`}>
            {tx.amount > 0 ? "-" : "+"}{money(Math.abs(tx.amount))}
          </span>
        </div>
        <div className="flex justify-between"><span className="text-text-muted">Bank</span><span>{tx.connectionLabel || "—"}</span></div>
      </div>

      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-4 w-fit">
        <button
          onClick={() => setTab("categorize")}
          className={`text-xs px-3 py-1 rounded-md ${tab === "categorize" ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"}`}
        >
          Categorize
        </button>
        {tx.amount > 0 && (
          <button
            onClick={() => setTab("match")}
            className={`text-xs px-3 py-1 rounded-md ${tab === "match" ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"}`}
          >
            Match to expense
          </button>
        )}
      </div>

      {tab === "categorize" && (
        <div className="space-y-4">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm">
              {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            {tx.suggestedCategory && !tx.categoryOverride && (
              <p className="text-[11px] text-text-muted mt-1">
                Suggested from vendor: {expenseCategoryLabel(tx.suggestedCategory)}
              </p>
            )}
          </Field>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={markTransfer} onChange={(e) => setMarkTransfer(e.target.checked)} />
              <span className="text-text-primary">Transfer between accounts</span>
            </label>
            <p className="text-[11px] text-text-muted ml-6">
              Transfers between the club&apos;s own accounts are neither income nor expense.
            </p>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={excludeTax} onChange={(e) => setExcludeTax(e.target.checked)} />
              <span className="text-text-primary">Exclude from Tax Summary</span>
            </label>
          </div>
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
          </Field>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveCategorize}
              disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {tab === "match" && (
        <div className="space-y-3">
          {loadingSug ? (
            <div className="text-sm text-text-muted">Looking for likely matches…</div>
          ) : suggestions.length === 0 ? (
            <div className="text-sm text-text-muted">
              No obvious matches within 3 days. Create a new expense from this row?
            </div>
          ) : (
            <ul className="divide-y divide-app-border border border-app-border rounded-lg">
              {suggestions.map((s) => (
                <li key={s.id} className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary truncate">{s.label}</div>
                    <div className="text-[11px] text-text-muted">
                      {new Date(s.date + "T00:00:00").toLocaleDateString()} · {money(s.amount)} · {(s.score * 100).toFixed(0)}% match
                    </div>
                  </div>
                  <button
                    disabled={saving}
                    onClick={() => confirmMatch(s.id)}
                    className="text-xs font-semibold px-3 py-1 rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                  >
                    Match
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-app-border pt-3">
            <p className="text-xs text-text-muted mb-2">Or create a new expense from this row:</p>
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm">
                {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Field>
            <button
              disabled={saving}
              onClick={createNewExpense}
              className="mt-3 w-full px-4 py-2 bg-charcoal text-white rounded-lg text-sm hover:bg-charcoal-hover disabled:opacity-50"
            >
              Create expense &amp; match
            </button>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      )}
    </Modal>
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
