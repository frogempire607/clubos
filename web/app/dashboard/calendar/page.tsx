"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmtTime, kindIsWallClockUTC, sameMonth } from "@/lib/datetime";
import PageHeader from "@/components/PageHeader";
import { SkeletonLine } from "@/components/LoadingSkeleton";

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
  const [showShare, setShowShare] = useState(false);

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
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl">
      <PageHeader
        title="Calendar"
        description="All offerings — events, classes, and confirmed private lessons."
        actions={
          <>
            <button
              onClick={() => setShowShare(true)}
              className="px-3 py-2 border border-app-border rounded-lg text-sm text-text-primary hover:bg-app-bg"
            >
              Share / subscribe
            </button>
            <Link href="/dashboard/classes" className="px-3 py-2 border border-app-border rounded-lg text-sm text-text-primary hover:bg-app-bg">+ Class</Link>
            <Link href="/dashboard/events" className="px-3 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Event</Link>
          </>
        }
      />

      {showShare && <CalendarLinksModal onClose={() => setShowShare(false)} />}

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

      <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
        {/* Month nav */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-app-border">
          <button
            onClick={prevMonth}
            aria-label="Previous month"
            className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-app-bg text-text-muted"
          >
            <ChevronLeft className="h-5 w-5" strokeWidth={2} />
          </button>
          <h2 className="text-base sm:text-lg font-semibold text-text-primary tabular-nums">
            {MONTHS[month]} {year}
            <span className="ml-2 text-xs text-text-muted font-normal">
              {itemsThisMonth.length} item{itemsThisMonth.length === 1 ? "" : "s"}
            </span>
          </h2>
          <button
            onClick={nextMonth}
            aria-label="Next month"
            className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-app-bg text-text-muted"
          >
            <ChevronRight className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>

        {/* ── Desktop only: week grid ───────────────────────────────────────
            Threshold is lg (1024px), not md. Reason: the dashboard
            sidebar takes 248px starting at md, so an iPad-portrait
            (~768px viewport) browser leaves only ~520px of main width.
            7 columns at 520px = ~74px per cell, which crushes the
            event chips and was the user-reported "crushed 7-column
            grid" on mobile. Day-list is the better read at those
            widths.                                                        */}
        <div className="hidden lg:block">
          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-app-border">
            {DAYS.map((d) => (
              <div key={d} className="py-2 text-center text-xs font-semibold text-text-muted uppercase tracking-wider">{d}</div>
            ))}
          </div>

          {/* Grid */}
          {loading ? (
            <div className="grid grid-cols-7 gap-px bg-app-border">
              {Array.from({ length: 42 }).map((_, i) => (
                <div key={i} className="bg-surface p-2 min-h-[120px]">
                  <SkeletonLine width={20} height={10} />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-7">
              {cells.map((day, i) => {
                const dayItems = day ? itemsOnDay(day) : [];
                // Show 4 chips per cell on desktop; the rest collapse into a clickable +N pill.
                const VISIBLE = 4;
                const remaining = dayItems.length - VISIBLE;
                return (
                  <div
                    key={i}
                    className={`min-h-[140px] p-2 border-b border-r border-app-border ${!day ? "bg-app-bg/40" : ""}`}
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
                          className={`text-sm font-semibold mb-1.5 w-7 h-7 flex items-center justify-center rounded-full transition tabular-nums ${
                            isToday(day)
                              ? "bg-brand text-white"
                              : selectedDay === day
                                ? "bg-text-primary text-white"
                                : "text-text-primary hover:bg-app-bg"
                          }`}
                        >
                          {day}
                        </button>
                        <div className="space-y-1">
                          {dayItems.slice(0, VISIBLE).map((it) => {
                            const c = colorFor(it);
                            return (
                              <button
                                key={`${it.kind}-${it.id}`}
                                onClick={() => setSelected(selected?.id === it.id && selected.kind === it.kind ? null : it)}
                                className="w-full text-left text-[11px] leading-tight px-1.5 py-1 rounded font-medium truncate hover:opacity-90"
                                style={{ background: c.bg, color: c.fg }}
                                title={it.name}
                              >
                                <span className="opacity-80 mr-0.5 tabular-nums">
                                  {fmtTime(it.startsAt, { utc: kindIsWallClockUTC(it.kind) })}
                                </span>
                                {it.name}
                              </button>
                            );
                          })}
                          {remaining > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedDay(day);
                                setSelected(null);
                              }}
                              className="block text-[11px] font-medium text-text-muted hover:text-text-primary px-1 underline-offset-2 hover:underline"
                            >
                              +{remaining} more
                            </button>
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

        {/* ── Mobile + tablet: vertical day-list (only days with items, plus today) ── */}
        <div className="lg:hidden">
          {loading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonLine key={i} width="100%" height={60} />
              ))}
            </div>
          ) : (
            (() => {
              const daysWithContent: { day: number; items: typeof items }[] = [];
              for (let d = 1; d <= daysInMonth; d++) {
                const dayItems = itemsOnDay(d);
                if (dayItems.length > 0 || isToday(d)) {
                  daysWithContent.push({ day: d, items: dayItems });
                }
              }
              if (daysWithContent.length === 0) {
                return (
                  <div className="p-8 text-center text-sm text-text-muted">
                    No items this month.
                  </div>
                );
              }
              return (
                <div className="divide-y divide-app-border">
                  {daysWithContent.map(({ day, items: dayItems }) => {
                    const date = new Date(year, month, day);
                    const weekday = DAYS[date.getDay()];
                    return (
                      <div key={day} className="px-4 py-3">
                        <div className="flex items-center gap-3 mb-2">
                          <div
                            className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center text-center flex-shrink-0 tabular-nums ${
                              isToday(day) ? "bg-brand text-white" : "bg-app-bg text-text-primary"
                            }`}
                          >
                            <div className="text-[9px] font-semibold uppercase tracking-wider opacity-80 leading-none">{weekday}</div>
                            <div className="text-sm font-bold leading-none mt-0.5">{day}</div>
                          </div>
                          <div className="text-xs text-text-muted">
                            {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
                          </div>
                        </div>
                        {dayItems.length === 0 ? (
                          <p className="text-xs text-text-muted ml-13 pl-0">Nothing scheduled.</p>
                        ) : (
                          <div className="space-y-1.5 ml-13">
                            {dayItems.map((it) => {
                              const c = colorFor(it);
                              return (
                                <button
                                  key={`${it.kind}-${it.id}`}
                                  onClick={() => setSelected(selected?.id === it.id && selected.kind === it.kind ? null : it)}
                                  className="w-full text-left text-xs px-2.5 py-1.5 rounded-md font-medium hover:opacity-90 flex items-center gap-2"
                                  style={{ background: c.bg, color: c.fg }}
                                  title={it.name}
                                >
                                  <span className="opacity-80 tabular-nums flex-shrink-0">
                                    {fmtTime(it.startsAt, { utc: kindIsWallClockUTC(it.kind) })}
                                  </span>
                                  <span className="truncate">{it.name}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()
          )}
        </div>
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

/* ─── Calendar share/subscribe modal ─── */

type FeedLinkSet = { scope: string; ics: string; webcal: string; google: string; embed: string };

function CalendarLinksModal({ onClose }: { onClose: () => void }) {
  const [links, setLinks] = useState<{ staff: FeedLinkSet; member: FeedLinkSet; public: FeedLinkSet } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/calendar/links")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setLinks)
      .catch(() => setError("Couldn't load calendar links."));
  }, []);

  function copy(value: string, key: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  const sections: { key: "staff" | "member" | "public"; title: string; note: string }[] = [
    { key: "staff", title: "Owner & staff calendar", note: "Everything — includes staff-only events and confirmed private lessons with athlete names. Share only with your team." },
    { key: "member", title: "Member calendar", note: "Public and members-only classes and events — what members see in the portal." },
    { key: "public", title: "Public calendar", note: "Public items only. Safe for your website or social bio." },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-text-primary">Calendar links</h2>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted">✕</button>
        </div>
        <p className="text-xs text-text-muted mb-4">
          These feeds update automatically when classes or events change. Add to Apple/Outlook with the
          iCal link, Google with the Google link, or embed the web view in your site.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!links && !error && <p className="text-sm text-text-muted">Loading…</p>}
        {links &&
          sections.map(({ key, title, note }) => {
            const l = links[key];
            return (
              <div key={key} className="border border-app-border rounded-xl p-3 mb-3">
                <div className="text-sm font-medium text-text-primary">{title}</div>
                <p className="text-[11px] text-text-muted mb-2">{note}</p>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => copy(l.ics, `${key}-ics`)} className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
                    {copied === `${key}-ics` ? "Copied!" : "Copy iCal link"}
                  </button>
                  <a href={l.google} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
                    Add to Google
                  </a>
                  <button onClick={() => copy(l.embed, `${key}-embed`)} className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
                    {copied === `${key}-embed` ? "Copied!" : "Copy embed link"}
                  </button>
                  <button
                    onClick={() => copy(`<iframe src="${l.embed}" style="width:100%;height:600px;border:0"></iframe>`, `${key}-iframe`)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg"
                  >
                    {copied === `${key}-iframe` ? "Copied!" : "Copy iframe snippet"}
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
