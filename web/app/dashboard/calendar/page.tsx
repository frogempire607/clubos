"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fmtTime, kindIsWallClockUTC, sameMonth } from "@/lib/datetime";

type Kind = "event" | "class" | "private";

type CalItem = {
  kind: Kind;
  id: string;
  refId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  typeKey: string;
  typeLabel: string;
  color: string | null;
  textColor: string | null;
  capacity: number | null;
  filled: number;
  detail?: string;
  description?: string | null;
  location?: string | null;
  coach?: string | null;
  price?: string | null;
};

type CalFeed = {
  from: string;
  to: string;
  items: CalItem[];
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const KIND_COLORS: Record<Kind, { bg: string; fg: string; label: string; href: string }> = {
  event:   { bg: "var(--color-warning)", fg: "#fff",                 label: "Events",          href: "/dashboard/events" },
  class:   { bg: "var(--color-primary)", fg: "#fff",                 label: "Classes",         href: "/dashboard/classes" },
  private: { bg: "#E8E1FD",              fg: "#3B2F8C",              label: "Private lessons", href: "/dashboard/privates" },
};

const KIND_SINGULAR_LABEL: Record<Kind, string> = {
  event: "Event",
  class: "Class",
  private: "Private lesson",
};

// Built-in event subtypes (when no customEventType is set)
const EVENT_SUBTYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  CLASS:      { bg: "var(--color-primary)", fg: "#fff" },
  PRIVATE:    { bg: "#E8E1FD",              fg: "#3B2F8C" },
  CLINIC:     { bg: "var(--color-success)", fg: "#1F1F23" },
  CAMP:       { bg: "var(--color-warning)", fg: "#fff" },
  TOURNAMENT: { bg: "#FCE4E0",              fg: "#7B2415" },
  OTHER:      { bg: "var(--color-bg)",      fg: "var(--color-muted)" },
};

function colorFor(item: CalItem): { bg: string; fg: string } {
  if (item.color) return { bg: item.color, fg: item.textColor ?? "#fff" };
  if (item.kind === "event") return EVENT_SUBTYPE_COLORS[item.typeKey] ?? EVENT_SUBTYPE_COLORS.OTHER;
  if (item.kind === "class") return KIND_COLORS.class;
  return KIND_COLORS.private;
}

