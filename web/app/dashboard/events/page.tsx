"use client";

import { useEffect, useState } from "react";
import StripeRequiredBanner from "@/components/StripeRequiredBanner";
import ImageUpload from "@/components/ImageUpload";

type BuiltInType = "CLASS" | "PRIVATE" | "CLINIC" | "CAMP" | "TOURNAMENT" | "OTHER";

type ClubEventType = {
  id: string;
  name: string;
  color: string;
  textColor: string;
  sortOrder: number;
};

type EventSession = {
  id?: string;
  name: string | null;
  startsAt: string;
  endsAt: string;
  sortOrder: number;
};

type Event = {
  id: string;
  type: BuiltInType;
  customEventTypeId: string | null;
  customEventType: ClubEventType | null;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  memberPrice: number | null;
  nonMemberPrice: number | null;
  dropInFee: number | null;
  travelFee: number | null;
  publishAt: string | null;
  unpublishAt: string | null;
  visibility: string;
  purchaseAccess: string;
  allowMembershipPayment: boolean;
  location: { name: string } | null;
  sessions: EventSession[];
  _count: { bookings: number };
};

type Member = { id: string; firstName: string; lastName: string };

const BUILT_IN_COLORS: Record<BuiltInType, { bg: string; fg: string }> = {
  CLASS: { bg: "#E6F1FB", fg: "#0C447C" },
  PRIVATE: { bg: "#EEEDFE", fg: "#3C3489" },
  CLINIC: { bg: "#EAF3DE", fg: "#27500A" },
  CAMP: { bg: "#FAEEDA", fg: "#633806" },
  TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
  OTHER: { bg: "#F1EFE8", fg: "#5F5E5A" },
};
const BUILT_IN_LABELS: Record<BuiltInType, string> = {
  CLASS: "Class", PRIVATE: "Private", CLINIC: "Clinic", CAMP: "Camp", TOURNAMENT: "Tournament", OTHER: "Other",
};

