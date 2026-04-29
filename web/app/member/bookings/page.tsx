"use client";

import { useEffect, useState } from "react";

type Booking = {
  id: string;
  status: string;
  event: {
    id: string;
    name: string;
    type: string;
    startsAt: string;
    endsAt: string;
    capacity: number | null;
    customEventType: { name: string; color: string; textColor: string } | null;
  };
};

const builtInColors: Record<string, { bg: string; fg: string }> = {
  CLASS: { bg: "var(--color-primary)", fg: "#fff" },
  PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
  CLINIC: { bg: "var(--color-success)", fg: "var(--color-text)" },
  CAMP: { bg: "var(--color-warning)", fg: "#fff" },
  TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

const statusBadge: Record<string, { bg: string; fg: string; label: string }> = {
  CONFIRMED: { bg: "var(--color-success)", fg: "var(--color-text)", label: "Confirmed" },
  WAITLISTED: { bg: "var(--color-warning)", fg: "#fff", label: "Waitlisted" },
  CANCELED: { bg: "var(--color-bg)", fg: "var(--color-muted)", label: "Canceled" },
  ATTENDED: { bg: "var(--color-primary)", fg: "#fff", label: "Attended" },
  NO_SHOW: { bg: "#FCE4E0", fg: "#7B2415", label: "No show" },
};

function getEventColor(b: Booking) {
  if (b.event.customEventType) {
    return { bg: b.event.customEventType.color, fg: b.event.customEventType.textColor };
  }
  return builtInColors[b.event.type] || builtInColors.OTHER;
}

function getEventLabel(b: Booking) {
  if (b.event.customEventType) return b.event.customEventType.name;
  return b.event.type.charAt(0) + b.event.type.slice(1).toLowerCase();
}

export default function MemberBookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");

  useEffect(() => {
    fetch("/api/member/portal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user?.memberProfile?.bookings) {
          setBookings(d.user.memberProfile.bookings);
        }
        setLoading(false);
      });
  }, []);

  const now = new Date();
  const filtered = bookings.filter((b) => {
    const start = new Date(b.event.startsAt);
    if (filter === "upcoming") return start >= now && b.status !== "CANCELED";
    if (filter === "past") return start < now || b.status === "CANCELED";
    return true;
  });

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">My Bookings</h1>
        <p className="text-sm text-stone-500">All your class and event registrations.</p>
      </div>

      <div className="flex gap-1 bg-stone-100 rounded-lg p-1 mb-6 w-fit">
        {(["upcoming", "past", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-sm px-4 py-1.5 rounded-md transition capitalize ${
              filter === f ? "bg-white shadow-sm text-stone-900 font-medium" : "text-stone-600"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">◷</p>
          <p className="text-base font-medium text-stone-900 mb-1">No bookings found</p>
          <p className="text-sm text-stone-500">
            {filter === "upcoming" ? "You have no upcoming bookings." : "No bookings in this category."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((b) => {
            const c = getEventColor(b);
            const s = statusBadge[b.status] || statusBadge.CONFIRMED;
            return (
              <div key={b.id} className="bg-white rounded-xl border border-stone-200 p-4">
                <div className="flex items-start gap-4">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 text-xs font-bold"
                    style={{ background: c.bg, color: c.fg }}
                  >
                    {new Date(b.event.startsAt).getDate()}
                    <br />
                    <span className="text-[9px]">
                      {new Date(b.event.startsAt).toLocaleDateString("en-US", { month: "short" })}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <h3 className="text-sm font-semibold text-stone-900">{b.event.name}</h3>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: c.bg, color: c.fg }}
                      >
                        {getEventLabel(b)}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                        style={{ background: s.bg, color: s.fg }}
                      >
                        {s.label}
                      </span>
                    </div>
                    <p className="text-xs text-stone-500">
                      {new Date(b.event.startsAt).toLocaleDateString("en-US", {
                        weekday: "long", month: "long", day: "numeric",
                      })}
                      {" · "}
                      {new Date(b.event.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      {" – "}
                      {new Date(b.event.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