export default function CalendarPage() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [feed, setFeed] = useState<CalFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CalItem | null>(null);
  // Day-level click: when set, shows a full list of every item on that day
  // with richer info + per-item Edit deep-links (Phase 2).
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Filter state
  const [kindFilter, setKindFilter] = useState<Set<Kind>>(new Set(["event", "class", "private"]));
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set()); // empty = all subtypes

  useEffect(() => {
    setLoading(true);
    // Pull a 3-month window centered on the visible month so prev/next nav is snappy.
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month + 2, 0, 23, 59, 59, 999);
    fetch(`/api/calendar?from=${start.toISOString()}&to=${end.toISOString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CalFeed | null) => {
        setFeed(d);
        setLoading(false);
      });
  }, [year, month]);

  function prevMonth() {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
  }

  const items = useMemo(() => feed?.items ?? [], [feed]);

  // Build a unique typeLabel set per kind for the secondary filter chips.
  const subtypesInRange = useMemo(() => {
    const map = new Map<string, { kind: Kind; key: string; label: string; color: { bg: string; fg: string } }>();
    for (const it of items) {
      const compound = `${it.kind}:${it.typeKey}`;
      if (!map.has(compound)) {
        map.set(compound, { kind: it.kind, key: compound, label: it.typeLabel, color: colorFor(it) });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      if (!kindFilter.has(it.kind)) return false;
      if (typeFilter.size > 0 && !typeFilter.has(`${it.kind}:${it.typeKey}`)) return false;
      return true;
    });
  }, [items, kindFilter, typeFilter]);

  function toggleKind(k: Kind) {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function toggleType(key: string) {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Build grid cells
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  // Span-aware filters: an Event whose start..end crosses multiple days
  // shows on each of those days. Class sessions and per-session event items
  // already represent one calendar slot each, so the span check naturally
  // collapses to the single-day case for them.
  function itemSpansDay(e: { kind: string; startsAt: string; endsAt: string }, y: number, mo: number, d: number) {
    const useUTC = kindIsWallClockUTC(e.kind);
    const target = new Date(Date.UTC(y, mo, d));
    const start = new Date(e.startsAt);
    const end = new Date(e.endsAt);
    const startDay = useUTC
      ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
      : Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = useUTC
      ? Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
      : Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    const tgt = target.getTime();
    return tgt >= startDay && tgt <= endDay;
  }

  // An item touches the visible month if its [start..end] day range overlaps
  // any day in the month.
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month, daysInMonth));
  const itemsThisMonth = filteredItems.filter((e) => {
    const useUTC = kindIsWallClockUTC(e.kind);
    if (!useUTC) {
      // For local-time items, a quick same-month check still catches the
      // common case AND multi-day spans get caught by the range overlap.
      if (sameMonth(e.startsAt, year, month, false)) return true;
    }
    const start = new Date(e.startsAt);
    const end = new Date(e.endsAt);
    const startDay = useUTC
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
      : new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
    const endDay = useUTC
      ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
      : new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()));
    return endDay.getTime() >= monthStart.getTime() && startDay.getTime() <= monthEnd.getTime();
  });

  function itemsOnDay(day: number) {
    return itemsThisMonth.filter((e) => itemSpansDay(e, year, month, day));
  }

  const isToday = (day: number) =>
    day === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Calendar</h1>
          <p className="text-sm text-text-muted">All offerings — events, classes, and confirmed private lessons.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/classes" className="px-3 py-2 border border-app-border rounded-lg text-sm text-text-primary hover:bg-app-bg">+ Class</Link>
          <Link href="/dashboard/events" className="px-3 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Event</Link>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-surface border border-app-border rounded-xl p-4 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-xs uppercase tracking-wider text-text-muted font-medium mr-1">Show</span>
          {(["event", "class", "private"] as Kind[]).map((k) => {
            const active = kindFilter.has(k);
            const c = KIND_COLORS[k];
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  active ? "border-transparent text-white" : "border-app-border text-text-muted bg-surface hover:bg-app-bg"
                }`}
                style={active ? { background: c.bg, color: c.fg } : {}}
              >
                {active ? "✓ " : ""}{c.label}
              </button>
            );
          })}
        </div>
        {subtypesInRange.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-app-border">
            <span className="text-xs uppercase tracking-wider text-text-muted font-medium mr-1">Type</span>
            {typeFilter.size > 0 && (
              <button
                onClick={() => setTypeFilter(new Set())}
                className="text-[11px] text-text-muted underline mr-1"
              >
                clear
              </button>
            )}
            {subtypesInRange.map((s) => {
              const active = typeFilter.size === 0 || typeFilter.has(s.key);
              return (
                <button
                  key={s.key}
                  onClick={() => toggleType(s.key)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1.5 ${
                    active ? "border-app-border bg-surface" : "border-app-border opacity-40 bg-app-bg"
                  }`}
                >
                  <span className="w-2 h-2 rounded-sm" style={{ background: s.color.bg, border: `1px solid ${s.color.fg}30` }} />
                  <span className="text-text-primary">{s.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-app-border overflow-hidden">
        {/* Month nav */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-app-bg text-text-muted">‹</button>
          <h2 className="text-base font-semibold text-text-primary">
            {MONTHS[month]} {year}
            <span className="ml-2 text-xs text-text-muted font-normal">
              {itemsThisMonth.length} item{itemsThisMonth.length === 1 ? "" : "s"}
            </span>
          </h2>
          <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-app-bg text-text-muted">›</button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-app-border">
          {DAYS.map((d) => (
            <div key={d} className="py-2 text-center text-xs font-medium text-text-muted uppercase tracking-wide">{d}</div>
          ))}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
        ) : (
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const dayItems = day ? itemsOnDay(day) : [];
              return (
                <div
                  key={i}
                  className={`min-h-[110px] p-1.5 border-b border-r border-app-border ${!day ? "bg-app-bg/50" : ""}`}
                >
                  {day && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedDay(day);
                          setSelected(null);
                        }}
                        title="Show every item on this day"
                        className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full transition ${
                          isToday(day)
                            ? "bg-brand text-white"
                            : selectedDay === day
                              ? "bg-text-primary text-white"
                              : "text-text-primary hover:bg-app-bg"
                        }`}
                      >
                        {day}
                      </button>
                      <div className="space-y-0.5">
                        {dayItems.slice(0, 3).map((it) => {
                          const c = colorFor(it);
                          return (
                            <button
                              key={`${it.kind}-${it.id}`}
                              onClick={() => setSelected(selected?.id === it.id && selected.kind === it.kind ? null : it)}
                              className="w-full text-left text-[10px] px-1.5 py-0.5 rounded font-medium truncate"
                              style={{ background: c.bg, color: c.fg }}
                              title={it.name}
                            >
                              <span className="opacity-70 mr-0.5">
                                {fmtTime(it.startsAt, { utc: kindIsWallClockUTC(it.kind) })}
                              </span>
                              {it.name}
                            </button>
                          );
                        })}
                        {dayItems.length > 3 && (
                          <div className="text-[10px] text-text-muted px-1">+{dayItems.length - 3} more</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected detail */}
      {selected && (
        <div className="mt-4 bg-white rounded-xl border border-app-border p-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <h3 className="text-base font-semibold text-text-primary">{selected.name}</h3>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: colorFor(selected).bg, color: colorFor(selected).fg }}
                >
                  {selected.typeLabel}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">
                  {KIND_SINGULAR_LABEL[selected.kind]}
                </span>
              </div>
              <div className="text-sm text-text-muted">
                {new Date(selected.startsAt).toLocaleString("en-US", {
                  weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
                  ...(kindIsWallClockUTC(selected.kind) ? { timeZone: "UTC" as const } : {}),
                })}
                {" – "}
                {fmtTime(selected.endsAt, { utc: kindIsWallClockUTC(selected.kind) })}
              </div>
              {selected.detail && (
                <div className="text-xs text-text-muted mt-0.5">{selected.detail}</div>
              )}
              {selected.capacity != null && selected.kind !== "private" && (
                <div className="text-sm text-text-muted mt-1">
                  {selected.filled}/{selected.capacity} booked
                </div>
              )}
            </div>
            <button onClick={() => setSelected(null)} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
          </div>
          {selected.kind === "event" && <EventDetails eventId={selected.refId} />}

          <div className="mt-3 flex gap-2">
            <Link
              href={
                selected.kind === "class"
                  ? "/dashboard/classes"
                  : selected.kind === "private"
                  ? "/dashboard/privates"
                  : "/dashboard/events"
              }
              className="text-xs px-3 py-1.5 rounded-md border border-app-border text-text-primary hover:bg-app-bg"
            >
              Open in {KIND_COLORS[selected.kind].label} →
            </Link>
          </div>
        </div>
      )}

      {/* Day detail (Phase 2) — click a day number to see every item that
          day with full info + Edit deep-links. */}
      {selectedDay != null && (() => {
        const dayItems = itemsOnDay(selectedDay);
        const dayDate = new Date(year, month, selectedDay);
        const dayLabel = dayDate.toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", year: "numeric",
        });
        return (
          <div className="mt-4 bg-white rounded-xl border border-app-border p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-base font-semibold text-text-primary">{dayLabel}</h3>
                <p className="text-xs text-text-muted">
                  {dayItems.length === 0
                    ? "Nothing scheduled."
                    : `${dayItems.length} item${dayItems.length === 1 ? "" : "s"} on this day`}
                </p>
              </div>
              <button
                onClick={() => setSelectedDay(null)}
                className="text-text-muted hover:text-text-primary text-xl leading-none"
              >
                ×
              </button>
            </div>

            {dayItems.length > 0 && (
              <div className="space-y-2">
                {dayItems
                  .slice()
                  .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
                  .map((it) => {
                    const c = colorFor(it);
                    const useUTC = kindIsWallClockUTC(it.kind);
                    const tStart = fmtTime(it.startsAt, { utc: useUTC });
                    const tEnd = fmtTime(it.endsAt, { utc: useUTC });
                    // Default = per-occurrence editing for that specific day:
                    //   class items → ?session=<classSessionId> opens the
                    //     SessionEditModal (this day only). "Edit entire
                    //     series →" inside that modal jumps to ?edit=<classId>.
                    //   event items from multi-day events (id contains ":")
                    //     → ?session=<eventId>:<sessionId> opens that event
                    //     occurrence; single-day events fall back to ?edit=.
                    //   privates → opens that booking directly.
                    const editHref =
                      it.kind === "event"
                        ? it.id.includes(":")
                          ? `/dashboard/events?session=${it.id}`
                          : `/dashboard/events?edit=${it.refId}`
                        : it.kind === "class"
                          ? `/dashboard/classes?session=${it.id}`
                          : `/dashboard/privates?booking=${it.refId}`;
                    // Multi-day events emit one item per session — note that
                    // edits to this item apply to this occurrence.
                    const isSessionOfEvent =
                      it.kind === "event" && it.id.includes(":");
                    return (
                      <div
                        key={`${it.kind}-${it.id}`}
                        className="rounded-lg border border-app-border p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span
                                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                style={{ background: c.bg, color: c.fg }}
                              >
                                {it.typeLabel}
                              </span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">
                                {KIND_SINGULAR_LABEL[it.kind]}
                              </span>
                              <span className="text-sm font-semibold text-text-primary">{it.name}</span>
                            </div>
                            <p className="text-xs text-text-muted">
                              {tStart} – {tEnd}
                              {it.location ? ` · ${it.location}` : ""}
                              {it.coach ? ` · ${it.coach}` : ""}
                              {it.capacity != null && it.kind !== "private"
                                ? ` · ${it.filled}/${it.capacity} booked`
                                : ""}
                            </p>
                            {it.price && (
                              <p className="text-xs text-text-muted mt-0.5">{it.price}</p>
                            )}
                            {it.description && (
                              <p className="text-xs text-text-muted mt-1 line-clamp-2 whitespace-pre-wrap">
                                {it.description}
                              </p>
                            )}
                            {it.detail && (
                              <p className="text-xs text-text-muted mt-1">{it.detail}</p>
                            )}
                            {isSessionOfEvent && (
                              <p className="text-[11px] text-text-muted mt-1 italic">
                                Multi-day event — edits to this occurrence apply
                                to this day&apos;s session. Use the event editor
                                for changes that should apply to the whole event.
                              </p>
                            )}
                          </div>
                          <Link
                            href={editHref}
                            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-md bg-brand text-white font-medium hover:bg-brand-hover"
                          >
                            Edit
                          </Link>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

type FullEvent = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  memberPrice: string | null;
  nonMemberPrice: string | null;
  dropInFee: string | null;
  visibility: string;
  isTournament: boolean;
  tournamentMode: string | null;
  publicRegistration: boolean;
  publicSlug: string | null;
  variableCostEnabled: boolean;
  variableCostMode: string | null;
  variableCostTotal: string | null;
  variableCostEstimatedTotal: string | null;
  location: { name: string; address: string | null } | null;
  sessions: { id: string; name: string | null; startsAt: string; endsAt: string }[];
  staffAssignments: { user: { id: string; firstName: string; lastName: string } }[];
  registrations: { id: string; name: string; status: string }[];
  bookings: { id: string; member: { firstName: string; lastName: string } | null }[];
};

function money(v: string | null) {
  return v == null ? null : Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function EventDetails({ eventId }: { eventId: string }) {
  const [ev, setEv] = useState<FullEvent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/events/${eventId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setEv(d); setLoading(false); });
  }, [eventId]);

  if (loading) return <div className="mt-3 text-xs text-text-muted">Loading details…</div>;
  if (!ev) return null;

  const prices = [
    ev.memberPrice && `Member ${money(ev.memberPrice)}`,
    ev.nonMemberPrice && `Non-member ${money(ev.nonMemberPrice)}`,
    ev.dropInFee && `Drop-in ${money(ev.dropInFee)}`,
  ].filter(Boolean);

  return (
    <div className="mt-3 pt-3 border-t border-app-border space-y-2 text-sm">
      {ev.description && <p className="text-text-muted whitespace-pre-wrap">{ev.description}</p>}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        {ev.location && (
          <Detail label="Location" value={`${ev.location.name}${ev.location.address ? ` — ${ev.location.address}` : ""}`} />
        )}
        <Detail label="Visibility" value={ev.visibility} />
        {prices.length > 0 && <Detail label="Pricing" value={prices.join(" · ")} />}
        {ev.capacity != null && <Detail label="Capacity" value={String(ev.capacity)} />}
        {ev.isTournament && (
          <Detail label="Tournament" value={ev.tournamentMode === "HOST" ? "Hosting" : ev.tournamentMode === "ATTEND" ? "Attending" : "Yes"} />
        )}
        {ev.variableCostEnabled && (
          <Detail
            label="Variable cost"
            value={
              ev.variableCostMode === "OFFICIAL"
                ? `Official ${money(ev.variableCostTotal) ?? "TBD"}${ev.variableCostEstimatedTotal ? ` (est. ${money(ev.variableCostEstimatedTotal)})` : ""}`
                : `Estimated split of ${money(ev.variableCostTotal) ?? "TBD"}`
            }
          />
        )}
        {ev.publicRegistration && ev.publicSlug && (
          <Detail label="Public link" value={`/e/${ev.publicSlug}`} />
        )}
      </div>

      {ev.sessions.length > 0 && (
        <div className="text-xs">
          <p className="text-text-muted font-medium mb-0.5">Sessions</p>
          {ev.sessions.map((s) => (
            <div key={s.id} className="text-text-muted">
              {s.name ? `${s.name}: ` : ""}
              {new Date(s.startsAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {" – "}
              {new Date(s.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        {ev.staffAssignments.length > 0 && (
          <Detail
            label="Staff"
            value={ev.staffAssignments.map((a) => `${a.user.firstName} ${a.user.lastName}`).join(", ")}
          />
        )}
        <Detail label="Bookings" value={String(ev.bookings.length)} />
        {ev.registrations.length > 0 && (
          <Detail label="Registrations" value={String(ev.registrations.length)} />
        )}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-text-muted">{label}: </span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}
