"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

type Sub = {
  id: string;
  optionLabel: string;
  price: string;
  billingPeriod: string | null;
  billingType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  startedAt: string | null;
  canceledAt: string | null;
  notes: string | null;
  membership: { name: string } | null;
};

type Relationship = {
  id: string;
  type: string;
  note: string | null;
  other: { id: string; firstName: string; lastName: string; status: string };
};

type MemberDetail = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  dateOfBirth: string | null;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  joinedAt: string;
  tags: string;
  notes: string | null;
  profileImageUrl: string | null;
  membership: { name: string } | null;
  subscriptions: Sub[];
  transactions: { id: string; amount: string; type: string; status: string; description: string | null; createdAt: string }[];
  bookings: { id: string; status: string; event: { id: string; name: string; type: string; startsAt: string } | null }[];
  attendanceRecords: { id: string; status: string; createdAt: string; classSession: { startsAt: string; recurringClass: { name: string } | null } | null }[];
  eventRegistrations: { id: string; status: string; amountDue: string | null; amountPaid: string | null; event: { id: string; name: string; startsAt: string } | null }[];
  relationships: Relationship[];
  migrationStatus?: string | null;
  legacyMembershipName?: string | null;
};

const statusColors: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: "var(--color-success)", fg: "#1F1F23" },
  PROSPECT: { bg: "var(--color-warning)", fg: "#fff" },
  INACTIVE: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  PAUSED: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  MIGRATING: { bg: "#1F1F23", fg: "#fff" },
};

const REL_TYPES = ["SIBLING", "COUSIN", "FRIEND", "TEAMMATE", "PARENT", "CHILD", "SPOUSE", "OTHER"];

function fmtDate(d: string | null) {
  return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}
