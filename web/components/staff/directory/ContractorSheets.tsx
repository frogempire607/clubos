"use client";

// Contractors & guests on the All staff list (2026-09-28). These are the
// no-login records that used to live on /dashboard/staff/contractors: name,
// contact, what they do, a W-9, payout notes, and a log of payments. The
// behaviour is the old page's — add, log / delete payments, archive, convert
// to a staff login — moved into Sheets, plus editing the details (PATCH was
// always there, the old page just never offered it). Every /api/contractors
// route is owner-only, so the list page only mounts these for owners.
import { useCallback, useEffect, useState } from "react";
import Sheet from "@/components/Sheet";

export type Contractor = {
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

type Detail = Omit<Contractor, "paymentCount" | "lastPaidAt"> & { payments: Payment[] };

export const money = (n: number | string) => `$${Number(n).toFixed(2)}`;

/**
 * "Guest" or "Contractor". The record has no type column — only the free-text
 * role ("Guest clinician", "Photographer", …) — so a role that says guest reads
 * as a guest and everything else as a contractor.
 */
export function contractorKind(role: string | null | undefined): "Guest" | "Contractor" {
  return /\bguest\b/i.test(role ?? "") ? "Guest" : "Contractor";
}

const inputCls =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand md:min-h-[38px]";
const labelCls = "mb-1 block text-[13px] font-medium text-text-primary";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-[13.5px] font-medium md:min-h-[36px]";
const btnPrimary = `${btn} bg-brand text-white hover:bg-brand-hover disabled:opacity-50`;
const btnSecondary = `${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`;

function errText(d: unknown, fallback: string) {
  const e = (d as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : fallback;
}

function ErrorLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface, transparent)", color: "var(--color-danger-text)" }}>
      {text}
    </p>
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
    if (!res.ok) {
      setErr(errText(d, "Upload failed"));
      return;
    }
    onChange(d.url);
  }

  return (
    <div>
      {value ? (
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <a href={value} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center text-brand hover:underline md:min-h-0">
            W-9 uploaded ✓
          </a>
          <button type="button" onClick={() => onChange(null)} className="inline-flex min-h-[44px] items-center px-2 text-[13px] text-text-muted hover:text-text-primary md:min-h-0">
            Remove
          </button>
        </div>
      ) : (
        <label className={`${btnSecondary} cursor-pointer`}>
          {busy ? "Uploading…" : "Upload W-9 (PDF)"}
          <input type="file" accept="application/pdf,image/*" className="hidden" onChange={upload} disabled={busy} />
        </label>
      )}
      {err && <p className="mt-1 text-[12px]" style={{ color: "var(--color-danger-text)" }}>{err}</p>}
    </div>
  );
}

type Fields = { name: string; email: string; phone: string; role: string; w9Url: string | null; payoutNotes: string };
const EMPTY: Fields = { name: "", email: "", phone: "", role: "", w9Url: null, payoutNotes: "" };

