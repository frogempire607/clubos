"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarPlus } from "lucide-react";
import {
  onActiveProfileChange,
  resolveActiveProfileId,
  setActiveProfileId,
} from "@/lib/activeProfile";
import { friendlyDate, friendlyTimeRange } from "@/lib/friendlyDate";
import { Avatar } from "@/components/member/ui";

type ScheduleMember = {
  id: string;
  firstName: string;
  lastName: string;
  kind: "self" | "child";
};

type ScheduleItem = {
  id: string;
  refId: string;
  kind: "class" | "event";
  title: string;
  typeLabel: string;
  startsAt: string;
  endsAt: string;
  description: string | null;
  location: string | null;
  coach: string | null;
  capacity: number | null;
  filled: number;
  price: string | null;
  statusText: string;
  canBook: boolean;
  bookingStatus: string | null;
  color: string | null;
  textColor: string | null;
  bookingTier?: "MEMBERSHIP" | "MEMBER" | "NON_MEMBER" | "DROP_IN" | null;
  bookingLabel?: string | null;
};

type PrivateOffering = {
  id: string;
  title: string;
  durationMin: number;
  basePrice: number;
};

type ScheduleResponse = {
  contextMember: ScheduleMember | null;
  accessibleMembers: ScheduleMember[];
  activeMembershipNames: string[];
  items: ScheduleItem[];
  privateOfferings: PrivateOffering[];
};

const filters = [
  { key: "all", label: "All" },
  { key: "class", label: "Classes" },
  { key: "event", label: "Events" },
] as const;

function formatTimeRange(item: ScheduleItem) {
  return friendlyTimeRange(item.startsAt, item.endsAt);
}

// Group/section header — friendly + relative ("Today", "Tomorrow", "Sat, Jun 21").
function formatLongDate(item: ScheduleItem) {
  return friendlyDate(item.startsAt, { relative: true, weekday: true });
}

// Day-window quick filters so parents can answer "what's on this week?" fast.
const windows = [
  { key: "all", label: "All" },
  { key: "week", label: "Next 7 days" },
  { key: "month", label: "Next 30 days" },
] as const;

function withinWindow(startsAt: string, key: (typeof windows)[number]["key"]): boolean {
  if (key === "all") return true;
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) return true;
  const now = Date.now();
  const days = key === "week" ? 7 : 30;
  return start <= now + days * 86_400_000;
}

function priceLabel(item: ScheduleItem) {
  if (item.bookingStatus) return item.statusText;
  if (item.price) return `$${item.price}`;
  return item.statusText;
}

function itemColors(item: ScheduleItem) {
  return {
    background: item.color || (item.kind === "class" ? "#1C1917" : "#F5F5F4"),
    color: item.textColor || (item.kind === "class" ? "#FFFFFF" : "#44403C"),
  };
}