function fmtMoney(v: string | number | null) {
  if (v == null) return "—";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function MemberProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [m, setM] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSub, setEditingSub] = useState<Sub | null>(null);
  const [addingRel, setAddingRel] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/members/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setM(d); setLoading(false); });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;
  if (!m) return <div className="p-8 text-center text-text-muted text-sm">Member not found.</div>;

  // Mid-migration members sit as PROSPECT in the DB but are existing members
  // being switched over — show them as "Migrating", not "Prospect".
  const displayStatus =
    m.status === "PROSPECT" && m.migrationStatus && m.migrationStatus !== "COMPLETED"
      ? "MIGRATING"
      : m.status;
  const sc = statusColors[displayStatus] ?? statusColors.INACTIVE;
  const activeSub = m.subscriptions.find((s) => s.status === "active");
  const pastSubs = m.subscriptions.filter((s) => s.status !== "active");

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link href="/dashboard/members" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Back to members
      </Link>

      {/* Header */}
      <div className="mt-3 mb-6 flex items-start gap-4">
        <div className="w-16 h-16 rounded-full bg-app-border flex items-center justify-center text-lg font-semibold text-text-primary overflow-hidden flex-shrink-0">
          {m.profileImageUrl
            ? <img src={m.profileImageUrl} alt="" className="w-full h-full object-cover" />
            : <>{m.firstName[0]}{m.lastName[0]}</>}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold text-text-primary">{m.firstName} {m.lastName}</h1>
            <span className="inline-flex items-center whitespace-nowrap text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: sc.bg, color: sc.fg }}>
              {displayStatus === "MIGRATING"
                ? "Migrating"
                : m.status.charAt(0) + m.status.slice(1).toLowerCase()}
            </span>
            {displayStatus === "MIGRATING" && m.legacyMembershipName && (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-muted"
                title="Imported plan from the previous software — billing starts after activation & approval."
              >
                {m.legacyMembershipName}
              </span>
            )}
            {/* Distinguish an activated account from a paying member: ACTIVE with
                no active subscription means the account exists but isn't on a plan. */}
            {m.status === "ACTIVE" && !activeSub && (
              <span
                className="inline-flex items-center whitespace-nowrap text-xs px-2 py-0.5 rounded-full bg-orange-accent/20 text-text-primary"
                title="This account is activated but has no active paid membership."
              >
                No membership
              </span>
            )}
            {m.isMinor && <span className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-muted">Minor</span>}
          </div>
          <div className="text-sm text-text-muted mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
            {m.email && <span>{m.email}</span>}
            {m.phone && <span>{m.phone}</span>}
            <span>Joined {fmtDate(m.joinedAt)}</span>
            {m.dateOfBirth && <span>DOB {fmtDate(m.dateOfBirth)}</span>}
          </div>
          {m.isMinor && m.guardianName && (
            <div className="text-xs text-text-muted mt-1">
              Guardian: {m.guardianName}{m.guardianEmail ? ` · ${m.guardianEmail}` : ""}{m.guardianPhone ? ` · ${m.guardianPhone}` : ""}
            </div>
          )}
          {m.tags.trim() && (
            <div className="flex gap-1 flex-wrap mt-2">
              {m.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-primary">{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Current membership */}
        <Card title="Current membership">
          {activeSub ? (
            <SubRow sub={activeSub} onEdit={() => setEditingSub(activeSub)} />
          ) : (
            <p className="text-sm text-text-muted">No active membership.</p>
          )}
        </Card>

        {/* Relationships */}
        <Card
          title="Relationships"
          action={<button onClick={() => setAddingRel(true)} className="text-xs text-brand hover:underline">+ Link member</button>}
        >
          {m.relationships.length === 0 ? (
            <p className="text-sm text-text-muted">No linked members.</p>
          ) : (
            <ul className="space-y-1.5">
              {m.relationships.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span>
                    <Link href={`/dashboard/members/${r.other.id}`} className="text-text-primary hover:underline font-medium">
                      {r.other.firstName} {r.other.lastName}
                    </Link>
                    <span className="text-text-muted ml-2 text-xs">
                      {r.type.charAt(0) + r.type.slice(1).toLowerCase()}{r.note ? ` · ${r.note}` : ""}
                    </span>
                  </span>
                  <button
                    onClick={async () => {
                      if (!confirm("Remove this relationship?")) return;
                      await fetch(`/api/members/${id}/relationships?relationshipId=${r.id}`, { method: "DELETE" });
                      load();
                    }}
                    className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Membership history */}
        <Card title="Membership history" className="lg:col-span-2">
          {m.subscriptions.length === 0 ? (
            <p className="text-sm text-text-muted">No membership history.</p>
          ) : (
            <div className="space-y-2">
              {[activeSub, ...pastSubs].filter(Boolean).map((s) => (
                <SubRow key={s!.id} sub={s!} onEdit={() => setEditingSub(s!)} />
              ))}
            </div>
          )}
        </Card>

        {/* Bookings */}
        <Card title="Event bookings">
          {m.bookings.length === 0 ? (
            <p className="text-sm text-text-muted">No bookings.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {m.bookings.map((b) => (
                <li key={b.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">{b.event?.name ?? "—"}</span>
                  <span className="text-xs text-text-muted">
                    {b.event ? fmtDate(b.event.startsAt) : ""} · {b.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Attendance */}
        <Card title="Attendance">
          {m.attendanceRecords.length === 0 ? (
            <p className="text-sm text-text-muted">No attendance records.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {m.attendanceRecords.map((a) => (
                <li key={a.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">
                    {a.classSession?.recurringClass?.name ?? "Session"}
                  </span>
                  <span className="text-xs text-text-muted">
                    {a.classSession ? fmtDate(a.classSession.startsAt) : fmtDate(a.createdAt)} · {a.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Event registrations */}
        <Card title="Tournament / event registrations">
          {m.eventRegistrations.length === 0 ? (
            <p className="text-sm text-text-muted">No registrations.</p>
          ) : (
            <ul className="space-y-1.5">
              {m.eventRegistrations.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">{r.event?.name ?? "—"}</span>
                  <span className="text-xs text-text-muted">
                    {r.status}{r.amountDue ? ` · due ${fmtMoney(r.amountDue)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Transactions */}
        <Card title="Recent transactions">
          {m.transactions.length === 0 ? (
            <p className="text-sm text-text-muted">No transactions.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {m.transactions.map((t) => (
                <li key={t.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">{t.description || t.type}</span>
                  <span className="text-xs text-text-muted">{fmtMoney(t.amount)} · {fmtDate(t.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {editingSub && (
        <EditSubModal
          sub={editingSub}
          onClose={() => setEditingSub(null)}
          onSaved={() => { setEditingSub(null); load(); }}
        />
      )}
      {addingRel && (
        <AddRelationshipModal
          memberId={id}
          onClose={() => setAddingRel(false)}
          onSaved={() => { setAddingRel(false); load(); }}
        />
      )}
    </div>
  );
}

function Card({ title, action, children, className = "" }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border border-app-border rounded-xl p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function SubRow({ sub, onEdit }: { sub: Sub; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between border border-app-border rounded-lg p-3">
      <div>
        <div className="text-sm font-medium text-text-primary">
          {sub.membership?.name ?? "Membership"} <span className="text-text-muted font-normal">· {sub.optionLabel}</span>
        </div>
        <div className="text-xs text-text-muted">
          {fmtMoney(sub.price)} · {sub.billingType.toLowerCase()} · {sub.status}
        </div>
        <div className="text-xs text-text-muted">
          {fmtDate(sub.startDate)} → {sub.endDate ? fmtDate(sub.endDate) : "open-ended"}
        </div>
        {sub.notes && <div className="text-xs text-text-muted mt-0.5 italic">{sub.notes}</div>}
      </div>
      <button onClick={onEdit} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
        Edit dates
      </button>
    </div>
  );
}

function EditSubModal({ sub, onClose, onSaved }: { sub: Sub; onClose: () => void; onSaved: () => void }) {
  const [startDate, setStartDate] = useState(sub.startDate ? sub.startDate.slice(0, 10) : "");
  const [endDate, setEndDate] = useState(sub.endDate ? sub.endDate.slice(0, 10) : "");
  const [status, setStatus] = useState(sub.status);
  const [price, setPrice] = useState(sub.price != null ? String(sub.price) : "");
  const [notes, setNotes] = useState(sub.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/members/subscriptions/${sub.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: startDate || null,
        endDate: endDate || null,
        status,
        notes: notes || null,
        ...(price.trim() !== "" ? { price: parseFloat(price) } : {}),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    const d = await res.json().catch(() => ({}));
    if (d.stripeNote) {
      setInfo(d.stripeNote);
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Edit subscription</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-xs text-text-muted">
            Adjusts the AthletixOS record only. Stripe's billing cycle is unchanged — use the Stripe portal for that.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Start date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">End date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                {["pending", "active", "past_due", "canceled", "expired"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Price ($)</label>
              <input type="number" min="0" step="0.01" value={price}
                onChange={(e) => setPrice(e.target.value)} placeholder="0.00"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Notes</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          {info && (
            <div className="text-sm text-text-primary bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {info}
            </div>
          )}
          <div className="flex gap-2">
            {info ? (
              <button onClick={onSaved} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
                Done
              </button>
            ) : (
              <>
                <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
                <button onClick={save} disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AddRelationshipModal({ memberId, onClose, onSaved }: { memberId: string; onClose: () => void; onSaved: () => void }) {
  const [members, setMembers] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [relatedMemberId, setRelatedMemberId] = useState("");
  const [type, setType] = useState("SIBLING");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/members")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: { id: string; firstName: string; lastName: string }[]) =>
        setMembers(d.filter((x) => x.id !== memberId)));
  }, [memberId]);

  const filtered = members.filter((x) =>
    `${x.firstName} ${x.lastName}`.toLowerCase().includes(search.toLowerCase())
  ).slice(0, 50);

  async function save() {
    if (!relatedMemberId) { setError("Pick a member."); return; }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/members/${memberId}/relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relatedMemberId, type, note: note || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Failed to link");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Link a member</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Relationship</label>
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
              {REL_TYPES.map((t) => (
                <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Member</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface mb-2"
            />
            <div className="max-h-48 overflow-y-auto border border-app-border rounded-lg">
              {filtered.map((x) => (
                <button
                  key={x.id}
                  onClick={() => setRelatedMemberId(x.id)}
                  className={`w-full text-left px-3 py-2 text-sm border-b border-app-border last:border-0 ${
                    relatedMemberId === x.id ? "bg-brand/10 text-brand" : "text-text-primary hover:bg-app-bg"
                  }`}
                >
                  {x.firstName} {x.lastName}
                </button>
              ))}
              {filtered.length === 0 && <div className="px-3 py-2 text-sm text-text-muted">No matches.</div>}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Note (optional)</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button onClick={save} disabled={saving || !relatedMemberId} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Linking…" : "Link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
