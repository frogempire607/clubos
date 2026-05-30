"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";

// ─── Types ────────────────────────────────────────────────────────────────────

type AvailabilitySlot = {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  active: boolean;
};

type AvailabilityException = {
  id: string;
  date: string;
  type: "UNAVAILABLE" | "PARTIAL";
  startTime: string | null;
  endTime: string | null;
  note: string | null;
};

type StaffMember = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ─── AvailabilityEditor ───────────────────────────────────────────────────────

function AvailabilityEditor({ staffId }: { staffId: string }) {
  const [slots, setSlots]       = useState<AvailabilitySlot[]>([]);
  const [exceptions, setExceptions] = useState<AvailabilityException[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);

  // Draft state for editing
  const [draft, setDraft] = useState<{ dayOfWeek: number; startTime: string; endTime: string; active: boolean }[]>([]);
  const [showAddException, setShowAddException] = useState(false);
  const [excForm, setExcForm] = useState({ date: "", type: "UNAVAILABLE" as "UNAVAILABLE" | "PARTIAL", startTime: "", endTime: "", note: "" });
  const [excSaving, setExcSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [aRes, eRes] = await Promise.all([
      fetch(`/api/staff/${staffId}/availability`),
      fetch(`/api/staff/${staffId}/availability/exceptions`),
    ]);
    const [a, e] = await Promise.all([aRes.json(), eRes.json()]);
    setSlots(Array.isArray(a) ? a : []);
    setExceptions(Array.isArray(e) ? e : []);

    // Build draft from existing slots
    const existing: typeof draft = Array.isArray(a) ? a.map((s: AvailabilitySlot) => ({
      dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, active: s.active,
    })) : [];
    setDraft(existing);
    setLoading(false);
  }, [staffId]);

  useEffect(() => { load(); }, [load]);

  function addSlot() {
    setDraft((d) => [...d, { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", active: true }]);
  }

  function removeSlot(i: number) {
    setDraft((d) => d.filter((_, idx) => idx !== i));
  }

  function updateSlot(i: number, key: string, value: string | number | boolean) {
    setDraft((d) => d.map((s, idx) => idx === i ? { ...s, [key]: value } : s));
  }

  async function saveAvailability() {
    setSaving(true);
    await fetch(`/api/staff/${staffId}/availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slots: draft }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    load();
  }

  async function deleteException(id: string) {
    if (!confirm("Remove this exception?")) return;
    await fetch(`/api/staff/${staffId}/availability/exceptions?exceptionId=${id}`, { method: "DELETE" });
    load();
  }

  async function addException(e: React.FormEvent) {
    e.preventDefault();
    setExcSaving(true);
    await fetch(`/api/staff/${staffId}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: excForm.date,
        type: excForm.type,
        startTime: excForm.type === "PARTIAL" ? excForm.startTime : null,
        endTime:   excForm.type === "PARTIAL" ? excForm.endTime : null,
        note:      excForm.note || null,
      }),
    });
    setExcSaving(false);
    setShowAddException(false);
    setExcForm({ date: "", type: "UNAVAILABLE", startTime: "", endTime: "", note: "" });
    load();
  }

  if (loading) return <div className="text-sm text-text-muted py-8 text-center">Loading…</div>;

  return (
    <div className="space-y-6">
      {/* Weekly availability */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Weekly availability</h3>
          <button onClick={addSlot} className="text-xs text-text-muted hover:text-text-primary border border-app-border px-2 py-1 rounded">
            + Add slot
          </button>
        </div>

        {draft.length === 0 ? (
          <p className="text-sm text-text-muted">No availability set. Add slots above.</p>
        ) : (
          <div className="space-y-2">
            {draft.map((slot, i) => (
              <div key={i} className="flex items-center gap-2 bg-app-bg rounded-lg px-3 py-2">
                <select className="border border-app-border rounded px-2 py-1 text-sm flex-shrink-0"
                  value={slot.dayOfWeek} onChange={(e) => updateSlot(i, "dayOfWeek", parseInt(e.target.value))}>
                  {DAY_NAMES.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
                </select>
                <input type="time" className="border border-app-border rounded px-2 py-1 text-sm"
                  value={slot.startTime} onChange={(e) => updateSlot(i, "startTime", e.target.value)} />
                <span className="text-text-muted text-sm">–</span>
                <input type="time" className="border border-app-border rounded px-2 py-1 text-sm"
                  value={slot.endTime} onChange={(e) => updateSlot(i, "endTime", e.target.value)} />
                <label className="flex items-center gap-1 text-xs text-text-muted ml-2">
                  <input type="checkbox" checked={slot.active} onChange={(e) => updateSlot(i, "active", e.target.checked)} />
                  Active
                </label>
                <button onClick={() => removeSlot(i)} className="ml-auto text-text-muted hover:text-red-500 text-lg leading-none">×</button>
              </div>
            ))}
          </div>
        )}

        <button onClick={saveAvailability} disabled={saving}
          className="mt-3 px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save availability"}
        </button>
      </div>

      {/* Exceptions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Exceptions / time off</h3>
          <button onClick={() => setShowAddException(true)}
            className="text-xs text-text-muted hover:text-text-primary border border-app-border px-2 py-1 rounded">
            + Add exception
          </button>
        </div>

        {exceptions.length === 0 ? (
          <p className="text-sm text-text-muted">No exceptions set.</p>
        ) : (
          <div className="space-y-2">
            {exceptions.map((exc) => (
              <div key={exc.id} className="flex items-center gap-3 bg-red-50 rounded-lg px-3 py-2 text-sm">
                <span className="font-medium text-text-primary">{new Date(exc.date).toLocaleDateString()}</span>
                <span className="text-text-muted">{exc.type === "UNAVAILABLE" ? "Full day off" : `Partial: ${exc.startTime}–${exc.endTime}`}</span>
                {exc.note && <span className="text-text-muted italic">"{exc.note}"</span>}
                <button onClick={() => deleteException(exc.id)} className="ml-auto text-text-muted hover:text-red-500 text-xs">Remove</button>
              </div>
            ))}
          </div>
        )}

        {showAddException && (
          <form onSubmit={addException} className="mt-3 bg-app-bg rounded-lg p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Date *</label>
                <input type="date" required className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                  value={excForm.date} onChange={(e) => setExcForm({ ...excForm, date: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Type</label>
                <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                  value={excForm.type} onChange={(e) => setExcForm({ ...excForm, type: e.target.value as "UNAVAILABLE" | "PARTIAL" })}>
                  <option value="UNAVAILABLE">Full day off</option>
                  <option value="PARTIAL">Partial availability</option>
                </select>
              </div>
            </div>

            {excForm.type === "PARTIAL" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Available from</label>
                  <input type="time" className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                    value={excForm.startTime} onChange={(e) => setExcForm({ ...excForm, startTime: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Available until</label>
                  <input type="time" className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                    value={excForm.endTime} onChange={(e) => setExcForm({ ...excForm, endTime: e.target.value })} />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Note (optional)</label>
              <input className="w-full border border-app-border rounded-md px-3 py-2 text-sm" placeholder="e.g. Vacation, Tournament…"
                value={excForm.note} onChange={(e) => setExcForm({ ...excForm, note: e.target.value })} />
            </div>

            <div className="flex gap-2">
              <button type="button" onClick={() => setShowAddException(false)}
                className="px-3 py-1.5 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Cancel</button>
              <button type="submit" disabled={excSaving}
                className="px-3 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
                {excSaving ? "Saving…" : "Add exception"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const { data: session } = useSession();
  const isOwner = session?.user.role === "OWNER";

  const [staff, setStaff]             = useState<StaffMember[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<string>("");
  const [loading, setLoading]         = useState(true);

  const loadStaff = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/staff?includeOwners=true");
    const data = await res.json();
    const list: StaffMember[] = Array.isArray(data) ? data : [];
    setStaff(list);
    // Auto-select self if not owner, or first staff if owner
    if (!isOwner && session?.user.id) {
      setSelectedStaff(session.user.id);
    } else if (list.length > 0 && !selectedStaff) {
      setSelectedStaff(list[0].id);
    }
    setLoading(false);
  }, [isOwner, session?.user.id, selectedStaff]);

  useEffect(() => { loadStaff(); }, [loadStaff]);  // eslint-disable-line react-hooks/exhaustive-deps

  const selectedMember = staff.find((s) => s.id === selectedStaff);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Staff Schedule</h1>
        <p className="text-sm text-text-muted mt-0.5">Manage weekly availability and time-off exceptions</p>
      </div>

      {loading ? (
        <div className="text-sm text-text-muted py-12 text-center">Loading…</div>
      ) : staff.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <p>No staff members found.</p>
          <p className="text-sm mt-1">Add staff in Settings → Staff & Permissions.</p>
        </div>
      ) : (
        <div className="flex gap-6">
          {/* Staff list sidebar */}
          <div className="w-48 flex-shrink-0">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Staff</p>
            <div className="space-y-1">
              {staff.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedStaff(s.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition ${
                    selectedStaff === s.id
                      ? "bg-brand text-white font-medium"
                      : "text-text-primary hover:bg-app-bg"
                  }`}
                >
                  {s.firstName} {s.lastName}
                  <span className="block text-xs opacity-60">{s.role}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Availability editor */}
          <div className="flex-1 bg-white rounded-xl border border-app-border p-6">
            {selectedMember ? (
              <>
                <div className="flex items-center gap-3 mb-6 pb-4 border-b border-app-border">
                  <div>
                    <h2 className="font-semibold text-text-primary">{selectedMember.firstName} {selectedMember.lastName}</h2>
                    <p className="text-xs text-text-muted">{selectedMember.role}</p>
                  </div>
                </div>
                <AvailabilityEditor staffId={selectedStaff} />
              </>
            ) : (
              <p className="text-text-muted text-sm">Select a staff member to manage their schedule.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