export default function MemberSchedulePage() {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof filters)[number]["key"]>("all");
  const [windowKey, setWindowKey] = useState<(typeof windows)[number]["key"]>("all");
  const [selected, setSelected] = useState<ScheduleItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [info, setInfo] = useState("");

  async function load(memberId?: string | null) {
    setLoading(true);
    setError("");
    const qs = memberId ? `?memberId=${encodeURIComponent(memberId)}` : "";
    const res = await fetch(`/api/member/schedule${qs}`, { cache: "no-store" });
    const next = res.ok ? ((await res.json()) as ScheduleResponse) : null;
    if (!next) {
      setError("Schedule could not be loaded.");
      setLoading(false);
      return;
    }
    const resolved = resolveActiveProfileId(next.accessibleMembers.map((m) => m.id));
    if (!memberId && resolved && next.contextMember?.id !== resolved) {
      await load(resolved);
      return;
    }
    setData(next);
    setActiveId(memberId || resolved);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(
    () =>
      onActiveProfileChange((id) => {
        setActiveId(id);
        load(id);
      }),
    [],
  );

  const items = useMemo(() => {
    const list = data?.items ?? [];
    return list
      .filter((item) => (filter === "all" ? true : item.kind === filter))
      .filter((item) => withinWindow(item.startsAt, windowKey));
  }, [data, filter, windowKey]);

  const grouped = useMemo(() => {
    const groups: { label: string; items: ScheduleItem[] }[] = [];
    for (const item of items) {
      const label = formatLongDate(item);
      const group = groups.find((g) => g.label === label);
      if (group) group.items.push(item);
      else groups.push({ label, items: [item] });
    }
    return groups;
  }, [items]);

  async function bookClass(item: ScheduleItem) {
    setBusy(item.id);
    setError("");
    setInfo("");
    const res = await fetch("/api/member/classes/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: item.id, memberId: activeId }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(d.error || "Could not book this class.");
      return;
    }
    // Parental gate (P4) — server returns 202 + { pendingApproval } when
    // a controlled minor queues an action. Don't show "Booked" — the
    // booking is on hold until the guardian responds.
    if (d.pendingApproval) {
      setSelected(null);
      setInfo(d.message || "Sent to your guardian for approval.");
      return;
    }
    if (d.url) {
      window.location.href = d.url;
      return;
    }
    // Only show "Booked" when the server confirms a real booking: either
    // the membership-covered free path, or an attendanceRecordId came
    // back. Guards against a spurious 2xx with no booking payload from
    // ever rendering a green badge again.
    if (d.coveredByMembership || d.attendanceRecordId) {
      setSelected(null);
      setInfo(d.coveredByMembership ? "Booked — covered by your membership." : "Booked.");
      await load(activeId);
      return;
    }
    setError("We couldn't confirm your booking. Contact your club if this keeps happening.");
  }

  async function register(item: ScheduleItem) {
    setBusy(item.id);
    setError("");
    setInfo("");
    const res = await fetch(`/api/member/events/${item.refId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pricingType: "MEMBER", memberId: activeId }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(d.error || "Could not register for this event.");
      return;
    }
    // Same P4 parental gate handling as bookClass — 202 + pendingApproval
    // means the registration is on hold, not done.
    if (d.pendingApproval) {
      setSelected(null);
      setInfo(d.message || "Sent to your guardian for approval.");
      return;
    }
    if (d.url) {
      window.location.href = d.url;
      return;
    }
    setSelected(null);
    setInfo(d.status === "WAITLISTED" ? "You're on the waitlist." : "Registered.");
    await load(activeId);
  }

  const activeMember = data?.contextMember;

  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Schedule</h1>
          <p className="text-sm text-stone-500">
            Classes, events, and private lesson options from your club.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSubscribe(true)}
            className="text-xs text-stone-500 hover:text-stone-900 inline-flex items-center gap-1"
          >
            <CalendarPlus className="h-3.5 w-3.5" strokeWidth={2} />
            Add to calendar
          </button>
          <Link href="/member/bookings" className="text-xs text-stone-500 hover:text-stone-900">
            My bookings →
          </Link>
        </div>
      </div>

      {showSubscribe && <SubscribeModal onClose={() => setShowSubscribe(false)} />}

      {data?.accessibleMembers && data.accessibleMembers.length > 1 && (
        <div className="-mt-2 mb-4 flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold flex-shrink-0">
            Athlete
          </span>
          {data.accessibleMembers.map((m) => {
            const isActive = m.id === activeId;
            const name = m.kind === "self" ? "You" : `${m.firstName} ${m.lastName}`;
            return (
              <button
                key={m.id}
                onClick={() => setActiveProfileId(m.id)}
                aria-pressed={isActive}
                className={`flex items-center gap-1.5 pl-1 pr-3 py-1 rounded-full border text-sm font-medium whitespace-nowrap flex-shrink-0 transition ${
                  isActive ? "pseg-active border-transparent" : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
                }`}
              >
                <Avatar name={name} size={22} />
                {name}
              </button>
            );
          })}
        </div>
      )}

      {data?.activeMembershipNames.length ? (
        <div className="pcard p-4 mb-4">
          <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-1">
            Active membership
          </p>
          <p className="text-sm text-stone-900">{data.activeMembershipNames.join(", ")}</p>
        </div>
      ) : null}

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">{error}</div>}
      {info && <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800 mb-4">{info}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="flex gap-1 bg-stone-100 rounded-lg p-1 w-fit">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-sm px-4 py-1.5 rounded-md transition ${
                filter === f.key ? "bg-white shadow-sm text-stone-900 font-medium" : "text-stone-600"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-stone-100 rounded-lg p-1 w-fit">
          {windows.map((w) => (
            <button
              key={w.key}
              onClick={() => setWindowKey(w.key)}
              className={`text-sm px-3 py-1.5 rounded-md transition ${
                windowKey === w.key ? "bg-white shadow-sm text-stone-900 font-medium" : "text-stone-600"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10 text-stone-400 text-sm">Loading schedule…</div>
      ) : !activeMember ? (
        <div className="pcard p-10 text-center">
          <p className="text-base font-medium text-stone-900 mb-1">No member profile linked</p>
          <p className="text-sm text-stone-500">Contact your club to connect this login to an athlete profile.</p>
        </div>
      ) : grouped.length === 0 ? (
        <div className="pcard p-10 text-center">
          <p className="text-base font-medium text-stone-900 mb-1">Nothing scheduled yet</p>
          <p className="text-sm text-stone-500">Check back soon for upcoming classes, events, and lessons.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <section key={group.label}>
              <h2 className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">{group.label}</h2>
              <div className="space-y-3">
                {group.items.map((item) => {
                  const c = itemColors(item);
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelected(item)}
                      className="w-full text-left pcard pcard-hover p-4"
                    >
                      <div className="flex items-start gap-4">
                        <div className="w-14 rounded-lg py-2 flex flex-col items-center justify-center flex-shrink-0" style={c}>
                          <span className="text-[10px] uppercase font-medium opacity-80">
                            {new Date(item.startsAt).toLocaleDateString("en-US", { month: "short" })}
                          </span>
                          <span className="text-xl font-bold leading-none">{new Date(item.startsAt).getDate()}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <h3 className="text-sm font-semibold text-stone-900">{item.title}</h3>
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={c}>
                              {item.typeLabel}
                            </span>
                          </div>
                          <p className="text-xs text-stone-500">
                            {formatTimeRange(item)}
                            {item.location ? ` · ${item.location}` : ""}
                            {item.capacity ? ` · ${Math.max(item.capacity - item.filled, 0)} spots left` : ""}
                          </p>
                          {item.description && (
                            <p className="text-xs text-stone-600 mt-1 line-clamp-2 whitespace-pre-wrap">{item.description}</p>
                          )}
                        </div>
                        <span className="text-xs text-stone-600 flex-shrink-0">{priceLabel(item)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {data?.privateOfferings.length ? (
        <div className="pcard p-5 mt-6">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-stone-900">Private lessons</h2>
              <p className="text-xs text-stone-500">Available lesson types from your club.</p>
            </div>
            <Link href="/member/privates" className="text-xs text-stone-500 hover:text-stone-900">
              Request →
            </Link>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.privateOfferings.map((type) => (
              <div key={type.id} className="rounded-lg border border-stone-100 p-3">
                <p className="text-sm font-medium text-stone-900">{type.title}</p>
                <p className="text-xs text-stone-500">
                  {type.durationMin} min · ${type.basePrice.toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {selected && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-stone-200 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-1">
                  {selected.typeLabel}
                </p>
                <h2 className="text-lg font-semibold text-stone-900">{selected.title}</h2>
              </div>
              <button onClick={() => setSelected(null)} className="text-stone-400 hover:text-stone-700 text-xl leading-none">
                x
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-xl border border-stone-200 p-4">
                <p className="text-sm font-medium text-stone-900">{formatLongDate(selected)}</p>
                <p className="text-sm text-stone-600">{formatTimeRange(selected)}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <Detail label="Coach" value={selected.coach} />
                <Detail label="Location" value={selected.location} />
                <Detail
                  label="Capacity"
                  value={selected.capacity ? `${selected.filled}/${selected.capacity} filled` : "No capacity limit listed"}
                />
                <Detail label="Price" value={selected.price ? `$${selected.price}` : selected.statusText} />
              </div>

              {selected.description && (
                <div>
                  <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-1">Details</p>
                  <p className="text-sm text-stone-700 whitespace-pre-wrap">{selected.description}</p>
                </div>
              )}

              <div className="rounded-xl bg-stone-50 border border-stone-200 p-4">
                <p className="text-sm font-semibold text-stone-900">{selected.statusText}</p>
                {selected.kind === "class" && selected.bookingLabel && (
                  <p className="text-xs text-stone-600 mt-1">
                    {selected.bookingLabel}
                    {selected.price ? ` — $${selected.price}` : ""}
                  </p>
                )}
                <p className="text-xs text-stone-500 mt-1">
                  {selected.kind === "class"
                    ? selected.canBook
                      ? selected.bookingTier === "MEMBERSHIP"
                        ? "Your membership covers this class."
                        : "You'll be taken to checkout to confirm payment."
                      : "Class booking is controlled by your club and membership rules."
                    : selected.canBook
                      ? "You can register for this event from this screen."
                      : "Registration is not available from your account right now."}
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50"
                >
                  Close
                </button>
                {selected.kind === "event" && (
                  <button
                    type="button"
                    disabled={!selected.canBook || busy === selected.id}
                    onClick={() => register(selected)}
                    className="flex-1 px-4 py-2 pbtn-accent rounded-lg text-sm font-semibold disabled:opacity-50"
                  >
                    {busy === selected.id ? "Registering..." : selected.canBook ? "Register" : selected.statusText}
                  </button>
                )}
                {selected.kind === "class" && (
                  <button
                    type="button"
                    disabled={!selected.canBook || busy === selected.id}
                    onClick={() => bookClass(selected)}
                    className="flex-1 px-4 py-2 pbtn-accent rounded-lg text-sm font-semibold disabled:opacity-50"
                  >
                    {busy === selected.id
                      ? "Booking..."
                      : selected.canBook
                        ? selected.bookingTier === "MEMBERSHIP"
                          ? "Book (covered)"
                          : selected.price
                            ? `Book — $${selected.price}`
                            : "Book"
                        : selected.statusText}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-stone-100 p-3">
      <p className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-1">{label}</p>
      <p className="text-sm text-stone-800">{value || "Not listed"}</p>
    </div>
  );
}

/* ─── Add-to-calendar modal ─── */

function SubscribeModal({ onClose }: { onClose: () => void }) {
  const [links, setLinks] = useState<{ ics: string; webcal: string; google: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/member/calendar-link")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setLinks)
      .catch(() => setError("Couldn't load the calendar link."));
  }, []);

  function copyIcs() {
    if (!links) return;
    navigator.clipboard?.writeText(links.ics).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-stone-900">Add to your calendar</h2>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg hover:bg-stone-100 flex items-center justify-center text-stone-500">✕</button>
        </div>
        <p className="text-xs text-stone-500 mb-4">
          Subscribe once — the club schedule stays up to date in your calendar app automatically.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!links && !error && <p className="text-sm text-stone-500">Loading…</p>}
        {links && (
          <div className="flex flex-col gap-2">
            <a
              href={links.google}
              target="_blank"
              rel="noreferrer"
              className="pbtn-accent text-center text-sm px-4 py-2.5 rounded-xl font-medium"
            >
              Add to Google Calendar
            </a>
            <a
              href={links.webcal}
              className="text-center text-sm px-4 py-2.5 rounded-xl font-medium border border-stone-300 text-stone-700 hover:bg-stone-50"
            >
              Add to Apple / Outlook
            </a>
            <button
              onClick={copyIcs}
              className="text-center text-sm px-4 py-2.5 rounded-xl font-medium border border-stone-300 text-stone-700 hover:bg-stone-50"
            >
              {copied ? "Copied!" : "Copy calendar link"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
