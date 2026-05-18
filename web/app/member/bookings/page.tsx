"use client";

import { useEffect, useMemo, useState } from "react";
import { resolveActiveProfileId, onActiveProfileChange } from "@/lib/activeProfile";

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

type MemberContext = {
  id: string;
  firstName: string;
  lastName: string;
  kind: "self" | "child";
  bookings: Booking[];
};

const builtInColors: Record<string, { bg: string; fg: string }> = {
  CLASS: { bg: "var(--color-primary)", fg: "#fff" },
  PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
  CLINIC: { bg: "var(--color-success)", fg: "#1F1F23" },
  CAMP: { bg: "var(--color-warning)", fg: "#fff" },
  TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

const statusBadge: Record<string, { bg: string; fg: string; label: string }> = {
  CONFIRMED: { bg: "var(--color-success)", fg: "#1F1F23", label: "Confirmed" },
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
  const [members, setMembers] = useState<MemberContext[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");

  useEffect(() => {
    fetch("/api/member/portal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: MemberContext[] = [];
        if (d?.user?.memberProfile) {
          list.push({
            id: d.user.memberProfile.id,
            firstName: d.user.memberProfile.firstName,
            lastName: d.user.memberProfile.lastName,
            kind: "self",
            bookings: d.user.memberProfile.bookings ?? [],
          });
        }
        for (const g of d?.user?.guardianOf ?? []) {
          list.push({
            id: g.member.id,
            firstName: g.member.firstName,
            lastName: g.member.lastName,
            kind: "child",
            bookings: g.member.bookings ?? [],
          });
        }
        setMembers(list);
        setActiveId(resolveActiveProfileId(list.map((m) => m.id)));
        setLoading(false);
      });
  }, []);

  // Follow the account-level switcher (shared across all portal pages).
  useEffect(() => onActiveProfileChange((id) => id && setActiveId(id)), []);

  const active = useMemo(() => members.find((m) => m.id === activeId), [members, activeId]);

  const now = new Date();
  const filtered = (active?.bookings ?? []).filter((b) => {
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

      {/* Profile selection is handled account-wide by the ProfileSwitcher in
          the portal layout — selection is shared across every portal page. */}
      {active && members.length > 1 && (
        <p className="text-sm text-stone-500 -mt-3 mb-4">
          Showing bookings for{" "}
          <span className="font-medium text-stone-900">
            {active.kind === "self" ? "you" : `${active.firstName} ${active.lastName}`}
          </span>
        </p>
      )}

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
      ) : !active ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-base font-medium text-stone-900 mb-1">No member context</p>
          <p className="text-sm text-stone-500">Link a child or contact your club to get started.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">◷</p>
          <p className="text-base font-medium text-stone-900 mb-1">No bookings found</p>
          <p className="text-sm text-stone-500">
            {filter === "upcoming"
              ? `${active.kind === "self" ? "You have" : `${active.firstName} has`} no upcoming bookings.`
              : "No bookings in this category."}
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
