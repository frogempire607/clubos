"use client";

// B21 — Schedule & availability tab. This is the existing Staff Schedule page
// (app/dashboard/staff/schedule) and Availability page
// (app/dashboard/staff/availability) scoped to one person, using the same
// API calls:
//   week feed    GET  /api/staff/schedule?from&to
//   assign       POST/DELETE /api/classes/:id/staff, /api/events/:id/staff
//   one day      POST /api/classes/:id/occurrence
//   weekly hours GET/POST /api/staff/:id/availability (POST replaces the full list)
//   time off     GET/POST/DELETE /api/staff/:id/availability/exceptions
// Fit ("outside hours") comes from lib/staffScheduleFit.ts: SAVED weekly
// hours + date exceptions.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ChevronLeft, ChevronRight, Lock, Pencil, X } from "lucide-react";
import Sheet from "@/components/Sheet";
import Reveal from "@/components/staff/access/Reveal";
import { range12h, to12h } from "@/lib/time12";
import { classTimesForDay, eventDaysInRange } from "@/lib/staffAssignments";
import {
  availabilityForDate,
  fitsWindows,
  fromMinutes,
  localHhmm,
  localYmd,
  scheduleFit,
  weekDates,
  type DayBand,
  type DateException,
  type WeeklySlot,
} from "@/lib/staffScheduleFit";
import type { StaffTabProps } from "@/components/staff/types";

// ── feed shapes (GET /api/staff/schedule) ───────────────────────────────────
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
type FeedException = { id: string; date: string; type: string; startTime: string | null; endTime: string | null; note: string | null };
type FeedPerson = {
  id: string;
  firstName: string;
  lastName: string;
  availability: { dayOfWeek: number; startTime: string; endTime: string }[];
  exceptions: FeedException[];
  classes: ClassInstance[];
  events: { id: string; name: string; type: string; startsAt: string; endsAt: string; sessions?: { startsAt: string; endsAt: string }[] }[];
};
type AllEvent = { id: string; name: string; type: string; startsAt: string; endsAt: string; sessions?: { startsAt: string; endsAt: string }[]; date: string; assignedUserIds: string[] };
type AllClass = { id: string; name: string; daysOfWeek: number[]; startTime: string; endTime: string; dayOverrides?: { dayOfWeek: number; startTime: string; endTime: string }[]; assignedStaffIds: string[] };
type Feed = { me: FeedPerson | null; allEvents: AllEvent[]; allClasses: AllClass[]; allStaff: { id: string; firstName: string; lastName: string }[] };

// ── editor shapes ───────────────────────────────────────────────────────────
type Slot = { key: number; dayOfWeek: number; startTime: string; endTime: string; active: boolean };
type Exception = { id: string; date: string; type: string; startTime: string | null; endTime: string | null; note: string | null };

type Item =
  | { kind: "class"; key: string; name: string; date: string; startTime: string; endTime: string; inst: ClassInstance; inSeries: boolean }
  | { kind: "event"; key: string; name: string; date: string; startTime: string; endTime: string; eventId: string };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";
