"use client";

// Unified payout ledger (P2): record + track PENDING/PAID payouts to staff,
// guest clinicians, contractors, and event workers — separate from payroll.
// Recording money owed/paid; the platform never moves money here.

import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import {
  PAYEE_TYPES,
  PAYOUT_KINDS,
  PAYOUT_METHODS,
  PAYEE_TYPE_LABELS,
  PAYOUT_KIND_LABELS,
  payeeUsesContractor,
} from "@/lib/payouts";

type Payout = {
  id: string;
  payeeType: string;
  payeeUserId: string | null;
  contractorId: string | null;
  payeeName: string;
  kind: string;
  eventId: string | null;
  eventName: string | null;
  amount: number;
  status: string;
  method: string | null;
  paidAt: string | null;
  notes: string | null;
  createdAt: string;
};
type StaffOpt = { id: string; name: string; role: string };
type ContractorOpt = { id: string; name: string; role: string | null; active: boolean };
type EventOpt = { id: string; name: string; startsAt: string };
type Data = { payouts: Payout[]; staff: StaffOpt[]; contractors: ContractorOpt[]; events: EventOpt[] };

const statusStyle: Record<string, { bg: string; fg: string }> = {
  PENDING: { bg: "var(--color-warning)", fg: "#fff" },
  PAID: { bg: "var(--color-success)", fg: "#1F1F23" },
  VOID: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

const fmtMoney = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PayoutsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/payouts");
    if (res.ok) setData(await res.json());
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/payouts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) load();
    else alert("Update failed");
  }
  async function del(id: string) {
    if (!confirm("Delete this payout record?")) return;
    const res = await fetch(`/api/payouts/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  const payouts = data?.payouts ?? [];
  const filtered = payouts.filter(
    (p) =>
      (statusFilter === "ALL" || p.status === statusFilter) &&
      (typeFilter === "ALL" || p.payeeType === typeFilter),
  );
  const pending = payouts.filter((p) => p.status === "PENDING");
  const pendingTotal = pending.reduce((s, p) => s + p.amount, 0);
  const paidTotal = payouts.filter((p) => p.status === "PAID").reduce((s, p) => s + p.amount, 0);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      <PageHeader
        title="Payouts"
        description="Track money owed and paid to staff, guests, contractors, and event workers"
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
          >
            + Record payout
          </button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6">
        <div className="bg-surface rounded-xl border border-app-border p-4">
          <div className="text-[11px] uppercase tracking-wider text-text-muted">Pending</div>
          <div className="text-2xl font-semibold text-text-primary mt-1">{fmtMoney(pendingTotal)}</div>
          <div className="text-xs text-text-muted">{pending.length} payout{pending.length === 1 ? "" : "s"}</div>
        </div>
        <div className="bg-surface rounded-xl border border-app-border p-4">
          <div className="text-[11px] uppercase tracking-wider text-text-muted">Paid (all time)</div>
          <div className="text-2xl font-semibold text-text-primary mt-1">{fmtMoney(paidTotal)}</div>
        </div>
        <div className="bg-surface rounded-xl border border-app-border p-4 col-span-2 lg:col-span-1">
          <div className="text-[11px] uppercase tracking-wider text-text-muted">Records</div>
          <div className="text-2xl font-semibold text-text-primary mt-1">{payouts.length}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="ALL">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="PAID">Paid</option>
          <option value="VOID">Void</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="ALL">All payees</option>
          {PAYEE_TYPES.map((t) => (
            <option key={t} value={t}>{PAYEE_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-text-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <h3 className="text-lg font-medium text-text-primary mb-1">No payouts yet</h3>
            <p className="text-sm text-text-muted mb-4">Record a payout to staff, a guest clinician, a contractor, or an event worker.</p>
            <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Record payout</button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-app-bg border-b border-app-border">
                <tr>
                  {["Payee", "For", "Amount", "Status", "Date", ""].map((h) => (
                    <th key={h} className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const s = statusStyle[p.status] ?? statusStyle.VOID;
                  const date = p.status === "PAID" && p.paidAt ? new Date(p.paidAt) : new Date(p.createdAt);
                  return (
                    <tr key={p.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                      <td className="px-5 py-3">
                        <div className="text-sm font-medium text-text-primary">{p.payeeName}</div>
                        <div className="text-[11px] text-text-muted">{PAYEE_TYPE_LABELS[p.payeeType] ?? p.payeeType}</div>
                      </td>
                      <td className="px-5 py-3">
                        <div className="text-sm text-text-primary">{PAYOUT_KIND_LABELS[p.kind] ?? p.kind}</div>
                        {p.eventName && <div className="text-[11px] text-text-muted truncate max-w-[180px]">{p.eventName}</div>}
                        {p.notes && !p.eventName && <div className="text-[11px] text-text-muted truncate max-w-[180px]">{p.notes}</div>}
                      </td>
                      <td className="px-5 py-3 text-sm font-medium text-text-primary tabular-nums whitespace-nowrap">{fmtMoney(p.amount)}</td>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: s.bg, color: s.fg }}>
                          {p.status.charAt(0) + p.status.slice(1).toLowerCase()}
                        </span>
                        {p.method && p.status === "PAID" && <div className="text-[11px] text-text-muted mt-0.5">{p.method.toLowerCase()}</div>}
                      </td>
                      <td className="px-5 py-3 text-sm text-text-muted whitespace-nowrap tabular-nums">{date.toLocaleDateString()}</td>
                      <td className="px-5 py-3">
                        <div className="flex gap-1 justify-end whitespace-nowrap">
                          {p.status === "PENDING" && (
                            <button onClick={() => patch(p.id, { status: "PAID" })} className="text-xs text-text-primary border border-app-border px-2 py-1 rounded hover:bg-app-bg">Mark paid</button>
                          )}
                          {p.status !== "VOID" && p.status !== "PAID" && (
                            <button onClick={() => patch(p.id, { status: "VOID" })} className="text-xs text-text-muted px-2 py-1 rounded hover:bg-app-bg">Void</button>
                          )}
                          <button onClick={() => del(p.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && data && (
        <CreatePayoutModal
          staff={data.staff}
          contractors={data.contractors}
          events={data.events}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function CreatePayoutModal({
  staff,
  contractors,
  events,
  onClose,
  onSaved,
}: {
  staff: StaffOpt[];
  contractors: ContractorOpt[];
  events: EventOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [payeeType, setPayeeType] = useState<string>("STAFF");
  const [payeeUserId, setPayeeUserId] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [kind, setKind] = useState("OTHER");
  const [eventId, setEventId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("PENDING");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const usesContractor = payeeUsesContractor(payeeType);

  function pickStaff(id: string) {
    setPayeeUserId(id);
    const u = staff.find((s) => s.id === id);
    if (u) setPayeeName(u.name);
  }
  function pickContractor(id: string) {
    setContractorId(id);
    const c = contractors.find((x) => x.id === id);
    if (c) setPayeeName(c.name);
  }
  function pickEvent(id: string) {
    setEventId(id);
    if (id && kind === "OTHER") setKind("EVENT");
  }

  async function submit() {
    if (!payeeName.trim()) { setError("Choose a payee or enter a name."); return; }
    if (!amount || parseFloat(amount) <= 0) { setError("Enter an amount."); return; }
    setSaving(true);
    setError("");
    const res = await fetch("/api/payouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payeeType,
        payeeUserId: usesContractor ? null : payeeUserId || null,
        contractorId: usesContractor ? contractorId || null : null,
        payeeName: payeeName.trim(),
        kind,
        eventId: eventId || null,
        amount: parseFloat(amount),
        status,
        method: method || null,
        notes: notes.trim() || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not save payout.");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-base font-semibold text-text-primary">Record payout</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Payee type</label>
            <select
              value={payeeType}
              onChange={(e) => { setPayeeType(e.target.value); setPayeeUserId(""); setContractorId(""); setPayeeName(""); }}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
            >
              {PAYEE_TYPES.map((t) => (
                <option key={t} value={t}>{PAYEE_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          {usesContractor ? (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Contractor / guest on file</label>
              <select value={contractorId} onChange={(e) => pickContractor(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                <option value="">Select… (or just type a name below)</option>
                {contractors.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.role ? ` — ${c.role}` : ""}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Staff member</label>
              <select value={payeeUserId} onChange={(e) => pickStaff(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                <option value="">Select… (or just type a name below)</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Payee name</label>
            <input type="text" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Name on the payout" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">For</label>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                {PAYOUT_KINDS.map((k) => (
                  <option key={k} value={k}>{PAYOUT_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Amount</label>
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Link to event (optional)</label>
            <select value={eventId} onChange={(e) => pickEvent(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
              <option value="">None</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-text-muted mt-1">Use this for clinic/camp/tournament coaching pay — it&apos;s tracked separately from payroll.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                <option value="PENDING">Pending</option>
                <option value="PAID">Paid</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Method</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                <option value="">—</option>
                {PAYOUT_METHODS.map((m) => (
                  <option key={m} value={m}>{m.charAt(0) + m.slice(1).toLowerCase()}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm resize-none" />
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button onClick={submit} disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : "Record payout"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
