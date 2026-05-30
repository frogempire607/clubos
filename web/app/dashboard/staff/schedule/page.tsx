"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Availability = { userId: string; dayOfWeek: number; startTime: string; endTime: string };
type Exception = { id: string; date: string; type: string; startTime: string | null; endTime: string | null; note: string | null };
type ClassInstance = {
  classId: string;
  sessionId: string | null;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  staffIds: string[];
  seriesStaffIds: string[];
  isSubstitute: boolean;
  canceled: boolean;
  note: string | null;
};
type StaffLite = { id: string; firstName: string; lastName: string };
type EventAssignment = { id: string; name: string; type: string; startsAt: string; endsAt: string };

type StaffSchedule = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  title: string | null;
  availability: Availability[];
  exceptions: Exception[];
  classes: ClassInstance[];
  events: EventAssignment[];
};

type AllEvent = { id: string; name: string; type: string; startsAt: string; date: string; assignedUserIds: string[] };
type AllClass = { id: string; name: string; daysOfWeek: number[]; startTime: string; endTime: string; assignedStaffIds: string[] };

type Feed = {
  staff: StaffSchedule[];
  allEvents: AllEvent[];
  allClasses: AllClass[];
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - out.getDay());
  return out;
}
function getWeekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export default function StaffSchedulePage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);

  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);

  const load = useCallback(() => {
    const from = toISODate(weekDays[0]);
    const to = toISODate(weekDays[6]);
    setLoading(true);
    fetch(`/api/staff/schedule?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setFeed(d ? { staff: d.staff ?? [], allEvents: d.allEvents ?? [], allClasses: d.allClasses ?? [] } : null);
        setLoading(false);
      });
  }, [weekDays]);

  useEffect(() => { load(); }, [load]);

  function shiftWeek(days: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + days);
    setWeekStart(startOfWeek(next));
  }

  const staff = feed?.staff ?? [];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Schedule</h1>
          <p className="text-sm text-text-muted mt-1">
            Availability, assigned classes, and event coverage. Click a day to add or remove an assignment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftWeek(-7)} className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">← Prev</button>
          <button onClick={() => setWeekStart(startOfWeek(new Date()))} className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">This week</button>
          <button onClick={() => shiftWeek(7)} className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Next →</button>
        </div>
      </div>

      <p className="text-xs text-text-muted mb-3">
        Week of {weekDays[0].toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
      </p>

      {loading ? (
        <p className="text-sm text-text-muted text-center py-16">Loading…</p>
      ) : staff.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-12 text-center">
          <p className="text-base font-medium text-text-primary mb-1">No staff yet</p>
          <p className="text-sm text-text-muted">
            Invite staff first on the <Link href="/dashboard/staff" className="underline">Directory</Link> page.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-app-bg border-b border-app-border">
                  <th className="sticky left-0 bg-app-bg text-left px-3 py-2 font-medium text-text-muted uppercase tracking-wider w-40">Staff</th>
                  {weekDays.map((d) => (
                    <th key={d.toISOString()} className="text-left px-2 py-2 font-medium text-text-muted uppercase tracking-wider min-w-[130px]">
                      <div>{DAY_LABELS[d.getDay()]}</div>
                      <div className="text-text-primary font-semibold">{d.getDate()}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} className="border-b border-app-border last:border-0 align-top">
                    <td className="sticky left-0 bg-surface px-3 py-3 w-40 border-r border-app-border">
                      <p className="text-sm font-medium text-text-primary">{s.firstName} {s.lastName}</p>
                      {s.title && <p className="text-[11px] text-text-muted">{s.title}</p>}
                      <p className="text-[10px] text-text-muted">{s.role === "OWNER" ? "Owner" : "Staff"}</p>
                    </td>
                    {weekDays.map((d) => (
                      <DayCell
                        key={d.toISOString()}
                        staff={s}
                        day={d}
                        allEvents={feed!.allEvents}
                        allClasses={feed!.allClasses}
                        allStaff={staff.map((x) => ({ id: x.id, firstName: x.firstName, lastName: x.lastName }))}
                        onChanged={load}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-text-muted mt-3">
        Recurring weekly hours and date exceptions are edited on the{" "}
        <Link href="/dashboard/staff/availability" className="underline">Availability</Link> page.
      </p>
    </div>
  );
}

function DayCell({
  staff,
  day,
  allEvents,
  allClasses,
  allStaff,
  onChanged,
}: {
  staff: StaffSchedule;
  day: Date;
  allEvents: AllEvent[];
  allClasses: AllClass[];
  allStaff: StaffLite[];
  onChanged: () => void;
}) {
  const dow = day.getDay();
  const dateStr = toISODate(day);
  const slots = staff.availability.filter((a) => a.dayOfWeek === dow);
  const exception = staff.exceptions.find((e) => e.date === dateStr);
  const classes = staff.classes.filter((c) => c.date === dateStr);
  const events = staff.events.filter((e) => e.startsAt.slice(0, 10) === dateStr);
  const isUnavailable = exception?.type === "UNAVAILABLE";
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingOcc, setEditingOcc] = useState<ClassInstance | null>(null);

  const eventsThisDay = allEvents.filter((e) => e.date === dateStr);
  const assignableEvents = eventsThisDay.filter((e) => !e.assignedUserIds.includes(staff.id));
  const classesThisDay = allClasses.filter((c) => c.daysOfWeek.includes(dow));
  const assignableClasses = classesThisDay.filter((c) => !c.assignedStaffIds.includes(staff.id));
  const canAssign = assignableEvents.length > 0 || assignableClasses.length > 0;

  async function assignEvent(eventId: string) {
    setBusy(true);
    await fetch(`/api/events/${eventId}/staff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: staff.id, role: "Coach" }),
    });
    setBusy(false);
    setPicking(false);
    onChanged();
  }
  async function unassignEvent(eventId: string) {
    setBusy(true);
    await fetch(`/api/events/${eventId}/staff?userId=${staff.id}`, { method: "DELETE" });
    setBusy(false);
    onChanged();
  }
  async function assignClass(classId: string) {
    setBusy(true);
    await fetch(`/api/classes/${classId}/staff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: staff.id }),
    });
    setBusy(false);
    setPicking(false);
    onChanged();
  }
  async function unassignClass(classId: string) {
    setBusy(true);
    await fetch(`/api/classes/${classId}/staff?userId=${staff.id}`, { method: "DELETE" });
    setBusy(false);
    onChanged();
  }

  return (
    <td className="px-2 py-3 align-top relative">
      {isUnavailable ? (
        <div className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded px-1.5 py-1">
          Unavailable{exception?.note ? ` — ${exception.note}` : ""}
        </div>
      ) : (
        <>
          {slots.length > 0 && (
            <div className="mb-1.5 space-y-0.5">
              {slots.map((s, i) => (
                <div key={i} className="text-[10px] text-text-muted">{s.startTime}–{s.endTime}</div>
              ))}
            </div>
          )}
          {exception?.type === "PARTIAL" && (
            <div className="text-[10px] text-orange-accent mb-1">Modified {exception.startTime}–{exception.endTime}</div>
          )}

          {classes.map((c, i) => (
            <div
              key={`c-${c.classId}-${i}`}
              className={`mb-1 text-[11px] rounded px-1.5 py-1 leading-tight flex items-start justify-between gap-1 ${
                c.canceled
                  ? "bg-app-bg text-text-muted line-through"
                  : c.isSubstitute
                    ? "bg-orange-accent/10 text-orange-accent"
                    : "bg-brand/10 text-brand"
              }`}
            >
              <span className="min-w-0">
                <span className="font-medium block truncate">
                  {c.name}
                  {c.isSubstitute && !c.canceled && <span className="ml-1 text-[8px] uppercase tracking-wide">· sub</span>}
                  {c.canceled && <span className="ml-1 text-[8px] uppercase tracking-wide">· canceled</span>}
                </span>
                <span className="text-[9px] opacity-75">{c.startTime}–{c.endTime}</span>
                {c.note && <span className="block text-[9px] opacity-75 truncate" title={c.note}>📝 {c.note}</span>}
              </span>
              <span className="flex flex-col items-end gap-0.5">
                <button onClick={() => setEditingOcc(c)} disabled={busy} title="Edit this occurrence" className="opacity-60 hover:opacity-100 leading-none">✎</button>
                <button onClick={() => unassignClass(c.classId)} disabled={busy} title="Remove from entire series" className="opacity-60 hover:opacity-100 leading-none">×</button>
              </span>
            </div>
          ))}

          {editingOcc && (
            <OccurrenceEditor
              instance={editingOcc}
              allStaff={allStaff}
              onClose={() => setEditingOcc(null)}
              onSaved={() => { setEditingOcc(null); onChanged(); }}
            />
          )}

          {events.map((e) => (
            <div key={e.id} className="mb-1 text-[11px] bg-orange-accent/10 text-orange-accent rounded px-1.5 py-1 leading-tight flex items-start justify-between gap-1">
              <span className="min-w-0">
                <span className="font-medium block truncate">{e.name}</span>
                <span className="text-[9px] opacity-75">
                  {new Date(e.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </span>
              </span>
              <button onClick={() => unassignEvent(e.id)} disabled={busy} title="Remove" className="text-orange-accent/60 hover:text-orange-accent leading-none">×</button>
            </div>
          ))}

          {slots.length === 0 && classes.length === 0 && events.length === 0 && !exception && (
            <div className="text-[10px] text-text-muted opacity-50 mb-1">Off</div>
          )}

          {canAssign && (
            <button onClick={() => setPicking((p) => !p)} className="text-[10px] text-text-muted hover:text-brand">
              {picking ? "Cancel" : "+ Assign"}
            </button>
          )}

          {picking && (
            <div className="absolute z-20 mt-1 left-1 right-1 bg-surface border border-app-border rounded-lg shadow-lg p-1.5 max-h-56 overflow-y-auto">
              {assignableEvents.length > 0 && (
                <>
                  <p className="text-[9px] uppercase tracking-wider text-text-muted px-1 py-0.5">Events</p>
                  {assignableEvents.map((e) => (
                    <button key={e.id} onClick={() => assignEvent(e.id)} disabled={busy}
                      className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-app-bg text-text-primary truncate">
                      {e.name}
                    </button>
                  ))}
                </>
              )}
              {assignableClasses.length > 0 && (
                <>
                  <p className="text-[9px] uppercase tracking-wider text-text-muted px-1 py-0.5 mt-1">Classes</p>
                  {assignableClasses.map((c) => (
                    <button key={c.id} onClick={() => assignClass(c.id)} disabled={busy}
                      className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-app-bg text-text-primary truncate">
                      {c.name} <span className="text-text-muted">{c.startTime}–{c.endTime}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </td>
  );
}

const SCOPES: { value: "occurrence" | "following" | "series"; label: string; hint: string }[] = [
  { value: "occurrence", label: "This occurrence", hint: "Only this one day" },
  { value: "following", label: "This & following", hint: "This day and every later session" },
  { value: "series", label: "Entire series", hint: "The recurring class itself" },
];

function OccurrenceEditor({
  instance,
  allStaff,
  onClose,
  onSaved,
}: {
  instance: ClassInstance;
  allStaff: StaffLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<"occurrence" | "following" | "series">("occurrence");
  const [staffMode, setStaffMode] = useState<string>(""); // "" keep, "__reset__", "__none__", or a userId
  const [startTime, setStartTime] = useState(instance.startTime);
  const [endTime, setEndTime] = useState(instance.endTime);
  const [note, setNote] = useState(instance.note ?? "");
  const [canceled, setCanceled] = useState(instance.canceled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const seriesScope = scope === "series";

  async function save() {
    setBusy(true);
    setErr("");
    const payload: Record<string, unknown> = { date: instance.date, scope };
    if (staffMode === "__reset__") payload.staffIds = null;
    else if (staffMode === "__none__") payload.staffIds = [];
    else if (staffMode) payload.staffIds = [staffMode];
    if (startTime && startTime !== instance.startTime) payload.startTime = startTime;
    if (endTime && endTime !== instance.endTime) payload.endTime = endTime;
    if (!seriesScope) {
      payload.note = note.trim() ? note.trim() : null;
      payload.canceled = canceled;
    }
    const res = await fetch(`/api/classes/${instance.classId}/occurrence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not save"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-sm border border-app-border" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{instance.name}</h3>
            <p className="text-[11px] text-text-muted">{new Date(instance.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1.5">Apply to</p>
            <div className="space-y-1">
              {SCOPES.map((s) => (
                <label key={s.value} className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="scope" checked={scope === s.value} onChange={() => setScope(s.value)} className="mt-0.5" />
                  <span>
                    <span className="text-text-primary">{s.label}</span>
                    <span className="text-text-muted text-xs block">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-text-muted mb-1">Coach</label>
            <select value={staffMode} onChange={(e) => setStaffMode(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
              <option value="">Keep current coach(es)</option>
              <option value="__reset__">Reset to series default</option>
              <option value="__none__">No coach (clear)</option>
              <optgroup label="Substitute / replace with">
                {allStaff.map((st) => (
                  <option key={st.id} value={st.id}>{st.firstName} {st.lastName}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-text-muted mb-1">Start</label>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-2 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-text-muted mb-1">End</label>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                className="w-full px-2 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
          </div>

          {!seriesScope && (
            <>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-text-muted mb-1">Note for this occurrence</label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
                  placeholder="e.g. Bring agility ladders; gym B" />
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={canceled} onChange={(e) => setCanceled(e.target.checked)} />
                <span className="text-text-primary">Cancel this {scope === "following" ? "and following sessions" : "session"}</span>
              </label>
            </>
          )}
          {seriesScope && (
            <p className="text-[11px] text-text-muted">
              Series changes update the recurring class. Future sessions are regenerated; attendance and one-off edits are preserved.
            </p>
          )}

          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</div>}

          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="text-sm px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Cancel</button>
            <button onClick={save} disabled={busy} className="text-sm px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