const input = "min-h-[44px] rounded-lg border border-app-border bg-surface px-2.5 text-[14px] text-text-primary md:min-h-[36px] md:text-[13px] disabled:opacity-60";
const tint = {
  ok: { background: "var(--color-success-surface)", color: "var(--color-success-text)" },
  warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
  chip: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  pending: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
  danger: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
};

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
/** "Thu, Sep 24" */
function shortDate(ymd: string): string {
  return ymdToUtc(ymd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function addDays(ymd: string, n: number): string {
  return new Date(ymdToUtc(ymd).getTime() + n * 86400000).toISOString().slice(0, 10);
}
function bandLabel(b: DayBand): string {
  const ranges = b.windows.map((w) => range12h(fromMinutes(w.start), fromMinutes(w.end))).join(", ");
  if (b.kind === "available") return ranges;
  if (b.kind === "none") return "Not available";
  if (b.kind === "time_off") return `Time off${b.note ? ` · ${b.note}` : ""}`;
  return `${ranges || "No hours"} (this date)${b.note ? ` · ${b.note}` : ""}`;
}
function bandStyle(b: DayBand) {
  return b.kind === "available" ? tint.ok : b.kind === "none" ? tint.chip : tint.warn;
}
function daySig(slots: { dayOfWeek: number; startTime: string; endTime: string; active: boolean }[], dow: number): string {
  return JSON.stringify(slots.filter((s) => s.dayOfWeek === dow).map((s) => [s.startTime, s.endTime, s.active]));
}
async function errorOf(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : fallback;
}

export default function ScheduleTab({ data, setDirty, setProblem }: StaffTabProps) {
  const { staff, viewer } = data;
  const staffId = staff.id;
  const first = staff.firstName || "This staff member";
  const self = viewer.isSelf;
  const { data: session } = useSession();
  const recorder = session?.user?.name || "your name";

  const today = localYmd(new Date());
  const thisWeek = weekDates(today)[0];
  const [weekStart, setWeekStart] = useState(thisWeek);
  const days = useMemo(() => weekDates(weekStart), [weekStart]);

  // ── week feed ─────────────────────────────────────────────────────────────
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const loadWeek = useCallback(async () => {
    const res = await fetch(`/api/staff/schedule?from=${days[0]}&to=${days[6]}`, { cache: "no-store" });
    if (!res.ok) {
      setFeedError(await errorOf(res, "Couldn't load this week."));
      return;
    }
    const d = await res.json();
    const all: FeedPerson[] = Array.isArray(d.staff) ? d.staff : [];
    setFeed({
      me: all.find((p) => p.id === staffId) ?? null,
      allEvents: d.allEvents ?? [],
      allClasses: d.allClasses ?? [],
      allStaff: all.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName })),
    });
    setFeedError(null);
  }, [days, staffId]);
  useEffect(() => {
    loadWeek();
  }, [loadWeek]);

  // ── weekly hours + exceptions (editor data) ───────────────────────────────
  const keySeq = useRef(0);
  const [savedSlots, setSavedSlots] = useState<Slot[] | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [hoursLoadError, setHoursLoadError] = useState(false);
  const loadHours = useCallback(async () => {
    const [a, e] = await Promise.all([
      fetch(`/api/staff/${staffId}/availability`, { cache: "no-store" }),
      fetch(`/api/staff/${staffId}/availability/exceptions`, { cache: "no-store" }),
    ]);
    if (a.ok) {
      const raw = (await a.json()) as { dayOfWeek: number; startTime: string; endTime: string; active: boolean }[];
      const list = (Array.isArray(raw) ? raw : []).map((s) => ({
        key: ++keySeq.current,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        active: s.active !== false,
      }));
      setSavedSlots(list);
      setSlots(list);
      setHoursLoadError(false);
    } else {
      setHoursLoadError(true);
    }
    if (e.ok) {
      const raw = await e.json();
      setExceptions(Array.isArray(raw) ? raw : []);
    }
  }, [staffId]);
  useEffect(() => {
    loadHours();
  }, [loadHours]);

  // ── fit for the week (SAVED hours + exceptions, same as the club Schedule) ─
  const items: Item[] = useMemo(() => {
    const me = feed?.me;
    if (!me) return [];
    const out: Item[] = [];
    for (const c of me.classes) {
      out.push({
        kind: "class",
        key: `c-${c.classId}-${c.date}`,
        name: c.name,
        date: c.date,
        startTime: c.startTime,
        endTime: c.endTime,
        inst: c,
        inSeries: c.seriesStaffIds.includes(staffId),
      });
    }
    // A multi-day event shows on every day of this week it touches.
    for (const ev of me.events) {
      for (const part of eventDaysInRange(ev, days, localYmd)) {
        out.push({ kind: "event", key: `e-${ev.id}-${part.date}-${part.startsAt.getTime()}`, name: ev.name, date: part.date, startTime: localHhmm(part.startsAt), endTime: localHhmm(part.endsAt), eventId: ev.id });
      }
    }
    return out.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  }, [feed, staffId, days]);

  const fitSlots: WeeklySlot[] = useMemo(() => (feed?.me?.availability ?? []).map((a) => ({ ...a, active: true })), [feed]);
  const fitExceptions: DateException[] = useMemo(() => feed?.me?.exceptions ?? [], [feed]);
  const live = useMemo(() => items.filter((i) => !(i.kind === "class" && i.inst.canceled)), [items]);
  const fit = useMemo(() => scheduleFit(days, fitSlots, fitExceptions, live), [days, fitSlots, fitExceptions, live]);
  const outsideKeys = useMemo(() => new Set(fit.results.filter((r) => r.fit === "outside").map((r) => r.assignment.key)), [fit]);

  // Red tab dot: only judged on the current week, so browsing ahead doesn't clear or raise it.
  useEffect(() => {
    if (feed && weekStart === thisWeek) setProblem?.(fit.outside > 0);
  }, [feed, fit.outside, weekStart, thisWeek, setProblem]);

  // ── weekly hours dirty state ──────────────────────────────────────────────
  const canHours = viewer.canEditHours && !hoursLoadError;
  const changedDays = useMemo(() => {
    const set = new Set<number>();
    if (!savedSlots) return set;
    for (let d = 0; d < 7; d++) if (daySig(slots, d) !== daySig(savedSlots, d)) set.add(d);
    return set;
  }, [slots, savedSlots]);
  const nChanged = changedDays.size;
  const dirty = canHours && nChanged > 0;
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  // ── status line ───────────────────────────────────────────────────────────
  const [flash, setFlash] = useState<string | null>(null);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── assignments ───────────────────────────────────────────────────────────
  const [pickDate, setPickDate] = useState<string | null>(null);
  const [confirmClass, setConfirmClass] = useState<Extract<Item, { kind: "class" }> | null>(null);
  const [editing, setEditing] = useState<ClassInstance | null>(null);

  async function assign(kind: "class" | "event", id: string, name: string, date: string) {
    setBusy(true);
    setWeekError(null);
    const res = await fetch(kind === "class" ? `/api/classes/${id}/staff` : `/api/events/${id}/staff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "class" ? { userId: staffId } : { userId: staffId, role: "Coach" }),
    });
    setBusy(false);
    if (!res.ok) {
      setWeekError(await errorOf(res, `Couldn't assign ${first} to ${name}.`));
      return;
    }
    setPickDate(null);
    setFlash(`Assigned ${first} to ${name}${kind === "class" ? " (every week it runs)" : `, ${shortDate(date)}`} — saved`);
    loadWeek();
  }
  async function unassign(item: Item) {
    setBusy(true);
    setWeekError(null);
    const url =
      item.kind === "class" ? `/api/classes/${item.inst.classId}/staff?userId=${staffId}` : `/api/events/${item.eventId}/staff?userId=${staffId}`;
    const res = await fetch(url, { method: "DELETE" });
    setBusy(false);
    setConfirmClass(null);
    if (!res.ok) {
      setWeekError(await errorOf(res, `Couldn't remove ${item.name}.`));
      return;
    }
    setFlash(`Removed ${first} from ${item.name}${item.kind === "class" ? " (every week)" : ""} — saved`);
    loadWeek();
  }

  // ── weekly hours editing ──────────────────────────────────────────────────
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [hoursFlash, setHoursFlash] = useState<string | null>(null);
  const [savingHours, setSavingHours] = useState(false);
  function addSlot(dow: number) {
    setHoursFlash(null);
    setSlots((p) => [...p, { key: ++keySeq.current, dayOfWeek: dow, startTime: "09:00", endTime: "17:00", active: true }]);
  }
  function updateSlot(key: number, patch: Partial<Slot>) {
    setHoursFlash(null);
    setSlots((p) => p.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
  function removeSlot(key: number) {
    setHoursFlash(null);
    setSlots((p) => p.filter((s) => s.key !== key));
  }
  async function saveHours() {
    setHoursError(null);
    for (const s of slots) {
      if (!s.startTime || !s.endTime || s.startTime >= s.endTime) {
        setHoursError(`Check ${DAY_NAMES[s.dayOfWeek]}: ${to12h(s.startTime) || "?"} – ${to12h(s.endTime) || "?"} ends before it starts.`);
        return;
      }
    }
    setSavingHours(true);
    const res = await fetch(`/api/staff/${staffId}/availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slots: slots.map((s) => ({ dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, active: s.active })),
      }),
    });
    setSavingHours(false);
    if (!res.ok) {
      setHoursError(await errorOf(res, "Couldn't save weekly hours."));
      return;
    }
    setHoursFlash(`Weekly hours saved — recorded under ${recorder}.`);
    await loadHours();
    loadWeek();
  }
  function discardHours() {
    if (savedSlots) setSlots(savedSlots);
    setHoursError(null);
    setHoursFlash("Changes discarded");
  }

  // ── time off ──────────────────────────────────────────────────────────────
  const [exDate, setExDate] = useState("");
  const [exType, setExType] = useState<"UNAVAILABLE" | "PARTIAL">("UNAVAILABLE");
  const [exStart, setExStart] = useState("09:00");
  const [exEnd, setExEnd] = useState("13:00");
  const [exNote, setExNote] = useState("");
  const [exError, setExError] = useState<string | null>(null);
  const [exFlash, setExFlash] = useState<string | null>(null);
  const [exBusy, setExBusy] = useState(false);
  async function addException() {
    if (!exDate) return;
    setExError(null);
    if (exType === "PARTIAL" && (!exStart || !exEnd || exStart >= exEnd)) {
      setExError("Modified hours must end after they start.");
      return;
    }
    setExBusy(true);
    const res = await fetch(`/api/staff/${staffId}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: exDate,
        type: exType,
        startTime: exType === "PARTIAL" ? exStart : null,
        endTime: exType === "PARTIAL" ? exEnd : null,
        note: exNote.trim() || null,
      }),
    });
    setExBusy(false);
    if (!res.ok) {
      setExError(await errorOf(res, "Couldn't add that date."));
      return;
    }
    setExFlash(`${exType === "PARTIAL" ? "Modified hours set" : "Time off added"} for ${shortDate(exDate)} — recorded under ${recorder}.`);
    setExDate("");
    setExNote("");
    await loadHours();
    loadWeek();
  }
  async function removeException(x: Exception) {
    setExError(null);
    setExBusy(true);
    const res = await fetch(`/api/staff/${staffId}/availability/exceptions?exceptionId=${x.id}`, { method: "DELETE" });
    setExBusy(false);
    if (!res.ok) {
      setExError(await errorOf(res, "Couldn't remove that date."));
      return;
    }
    setExFlash(`${shortDate(x.date)} removed — saved.`);
    await loadHours();
    loadWeek();
  }
  const upcoming = exceptions.filter((x) => x.date.slice(0, 10) >= today).sort((a, b) => a.date.localeCompare(b.date));

  // ── picker options for a day ──────────────────────────────────────────────
  const pickBand = pickDate ? availabilityForDate(pickDate, fitSlots, fitExceptions) : null;
  const pickOptions = useMemo(() => {
    if (!pickDate || !feed) return [];
    const band = availabilityForDate(pickDate, fitSlots, fitExceptions);
    const dow = ymdToUtc(pickDate).getUTCDay();
    const evs = feed.allEvents
      .filter((e) => !e.assignedUserIds.includes(staffId))
      .flatMap((e) => {
        // Every day the event touches (multi-day camps included), judged by that day's start.
        const part = eventDaysInRange(e, [pickDate], localYmd)[0];
        if (!part) return [];
        const st = localHhmm(part.startsAt);
        return [{ kind: "event" as const, id: e.id, name: e.name, time: to12h(st), fits: fitsWindows(st, "", band.windows), sort: st }];
      });
    const cls = feed.allClasses
      .filter((c) => c.daysOfWeek.includes(dow) && !c.assignedStaffIds.includes(staffId))
      .map((c) => {
        // That weekday's own time when the class has a per-day override.
        const t = classTimesForDay(c.startTime, c.endTime, c.dayOverrides, dow);
        return { kind: "class" as const, id: c.id, name: c.name, time: range12h(t.startTime, t.endTime), fits: fitsWindows(t.startTime, t.endTime, band.windows), sort: t.startTime };
      });
    return [...cls, ...evs].sort((a, b) => a.sort.localeCompare(b.sort));
  }, [pickDate, feed, fitSlots, fitExceptions, staffId]);

  const weekLabel = `Week of ${ymdToUtc(days[0]).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  const rangeCap = `${ymdToUtc(days[0]).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${ymdToUtc(days[6]).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  const whoIs = self ? "you’re" : `${first} is`;

  return (
    <div className="space-y-4 pb-4">
      {/* ── Week ─────────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-text-primary">{weekLabel}</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week" className={`${btn} gap-1 border border-app-border text-text-primary hover:bg-app-bg`}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <button type="button" onClick={() => setWeekStart(thisWeek)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              This week
            </button>
            <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week" className={`${btn} gap-1 border border-app-border text-text-primary hover:bg-app-bg`}>
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[12.5px] text-text-muted">
          Green = when {whoIs} available. Orange = assigned outside those hours, or time off. {rangeCap}.
        </p>

        {(flash || weekError) && (
          <div role="status" className="mt-3 flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-[13px]" style={weekError ? tint.danger : tint.ok}>
            <span>{weekError ?? flash}</span>
            <button type="button" onClick={() => { setFlash(null); setWeekError(null); }} aria-label="Dismiss" className="-my-2 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center md:h-7 md:w-7">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {feedError ? (
          <p className="mt-4 text-[13px] text-text-muted">{feedError}</p>
        ) : !feed ? (
          <p className="mt-4 text-[13px] text-text-muted">Loading the week…</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-1.5 lg:grid-cols-7 lg:gap-2">
            {days.map((d, i) => {
              const band = fit.days[i];
              const dayItems = items.filter((it) => it.date === d);
              const isToday = d === today;
              return (
                <div
                  key={d}
                  className={`grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 rounded-[10px] border bg-surface px-3 py-2.5 lg:flex lg:min-h-[156px] lg:flex-col lg:gap-1.5 lg:p-2.5 ${
                    isToday ? "border-brand ring-1 ring-inset ring-brand" : "border-app-border"
                  }`}
                >
                  <div className="row-span-3 flex flex-col text-[12px] text-text-muted lg:flex-row lg:items-baseline lg:justify-between">
                    <b className="font-semibold uppercase tracking-wide text-text-primary">{DOW[i]}</b>
                    <span>{ymdToUtc(d).getUTCDate()}</span>
                  </div>
                  <span className="max-w-full self-start rounded-md px-1.5 py-0.5 text-[12px]" style={bandStyle(band)}>
                    {bandLabel(band)}
                  </span>
                  {dayItems.length > 0 && (
                    <div className="flex min-w-0 flex-col gap-1.5">
                      {dayItems.map((it) => {
                        const canceled = it.kind === "class" && it.inst.canceled;
                        const outside = outsideKeys.has(it.key);
                        const style = canceled ? tint.chip : outside ? tint.warn : tint.pending;
                        const sub = it.kind === "class" && it.inst.isSubstitute && !canceled;
                        return (
                          <div
                            key={it.key}
                            className="flex min-w-0 items-center gap-0.5 rounded-lg py-1 pl-2.5 pr-1"
                            style={{ ...style, ...(outside ? { boxShadow: "inset 0 0 0 1px var(--color-warn-border)" } : {}) }}
                          >
                            <div className={`min-w-0 flex-1 text-[13px] font-medium leading-snug ${canceled ? "line-through" : ""}`}>
                              <span className="block truncate">
                                {it.name}
                                {it.kind === "event" && <span className="font-normal"> · event</span>}
                              </span>
                              <small className="block text-[12px] font-normal opacity-90">
                                {range12h(it.startTime, it.endTime)}
                                {outside && " · outside hours"}
                                {sub && " · sub"}
                                {canceled && " · canceled"}
                              </small>
                            </div>
                            {viewer.canAssign && it.kind === "class" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setEditing(it.inst)}
                                aria-label={`Change ${it.name} on ${shortDate(d)}`}
                                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-70 hover:opacity-100 md:h-7 md:w-7"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {viewer.canAssign && (it.kind === "event" || it.inSeries) && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => (it.kind === "class" ? setConfirmClass(it) : unassign(it))}
                                aria-label={`Remove ${it.name} on ${shortDate(d)}`}
                                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-70 hover:opacity-100 md:h-7 md:w-7"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {viewer.canAssign && (
                    <button
                      type="button"
                      onClick={() => {
                        setWeekError(null);
                        setPickDate(d);
                      }}
                      className="inline-flex min-h-[44px] items-center self-start text-[12.5px] font-medium text-brand hover:underline md:min-h-0 lg:mt-auto"
                    >
                      + Assign
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!viewer.canAssign && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2.5 text-[12.5px] text-text-muted" style={{ background: "var(--color-inset-surface)", borderColor: "var(--color-inset-border)" }}>
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              <b className="font-medium text-text-primary">Assigning classes</b> needs Staff schedule: edit.
            </span>
            <span>
              {self
                ? "You see your assignments here. Your hours and time off below are yours to change."
                : `You see ${first}'s assignments here.${viewer.canEditHours ? ` You can change ${first}'s hours and time off below.` : ""}`}
            </span>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* ── Weekly hours ───────────────────────────────────────────────── */}
        <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-text-primary">Weekly hours</h2>
            {dirty && <span className="text-[12px] font-medium text-brand">Unsaved</span>}
          </div>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {self
              ? "Your recurring availability. Owners can see and change it too — every change is recorded under the name of whoever made it."
              : `${first}'s recurring availability. ${first} can keep this current from their own profile${viewer.canEditHours ? "; you can change it here too" : ""}.`}
          </p>
          {hoursLoadError && (
            <p className="mt-2 text-[12.5px] text-text-muted">Weekly hours couldn't be loaded for editing. The week above shows the saved hours.</p>
          )}
          {!viewer.canEditHours && (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-muted">
              <Lock className="h-3.5 w-3.5" aria-hidden /> Changing hours needs Staff schedule: edit.
            </p>
          )}
          <div className="mt-2">
            {DAY_NAMES.map((name, dow) => {
              const daySlots = slots.filter((s) => s.dayOfWeek === dow);
              const changed = changedDays.has(dow);
              return (
                <div
                  key={name}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1.5 border-b py-2.5 last:border-b-0 sm:grid-cols-[104px_minmax(0,1fr)_auto] ${
                    changed ? "-mx-4 bg-brand/5 px-4 sm:-mx-5 sm:px-5" : ""
                  }`}
                  style={{ borderColor: "var(--color-hairline)" }}
                >
                  <div className="pt-2.5 text-[13.5px] font-medium text-text-primary md:pt-1.5">{name}</div>
                  <div className="col-span-2 row-start-2 flex min-w-0 flex-col gap-1.5 sm:col-span-1 sm:row-start-auto">
                    {daySlots.length === 0 && <p className="py-1.5 text-[12.5px] text-text-muted">Off</p>}
                    {daySlots.map((s) => (
                      <div key={s.key} className="flex flex-wrap items-center gap-2">
                        <input
                          type="time"
                          value={s.startTime}
                          disabled={!canHours}
                          onChange={(e) => updateSlot(s.key, { startTime: e.target.value })}
                          aria-label={`${name} start time`}
                          className={`${input} ${s.active ? "" : "opacity-50"}`}
                        />
                        <span className="text-text-muted">–</span>
                        <input
                          type="time"
                          value={s.endTime}
                          disabled={!canHours}
                          onChange={(e) => updateSlot(s.key, { endTime: e.target.value })}
                          aria-label={`${name} end time`}
                          className={`${input} ${s.active ? "" : "opacity-50"}`}
                        />
                        <label className="inline-flex min-h-[44px] items-center gap-1.5 text-[12.5px] text-text-muted md:min-h-0">
                          <input
                            type="checkbox"
                            checked={s.active}
                            disabled={!canHours}
                            onChange={(e) => updateSlot(s.key, { active: e.target.checked })}
                          />
                          Active
                        </label>
                        {canHours && (
                          <button
                            type="button"
                            onClick={() => removeSlot(s.key)}
                            className="inline-flex min-h-[44px] items-center rounded-md px-2 text-[12.5px] md:min-h-0 md:py-1"
                            style={{ color: "var(--color-danger-text)" }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {canHours ? (
                    <button
                      type="button"
                      onClick={() => addSlot(dow)}
                      className="inline-flex min-h-[44px] items-center justify-self-end text-[12.5px] font-medium text-brand hover:underline md:min-h-0 md:pt-1.5"
                    >
                      + Add slot
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Time off & date exceptions ─────────────────────────────────── */}
        <section className="self-start rounded-xl border border-app-border bg-surface p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold text-text-primary">Time off &amp; date exceptions</h2>
          <p className="mt-1 text-[12.5px] text-text-muted">
            Block out vacation days or set modified hours for one date. <b className="font-medium text-text-primary">Saves when you add it.</b>
          </p>
          {viewer.canEditHours ? (
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-text-muted">
                Date
                <input type="date" value={exDate} onChange={(e) => setExDate(e.target.value)} className={`${input} w-full`} />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-text-muted">
                Type
                <select value={exType} onChange={(e) => setExType(e.target.value as "UNAVAILABLE" | "PARTIAL")} className={`${input} w-full`}>
                  <option value="UNAVAILABLE">Unavailable</option>
                  <option value="PARTIAL">Modified hours</option>
                </select>
              </label>
              <Reveal open={exType === "PARTIAL"} className="col-span-2">
                <div className="grid grid-cols-2 gap-2.5 pt-0.5">
                  <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-text-muted">
                    From
                    <input type="time" value={exStart} onChange={(e) => setExStart(e.target.value)} className={`${input} w-full`} aria-label="Modified hours start" />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-text-muted">
                    To
                    <input type="time" value={exEnd} onChange={(e) => setExEnd(e.target.value)} className={`${input} w-full`} aria-label="Modified hours end" />
                  </label>
                </div>
              </Reveal>
              <label className="col-span-2 flex min-w-0 flex-col gap-1 text-[12px] font-medium text-text-muted">
                Note (optional)
                <input type="text" value={exNote} maxLength={200} onChange={(e) => setExNote(e.target.value)} placeholder="e.g. Vacation" className={`${input} w-full`} />
              </label>
              <button
                type="button"
                onClick={addException}
                disabled={!exDate || exBusy}
                className={`${btn} col-span-2 border border-brand text-brand hover:bg-brand/5`}
              >
                {exBusy ? "Saving…" : "Add"}
              </button>
            </div>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-muted">
              <Lock className="h-3.5 w-3.5" aria-hidden /> Adding time off needs Staff schedule: edit.
            </p>
          )}
          {(exError || exFlash) && (
            <p role="status" className="mt-2.5 rounded-lg px-3 py-2 text-[12.5px]" style={exError ? tint.danger : tint.ok}>
              {exError ?? exFlash}
            </p>
          )}
          <div className="mt-3.5 border-t pt-1" style={{ borderColor: "var(--color-hairline)" }}>
            {upcoming.length === 0 ? (
              <p className="py-3 text-center text-[12.5px] text-text-muted">No upcoming exceptions.</p>
            ) : (
              <ul>
                {upcoming.map((x) => (
                  <li key={x.id} className="flex items-center gap-2 border-b py-2 last:border-b-0" style={{ borderColor: "var(--color-hairline)" }}>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium text-text-primary">{shortDate(x.date)}</div>
                      <div className="text-[12px] text-text-muted">
                        {x.type === "UNAVAILABLE" ? "Unavailable" : `Modified hours ${range12h(x.startTime, x.endTime) || "(no times)"}`}
                        {x.note ? ` · ${x.note}` : ""}
                      </div>
                    </div>
                    {viewer.canEditHours && (
                      <button
                        type="button"
                        disabled={exBusy}
                        onClick={() => removeException(x)}
                        aria-label={`Remove ${shortDate(x.date)}`}
                        className="inline-flex min-h-[44px] items-center rounded-md px-2 text-[12.5px] md:min-h-0 md:py-1"
                        style={{ color: "var(--color-danger-text)" }}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* ── One sticky save bar for weekly hours ─────────────────────────── */}
      {canHours && savedSlots && (
        <div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center gap-2 rounded-xl border border-app-border bg-surface px-4 py-3 shadow-lg md:bottom-4">
          <div className="flex min-w-0 basis-full items-center gap-2 text-[13px] text-text-muted sm:basis-auto sm:flex-1" role="status">
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />}
            <span style={hoursError ? { color: "var(--color-danger-text)" } : undefined}>
              {hoursError
                ? hoursError
                : dirty
                  ? `${nChanged} unsaved change${nChanged === 1 ? "" : "s"} to weekly hours — saved under ${recorder}`
                  : hoursFlash ?? "Weekly hours saved"}
            </span>
          </div>
          {dirty && (
            <button type="button" onClick={discardHours} className={`${btn} flex-1 border border-app-border text-text-primary hover:bg-app-bg sm:flex-none`}>
              Discard
            </button>
          )}
          <button
            type="button"
            onClick={saveHours}
            disabled={!dirty || savingHours}
            className={`${btn} flex-1 bg-brand text-white hover:bg-brand-hover sm:flex-none`}
          >
            {savingHours ? "Saving…" : "Save weekly hours"}
          </button>
        </div>
      )}

      {/* ── + Assign picker ─────────────────────────────────────────────── */}
      <Sheet
        open={!!pickDate}
        onClose={() => setPickDate(null)}
        title={pickDate ? `Assign ${first} — ${shortDate(pickDate)}` : ""}
        description={pickBand ? `${self ? "Your" : `${first}'s`} hours that day: ${bandLabel(pickBand)}. Saves as soon as you pick.` : undefined}
        footer={
          <button type="button" onClick={() => setPickDate(null)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
            Cancel
          </button>
        }
      >
        {weekError && (
          <p role="alert" className="mb-2 rounded-lg px-3 py-2 text-[12.5px]" style={tint.danger}>
            {weekError}
          </p>
        )}
        {pickOptions.length === 0 ? (
          <p className="py-4 text-center text-[12.5px] text-text-muted">No other classes or events run this day.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {pickOptions.map((o) => (
              <button
                key={`${o.kind}-${o.id}`}
                type="button"
                disabled={busy}
                onClick={() => pickDate && assign(o.kind, o.id, o.name, pickDate)}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-app-border px-3 py-2 text-left hover:bg-app-bg disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13.5px] font-medium text-text-primary">{o.name}</b>
                  <small className="block text-[12px] text-text-muted">
                    {o.kind === "event" ? `Event · starts ${o.time}` : `${o.time} · every ${DAY_NAMES[ymdToUtc(pickDate!).getUTCDay()]}`}
                  </small>
                </span>
                <span className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium" style={o.fits ? tint.ok : tint.warn}>
                  {o.fits ? "Fits hours" : "Outside hours"}
                </span>
              </button>
            ))}
          </div>
        )}
      </Sheet>

      {/* ── Remove from a class series ──────────────────────────────────── */}
      <Sheet
        open={!!confirmClass}
        onClose={() => setConfirmClass(null)}
        title={confirmClass ? `Remove ${first} from ${confirmClass.name}?` : ""}
        description={
          confirmClass
            ? `This takes ${first} off every ${confirmClass.name} session, not just ${shortDate(confirmClass.date)}. To change one day only, use the pencil instead.`
            : undefined
        }
        footer={
          <>
            <button type="button" onClick={() => setConfirmClass(null)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              Keep {first} on it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => confirmClass && unassign(confirmClass)}
              className={`${btn} bg-red-600 text-white hover:bg-red-700`}
            >
              Remove from every week
            </button>
          </>
        }
      />

      {editing && feed && (
        <OccurrenceEditor
          instance={editing}
          allStaff={feed.allStaff}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setFlash(msg);
            loadWeek();
          }}
        />
      )}
    </div>
  );
}

// ── Edit one day of a class (same as the Schedule page's occurrence editor) ──
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
  allStaff: { id: string; firstName: string; lastName: string }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [scope, setScope] = useState<"occurrence" | "following" | "series">("occurrence");
  const [staffMode, setStaffMode] = useState(""); // "" keep, "__reset__", "__none__", or a userId
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
    setBusy(false);
    if (!res.ok) {
      setErr(await errorOf(res, "Couldn't save."));
      return;
    }
    onSaved(`${instance.name}, ${shortDate(instance.date)} updated — saved`);
  }

  const label = "flex flex-col gap-1 text-[12px] font-medium text-text-muted";
  return (
    <Sheet
      open
      onClose={onClose}
      title={instance.name}
      description={ymdToUtc(instance.date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}
      width={420}
      footer={
        <>
          <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-1.5 text-[12px] font-medium text-text-muted">Apply to</legend>
          {SCOPES.map((s) => (
            <label key={s.value} className="flex min-h-[44px] cursor-pointer items-start gap-2 py-1 md:min-h-0">
              <input type="radio" name="occ-scope" checked={scope === s.value} onChange={() => setScope(s.value)} className="mt-1" />
              <span>
                <span className="block text-[13.5px] text-text-primary">{s.label}</span>
                <span className="block text-[12px] text-text-muted">{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className={label}>
          Staff on this class
          <select value={staffMode} onChange={(e) => setStaffMode(e.target.value)} className={`${input} w-full`}>
            <option value="">Keep current staff</option>
            <option value="__reset__">Reset to series default</option>
            <option value="__none__">Nobody (clear)</option>
            <optgroup label="Substitute / replace with">
              {allStaff.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.firstName} {st.lastName}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2.5">
          <label className={label}>
            Start
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={`${input} w-full`} />
          </label>
          <label className={label}>
            End
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={`${input} w-full`} />
          </label>
        </div>
        <Reveal open={!seriesScope}>
          <div className="space-y-3">
            <label className={label}>
              Note for this occurrence
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. Room B today" className="w-full rounded-lg border border-app-border bg-surface px-2.5 py-2 text-[14px] text-text-primary md:text-[13px]" />
            </label>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[13.5px] text-text-primary md:min-h-0">
              <input type="checkbox" checked={canceled} onChange={(e) => setCanceled(e.target.checked)} />
              Cancel this {scope === "following" ? "and following sessions" : "session"}
            </label>
          </div>
        </Reveal>
        {seriesScope && (
          <p className="text-[12px] text-text-muted">
            Series changes update the recurring class. Future sessions are regenerated; attendance and one-off edits are preserved.
          </p>
        )}
        {err && (
          <p role="alert" className="rounded-lg px-3 py-2 text-[12.5px]" style={tint.danger}>
            {err}
          </p>
        )}
      </div>
    </Sheet>
  );
}
