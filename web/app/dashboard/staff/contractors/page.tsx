"use client";

import { useEffect, useState } from "react";

type Contractor = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  w9Url: string | null;
  payoutNotes: string | null;
  active: boolean;
  convertedUserId: string | null;
  paymentCount: number;
  totalPaid: number;
  lastPaidAt: string | null;
};

type Payment = {
  id: string;
  amount: string | number;
  date: string;
  service: string | null;
  notes: string | null;
};

const money = (n: number | string) => `$${Number(n).toFixed(2)}`;

export default function ContractorsPage() {
  const [list, setList] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/contractors")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { setList(Array.isArray(d) ? d : []); setLoading(false); });
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Guest Coaches & Contractors</h1>
          <p className="text-sm text-text-muted mt-1">
            Lightweight records for guest clinicians, referees, photographers, and other contractors.
            No login required — log payments here and export for accounting.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <a
            href="/api/contractors/export"
            className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg transition"
          >
            Export payments
          </a>
          <button
            onClick={() => setShowAdd(true)}
            className="text-sm px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover transition"
          >
            + Add contractor
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-text-muted text-center py-12">Loading…</div>
      ) : list.length === 0 ? (
        <div className="bg-surface rounded-xl border border-app-border p-12 text-center">
          <p className="text-base font-medium text-text-primary mb-1">No contractors yet</p>
          <p className="text-sm text-text-muted mb-4">
            Add a guest coach, referee, or contractor to start logging payments.
          </p>
          <button onClick={() => setShowAdd(true)} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover">
            Add your first contractor
          </button>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-app-border bg-app-bg/40">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Contact</th>
                <th className="px-4 py-2.5 font-medium">Total paid</th>
                <th className="px-4 py-2.5 font-medium">Last paid</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-app-border last:border-0">
                  <td className="px-4 py-3">
                    <p className="text-text-primary font-medium">{c.name}</p>
                    {c.w9Url && (
                      <a href={c.w9Url} target="_blank" rel="noreferrer" className="text-[11px] text-brand hover:underline">W-9 on file</a>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-muted">{c.role || "—"}</td>
                  <td className="px-4 py-3 text-text-muted text-xs">
                    <p>{c.email || "—"}</p>
                    {c.phone && <p>{c.phone}</p>}
                  </td>
                  <td className="px-4 py-3 text-text-primary font-medium">
                    {money(c.totalPaid)}
                    <span className="text-text-muted font-normal text-xs"> · {c.paymentCount}</span>
                  </td>
                  <td className="px-4 py-3 text-text-muted text-xs">
                    {c.lastPaidAt ? new Date(c.lastPaidAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {c.convertedUserId ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/10 text-brand font-medium">Converted to staff</span>
                    ) : c.active ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-lime-accent/20 text-text-primary font-medium">Active</span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">Archived</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setDetailId(c.id)}
                      className="text-xs px-2.5 py-1 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddContractorModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />
      )}
      {detailId && (
        <ContractorDetailModal
          id={detailId}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

/* ── W-9 / document upload (PDF or image) ── */
function DocUpload({ value, onChange }: { value: string | null; onChange: (url: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setErr("");
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
          <a href={value} target="_blank" rel="noreferrer" className="text-brand hover:underline">W-9 uploaded ✓</a>
          <button type="button" onClick={() => onChange(null)} className="text-xs text-text-muted hover:text-text-primary">Remove</button>
        </div>
      ) : (
        <label className="inline-block text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg cursor-pointer">
          {busy ? "Uploading…" : "Upload W-9 (PDF)"}
          <input type="file" accept="application/pdf,image/*" className="hidden" onChange={upload} disabled={busy} />
        </label>
      )}
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
    </div>
  );
}

function AddContractorModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  const [w9Url, setW9Url] = useState<string | null>(null);
  const [payoutNotes, setPayoutNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    const res = await fetch("/api/contractors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, role, w9Url: w9Url || "", payoutNotes }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not save"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md border border-app-border max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Add contractor</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" placeholder="Jordan Smith" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Role</label>
            <input value={role} onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" placeholder="Referee, Photographer, Guest clinician…" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" placeholder="jordan@example.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" placeholder="(555) 555-5555" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">W-9</label>
            <DocUpload value={w9Url} onChange={setW9Url} />
            <p className="text-xs text-text-muted mt-1">Provide an email or a W-9 so this contractor can be paid.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Payout notes</label>
            <textarea value={payoutNotes} onChange={(e) => setPayoutNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" placeholder="Venmo @jordan, $75/session, etc." />
          </div>
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="text-sm px-4 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : "Add contractor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ContractorDetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<(Contractor & { payments: Payment[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [service, setService] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function load() {
    setLoading(true);
    fetch(`/api/contractors/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }
  useEffect(() => { load(); }, [id]);

  async function logPayment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/contractors/${id}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: parseFloat(amount), date, service, notes }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not log payment"); return; }
    setAmount(""); setService(""); setNotes("");
    load();
    onChanged();
  }

  async function removePayment(paymentId: string) {
    if (!confirm("Delete this payment record?")) return;
    await fetch(`/api/contractors/${id}/payments?paymentId=${paymentId}`, { method: "DELETE" });
    load();
    onChanged();
  }

  async function convertToStaff() {
    if (!confirm("Convert this contractor into a full staff member? They'll get a login and a temp password by email.")) return;
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/contractors/${id}/invite`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not convert"); return; }
    onChanged();
    onClose();
  }

  async function archive() {
    if (!confirm("Archive this contractor? Payment history is kept for accounting.")) return;
    await fetch(`/api/contractors/${id}`, { method: "DELETE" });
    onChanged();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-2xl border border-app-border max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{data?.name ?? "Contractor"}</h2>
            {data?.role && <p className="text-xs text-text-muted">{data.role}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading || !data ? (
            <p className="text-sm text-text-muted text-center py-8">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 mb-5 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Contact</p>
                  <p className="text-text-primary">{data.email || "—"}</p>
                  {data.phone && <p className="text-text-muted">{data.phone}</p>}
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Total paid</p>
                  <p className="text-text-primary font-semibold">{money(data.totalPaid)}</p>
                </div>
                {data.w9Url && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">W-9</p>
                    <a href={data.w9Url} target="_blank" rel="noreferrer" className="text-brand hover:underline">View document</a>
                  </div>
                )}
                {data.payoutNotes && (
                  <div className="col-span-2">
                    <p className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">Payout notes</p>
                    <p className="text-text-primary whitespace-pre-wrap">{data.payoutNotes}</p>
                  </div>
                )}
              </div>

              {!data.convertedUserId && (
                <form onSubmit={logPayment} className="bg-app-bg/50 border border-app-border rounded-lg p-4 mb-5">
                  <p className="text-sm font-medium text-text-primary mb-3">Log a payment / service</p>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <input type="number" step="0.01" min="0" required value={amount} onChange={(e) => setAmount(e.target.value)}
                      placeholder="Amount" className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                      className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
                    <input value={service} onChange={(e) => setService(e.target.value)}
                      placeholder="Service" className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
                  </div>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)"
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface mb-2" />
                  {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
                  <button type="submit" disabled={busy} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
                    {busy ? "Saving…" : "Log payment"}
                  </button>
                </form>
              )}

              <p className="text-sm font-medium text-text-primary mb-2">Payment history</p>
              {data.payments.length === 0 ? (
                <p className="text-sm text-text-muted py-3">No payments logged yet.</p>
              ) : (
                <div className="border border-app-border rounded-lg overflow-hidden mb-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-app-border bg-app-bg/40">
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Amount</th>
                        <th className="px-3 py-2 font-medium">Service</th>
                        <th className="px-3 py-2 font-medium">Notes</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payments.map((p) => (
                        <tr key={p.id} className="border-b border-app-border last:border-0">
                          <td className="px-3 py-2 text-text-muted">{new Date(p.date).toLocaleDateString()}</td>
                          <td className="px-3 py-2 text-text-primary font-medium">{money(p.amount)}</td>
                          <td className="px-3 py-2 text-text-muted">{p.service || "—"}</td>
                          <td className="px-3 py-2 text-text-muted">{p.notes || "—"}</td>
                          <td className="px-3 py-2 text-right">
                            <button onClick={() => removePayment(p.id)} className="text-xs text-text-muted hover:text-red-600">Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex gap-2 justify-between border-t border-app-border pt-4">
                <button onClick={archive} className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-muted hover:text-red-600 hover:border-red-200">
                  Archive
                </button>
                {!data.convertedUserId && (
                  <button onClick={convertToStaff} disabled={busy} className="text-sm px-3 py-2 border border-brand text-brand rounded-lg hover:bg-brand/10 disabled:opacity-50">
                    Convert to staff member
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
