"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckSquare, MessageCircle } from "lucide-react";
import { resolveActiveProfileId, onActiveProfileChange } from "@/lib/activeProfile";

type Booking = {
  id: string;
  status: string;
  kind?: "event" | "class" | "private";
  coach?: string | null;
  event: {
    id: string;
    name: string;
    type: string;
    startsAt: string;
    endsAt: string;
    capacity?: number | null;
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

type RawAttendanceRecord = {
  id: string;
  status: string;
  classSession: {
    id: string;
    startsAt: string;
    endsAt: string;
    recurringClass: {
      id: string;
      name: string;
      color: string | null;
      textColor: string | null;
      assignedStaffIds: unknown;
    } | null;
  } | null;
};

type RawPrivateBooking = {
  id: string;
  status: string;
  createdAt: string;
  confirmedStartAt: string | null;
  confirmedEndAt: string | null;
  requestedSlots: unknown;
  lessonType: { id: string; title: string; durationMin: number } | null;
  coach: { id: string; firstName: string; lastName: string } | null;
};

// Pull the earliest requested slot date+time from the JSON column. Returns a
// best-effort ISO string for display purposes; falls back to createdAt if the
// slot data is malformed so the booking still appears in the list.
function firstRequestedSlotAt(raw: unknown, fallback: string): string {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const sorted = (raw as Array<{ date?: string; startTime?: string }>)
    .filter((s) => typeof s?.date === "string" && typeof s?.startTime === "string")
    .sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  const first = sorted[0];
  if (!first?.date || !first?.startTime) return fallback;
  // Strings are stored as "YYYY-MM-DD" + "HH:mm" in the request payload.
  // new Date("YYYY-MM-DDTHH:mm") parses as local time, which matches how
  // the member entered their preferred slot.
  const iso = new Date(`${first.date}T${first.startTime}`);
  return Number.isNaN(iso.getTime()) ? fallback : iso.toISOString();
}

function privateBookingsToBookings(records: RawPrivateBooking[] | undefined): Booking[] {
  if (!records) return [];
  return records
    .filter((r) => r.lessonType)
    .map((r) => {
      const startsAt =
        r.confirmedStartAt ?? firstRequestedSlotAt(r.requestedSlots, r.createdAt);
      const endsAt =
        r.confirmedEndAt ??
        new Date(
          new Date(startsAt).getTime() + (r.lessonType!.durationMin || 60) * 60_000,
        ).toISOString();
      const coachName = r.coach
        ? `${r.coach.firstName} ${r.coach.lastName}`.trim() || null
        : null;
      return {
        id: `private:${r.id}`,
        status: r.status,
        kind: "private" as const,
        coach: coachName,
        event: {
          id: r.id,
          name: r.lessonType!.title,
          type: "PRIVATE",
          startsAt,
          endsAt,
          capacity: null,
          customEventType: null,
        },
      };
    });
}

function classAttendanceToBookings(
  records: RawAttendanceRecord[] | undefined,
  staffById: Map<string, string>,
): Booking[] {
  if (!records) return [];
  return records
    .filter((r) => r.classSession && r.classSession.recurringClass)
    .map((r) => {
      const cs = r.classSession!;
      const rc = cs.recurringClass!;
      const staffIds = Array.isArray(rc.assignedStaffIds) ? (rc.assignedStaffIds as string[]) : [];
      const coach = staffIds.map((id) => staffById.get(id)).filter(Boolean).join(", ") || null;
      // Status semantics differ: AttendanceRecord uses PRESENT/LATE/DROP_IN/TRIAL
      // ahead of time as "booked" markers. Show all as Confirmed in the list.
      return {
        id: `class:${r.id}`,
        status: "CONFIRMED",
        kind: "class" as const,
        coach,
        event: {
          id: rc.id,
          name: rc.name,
          type: "CLASS",
          startsAt: cs.startsAt,
          endsAt: cs.endsAt,
          capacity: null,
          customEventType: rc.color
            ? { name: "Class", color: rc.color, textColor: rc.textColor || "#fff" }
            : null,
        },
      };
    });
}

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
  // PrivateBooking states. REQUESTED + PENDING_COACH are pre-confirmation —
  // the athlete is waiting on the coach to accept / propose a time.
  REQUESTED: { bg: "var(--color-warning)", fg: "#fff", label: "Requested" },
  PENDING_COACH: { bg: "var(--color-warning)", fg: "#fff", label: "Pending coach" },
  COMPLETED: { bg: "var(--color-bg)", fg: "var(--color-muted)", label: "Completed" },
  DECLINED: { bg: "#FCE4E0", fg: "#7B2415", label: "Declined" },
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
  const router = useRouter();
  const [members, setMembers] = useState<MemberContext[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
  // Manage-booking sheet: privates can cancel or request a time change;
  // classes and events can cancel (refunds always go to staff review).
  const [manage, setManage] = useState<{ kind: "private" | "class" | "event"; id: string; name: string } | null>(null);
  const [manageMode, setManageMode] = useState<"menu" | "cancel" | "change">("menu");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState<string | null>(null);

  async function openEventChat(eventId: string) {
    setChatBusy(eventId);
    const res = await fetch(`/api/member/events/${eventId}/chat`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setChatBusy(null);
    if (!res.ok || !d.groupId) {
      setToast(d.error || "Couldn't open the event chat.");
      return;
    }
    router.push(`/member/messages/group/${d.groupId}`);
  }

  useEffect(() => {
    (async () => {
      const portal = await fetch("/api/member/portal").then((r) => (r.ok ? r.json() : null));
      if (!portal) { setLoading(false); return; }

      // Resolve coach names for class attendance records by looking up the
      // assigned staff IDs we already have in the payload.
      const staffIds = new Set<string>();
      const collect = (arr: RawAttendanceRecord[] | undefined) => {
        for (const r of arr ?? []) {
          const ids = r.classSession?.recurringClass?.assignedStaffIds;
          if (Array.isArray(ids)) ids.forEach((id) => typeof id === "string" && staffIds.add(id));
        }
      };
      collect(portal?.user?.memberProfile?.attendanceRecords);
      for (const g of portal?.user?.guardianOf ?? []) collect(g.member?.attendanceRecords);

      const staffById = new Map<string, string>();
      if (staffIds.size > 0) {
        const res = await fetch("/api/member/staff").then((r) => (r.ok ? r.json() : []));
        const items: Array<{ id: string; firstName: string; lastName: string }> = Array.isArray(res) ? res : res.items ?? [];
        for (const u of items) staffById.set(u.id, `${u.firstName} ${u.lastName}`.trim());
      }

      const list: MemberContext[] = [];
      if (portal?.user?.memberProfile) {
        const m = portal.user.memberProfile;
        list.push({
          id: m.id,
          firstName: m.firstName,
          lastName: m.lastName,
          kind: "self",
          bookings: [
            ...((m.bookings ?? []) as Booking[]).map((b) => ({ ...b, kind: "event" as const })),
            ...classAttendanceToBookings(m.attendanceRecords, staffById),
            ...privateBookingsToBookings(m.privateBookings),
          ],
        });
      }
      for (const g of portal?.user?.guardianOf ?? []) {
        list.push({
          id: g.member.id,
          firstName: g.member.firstName,
          lastName: g.member.lastName,
          kind: "child",
          bookings: [
            ...((g.member.bookings ?? []) as Booking[]).map((b) => ({ ...b, kind: "event" as const })),
            ...classAttendanceToBookings(g.member.attendanceRecords, staffById),
            ...privateBookingsToBookings(g.member.privateBookings),
          ],
        });
      }
      setMembers(list);
      setActiveId(resolveActiveProfileId(list.map((m) => m.id)));
      setLoading(false);
    })();
  }, []);

  // Follow the account-level switcher (shared across all portal pages).
  useEffect(() => onActiveProfileChange((id) => id && setActiveId(id)), []);

  const active = useMemo(() => members.find((m) => m.id === activeId), [members, activeId]);

  const now = new Date();
  // Terminal statuses never appear in "upcoming" regardless of time, since
  // they're no longer actionable. DECLINED/COMPLETED come from privates;
  // CANCELED applies to events and classes.
  const TERMINAL = new Set(["CANCELED", "DECLINED", "COMPLETED"]);
  const filtered = (active?.bookings ?? [])
    .filter((b) => {
      const start = new Date(b.event.startsAt);
      if (filter === "upcoming") return start >= now && !TERMINAL.has(b.status);
      if (filter === "past") return start < now || TERMINAL.has(b.status);
      return true;
    })
    .sort((a, b) => new Date(a.event.startsAt).getTime() - new Date(b.event.startsAt).getTime());

  async function submitManage() {
    if (!manage) return;
    setBusy(true);
    const action = manageMode === "cancel" ? "CANCEL" : "REQUEST_CHANGE";
    const res =
      manage.kind === "private"
        ? await fetch(`/api/member/privates/${manage.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, reason: reason.trim() || null }),
          })
        : await fetch(`/api/member/bookings/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: manage.kind, id: manage.id, reason: reason.trim() || null }),
          });
    setBusy(false);
    if (res.ok) {
      const d = await res.json().catch(() => ({}));
      if (action === "CANCEL") {
        setMembers((prev) =>
          prev.map((m) =>
            m.id === activeId
              ? {
                  ...m,
                  bookings: m.bookings.map((b) => {
                    if (manage.kind === "private") {
                      return b.kind === "private" && b.event.id === manage.id ? { ...b, status: "CANCELED" } : b;
                    }
                    if (manage.kind === "class") {
                      return b.kind === "class" && b.id === `class:${manage.id}` ? { ...b, status: "CANCELED" } : b;
                    }
                    return b.kind === "event" && b.id === manage.id ? { ...b, status: "CANCELED" } : b;
                  }),
                }
              : m,
          ),
        );
        // Paid bookings return a refund-request message — surface it verbatim
        // so the member knows the refund is requested, not automatic.
        setToast(
          typeof d.message === "string" && d.message
            ? d.message
            : "Booking canceled — your club has been notified.",
        );
      } else {
        setToast("Change request sent to your coach.");
      }
      setManage(null);
      setReason("");
    } else {
      const d = await res.json().catch(() => ({}));
      setToast(d.error || "Something went wrong. Please try again.");
    }
    setTimeout(() => setToast(null), 3500);
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">My Bookings</h1>
          <p className="text-sm text-stone-500">
            Classes, events, and private lessons — all in one place.
          </p>
        </div>
        <Link
          href="/member/privates"
          className="flex-shrink-0 px-3 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 whitespace-nowrap"
        >
          Request a private
        </Link>
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
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <CheckSquare className="h-7 w-7" strokeWidth={2} />
          </div>
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
                      {b.coach ? ` · Coach ${b.coach}` : ""}
                    </p>
                  </div>
                </div>
                {b.kind === "private" && !TERMINAL.has(b.status) && (
                  <div className="mt-3 pt-3 border-t border-stone-100 flex justify-end">
                    <button
                      onClick={() => { setManage({ kind: "private", id: b.event.id, name: b.event.name }); setManageMode("menu"); setReason(""); }}
                      className="text-xs px-3 py-1.5 rounded-md border border-stone-300 text-stone-700 hover:bg-stone-50"
                    >
                      Manage booking
                    </button>
                  </div>
                )}
                {(b.kind === "class" || b.kind === "event") && !TERMINAL.has(b.status) && (
                  <div className="mt-3 pt-3 border-t border-stone-100 flex justify-end gap-2">
                    {b.kind === "event" && (
                      <button
                        disabled={chatBusy === b.event.id}
                        onClick={() => openEventChat(b.event.id)}
                        className="text-xs px-3 py-1.5 rounded-md border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        <MessageCircle className="h-3.5 w-3.5" strokeWidth={2} />
                        {chatBusy === b.event.id ? "Opening…" : "Event chat"}
                      </button>
                    )}
                    {new Date(b.event.startsAt) > new Date() && (
                      <button
                        onClick={() => {
                          setManage({
                            kind: b.kind as "class" | "event",
                            id: b.kind === "class" ? b.id.replace(/^class:/, "") : b.id,
                            name: b.event.name,
                          });
                          setManageMode("cancel");
                          setReason("");
                        }}
                        className="text-xs px-3 py-1.5 rounded-md border border-stone-300 text-stone-700 hover:bg-stone-50"
                      >
                        Cancel booking
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {manage && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={() => setManage(null)}
        >
          <div className="bg-white rounded-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-stone-900 mb-0.5">Manage booking</h3>
            <p className="text-xs text-stone-500 mb-4">{manage.name}</p>
            {manageMode === "menu" ? (
              <div className="space-y-2">
                <button
                  onClick={() => setManageMode("change")}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-stone-200 text-sm text-stone-800 hover:bg-stone-50"
                >
                  Request a time change
                </button>
                <button
                  onClick={() => setManageMode("cancel")}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-red-200 text-sm text-red-700 hover:bg-red-50"
                >
                  Cancel this booking
                </button>
                <button onClick={() => setManage(null)} className="w-full px-3 py-2 text-sm text-stone-500">
                  Close
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-xs font-medium text-stone-700">
                  {manageMode === "cancel" ? "Reason for cancelling (optional)" : "What change do you need?"}
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder={manageMode === "cancel" ? "Let your coach know why…" : "e.g. Can we move to Thursday evening?"}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                />
                {manageMode === "cancel" && (
                  <p className="text-[11px] text-stone-500">
                    Already paid (card or package credit)? Refunds aren&apos;t automatic — canceling
                    sends a refund request and your club will follow up.
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => (manage.kind === "private" ? setManageMode("menu") : setManage(null))}
                    className="flex-1 px-3 py-2 border border-stone-300 rounded-lg text-sm text-stone-700 hover:bg-stone-50"
                  >
                    Back
                  </button>
                  <button
                    disabled={busy}
                    onClick={submitManage}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 ${
                      manageMode === "cancel" ? "bg-red-600 hover:bg-red-700" : "bg-stone-900 hover:bg-stone-700"
                    }`}
                  >
                    {busy ? "Sending…" : manageMode === "cancel" ? "Cancel booking" : "Send request"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-stone-900 text-white text-sm px-4 py-2 rounded-lg z-50 shadow-lg">
          {toast}
        </div>
      )}
    </>
  );
}