function getTypeDisplay(e: Event): { name: string; bg: string; fg: string } {
  if (e.customEventType) {
    return { name: e.customEventType.name, bg: e.customEventType.color, fg: e.customEventType.textColor };
  }
  const c = BUILT_IN_COLORS[e.type] || BUILT_IN_COLORS.OTHER;
  return { name: BUILT_IN_LABELS[e.type] || e.type, bg: c.bg, fg: c.fg };
}

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [clubEventTypes, setClubEventTypes] = useState<ClubEventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Event | null>(null);
  const [viewingBookings, setViewingBookings] = useState<string | null>(null);
  const [showManageTypes, setShowManageTypes] = useState(false);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");

  async function load() {
    setLoading(true);
    const [eRes, tRes] = await Promise.all([fetch("/api/events"), fetch("/api/events/types")]);
    if (eRes.ok) setEvents(await eRes.json());
    if (tRes.ok) setClubEventTypes(await tRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const now = new Date();
  const filtered = events.filter((e) => {
    const start = new Date(e.startsAt);
    if (filter === "upcoming") return start >= now;
    if (filter === "past") return start < now;
    return true;
  });

  async function handleDelete(id: string) {
    if (!confirm("Delete this event? Bookings will be canceled.")) return;
    const res = await fetch(`/api/events/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  function getPublishStatus(e: Event): { label: string; bg: string; fg: string } | null {
    const now = new Date();
    if (e.publishAt && new Date(e.publishAt) > now) return { label: "Scheduled", bg: "#FAEEDA", fg: "#633806" };
    if (e.unpublishAt && new Date(e.unpublishAt) < now) return { label: "Unpublished", bg: "#F1EFE8", fg: "#5F5E5A" };
    return null;
  }

  return (
    <div className="p-8 max-w-7xl">
      <StripeRequiredBanner feature="charge for events" />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-stone-900 mb-1">Events</h1>
          <p className="text-sm text-stone-500">Classes, privates, clinics, camps, tournaments</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowManageTypes(true)} className="text-sm px-3 py-2 rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-50">
            Manage event types
          </button>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700">
            + Add event
          </button>
        </div>
      </div>

      <div className="flex gap-1 bg-stone-100 rounded-lg p-1 mb-4 w-fit">
        {(["upcoming", "past", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`text-xs px-3 py-1.5 rounded-md transition ${filter === f ? "bg-white shadow-sm text-stone-900 font-medium" : "text-stone-600"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-8 text-center text-stone-500 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="text-4xl mb-2">◈</div>
          <h3 className="text-lg font-medium text-stone-900 mb-1">No events</h3>
          <p className="text-sm text-stone-500 mb-4">{filter === "upcoming" ? "No upcoming events scheduled." : "Nothing to show here."}</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700">
            + Schedule your first event
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => {
            const td = getTypeDisplay(e);
            const start = new Date(e.startsAt);
            const end = new Date(e.endsAt);
            const isFull = e.capacity && e._count.bookings >= e.capacity;
            const pubStatus = getPublishStatus(e);
            return (
              <div key={e.id} className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition">
                <div className="flex items-start gap-4">
                  <div className="w-14 text-center bg-stone-50 rounded-lg py-2 flex-shrink-0">
                    <div className="text-[10px] uppercase font-medium text-stone-500">{start.toLocaleString("en-US", { month: "short" })}</div>
                    <div className="text-xl font-semibold text-stone-900 leading-tight">{start.getDate()}</div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-base font-semibold text-stone-900 truncate">{e.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: td.bg, color: td.fg }}>{td.name}</span>
                      {pubStatus && <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: pubStatus.bg, color: pubStatus.fg }}>{pubStatus.label}</span>}
                      {isFull && <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-stone-900 text-white">Full</span>}
                      {e.visibility === "MEMBERS_ONLY" && <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-600">Members only</span>}
                      {e.visibility === "STAFF_ONLY" && <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-900 text-white">Staff only</span>}
                      {e.purchaseAccess === "STAFF_ONLY" && <span className="text-[10px] px-2 py-0.5 rounded-full border border-stone-300 text-stone-600">Staff books</span>}
                    </div>
                    <div className="text-xs text-stone-500 flex items-center gap-3 flex-wrap">
                      <span>
                        {start.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}
                        {" – "}
                        {end.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}
                      </span>
                      {e.sessions.length > 1 && <span>· {e.sessions.length} sessions</span>}
                      {e.location && <span>· {e.location.name}</span>}
                      {e.memberPrice != null && <span>· Member ${Number(e.memberPrice).toFixed(2)}</span>}
                      {e.nonMemberPrice != null && <span>· Non-mem ${Number(e.nonMemberPrice).toFixed(2)}</span>}
                      {e.dropInFee != null && <span>· Drop-in ${Number(e.dropInFee).toFixed(2)}</span>}
                      {e.allowMembershipPayment && <span>· Membership accepted</span>}
                      {e.capacity && <span>· {e._count.bookings}/{e.capacity}</span>}
                      {!e.capacity && e._count.bookings > 0 && <span>· {e._count.bookings} booked</span>}
                    </div>
                    {/* Show sessions if multiple */}
                    {e.sessions.length > 1 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {e.sessions.map((s, i) => (
                          <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-stone-50 border border-stone-200 text-stone-600">
                            {s.name || `Session ${i + 1}`}: {new Date(s.startsAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}–{new Date(s.endsAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-1 flex-shrink-0">
                    <button onClick={() => setViewingBookings(e.id)} className="text-xs text-stone-600 hover:text-stone-900 px-2 py-1 rounded hover:bg-stone-100">Bookings</button>
                    <button onClick={() => setEditing(e)} className="text-xs text-stone-600 hover:text-stone-900 px-2 py-1 rounded hover:bg-stone-100">Edit</button>
                    <button onClick={() => handleDelete(e.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(showAdd || editing) && (
        <EventModal
          event={editing}
          clubEventTypes={clubEventTypes}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {viewingBookings && <BookingsModal eventId={viewingBookings} onClose={() => { setViewingBookings(null); load(); }} />}

      {showManageTypes && (
        <ManageTypesModal
          types={clubEventTypes}
          onClose={() => setShowManageTypes(false)}
          onSaved={() => { setShowManageTypes(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Event Modal ──────────────────────────────────────────────────────────────
const COLOR_PRESETS = [
  { bg: "#E6F1FB", fg: "#0C447C", name: "Blue" },
  { bg: "#EAF3DE", fg: "#27500A", name: "Green" },
  { bg: "#FAEEDA", fg: "#633806", name: "Amber" },
  { bg: "#FCE4E0", fg: "#7B2415", name: "Red" },
  { bg: "#EEEDFE", fg: "#3C3489", name: "Purple" },
  { bg: "#F1EFE8", fg: "#5F5E5A", name: "Stone" },
  { bg: "#FDE7F3", fg: "#7B1F5A", name: "Pink" },
  { bg: "#D1FAE5", fg: "#065F46", name: "Teal" },
];

function toLocalInput(d: Date) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}

function EventModal({ event, clubEventTypes, onClose, onSaved }: {
  event: Event | null;
  clubEventTypes: ClubEventType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!event;

  const defaultStart = new Date();
  defaultStart.setHours(defaultStart.getHours() + 1, 0, 0, 0);
  const defaultEnd = new Date(defaultStart);
  defaultEnd.setHours(defaultEnd.getHours() + 1);

  // Determine initial type selection
  const initTypeKey = event?.customEventTypeId
    ? `custom:${event.customEventTypeId}`
    : (event?.type || "CLASS");

  const [typeKey, setTypeKey] = useState<string>(initTypeKey);
  const [name, setName] = useState(event?.name || "");
  const [description, setDescription] = useState(event?.description || "");
  const [startsAt, setStartsAt] = useState(event ? toLocalInput(new Date(event.startsAt)) : toLocalInput(defaultStart));
  const [endsAt, setEndsAt] = useState(event ? toLocalInput(new Date(event.endsAt)) : toLocalInput(defaultEnd));
  const [capacity, setCapacity] = useState(event?.capacity?.toString() || "");
  const [memberPrice, setMemberPrice] = useState(event?.memberPrice?.toString() || "");
  const [nonMemberPrice, setNonMemberPrice] = useState(event?.nonMemberPrice?.toString() || "");
  const [dropInFee, setDropInFee] = useState(event?.dropInFee?.toString() || "");
  const [travelFee, setTravelFee] = useState(event?.travelFee?.toString() || "");
  const [publishAt, setPublishAt] = useState(event?.publishAt ? toLocalInput(new Date(event.publishAt)) : "");
  const [unpublishAt, setUnpublishAt] = useState(event?.unpublishAt ? toLocalInput(new Date(event.unpublishAt)) : "");
  const [visibility, setVisibility] = useState(event?.visibility || "PUBLIC");
  const [purchaseAccess, setPurchaseAccess] = useState(event?.purchaseAccess || "ANYONE");
  const [allowMembershipPayment, setAllowMembershipPayment] = useState(event?.allowMembershipPayment || false);
  const [sessions, setSessions] = useState<Omit<EventSession, "id">[]>(
    event?.sessions?.length
      ? event.sessions.map((s) => ({ name: s.name, startsAt: toLocalInput(new Date(s.startsAt)), endsAt: toLocalInput(new Date(s.endsAt)), sortOrder: s.sortOrder }))
      : []
  );
  const [imageUrl, setImageUrl] = useState<string>((event as any)?.imageUrl || "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function addSession() {
    const lastEnd = sessions.length > 0 ? sessions[sessions.length - 1].endsAt : startsAt;
    const start = new Date(lastEnd);
    start.setMinutes(start.getMinutes() + 30);
    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    setSessions([...sessions, { name: null, startsAt: toLocalInput(start), endsAt: toLocalInput(end), sortOrder: sessions.length }]);
  }

  function removeSession(i: number) { setSessions(sessions.filter((_, idx) => idx !== i)); }
  function updateSession(i: number, key: keyof Omit<EventSession, "id">, val: any) {
    const copy = [...sessions];
    (copy[i] as any)[key] = val;
    setSessions(copy);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const isCustom = typeKey.startsWith("custom:");
    const customEventTypeId = isCustom ? typeKey.replace("custom:", "") : null;
    const type = isCustom ? "OTHER" : (typeKey as BuiltInType);

    const url = isEdit ? `/api/events/${event!.id}` : "/api/events";
    const method = isEdit ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type, customEventTypeId, name,
        description: description || undefined,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        capacity: capacity ? parseInt(capacity) : null,
        memberPrice: memberPrice ? parseFloat(memberPrice) : null,
        nonMemberPrice: nonMemberPrice ? parseFloat(nonMemberPrice) : null,
        dropInFee: dropInFee ? parseFloat(dropInFee) : null,
        travelFee: travelFee ? parseFloat(travelFee) : null,
        publishAt: publishAt ? new Date(publishAt).toISOString() : null,
        unpublishAt: unpublishAt ? new Date(unpublishAt).toISOString() : null,
        visibility, purchaseAccess, allowMembershipPayment,
        imageUrl: imageUrl || null,
        sessions: sessions.length > 0
          ? sessions.map((s, i) => ({ name: s.name || null, startsAt: new Date(s.startsAt).toISOString(), endsAt: new Date(s.endsAt).toISOString(), sortOrder: i }))
          : [],
      }),
    });

    setSaving(false);
    if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-stone-900">{isEdit ? "Edit event" : "Create event"}</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <ImageUpload
            label="Event image (optional)"
            value={imageUrl}
            onChange={setImageUrl}
            shape="square"
            placeholder="Upload a cover photo for this event"
          />

          {/* Event type */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Event type</label>
            <select value={typeKey} onChange={(e) => setTypeKey(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white">
              <optgroup label="Built-in types">
                <option value="CLASS">Class</option>
                <option value="PRIVATE">Private session</option>
                <option value="CLINIC">Clinic</option>
                <option value="CAMP">Camp</option>
                <option value="TOURNAMENT">Tournament</option>
                <option value="OTHER">Other</option>
              </optgroup>
              {clubEventTypes.length > 0 && (
                <optgroup label="Your custom types">
                  {clubEventTypes.map((t) => (
                    <option key={t.id} value={`custom:${t.id}`}>{t.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
          </div>

          {/* Main time (used when no sessions) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Starts</label>
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Ends</label>
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
            </div>
          </div>

          {/* Sessions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-stone-700">Sessions (optional)</label>
              <button type="button" onClick={addSession} className="text-xs text-stone-600 hover:text-stone-900">+ Add session</button>
            </div>
            {sessions.length === 0 ? (
              <p className="text-xs text-stone-400">Add sessions for multi-part events (clinics with breaks, tournaments with multiple rounds, etc.)</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((s, i) => (
                  <div key={i} className="border border-stone-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <input
                        type="text"
                        value={s.name || ""}
                        onChange={(e) => updateSession(i, "name", e.target.value || null)}
                        placeholder={`Session ${i + 1} name (optional)`}
                        className="flex-1 px-2 py-1 border border-stone-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-stone-900"
                      />
                      <button type="button" onClick={() => removeSession(i)} className="ml-2 text-stone-400 hover:text-red-600 text-lg leading-none">×</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-stone-500 mb-0.5 block">Start</label>
                        <input type="datetime-local" value={s.startsAt} onChange={(e) => updateSession(i, "startsAt", e.target.value)} className="w-full px-2 py-1.5 border border-stone-200 rounded text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-stone-500 mb-0.5 block">End</label>
                        <input type="datetime-local" value={s.endsAt} onChange={(e) => updateSession(i, "endsAt", e.target.value)} className="w-full px-2 py-1.5 border border-stone-200 rounded text-sm" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Capacity</label>
            <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="Leave blank for unlimited" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
          </div>

          {/* Pricing */}
          <div className="border-t border-stone-100 pt-4">
            <p className="text-xs uppercase tracking-wider text-stone-500 mb-3 font-medium">Pricing</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Member price</label>
                <input type="number" min="0" step="0.01" value={memberPrice} onChange={(e) => setMemberPrice(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Non-member</label>
                <input type="number" min="0" step="0.01" value={nonMemberPrice} onChange={(e) => setNonMemberPrice(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Drop-in fee</label>
                <input type="number" min="0" step="0.01" value={dropInFee} onChange={(e) => setDropInFee(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
              </div>
            </div>
            <label className="flex items-center gap-2 mt-3 cursor-pointer">
              <input type="checkbox" checked={allowMembershipPayment} onChange={(e) => setAllowMembershipPayment(e.target.checked)} className="rounded" />
              <span className="text-sm text-stone-700">Allow members to use their membership to pay for this event</span>
            </label>
          </div>

          {/* Visibility & Access */}
          <div className="border-t border-stone-100 pt-4">
            <p className="text-xs uppercase tracking-wider text-stone-500 mb-3 font-medium">Visibility & Access</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Who can see this event?</label>
                <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white">
                  <option value="PUBLIC">Everyone (public)</option>
                  <option value="MEMBERS_ONLY">Active members only</option>
                  <option value="STAFF_ONLY">Staff & owner only</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Who can book/purchase?</label>
                <select value={purchaseAccess} onChange={(e) => setPurchaseAccess(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white">
                  <option value="ANYONE">Members can self-book</option>
                  <option value="STAFF_ONLY">Staff & owner only</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm resize-none" />
          </div>

          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-stone-600 hover:text-stone-900">
            {showAdvanced ? "− Hide" : "+ Show"} advanced options
          </button>

          {showAdvanced && (
            <div className="space-y-3 pt-2 border-t border-stone-100">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Travel fee</label>
                <input type="number" min="0" step="0.01" value={travelFee} onChange={(e) => setTravelFee(e.target.value)} placeholder="For tournaments / off-site events" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Publish at</label>
                  <input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
                  <p className="text-[10px] text-stone-400 mt-1">Hide until this date</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Unpublish at</label>
                  <input type="datetime-local" value={unpublishAt} onChange={(e) => setUnpublishAt(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
                  <p className="text-[10px] text-stone-400 mt-1">Hide after this date</p>
                </div>
              </div>
            </div>
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Manage Event Types Modal ─────────────────────────────────────────────────
function ManageTypesModal({ types, onClose, onSaved }: { types: ClubEventType[]; onClose: () => void; onSaved: () => void }) {
  const [localTypes, setLocalTypes] = useState<ClubEventType[]>(types);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLOR_PRESETS[0].bg);
  const [newTextColor, setNewTextColor] = useState(COLOR_PRESETS[0].fg);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function addType() {
    if (!newName.trim()) return;
    setSaving(true);
    const res = await fetch("/api/events/types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor, textColor: newTextColor, sortOrder: localTypes.length }),
    });
    setSaving(false);
    if (res.ok) {
      const t = await res.json();
      setLocalTypes([...localTypes, t]);
      setNewName("");
    } else {
      setError("Failed to create type");
    }
  }

  async function deleteType(id: string) {
    if (!confirm("Delete this event type? Events using it will revert to 'Other'.")) return;
    await fetch(`/api/events/types/${id}`, { method: "DELETE" });
    setLocalTypes(localTypes.filter((t) => t.id !== id));
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h2 className="text-lg font-semibold text-stone-900">Manage event types</h2>
            <p className="text-xs text-stone-500">Create custom types for your sport (e.g. Game, Match, Scrimmage)</p>
          </div>
          <button onClick={() => { onSaved(); }} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Built-in types */}
          <div>
            <p className="text-xs uppercase tracking-wider text-stone-500 mb-2 font-medium">Built-in types</p>
            <div className="flex flex-wrap gap-2">
              {(Object.entries(BUILT_IN_LABELS) as [BuiltInType, string][]).map(([key, label]) => {
                const c = BUILT_IN_COLORS[key];
                return (
                  <span key={key} className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>{label}</span>
                );
              })}
            </div>
          </div>

          {/* Custom types */}
          <div>
            <p className="text-xs uppercase tracking-wider text-stone-500 mb-2 font-medium">Your custom types</p>
            {localTypes.length === 0 ? (
              <p className="text-sm text-stone-400">No custom types yet.</p>
            ) : (
              <div className="space-y-1">
                {localTypes.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-stone-50">
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: t.color, color: t.textColor }}>{t.name}</span>
                    <div className="flex-1" />
                    <button onClick={() => deleteType(t.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add new type */}
          <div className="border-t border-stone-100 pt-4">
            <p className="text-xs uppercase tracking-wider text-stone-500 mb-3 font-medium">Add new type</p>
            <div className="space-y-3">
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Type name (e.g. Game, Match, Scrimmage)" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addType())} />
              <div>
                <p className="text-xs text-stone-500 mb-2">Badge color:</p>
                <div className="flex flex-wrap gap-2">
                  {COLOR_PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => { setNewColor(p.bg); setNewTextColor(p.fg); }}
                      className={`text-xs px-2.5 py-1 rounded-full font-medium border-2 transition ${newColor === p.bg ? "border-stone-900" : "border-transparent"}`}
                      style={{ background: p.bg, color: p.fg }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="mt-2">
                  <span className="text-xs text-stone-500 mr-2">Preview:</span>
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: newColor, color: newTextColor }}>{newName || "New type"}</span>
                </div>
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
              <button onClick={addType} disabled={!newName.trim() || saving} className="w-full px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
                {saving ? "Creating…" : "Create type"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Bookings Modal ───────────────────────────────────────────────────────────
function BookingsModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [event, setEvent] = useState<any>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMember, setSelectedMember] = useState("");
  const [pricingType, setPricingType] = useState<"MEMBER" | "NON_MEMBER" | "DROP_IN">("MEMBER");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    const [eRes, mRes] = await Promise.all([fetch(`/api/events/${eventId}`), fetch("/api/members")]);
    if (eRes.ok) setEvent(await eRes.json());
    if (mRes.ok) setMembers(await mRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, [eventId]);

  const isPaid = !!(event?.memberPrice || event?.nonMemberPrice || event?.dropInFee);

  async function handleAdd() {
    if (!selectedMember) return;
    setError("");
    setAdding(true);
    if (isPaid) {
      const res = await fetch(`/api/events/${eventId}/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: selectedMember, pricingType }),
      });
      const data = await res.json();
      setAdding(false);
      if (!res.ok || !data.url) { setError(data.error?.toString() || "Failed to start checkout"); return; }
      window.open(data.url, "_blank");
    } else {
      const res = await fetch(`/api/events/${eventId}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: selectedMember }),
      });
      setAdding(false);
      if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Failed to book"); return; }
      setSelectedMember("");
      load();
    }
  }

  async function handleRemove(memberId: string) {
    if (!confirm("Cancel this booking?")) return;
    await fetch(`/api/events/${eventId}/bookings?memberId=${memberId}`, { method: "DELETE" });
    load();
  }

  const bookedIds = new Set((event?.bookings || []).map((b: any) => b.member.id));
  const availableMembers = members.filter((m) => !bookedIds.has(m.id));
  const totalBookings = event?.bookings?.length ?? 0;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h2 className="text-lg font-semibold text-stone-900">Bookings · {totalBookings}{event?.capacity && `/${event.capacity}`}</h2>
            {event && <p className="text-xs text-stone-500">{event.name}</p>}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="text-center text-sm text-stone-500 py-4">Loading…</div>
          ) : (
            <>
              <div className="mb-4 space-y-2">
                <label className="block text-sm font-medium text-stone-700">Add member</label>
                <select value={selectedMember} onChange={(e) => setSelectedMember(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white">
                  <option value="">Select a member…</option>
                  {availableMembers.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
                </select>
                {isPaid && (
                  <select value={pricingType} onChange={(e) => setPricingType(e.target.value as any)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white">
                    {event?.memberPrice && <option value="MEMBER">Member price — ${Number(event.memberPrice).toFixed(2)}</option>}
                    {event?.nonMemberPrice && <option value="NON_MEMBER">Non-member — ${Number(event.nonMemberPrice).toFixed(2)}</option>}
                    {event?.dropInFee && <option value="DROP_IN">Drop-in — ${Number(event.dropInFee).toFixed(2)}</option>}
                  </select>
                )}
                <button onClick={handleAdd} disabled={!selectedMember || adding} className="w-full px-3 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
                  {adding ? "Processing…" : isPaid ? "Send checkout link" : "Book (free)"}
                </button>
                {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>}
              </div>
              {totalBookings === 0 ? (
                <div className="text-sm text-stone-500 text-center py-6">No bookings yet.</div>
              ) : (
                <div className="space-y-1">
                  {event?.bookings?.map((b: any) => (
                    <div key={b.id} className="flex items-center justify-between py-2 px-3 rounded hover:bg-stone-50">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-stone-200 flex items-center justify-center text-[10px] font-medium text-stone-700">
                          {b.member.firstName[0]}{b.member.lastName[0]}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-stone-900">{b.member.firstName} {b.member.lastName}</div>
                          <div className="text-[10px]" style={{ color: b.status === "WAITLISTED" ? "#633806" : "#27500A" }}>
                            {b.status === "WAITLISTED" ? "Waitlisted" : "Confirmed"}
                          </div>
                        </div>
                      </div>
                      <button onClick={() => handleRemove(b.member.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Cancel</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
