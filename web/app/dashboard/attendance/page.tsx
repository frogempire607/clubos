"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ExportMenu from "@/components/ExportMenu";

// ─── Types ────────────────────────────────────────────────────────────────────

type ClassSession = {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  canceled: boolean;
  recurringClass: { name: string; capacity: number | null };
  _count: { attendance: number };
};

type Event = {
  id: string;
  name: string;
  type: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  location: { name: string } | null;
  _count: { bookings: number };
};

type AttendanceRecord = {
  id: string;
  memberId: string;
  status: string;
  checkedInAt: string | null;
  notes: string | null;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    isMinor: boolean;
    guardianName: string | null;
    status: string;
  };
};

type Member = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  isMinor: boolean;
  guardianName: string | null;
  status: string;
};

const STATUS_CONFIG: Record<string, { label: string; bg: string; fg: string }> = {
  PRESENT: { label: "Present", bg: "#EAF3DE", fg: "#27500A" },
  ABSENT: { label: "Absent", fg: "#5F5E5A", bg: "#F1EFE8" },
  LATE: { label: "Late", bg: "#FAEEDA", fg: "#633806" },
  TRIAL: { label: "Trial", bg: "#E6F1FB", fg: "#0C447C" },
  DROP_IN: { label: "Drop-In", bg: "#EEEDFE", fg: "#3C3489" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  const date = new Date(iso);
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function fmtDateHeader(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Quick Add Member Form ────────────────────────────────────────────────────

function QuickAddForm({
  sessionId,
  onAdded,
}: {
  sessionId: string;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"search" | "add-new">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [isMinor, setIsMinor] = useState(false);
  const [guardianName, setGuardianName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/members")
      .then((r) => r.json())
      .then((d) => setAllMembers(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const q = query.toLowerCase();
    setResults(
      allMembers
        .filter(
          (m) =>
            `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
            (m.email ?? "").toLowerCase().includes(q)
        )
        .slice(0, 8)
    );
  }, [query, allMembers]);

  async function checkIn(memberId: string, status = "PRESENT") {
    setSaving(true);
    await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sessionId, memberId, status }),
    });
    setSaving(false);
    setQuery("");
    setResults([]);
    onAdded();
  }

  async function createAndCheckIn(e: React.FormEvent) {
    e.preventDefault();
    if (!newFirst || !newLast) { setError("Name is required."); return; }
    setSaving(true);
    setError("");

    const res = await fetch("/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: newFirst,
        lastName: newLast,
        phone: newPhone || null,
        isMinor,
        guardianName: isMinor ? guardianName : null,
        status: "PROSPECT",
      }),
    });
    if (!res.ok) {
      setError("Failed to create member.");
      setSaving(false);
      return;
    }
    const member = await res.json();
    await checkIn(member.id, "TRIAL");
    setStep("search");
    setNewFirst(""); setNewLast(""); setNewPhone(""); setIsMinor(false); setGuardianName("");
  }

  if (step === "add-new") {
    return (
      <form onSubmit={createAndCheckIn} className="space-y-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-stone-700">New Member (Quick Add)</span>
          <button type="button" onClick={() => setStep("search")} className="text-xs text-stone-400 hover:text-stone-600">
            ← Back
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            required
            placeholder="First name"
            value={newFirst}
            onChange={(e) => setNewFirst(e.target.value)}
            className="border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
          />
          <input
            required
            placeholder="Last name"
            value={newLast}
            onChange={(e) => setNewLast(e.target.value)}
            className="border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
          />
        </div>
        <input
          placeholder="Phone"
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
        />
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isMinor} onChange={(e) => setIsMinor(e.target.checked)} className="rounded" />
          <span className="text-sm text-stone-700">Minor / under 18</span>
        </label>
        {isMinor && (
          <input
            placeholder="Guardian name"
            value={guardianName}
            onChange={(e) => setGuardianName(e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
          />
        )}
        {error && <p className="text-red-600 text-xs">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full px-4 py-2 bg-stone-900 text-white text-sm rounded-lg hover:bg-stone-800 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add as Trial & Check In"}
        </button>
      </form>
    );
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search members to add…"
        className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300 mb-2"
      />
      {results.length > 0 && (
        <div className="space-y-1 mb-2">
          {results.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-stone-50 border border-stone-100"
            >
              <div>
                <div className="text-sm font-medium text-stone-800">
                  {m.firstName} {m.lastName}
                  {m.isMinor && <span className="ml-1.5 text-xs text-blue-600">(minor)</span>}
                </div>
                {m.isMinor && m.guardianName && (
                  <div className="text-xs text-stone-400">Guardian: {m.guardianName}</div>
                )}
              </div>
              <div className="flex gap-1.5">
                <button
                  disabled={saving}
                  onClick={() => checkIn(m.id, "PRESENT")}
                  className="px-2 py-1 text-xs rounded bg-green-50 text-green-700 hover:bg-green-100"
                >
                  Present
                </button>
                <button
                  disabled={saving}
                  onClick={() => checkIn(m.id, "TRIAL")}
                  className="px-2 py-1 text-xs rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
                >
                  Trial
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => setStep("add-new")}
        className="w-full px-3 py-2 border border-dashed border-stone-300 rounded-lg text-xs text-stone-500 hover:border-stone-400 hover:text-stone-700 transition-colors"
      >
        + Add a brand-new member
      </button>
    </div>
  );
}

// ─── Attendance Panel ─────────────────────────────────────────────────────────

function AttendancePanel({
  sessionId,
  sessionName,
  onClose,
}: {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    session: ClassSession & { recurringClass: { name: string; capacity: number | null } };
    attendance: AttendanceRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/attendance/${sessionId}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(memberId: string, status: string) {
    setUpdating(memberId);
    await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sessionId, memberId, status }),
    });
    setUpdating(null);
    load();
  }

  const attendance = data?.attendance ?? [];
  const filtered = filter
    ? attendance.filter(
        (r) =>
          `${r.member.firstName} ${r.member.lastName}`.toLowerCase().includes(filter.toLowerCase())
      )
    : attendance;

  const counts = Object.keys(STATUS_CONFIG).reduce(
    (acc, k) => ({ ...acc, [k]: attendance.filter((r) => r.status === k).length }),
    {} as Record<string, number>
  );

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-[480px] bg-white shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-stone-200 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-stone-900">{sessionName}</h2>
            <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
          </div>
          {/* Status summary */}
          <div className="flex gap-2 flex-wrap">
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <span
                key={k}
                style={{ background: v.bg, color: v.fg }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
              >
                {v.label}: {counts[k] ?? 0}
              </span>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-stone-400 text-center py-12">Loading roster…</p>
          ) : (
            <>
              {/* Search */}
              <div className="px-4 pt-4 pb-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter attendees…"
                  className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
                />
              </div>

              {/* Attendance list */}
              {filtered.length === 0 && !showAdd ? (
                <div className="text-center py-8 text-stone-400 text-sm px-4">
                  {filter ? "No attendees match your filter." : "No one checked in yet. Use the form below to add members."}
                </div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {filtered.map((rec) => {
                    const s = STATUS_CONFIG[rec.status] ?? STATUS_CONFIG.PRESENT;
                    return (
                      <div key={rec.id} className="px-4 py-3">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-sm font-medium text-stone-800">
                              {rec.member.firstName} {rec.member.lastName}
                              {rec.member.isMinor && (
                                <span className="ml-1.5 text-xs text-blue-600">(minor)</span>
                              )}
                            </div>
                            {rec.member.isMinor && rec.member.guardianName && (
                              <div className="text-xs text-stone-400">
                                Guardian: {rec.member.guardianName}
                              </div>
                            )}
                            {rec.checkedInAt && (
                              <div className="text-xs text-stone-400">
                                Checked in {new Date(rec.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </div>
                            )}
                          </div>
                          <span
                            style={{ background: s.bg, color: s.fg }}
                            className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                          >
                            {s.label}
                          </span>
                        </div>
                        {/* Status buttons */}
                        <div className="flex gap-1.5 flex-wrap">
                          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                            <button
                              key={k}
                              disabled={updating === rec.member.id}
                              onClick={() => setStatus(rec.member.id, k)}
                              style={
                                rec.status === k
                                  ? { background: v.bg, color: v.fg, borderColor: v.fg + "55" }
                                  : {}
                              }
                              className={`px-2.5 py-1 text-xs rounded border transition-all ${
                                rec.status === k
                                  ? "font-medium border-current"
                                  : "border-stone-200 text-stone-500 hover:border-stone-400"
                              }`}
                            >
                              {v.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add member section */}
              <div className="px-4 py-4 border-t border-stone-100 mt-2">
                {showAdd ? (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-stone-700 uppercase tracking-wide">Add Member</span>
                      <button onClick={() => setShowAdd(false)} className="text-xs text-stone-400 hover:text-stone-600">
                        Hide
                      </button>
                    </div>
                    <QuickAddForm sessionId={sessionId} onAdded={() => { load(); }} />
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAdd(true)}
                    className="w-full px-4 py-2.5 border border-stone-200 rounded-lg text-sm text-stone-600 hover:bg-stone-50 hover:border-stone-300 font-medium"
                  >
                    + Add Member to Session
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

// ─── Schedule Item ────────────────────────────────────────────────────────────

function ScheduleItem({
  label,
  sublabel,
  timeRange,
  checkedIn,
  capacity,
  type,
  onClick,
  active,
}: {
  label: string;
  sublabel?: string;
  timeRange: string;
  checkedIn: number;
  capacity: number | null;
  type: "class" | "event";
  onClick: () => void;
  active: boolean;
}) {
  const pct = capacity ? Math.min(100, Math.round((checkedIn / capacity) * 100)) : null;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3.5 rounded-xl border transition-all ${
        active
          ? "border-stone-900 bg-stone-900 text-white"
          : "border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-sm font-medium truncate ${active ? "text-white" : "text-stone-900"}`}>{label}</div>
          {sublabel && (
            <div className={`text-xs mt-0.5 truncate ${active ? "text-stone-300" : "text-stone-500"}`}>{sublabel}</div>
          )}
          <div className={`text-xs mt-1 ${active ? "text-stone-400" : "text-stone-400"}`}>{timeRange}</div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className={`text-sm font-semibold ${active ? "text-white" : "text-stone-700"}`}>
            {checkedIn}
            {capacity ? <span className={`font-normal text-xs ml-0.5 ${active ? "text-stone-400" : "text-stone-400"}`}>/{capacity}</span> : ""}
          </div>
          {pct !== null && (
            <div className={`text-xs mt-0.5 ${active ? "text-stone-400" : "text-stone-400"}`}>{pct}%</div>
          )}
          <span
            className={`inline-block mt-1 text-xs px-1.5 py-0.5 rounded ${
              type === "class"
                ? active ? "bg-stone-700 text-stone-200" : "bg-blue-50 text-blue-700"
                : active ? "bg-stone-700 text-stone-200" : "bg-stone-100 text-stone-600"
            }`}
          >
            {type === "class" ? "Class" : "Event"}
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── Main Page (inner, needs useSearchParams) ─────────────────────────────────

function AttendancePageInner() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get("date") ?? todayStr();
  const initialSession = searchParams.get("session") ?? null;

  const [date, setDate] = useState(initialDate);
  const [classSessions, setClassSessions] = useState<ClassSession[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState<{ id: string; name: string } | null>(
    null
  );

  const load = useCallback(async (d: string) => {
    setLoading(true);
    const res = await fetch(`/api/attendance?date=${d}`);
    if (res.ok) {
      const data = await res.json();
      setClassSessions(data.classSessions ?? []);
      setEvents(data.events ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  // Auto-open session from URL param
  useEffect(() => {
    if (initialSession && classSessions.length > 0) {
      const s = classSessions.find((cs) => cs.id === initialSession);
      if (s) setSelectedSession({ id: s.id, name: s.recurringClass.name });
    }
  }, [initialSession, classSessions]);

  const isToday = date === todayStr();
  const totalItems = classSessions.length + events.length;

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 p-8 max-w-2xl">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-stone-900">Attendance</h1>
            <p className="text-sm text-stone-500 mt-1">Check in members for today's classes and events</p>
          </div>
          <ExportMenu baseUrl="/api/export/attendance" label="Export" />
        </div>

        {/* Date navigation */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setDate(addDays(date, -1))}
            className="p-2 border border-stone-200 rounded-lg hover:bg-stone-50 text-stone-600"
          >
            ‹
          </button>
          <div className="flex-1 text-center">
            <div className="font-semibold text-stone-900">{fmtDateHeader(date)}</div>
            {isToday && (
              <div className="text-xs text-green-600 font-medium">Today</div>
            )}
          </div>
          <button
            onClick={() => setDate(addDays(date, 1))}
            className="p-2 border border-stone-200 rounded-lg hover:bg-stone-50 text-stone-600"
          >
            ›
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(todayStr())}
              className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm text-stone-600 hover:bg-stone-50"
            >
              Today
            </button>
          )}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-stone-200 rounded-lg px-3 py-1.5 text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-300"
          />
        </div>

        {/* Session list */}
        {loading ? (
          <div className="text-center py-16 text-stone-400 text-sm">Loading schedule…</div>
        ) : totalItems === 0 ? (
          <div className="text-center py-20 border border-dashed border-stone-200 rounded-xl">
            <div className="text-stone-300 text-4xl mb-3">◫</div>
            <p className="text-stone-600 font-medium mb-1">No sessions scheduled</p>
            <p className="text-stone-400 text-sm">
              {isToday
                ? "No classes or events are scheduled for today."
                : "No classes or events are scheduled for this date."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {classSessions.map((s) => (
              <ScheduleItem
                key={s.id}
                label={s.recurringClass.name}
                timeRange={`${fmtTime(s.startsAt)} – ${fmtTime(s.endsAt)}`}
                checkedIn={s._count.attendance}
                capacity={s.recurringClass.capacity}
                type="class"
                active={selectedSession?.id === s.id}
                onClick={() =>
                  setSelectedSession(
                    selectedSession?.id === s.id
                      ? null
                      : { id: s.id, name: s.recurringClass.name }
                  )
                }
              />
            ))}
            {events.map((ev) => (
              <ScheduleItem
                key={ev.id}
                label={ev.name}
                sublabel={ev.location?.name}
                timeRange={`${fmtTime(ev.startsAt)} – ${fmtTime(ev.endsAt)}`}
                checkedIn={ev._count.bookings}
                capacity={ev.capacity}
                type="event"
                active={false}
                onClick={() => {
                  window.location.href = `/dashboard/events`;
                }}
              />
            ))}
          </div>
        )}

        {/* Hint */}
        {totalItems > 0 && (
          <p className="text-xs text-stone-400 text-center mt-4">
            Click a class session to open the attendance roster →
          </p>
        )}
      </div>

      {/* Attendance panel slide-over */}
      {selectedSession && (
        <AttendancePanel
          sessionId={selectedSession.id}
          sessionName={selectedSession.name}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}

// ─── Export (wrapped in Suspense for useSearchParams) ─────────────────────────

export default function AttendancePage() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400 text-sm">Loading…</div>}>
      <AttendancePageInner />
    </Suspense>
  );
}