function DetailsForm({ value, onChange }: { value: Fields; onChange: (f: Fields) => void }) {
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const kind = contractorKind(value.role);
  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls}>Name *</label>
        <input value={value.name} onChange={set("name")} required className={inputCls} placeholder="Jordan Smith" />
      </div>
      <div>
        <span className={labelCls}>Type</span>
        <div className="inline-flex rounded-lg border border-app-border bg-app-bg p-0.5">
          {(["Contractor", "Guest"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => {
                if (k === kind) return;
                // Guest is read from the role text, so switching edits the role.
                const role =
                  k === "Guest"
                    ? value.role.trim()
                      ? `Guest ${value.role.trim()}`
                      : "Guest"
                    : value.role.replace(/\bguest\b\s*/i, "").trim();
                onChange({ ...value, role });
              }}
              className={`inline-flex min-h-[44px] min-w-[104px] items-center justify-center rounded-md px-3 text-[13px] font-medium md:min-h-[32px] ${
                kind === k ? "bg-surface text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className={labelCls}>Role</label>
        <input value={value.role} onChange={set("role")} className={inputCls} placeholder="Referee, Photographer, Guest clinician…" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Email</label>
          <input type="email" value={value.email} onChange={set("email")} className={inputCls} placeholder="jordan@example.com" />
        </div>
        <div>
          <label className={labelCls}>Phone</label>
          <input value={value.phone} onChange={set("phone")} className={inputCls} placeholder="(555) 555-5555" />
        </div>
      </div>
      <div>
        <span className={labelCls}>W-9</span>
        <DocUpload value={value.w9Url} onChange={(w9Url) => onChange({ ...value, w9Url })} />
        <p className="mt-1 text-[12px] text-text-muted">Provide an email or a W-9 so this person can be paid.</p>
      </div>
      <div>
        <label className={labelCls}>Payout notes</label>
        <textarea
          value={value.payoutNotes}
          onChange={set("payoutNotes")}
          rows={2}
          className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          placeholder="Venmo @jordan, $75/session, etc."
        />
      </div>
    </div>
  );
}

/* ── Add a contractor or guest ── */
export function AddContractorSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setF(EMPTY);
      setErr("");
    }
  }, [open]);

  async function submit() {
    if (!f.name.trim()) {
      setErr("Add a name.");
      return;
    }
    setSaving(true);
    setErr("");
    const res = await fetch("/api/contractors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f, name: f.name.trim(), w9Url: f.w9Url || "" }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setErr(errText(d, "Could not save"));
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a contractor or guest"
      description="No login — for guest clinicians, referees, photographers and other paid help. Log their payments here."
      footer={
        <>
          <button type="button" onClick={onClose} className={btnSecondary}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={saving} className={btnPrimary}>
            {saving ? "Saving…" : "Add"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <DetailsForm value={f} onChange={setF} />
        <ErrorLine text={err} />
      </div>
    </Sheet>
  );
}

/* ── One contractor: details, payments, archive, convert ── */
export function ContractorSheet({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Fields | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [service, setService] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [deletingPayment, setDeletingPayment] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "archive" | "convert">(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const r = await fetch(`/api/contractors/${id}`);
    setData(r.ok ? await r.json() : null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    setData(null);
    setEditing(null);
    setErr("");
    setDeletingPayment(null);
    setConfirm(null);
    load();
  }, [load]);

  async function saveDetails() {
    if (!id || !editing) return;
    if (!editing.name.trim()) {
      setErr("Add a name.");
      return;
    }
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/contractors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editing.name.trim(),
        email: editing.email.trim(),
        phone: editing.phone.trim() || null,
        role: editing.role.trim() || null,
        w9Url: editing.w9Url || null,
        payoutNotes: editing.payoutNotes.trim() || null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(errText(d, "Could not save"));
      return;
    }
    setEditing(null);
    await load();
    onChanged();
  }

  async function logPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/contractors/${id}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: parseFloat(amount), date, service, notes }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(errText(d, "Could not log payment"));
      return;
    }
    setAmount("");
    setService("");
    setNotes("");
    await load();
    onChanged();
  }

  async function removePayment(paymentId: string) {
    if (!id) return;
    setBusy(true);
    await fetch(`/api/contractors/${id}/payments?paymentId=${paymentId}`, { method: "DELETE" });
    setBusy(false);
    setDeletingPayment(null);
    await load();
    onChanged();
  }

  async function convertToStaff() {
    if (!id) return;
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/contractors/${id}/invite`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    setConfirm(null);
    if (!res.ok) {
      setErr(errText(d, "Could not convert"));
      return;
    }
    onChanged();
    onClose();
  }

  async function archive() {
    if (!id) return;
    setBusy(true);
    await fetch(`/api/contractors/${id}`, { method: "DELETE" });
    setBusy(false);
    setConfirm(null);
    onChanged();
    onClose();
  }

  const name = data?.name ?? "Contractor";
  const smallLabel = "mb-0.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted";

  return (
    <>
      <Sheet
        open={!!id}
        onClose={onClose}
        width={640}
        title={editing ? `Edit ${name}` : name}
        description={data ? `${contractorKind(data.role)}${data.role ? ` · ${data.role}` : ""} · no login` : undefined}
        footer={
          editing ? (
            <>
              <button type="button" onClick={() => { setEditing(null); setErr(""); }} className={btnSecondary}>
                Cancel
              </button>
              <button type="button" onClick={saveDetails} disabled={busy} className={btnPrimary}>
                {busy ? "Saving…" : "Save"}
              </button>
            </>
          ) : data ? (
            <>
              <button type="button" onClick={() => setConfirm("archive")} className={btnSecondary} style={{ color: "var(--color-danger-text)" }}>
                Archive
              </button>
              {!data.convertedUserId && (
                <button type="button" onClick={() => setConfirm("convert")} disabled={busy} className={`${btn} border border-brand text-brand hover:bg-brand/10 disabled:opacity-50`}>
                  Convert to staff login
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    name: data.name,
                    email: data.email ?? "",
                    phone: data.phone ?? "",
                    role: data.role ?? "",
                    w9Url: data.w9Url,
                    payoutNotes: data.payoutNotes ?? "",
                  })
                }
                className={btnPrimary}
              >
                Edit details
              </button>
            </>
          ) : undefined
        }
      >
        {loading || !data ? (
          <p className="py-8 text-center text-[14px] text-text-muted">{loading ? "Loading…" : "Couldn't load this record."}</p>
        ) : editing ? (
          <div className="space-y-4">
            <DetailsForm value={editing} onChange={setEditing} />
            <ErrorLine text={err} />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-4 text-[14px] sm:grid-cols-2">
              <div className="min-w-0">
                <p className={smallLabel}>Contact</p>
                <p className="break-words text-text-primary">{data.email || "—"}</p>
                {data.phone && <p className="text-text-muted">{data.phone}</p>}
              </div>
              <div>
                <p className={smallLabel}>Total paid</p>
                <p className="font-semibold text-text-primary">{money(data.totalPaid)}</p>
              </div>
              {data.w9Url && (
                <div>
                  <p className={smallLabel}>W-9</p>
                  <a href={data.w9Url} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center text-brand hover:underline md:min-h-0">
                    View document
                  </a>
                </div>
              )}
              {data.payoutNotes && (
                <div className="sm:col-span-2">
                  <p className={smallLabel}>Payout notes</p>
                  <p className="whitespace-pre-wrap text-text-primary">{data.payoutNotes}</p>
                </div>
              )}
              {data.convertedUserId && (
                <p className="text-[13px] text-text-muted sm:col-span-2">
                  Converted to a staff login — their staff row is on the All staff list. This record keeps the payment history.
                </p>
              )}
            </div>

            <ErrorLine text={err} />

            {!data.convertedUserId && (
              <form onSubmit={logPayment} className="rounded-lg border border-app-border bg-app-bg p-4">
                <p className="mb-3 text-[14px] font-medium text-text-primary">Log a payment</p>
                <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Amount"
                    aria-label="Amount"
                    className={inputCls}
                  />
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" className={inputCls} />
                  <input value={service} onChange={(e) => setService(e.target.value)} placeholder="Service" aria-label="Service" className={inputCls} />
                </div>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" className={`${inputCls} mb-3`} />
                <button type="submit" disabled={busy} className={btnPrimary}>
                  {busy ? "Saving…" : "Log payment"}
                </button>
              </form>
            )}

            <div>
              <p className="mb-2 text-[14px] font-medium text-text-primary">Payment history</p>
              {data.payments.length === 0 ? (
                <p className="py-3 text-[14px] text-text-muted">No payments logged yet.</p>
              ) : (
                <ul className="overflow-hidden rounded-lg border border-app-border">
                  {data.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-app-border px-3 py-2 text-[13px] last:border-b-0">
                      <span className="w-24 shrink-0 text-text-muted">{new Date(p.date).toLocaleDateString()}</span>
                      <span className="w-20 shrink-0 font-medium text-text-primary">{money(p.amount)}</span>
                      <span className="min-w-0 flex-1 truncate text-text-muted">
                        {[p.service, p.notes].filter(Boolean).join(" · ") || "—"}
                      </span>
                      {deletingPayment === p.id ? (
                        <span className="flex items-center gap-1">
                          <button type="button" onClick={() => setDeletingPayment(null)} className="inline-flex min-h-[44px] items-center px-2 text-text-muted hover:text-text-primary md:min-h-[28px]">
                            Keep
                          </button>
                          <button
                            type="button"
                            onClick={() => removePayment(p.id)}
                            disabled={busy}
                            className="inline-flex min-h-[44px] items-center px-2 font-medium md:min-h-[28px]"
                            style={{ color: "var(--color-danger-text)" }}
                          >
                            Delete payment
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setDeletingPayment(p.id)} className="inline-flex min-h-[44px] items-center px-2 text-text-muted hover:text-text-primary md:min-h-[28px]">
                          Delete
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Sheet>

      <Sheet
        open={confirm === "archive"}
        onClose={() => setConfirm(null)}
        title={`Archive ${name}?`}
        description="They leave the list. Payment history is kept for accounting."
        footer={
          <>
            <button type="button" onClick={() => setConfirm(null)} className={btnSecondary}>
              Keep
            </button>
            <button type="button" onClick={archive} disabled={busy} className={`${btn} bg-red-600 text-white hover:bg-red-700 disabled:opacity-50`}>
              {busy ? "Archiving…" : "Archive"}
            </button>
          </>
        }
      />
      <Sheet
        open={confirm === "convert"}
        onClose={() => setConfirm(null)}
        title={`Give ${name} a staff login?`}
        description="They become a staff member with default access and get a login and a temporary password by email. You can set their access on their profile afterwards."
        footer={
          <>
            <button type="button" onClick={() => setConfirm(null)} className={btnSecondary}>
              Not now
            </button>
            <button type="button" onClick={convertToStaff} disabled={busy} className={btnPrimary}>
              {busy ? "Converting…" : "Convert to staff"}
            </button>
          </>
        }
      />
    </>
  );
}
