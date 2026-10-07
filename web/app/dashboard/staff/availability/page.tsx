"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { range12h, to12h } from "@/lib/time12";

type Staff = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
};

type Slot = {
  id?: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  active: boolean;
};

type Exception = {
  id: string;
  date: string;
  type: string;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function StaffAvailabilityPage() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const { data: session, status } = useSession();
  const myId = session?.user?.id ?? null;
  const myName = session?.user?.name ?? "";
  const myEmail = session?.user?.email ?? "";
  const myRole = session?.user?.role ?? "STAFF";

  useEffect(() => {
    if (status === "loading") return;
    fetch("/api/staff?includeOwners=true")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Staff[] | null) => {
        // The staff list needs Staff & contractors: view. A coach without it
        // used to get an empty picker here; they still manage their OWN hours
        // (the availability API allows self), so show just them.
        let list: Staff[] = Array.isArray(d) ? d : [];
        if (list.length === 0 && myId) {
          const [firstName, ...rest] = myName.trim().split(/\s+/);
          list = [{ id: myId, firstName: firstName || "Me", lastName: rest.join(" "), email: myEmail, role: myRole }];
        }
        setStaff(list);
        if (list.length > 0) setSelectedId(list[0].id);
        setLoading(false);
      });
  }, [status, myId, myName, myEmail, myRole]);

  const loadData = useCallback((staffId: string) => {
    Promise.all([
      fetch(`/api/staff/${staffId}/availability`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/staff/${staffId}/availability/exceptions`).then((r) => (r.ok ? r.json() : [])),
    ]).then(([slotData, excData]) => {
      setSlots(Array.isArray(slotData) ? slotData : []);
      setExceptions(Array.isArray(excData) ? excData : []);
    });
  }, []);

  useEffect(() => {
    if (selectedId) loadData(selectedId);
  }, [selectedId, loadData]);

  function addSlot(day: number) {
    setSlots((prev) => [
      ...prev,
      { dayOfWeek: day, startTime: "09:00", endTime: "17:00", active: true },
    ]);
  }

  function updateSlot(idx: number, patch: Partial<Slot>) {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function removeSlot(idx: number) {
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  }

  async function saveSlots() {
    if (!selectedId) return;
    setSaving(true);
    setError("");
    // Validate
    for (const s of slots) {
      if (s.startTime >= s.endTime) {
        setError(`Check ${DAY_NAMES[s.dayOfWeek]}: ${to12h(s.startTime)} – ${to12h(s.endTime)} ends before it starts.`);
        setSaving(false);
        return;
      }
    }
    const res = await fetch(`/api/staff/${selectedId}/availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slots: slots.map((s) => ({
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          active: s.active,
        })),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    loadData(selectedId);
  }

  async function addException(date: string, type: "UNAVAILABLE" | "PARTIAL", note: string, startTime?: string, endTime?: string) {
    if (!selectedId || !date) return;
    const res = await fetch(`/api/staff/${selectedId}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        type,
        startTime: type === "PARTIAL" ? startTime : null,
        endTime: type === "PARTIAL" ? endTime : null,
        note: note || null,
      }),
    });
    if (res.ok) {
      loadData(selectedId);
    } else {
      const d = await res.json().catch(() => ({}));
      alert(typeof d.error === "string" ? d.error : "Could not add exception");
    }
  }

  async function deleteException(id: string) {
    if (!selectedId) return;
    const res = await fetch(`/api/staff/${selectedId}/availability/exceptions?exceptionId=${id}`, {
      method: "DELETE",
    });
    if (res.ok) loadData(selectedId);
  }

  const selected = staff.find((s) => s.id === selectedId);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Availability</h1>
        <p className="text-sm text-text-muted mt-1">
          Set recurring weekly hours and block out specific dates per staff member.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted text-center py-16">Loading…</p>
      ) : staff.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-12 text-center">
          <p className="text-base font-medium text-text-primary mb-1">No staff yet</p>
          <p className="text-sm text-text-muted">
            Invite staff first on the <a href="/dashboard/staff" className="underline">Directory</a> page.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Staff list */}
          <div className="lg:col-span-1">
            <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-app-border">
                <h3 className="text-sm font-semibold text-text-primary">Staff</h3>
              </div>
              <ul>
                {staff.map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelectedId(s.id)}
                      className={`w-full min-h-[44px] text-left px-4 py-3 border-b border-app-border last:border-0 transition ${
                        selectedId === s.id ? "bg-brand/10" : "hover:bg-app-bg"
                      }`}
                    >
                      <p className="text-sm font-medium text-text-primary">
                        {s.firstName} {s.lastName}
                      </p>
                      <p className="text-xs text-text-muted">
                        {s.role === "OWNER" ? "Owner" : "Staff"}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Editor */}
          <div className="lg:col-span-3 space-y-4">
            {selected ? (
              <>
                <div className="bg-surface border border-app-border rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">
                        Weekly hours
                      </h2>
                      <p className="text-xs text-text-muted">
                        {selected.firstName} {selected.lastName}'s recurring availability
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {saved && <span className="text-xs" style={{ color: "var(--color-success-text)" }}>Saved</span>}
                      {error && <span className="text-xs" style={{ color: "var(--color-danger-text)" }}>{error}</span>}
                      <button
                        onClick={saveSlots}
                        disabled={saving}
                        className="min-h-[44px] md:min-h-[36px] text-sm px-4 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {DAY_NAMES.map((dayName, dayIdx) => {
                      const daySlots = slots.map((s, i) => ({ slot: s, idx: i })).filter((x) => x.slot.dayOfWeek === dayIdx);
                      return (
                        <div key={dayIdx} className="flex flex-wrap sm:flex-nowrap items-start gap-3 py-2 border-b border-app-border last:border-0">
                          <div className="w-20 pt-2 text-sm font-medium text-text-primary">{dayName}</div>
                          <div className="flex-1 space-y-1.5">
                            {daySlots.length === 0 && (
                              <p className="text-xs text-text-muted py-2">Off</p>
                            )}
                            {daySlots.map(({ slot, idx }) => (
                              <div key={idx} className="flex flex-wrap items-center gap-2">
                                <input
                                  type="time"
                                  value={slot.startTime}
                                  onChange={(e) => updateSlot(idx, { startTime: e.target.value })}
                                  className="min-h-[44px] md:min-h-[36px] px-2 py-1 border border-app-border rounded text-sm bg-surface text-text-primary"
                                />
                                <span className="text-text-muted text-sm">–</span>
                                <input
                                  type="time"
                                  value={slot.endTime}
                                  onChange={(e) => updateSlot(idx, { endTime: e.target.value })}
                                  className="min-h-[44px] md:min-h-[36px] px-2 py-1 border border-app-border rounded text-sm bg-surface text-text-primary"
                                />
                                <span className="text-xs text-text-muted tabular-nums">{range12h(slot.startTime, slot.endTime)}</span>
                                <label className="flex min-h-[44px] md:min-h-0 items-center gap-1 text-xs text-text-muted">
                                  <input
                                    type="checkbox"
                                    checked={slot.active}
                                    onChange={(e) => updateSlot(idx, { active: e.target.checked })}
                                  />
                                  Active
                                </label>
                                <button
                                  onClick={() => removeSlot(idx)}
                                  className="min-h-[44px] md:min-h-[32px] text-xs px-2 py-1 rounded hover:bg-app-bg" style={{ color: "var(--color-danger-text)" }}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={() => addSlot(dayIdx)}
                            className="min-h-[44px] md:min-h-0 text-xs text-brand hover:underline pt-2 flex-shrink-0"
                          >
                            + Add slot
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <ExceptionsCard
                  exceptions={exceptions}
                  onAdd={addException}
                  onDelete={deleteException}
                />
              </>
            ) : (
              <p className="text-sm text-text-muted text-center py-16">Select a staff member to edit availability.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ExceptionsCard({
  exceptions,
  onAdd,
  onDelete,
}: {
  exceptions: Exception[];
  onAdd: (date: string, type: "UNAVAILABLE" | "PARTIAL", note: string, startTime?: string, endTime?: string) => void;
  onDelete: (id: string) => void;
}) {
  const [date, setDate] = useState("");
  const [type, setType] = useState<"UNAVAILABLE" | "PARTIAL">("UNAVAILABLE");
  const [note, setNote] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("13:00");

  function submit() {
    if (!date) return;
    onAdd(date, type, note, startTime, endTime);
    setDate("");
    setNote("");
  }

  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <h2 className="text-base font-semibold text-text-primary mb-1">Date exceptions</h2>
      <p className="text-xs text-text-muted mb-4">
        Block out vacation days or set modified hours for a specific date.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-4 pb-4 border-b border-app-border">
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-[44px] md:min-h-[36px] px-2 py-1.5 border border-app-border rounded text-sm bg-surface text-text-primary"
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "UNAVAILABLE" | "PARTIAL")}
            className="min-h-[44px] md:min-h-[36px] px-2 py-1.5 border border-app-border rounded text-sm bg-surface text-text-primary"
          >
            <option value="UNAVAILABLE">Unavailable</option>
            <option value="PARTIAL">Modified hours</option>
          </select>
        </div>
        {type === "PARTIAL" && (
          <>
            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">From</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="min-h-[44px] md:min-h-[36px] px-2 py-1.5 border border-app-border rounded text-sm bg-surface text-text-primary"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">To</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="min-h-[44px] md:min-h-[36px] px-2 py-1.5 border border-app-border rounded text-sm bg-surface text-text-primary"
              />
            </div>
          </>
        )}
        <div className="flex-1 min-w-[120px]">
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Note (optional)</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Vacation"
            className="w-full min-h-[44px] md:min-h-[36px] px-2 py-1.5 border border-app-border rounded text-sm bg-surface text-text-primary"
          />
        </div>
        <button
          onClick={submit}
          disabled={!date}
          className="min-h-[44px] md:min-h-[36px] text-sm px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {exceptions.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-4">No upcoming exceptions.</p>
      ) : (
        <ul className="space-y-1">
          {exceptions.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between py-2 px-2 rounded hover:bg-app-bg"
            >
              <div>
                <p className="text-sm text-text-primary">
                  {/* Exception dates are stored at UTC midnight — read them in UTC
                      or US viewers see the day before. */}
                  {new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                  {" — "}
                  <span className="text-xs" style={{ color: e.type === "UNAVAILABLE" ? "var(--color-danger-text)" : "var(--color-warn-text)" }}>
                    {e.type === "UNAVAILABLE" ? "Unavailable" : `Modified ${range12h(e.startTime, e.endTime)}`}
                  </span>
                </p>
                {e.note && <p className="text-xs text-text-muted">{e.note}</p>}
              </div>
              <button
                onClick={() => onDelete(e.id)}
                className="min-h-[44px] md:min-h-[32px] text-xs px-2 py-1 rounded hover:bg-app-bg" style={{ color: "var(--color-danger-text)" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
