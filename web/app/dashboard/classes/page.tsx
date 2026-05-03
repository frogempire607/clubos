"use client";

import { useEffect, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

type RecurringClass = {
  id: string;
  name: string;
  description: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  capacity: number | null;
  recurrenceStartDate: string;
  recurrenceEndDate: string | null;
  pricingOptions: PricingOption[];
  assignedStaffIds?: string[];
  active: boolean;
  locationId: string | null;
  location: { name: string } | null;
  _count: { sessions: number };
};

type Location = { id: string; name: string };
type Membership = { id: string; name: string; active: boolean };
type Staff = { id: string; firstName: string; lastName: string };

type ClassSession = {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  canceled: boolean;
  _count: { attendance: number };
};

// ─── Constants ───────────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtDays(days: number[]) {
  return [...days].sort().map((d) => DAYS[d]).join(", ");
}

function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ─── New/Edit Class Modal ─────────────────────────────────────────────────────

type FormData = {
  name: string;
  description: string;
  locationId: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  capacity: string;
  recurrenceStartDate: string;
  recurrenceEndDate: string;
  memberPriceEnabled: boolean;
  memberPrice: string;
  nonmemberPriceEnabled: boolean;
  nonmemberPrice: string;
  dropinPriceEnabled: boolean;
  dropinPrice: string;
  allowedMembershipIds: string[];
  assignedStaffIds: string[];
};

const emptyForm = (): FormData => ({
  name: "",
  description: "",
  locationId: "",
  daysOfWeek: [],
  startTime: "18:00",
  endTime: "19:30",
  capacity: "",
  recurrenceStartDate: new Date().toISOString().split("T")[0],
  recurrenceEndDate: "",
  memberPriceEnabled: false,
  memberPrice: "",
  nonmemberPriceEnabled: false,
  nonmemberPrice: "",
  dropinPriceEnabled: false,
  dropinPrice: "",
  allowedMembershipIds: [],
  assignedStaffIds: [],
});

function formFromClass(c: RecurringClass): FormData {
  const opts = c.pricingOptions ?? [];
  const member = opts.find((o) => o.type === "member") as ({ price: number } | undefined);
  const nonmember = opts.find((o) => o.type === "nonmember") as ({ price: number } | undefined);
  const dropin = opts.find((o) => o.type === "dropin") as ({ price: number } | undefined);
  return {
    name: c.name,
    description: c.description ?? "",
    locationId: c.locationId ?? "",
    daysOfWeek: c.daysOfWeek ?? [],
    startTime: c.startTime,
    endTime: c.endTime,
    capacity: c.capacity?.toString() ?? "",
    recurrenceStartDate: c.recurrenceStartDate.split("T")[0],
    recurrenceEndDate: c.recurrenceEndDate?.split("T")[0] ?? "",
    memberPriceEnabled: !!member,
    memberPrice: member?.price.toString() ?? "",
    nonmemberPriceEnabled: !!nonmember,
    nonmemberPrice: nonmember?.price.toString() ?? "",
    dropinPriceEnabled: !!dropin,
    dropinPrice: dropin?.price.toString() ?? "",
    allowedMembershipIds: opts.filter((o) => o.type === "membership").map((o) => o.membershipId),
    assignedStaffIds: c.assignedStaffIds ?? [],
  };
}

