"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type EventType = "CLASS" | "PRIVATE" | "CLINIC" | "CAMP" | "TOURNAMENT" | "OTHER";

type CustomEventType = {
  id: string;
  name: string;
  color: string;
  textColor: string;
};

type CalEvent = {
  id: string;
  type: EventType;
  name: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  customEventTypeId: string | null;
  customEventType: CustomEventType | null;
  _count: { bookings: number };
};

const builtInColors: Record<EventType, { bg: string; fg: string }> = {
  CLASS: { bg: "#E6F1FB", fg: "#0C447C" },
  PRIVATE: { bg: "#EEEDFE", fg: "#3C3489" },
  CLINIC: { bg: "#EAF3DE", fg: "#27500A" },
  CAMP: { bg: "#FAEEDA", fg: "#633806" },
  TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
  OTHER: { bg: "#F1EFE8", fg: "#5F5E5A" },
};

function getEventColor(e: CalEvent): { bg: string; fg: string } {
  if (e.customEventType) {
    return { bg: e.customEventType.color, fg: e.customEventType.textColor };
  }
  return builtInColors[e.type];
}

function getEventLabel(e: CalEvent): string {
  if (e.customEventType) return e.customEventType.name;
  return e.type.charAt(0) + e.type.slice(1).toLowerCase();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function CalendarPage() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomEventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CalEvent | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/events").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/events/types").then((r) => (r.ok ? r.json() : [])),
    ]).then(([evts, types]) => {
      setEvents(evts);
      setCustomTypes(types);
      setLoading(false);
    });
  }, []);

  function prevMonth() {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
  }

  function nextMonth() {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const eventsThisMonth = events.filter((e) => {
    const d = new Date(e.startsAt);
    return d.getFullYear() === year && d.getMonth() === month;
  });

  function eventsOnDay(day: number) {
    return eventsThisMonth.filter((e) => new Date(e.startsAt).getDate() === day);
  }

  const isToday = (day: number) =>
    day === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  const customTypesUsed = customTypes.filter((ct) =>
    events.some((e) => e.customEventTypeId === ct.id)
  );

  const builtInTypesUsed = (Object.entries(builtInColors) as [EventType, { bg: string; fg: string }][]).filter(
    ([type]) => events.some((e) => e.type === type && !e.customEventTypeId)
  );

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-stone-900 mb-1">Calendar</h1>
          <p className="text-sm text-stone-500">Monthly view of your club schedule.</p>
        </div>
        <Link
          href="/dashboard/events"
          className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700"
        >
          + Add event
        </Link>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
        {/* Month nav */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200">
          <button
            onClick={prevMonth}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-stone-100 text-stone-600"
          >
            ‹
          </button>
          <h2 className="text-base font-semibold text-stone-900">
            {MONTHS[month]} {year}
          </h2>
          <button
            onClick={nextMonth}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-stone-100 text-stone-600"
          >
            ›
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-stone-200">
          {DAYS.map((d) => (
            <div
              key={d}
              className="py-2 text-center text-xs font-medium text-stone-500 uppercase tracking-wide"
            >
              {d}
            </div>
          ))}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="p-8 text-center text-stone-500 text-sm">Loading events…</div>
        ) : (
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const dayEvents = day ? eventsOnDay(day) : [];
              return (
                <div
                  key={i}
                  className={`min-h-[100px] p-1.5 border-b border-r border-stone-100 ${
                    !day ? "bg-stone-50/50" : ""
                  }`}
                >
                  {day && (
                    <>
                      <div
                        className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                          isToday(day)
                            ? "bg-stone-900 text-white"
                            : "text-stone-700"
                        }`}
                      >
                        {day}
                      </div>
                      <div className="space-y-0.5">
                        {dayEvents.slice(0, 3).map((e) => {
                          const c = getEventColor(e);
                          return (
                            <button
                              key={e.id}
                              onClick={() => setSelected(selected?.id === e.id ? null : e)}
                              className="w-full text-left text-[10px] px-1.5 py-0.5 rounded font-medium truncate"
                              style={{ background: c.bg, color: c.fg }}
                            >
                              {e.name}
                            </button>
                          );
                        })}
                        {dayEvents.length > 3 && (
                          <div className="text-[10px] text-stone-400 px-1">
                            +{dayEvents.length - 3} more
                          </div>
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

      {/* Event detail panel */}
      {selected && (
        <div className="mt-4 bg-white rounded-xl border border-stone-200 p-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <h3 className="text-base font-semibold text-stone-900">{selected.name}</h3>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: getEventColor(selected).bg, color: getEventColor(selected).fg }}
                >
                  {getEventLabel(selected)}
                </span>
              </div>
              <div className="text-sm text-stone-600">
                {new Date(selected.startsAt).toLocaleString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {" – "}
                {new Date(selected.endsAt).toLocaleString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
              {selected.capacity && (
                <div className="text-sm text-stone-500 mt-1">
                  {selected._count.bookings}/{selected.capacity} booked
                </div>
              )}
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-stone-400 hover:text-stone-700 text-xl leading-none"
            >
              ×
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <Link
              href="/dashboard/events"
              className="text-xs px-3 py-1.5 rounded-md border border-stone-200 text-stone-700 hover:bg-stone-50"
            >
              View in Events →
            </Link>
          </div>
        </div>
      )}

      {/* Legend */}
      {!loading && (
        <div className="flex flex-wrap gap-3 mt-4">
          {builtInTypesUsed.map(([type, c]) => (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: c.bg, border: `1px solid ${c.fg}20` }} />
              <span className="text-xs text-stone-500">
                {type.charAt(0) + type.slice(1).toLowerCase()}
              </span>
            </div>
          ))}
          {customTypesUsed.map((ct) => (
            <div key={ct.id} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: ct.color, border: `1px solid ${ct.textColor}20` }} />
              <span className="text-xs text-stone-500">{ct.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