function ClassModal({
  editing,
  locations,
  memberships,
  staffList,
  onSave,
  onClose,
}: {
  editing: RecurringClass | null;
  locations: Location[];
  memberships: Membership[];
  staffList: Staff[];
  onSave: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormData>(editing ? formFromClass(editing) : emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set<K extends keyof FormData>(k: K, v: FormData[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  function toggleDay(d: number) {
    set(
      "daysOfWeek",
      form.daysOfWeek.includes(d)
        ? form.daysOfWeek.filter((x) => x !== d)
        : [...form.daysOfWeek, d]
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.daysOfWeek.length === 0) { setError("Select at least one day."); return; }
    setSaving(true);
    setError("");

    const pricingOptions: PricingOption[] = [];
    if (form.memberPriceEnabled && form.memberPrice)
      pricingOptions.push({ type: "member", price: parseFloat(form.memberPrice) });
    if (form.nonmemberPriceEnabled && form.nonmemberPrice)
      pricingOptions.push({ type: "nonmember", price: parseFloat(form.nonmemberPrice) });
    if (form.dropinPriceEnabled && form.dropinPrice)
      pricingOptions.push({ type: "dropin", price: parseFloat(form.dropinPrice) });
    for (const membershipId of form.allowedMembershipIds) {
      pricingOptions.push({ type: "membership", membershipId });
    }

    const payload = {
      name: form.name,
      description: form.description || null,
      locationId: form.locationId || null,
      daysOfWeek: form.daysOfWeek,
      startTime: form.startTime,
      endTime: form.endTime,
      capacity: form.capacity ? parseInt(form.capacity) : null,
      recurrenceStartDate: form.recurrenceStartDate,
      recurrenceEndDate: form.recurrenceEndDate || null,
      pricingOptions,
      assignedStaffIds: form.assignedStaffIds,
    };

    const url = editing ? `/api/classes/${editing.id}` : "/api/classes";
    const method = editing ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const fieldErrs = d.error?.fieldErrors as Record<string, string[]> | undefined;
      const firstField = fieldErrs ? Object.keys(fieldErrs)[0] : null;
      const firstFieldErr = firstField && fieldErrs ? `${firstField}: ${fieldErrs[firstField][0]}` : null;
      const formErr = d.error?.formErrors?.[0];
      setError(formErr || firstFieldErr || (typeof d.error === "string" ? d.error : null) || "Failed to save class.");
      return;
    }
    onSave();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="font-semibold text-text-primary">{editing ? "Edit Class" : "New Class"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Class Name *</label>
            <input
              required
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Beginner Jiu-Jitsu"
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Description</label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          {/* Location */}
          {locations.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Location</label>
              <select
                value={form.locationId}
                onChange={(e) => set("locationId", e.target.value)}
                className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="">No location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Days of week */}
          <div>
            <label className="block text-xs font-medium text-text-primary mb-2">Days of Week *</label>
            <div className="flex gap-1.5 flex-wrap">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    form.daysOfWeek.includes(i)
                      ? "bg-brand text-white border-brand"
                      : "bg-surface text-text-muted border-app-border hover:border-app-border"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Times */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Start Time *</label>
              <input
                required
                type="time"
                value={form.startTime}
                onChange={(e) => set("startTime", e.target.value)}
                className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">End Time *</label>
              <input
                required
                type="time"
                value={form.endTime}
                onChange={(e) => set("endTime", e.target.value)}
                className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>

          {/* Capacity */}
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Capacity</label>
            <input
              type="number"
              min="1"
              value={form.capacity}
              onChange={(e) => set("capacity", e.target.value)}
              placeholder="No limit"
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          {/* Recurrence */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Starts On *</label>
              <input
                required
                type="date"
                value={form.recurrenceStartDate}
                onChange={(e) => set("recurrenceStartDate", e.target.value)}
                className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Ends On</label>
              <input
                type="date"
                value={form.recurrenceEndDate}
                onChange={(e) => set("recurrenceEndDate", e.target.value)}
                placeholder="Ongoing"
                className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <p className="text-xs text-text-muted mt-1">Leave blank for ongoing</p>
            </div>
          </div>

          {/* Pricing options */}
          <div>
            <label className="block text-xs font-medium text-text-primary mb-2">Pricing Options</label>
            <div className="space-y-2">
              {(
                [
                  { key: "memberPriceEnabled" as const, priceKey: "memberPrice" as const, label: "Member Pricing" },
                  { key: "nonmemberPriceEnabled" as const, priceKey: "nonmemberPrice" as const, label: "Non-Member Pricing" },
                  { key: "dropinPriceEnabled" as const, priceKey: "dropinPrice" as const, label: "Drop-In / Per Session" },
                ] as const
              ).map(({ key, priceKey, label }) => (
                <div key={key} className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer min-w-[160px]">
                    <input
                      type="checkbox"
                      checked={form[key]}
                      onChange={(e) => set(key, e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm text-text-primary">{label}</span>
                  </label>
                  {form[key] && (
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-text-muted">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form[priceKey]}
                        onChange={(e) => set(priceKey, e.target.value)}
                        placeholder="0.00"
                        className="w-24 border border-app-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Accepted memberships */}
          <div className="border-t border-app-border pt-4">
            <label className="block text-xs font-medium text-text-primary mb-1">
              Accepted Memberships / Purchase Options
            </label>
            <p className="text-[11px] text-text-muted mb-2">
              Members on any selected plan can register at no extra cost. Others pay the prices above.
            </p>
            {memberships.length === 0 ? (
              <div className="border border-dashed border-app-border rounded-lg p-3 text-xs text-text-muted">
                No active memberships yet.{" "}
                <a href="/dashboard/memberships" className="text-brand hover:underline">
                  Create a membership →
                </a>
              </div>
            ) : (
              <div className="border border-app-border rounded-lg p-3 space-y-1.5 max-h-40 overflow-y-auto">
                {memberships.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.allowedMembershipIds.includes(m.id)}
                      onChange={() => set("allowedMembershipIds", form.allowedMembershipIds.includes(m.id) ? form.allowedMembershipIds.filter((id) => id !== m.id) : [...form.allowedMembershipIds, m.id])}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            )}
            {form.allowedMembershipIds.length > 0 && (
              <p className="text-[11px] text-text-muted mt-1">
                {form.allowedMembershipIds.length} membership{form.allowedMembershipIds.length === 1 ? "" : "s"} selected
              </p>
            )}
          </div>

          {staffList.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-text-primary mb-2">Assigned staff / coaches</label>
              <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                {staffList.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer border border-app-border rounded-lg px-3 py-2">
                    <input
                      type="checkbox"
                      checked={form.assignedStaffIds.includes(s.id)}
                      onChange={() => set("assignedStaffIds", form.assignedStaffIds.includes(s.id) ? form.assignedStaffIds.filter((id) => id !== s.id) : [...form.assignedStaffIds, s.id])}
                    />
                    {s.firstName} {s.lastName}
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border border-app-border text-sm text-text-muted hover:bg-app-bg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : editing ? "Save Changes" : "Create Class"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Sessions Modal ───────────────────────────────────────────────────────────

function SessionsModal({
  cls,
  onClose,
}: {
  cls: RecurringClass;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/classes/${cls.id}/sessions?upcoming=true&limit=20`)
      .then((r) => r.json())
      .then((d) => { setSessions(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [cls.id]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-md max-h-[80vh] overflow-y-auto shadow-xl">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-text-primary">{cls.name}</h2>
            <p className="text-xs text-text-muted mt-0.5">
              {fmtDays(cls.daysOfWeek)} · {fmtTime(cls.startTime)}–{fmtTime(cls.endTime)}
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>
        <div className="p-4">
          {loading ? (
            <p className="text-sm text-text-muted text-center py-8">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">No upcoming sessions.</p>
          ) : (
            <div className="space-y-1.5">
              {sessions.map((s) => (
                <a
                  key={s.id}
                  href={`/dashboard/attendance?session=${s.id}&date=${s.date.split("T")[0]}`}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-app-bg border border-app-border group"
                >
                  <div>
                    <div className="text-sm font-medium text-text-primary">{fmtDate(s.date)}</div>
                    <div className="text-xs text-text-muted">
                      {fmtTime(s.startsAt.split("T")[1]?.slice(0, 5) || cls.startTime)}–
                      {fmtTime(s.endsAt.split("T")[1]?.slice(0, 5) || cls.endTime)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-muted">
                      {s._count.attendance} checked in
                      {cls.capacity ? ` / ${cls.capacity}` : ""}
                    </span>
                    <span className="text-xs text-text-muted group-hover:text-text-muted">→</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 pb-4">
          <a
            href={`/dashboard/attendance`}
            className="block text-center text-xs text-text-muted hover:text-text-primary"
          >
            Go to Attendance →
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ClassesPage() {
  const [classes, setClasses] = useState<RecurringClass[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"classes" | "events">("classes");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<RecurringClass | null>(null);
  const [viewingSessions, setViewingSessions] = useState<RecurringClass | null>(null);
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    const cRes = await fetch("/api/classes");
    if (cRes.ok) setClasses(await cRes.json());
    const lRes = await fetch("/api/club/locations").catch(() => null);
    if (lRes && lRes.ok) setLocations(await lRes.json().catch(() => []));
    const mRes = await fetch("/api/memberships").catch(() => null);
    if (mRes && mRes.ok) setMemberships((await mRes.json().catch(() => [])).filter((m: Membership) => m.active));
    const sRes = await fetch("/api/staff?includeOwners=true").catch(() => null);
    if (sRes && sRes.ok) setStaffList(await sRes.json().catch(() => []));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function deleteClass(id: string) {
    if (!confirm("Archive this class? Sessions already generated will remain.")) return;
    await fetch(`/api/classes/${id}`, { method: "DELETE" });
    load();
  }

  const filtered = classes.filter(
    (c) =>
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.location?.name ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Classes &amp; Events</h1>
          <p className="text-sm text-text-muted mt-1">Manage recurring classes and one-time events</p>
        </div>
        {tab === "classes" && (
          <button
            onClick={() => { setEditing(null); setShowModal(true); }}
            className="px-4 py-2 bg-brand text-white text-sm font-medium rounded-lg hover:bg-brand-hover"
          >
            + New Class
          </button>
        )}
        {tab === "events" && (
          <a
            href="/dashboard/events"
            className="px-4 py-2 bg-brand text-white text-sm font-medium rounded-lg hover:bg-brand-hover"
          >
            + New Event
          </a>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-app-border">
        {(["classes", "events"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t
                ? "border-brand text-text-primary"
                : "border-transparent text-text-muted hover:text-text-primary"
            }`}
          >
            {t === "classes" ? "Classes" : "Events"}
          </button>
        ))}
      </div>

      {/* Classes Tab */}
      {tab === "classes" && (
        <>
          {/* Search */}
          <div className="mb-4">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search classes…"
              className="w-72 border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          {loading ? (
            <div className="text-sm text-text-muted py-16 text-center">Loading classes…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 border border-dashed border-app-border rounded-xl">
              <div className="text-text-muted text-4xl mb-3">◈</div>
              <p className="text-text-muted font-medium mb-1">
                {search ? "No classes match your search" : "No classes yet"}
              </p>
              {!search && (
                <>
                  <p className="text-text-muted text-sm mb-4">
                    Create recurring weekly classes with automatic session generation.
                  </p>
                  <button
                    onClick={() => { setEditing(null); setShowModal(true); }}
                    className="px-4 py-2 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover"
                  >
                    Create your first class
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="overflow-hidden border border-app-border rounded-xl">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-app-bg border-b border-app-border">
                    <th className="text-left px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">Schedule</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">Location</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">Capacity</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">Sessions</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {filtered.map((cls) => (
                    <tr key={cls.id} className="hover:bg-app-bg transition-colors">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setViewingSessions(cls)}
                          className="font-medium text-text-primary hover:underline text-left"
                        >
                          {cls.name}
                        </button>
                        {cls.description && (
                          <div className="text-xs text-text-muted truncate max-w-[200px]">{cls.description}</div>
                        )}
                        <div className="text-[10px] text-text-muted mt-0.5">
                          {cls.assignedStaffIds?.length
                            ? `Staff: ${cls.assignedStaffIds.map((id) => staffList.find((s) => s.id === id)).filter(Boolean).map((s) => `${s!.firstName} ${s!.lastName}`).join(", ")}`
                            : "No staff assigned"}
                        </div>
                        {(cls.pricingOptions || []).filter((o) => o.type === "membership").length > 0 && (
                          <div className="text-[10px] text-text-muted mt-0.5">
                            Options: {(cls.pricingOptions || []).filter((o) => o.type === "membership").map((o) => memberships.find((m) => m.id === o.membershipId)?.name).filter(Boolean).join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        <div>{fmtDays(cls.daysOfWeek)}</div>
                        <div className="text-xs text-text-muted">
                          {fmtTime(cls.startTime)}–{fmtTime(cls.endTime)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-muted">{cls.location?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-text-muted">{cls.capacity ?? "No limit"}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setViewingSessions(cls)}
                          className="text-text-muted hover:text-text-primary underline-offset-2 hover:underline"
                        >
                          {cls._count.sessions} upcoming
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            cls.active
                              ? "bg-lime-accent text-text-primary"
                              : "bg-app-bg text-text-muted"
                          }`}
                        >
                          {cls.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            onClick={() => setViewingSessions(cls)}
                            className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                          >
                            Sessions
                          </button>
                          <button
                            onClick={() => { setEditing(cls); setShowModal(true); }}
                            className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteClass(cls.id)}
                            className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Events Tab — redirects to existing events page */}
      {tab === "events" && (
        <div className="text-center py-20">
          <div className="text-text-muted text-4xl mb-3">◈</div>
          <p className="text-text-muted font-medium mb-1">Events are managed separately</p>
          <p className="text-text-muted text-sm mb-5">
            Events include clinics, camps, tournaments, seminars, and special programs.
          </p>
          <a
            href="/dashboard/events"
            className="inline-block px-5 py-2 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover"
          >
            Go to Events →
          </a>
        </div>
      )}

      {/* Modals */}
      {showModal && (
        <ClassModal
          editing={editing}
          locations={locations}
          memberships={memberships}
          staffList={staffList}
          onSave={load}
          onClose={() => { setShowModal(false); setEditing(null); }}
        />
      )}
      {viewingSessions && (
        <SessionsModal cls={viewingSessions} onClose={() => setViewingSessions(null)} />
      )}
    </div>
  );
}
