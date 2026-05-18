"use client";

import { useEffect, useState } from "react";
import StripeRequiredBanner from "@/components/StripeRequiredBanner";
import ImageUpload from "@/components/ImageUpload";

type BuiltInType = "CLASS" | "PRIVATE" | "CLINIC" | "CAMP" | "TOURNAMENT" | "OTHER";

type FormFieldDef = {
  id: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "checkbox";
  required: boolean;
  options?: string[];
};

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
  pricingOptions?: { type: "membership"; membershipId: string }[] | null;
  location: { name: string } | null;
  sessions: EventSession[];
  staffAssignments?: { user: { id: string; firstName: string; lastName: string } }[];
  _count: { bookings: number; registrations?: number };
  isTournament?: boolean;
  tournamentMode?: string | null;
  publicSlug?: string | null;
  publicRegistration?: boolean;
  variableCostEnabled?: boolean;
  variableCostMode?: string | null;
  variableCostBilledAt?: string | null;
  variableCostTotal?: number | string | null;
  variableCostEstimatedSignups?: number | null;
  variableCostEstimatedTotal?: number | string | null;
};

type Member = { id: string; firstName: string; lastName: string };
type Membership = { id: string; name: string; active: boolean };
type Staff = { id: string; firstName: string; lastName: string };

const BUILT_IN_COLORS: Record<BuiltInType, { bg: string; fg: string }> = {
  CLASS: { bg: "var(--color-primary)", fg: "#fff" },
  PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
  CLINIC: { bg: "var(--color-success)", fg: "var(--color-text)" },
  CAMP: { bg: "var(--color-warning)", fg: "#fff" },
  TOURNAMENT: { bg: "var(--color-warning)", fg: "#fff" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
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

// Compact at-a-glance pricing badge so paid events are never mistaken for free.
function getPricingBadge(e: Event, memberships: Membership[]): { label: string; bg: string; fg: string } {
  const varTotal =
    e.variableCostTotal != null
      ? Number(e.variableCostTotal)
      : e.variableCostEstimatedTotal != null
        ? Number(e.variableCostEstimatedTotal)
        : 0;
  if (e.variableCostEnabled && varTotal > 0) {
    return { label: "Variable cost — billed later", bg: "var(--color-warning)", fg: "#fff" };
  }
  const hasMembershipCover = ((e.pricingOptions as any[]) || []).some(
    (p) => p?.type === "membership" && p.membershipId && memberships.some((m) => m.id === p.membershipId),
  );
  const isPaid = !!(e.memberPrice != null || e.nonMemberPrice != null || e.dropInFee != null);
  if (hasMembershipCover) {
    return { label: "Covered by memberships", bg: "var(--color-primary)", fg: "#fff" };
  }
  if (isPaid) {
    return { label: "Requires payment", bg: "var(--color-warning)", fg: "#fff" };
  }
  return { label: "Free", bg: "var(--color-bg)", fg: "var(--color-muted)" };
}

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [clubEventTypes, setClubEventTypes] = useState<ClubEventType[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Event | null>(null);
  const [viewingBookings, setViewingBookings] = useState<string | null>(null);
  const [viewingRegistrations, setViewingRegistrations] = useState<string | null>(null);
  const [showManageTypes, setShowManageTypes] = useState(false);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");

  async function load() {
    setLoading(true);
    const [eRes, tRes, mRes, sRes] = await Promise.all([
      fetch("/api/events"),
      fetch("/api/events/types"),
      fetch("/api/memberships"),
      fetch("/api/staff?includeOwners=true"),
    ]);
    if (eRes.ok) setEvents(await eRes.json());
    if (tRes.ok) setClubEventTypes(await tRes.json());
    if (mRes.ok) setMemberships((await mRes.json()).filter((m: Membership) => m.active));
    if (sRes.ok) setStaffList(await sRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Deep link from the attendance QR code: /dashboard/events?event=<id>
  // opens that event's bookings/check-in directly.
  useEffect(() => {
    if (loading || events.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get("event");
    if (eventId && events.some((e) => e.id === eventId)) {
      setViewingBookings(eventId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

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
    if (e.publishAt && new Date(e.publishAt) > now) return { label: "Scheduled", bg: "var(--color-warning)", fg: "#fff" };
    if (e.unpublishAt && new Date(e.unpublishAt) < now) return { label: "Unpublished", bg: "var(--color-bg)", fg: "var(--color-muted)" };
    return null;
  }

  return (
    <div className="p-8 max-w-7xl">
      <StripeRequiredBanner feature="charge for events" />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Events</h1>
          <p className="text-sm text-text-muted">Classes, privates, clinics, camps, tournaments</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowManageTypes(true)} className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
            Manage event types
          </button>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add event
          </button>
        </div>
      </div>

      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-4 w-fit">
        {(["upcoming", "past", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`text-xs px-3 py-1.5 rounded-md transition ${filter === f ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface rounded-xl border border-app-border p-12 text-center">
          <div className="text-4xl mb-2">◈</div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No events</h3>
          <p className="text-sm text-text-muted mb-4">{filter === "upcoming" ? "No upcoming events scheduled." : "Nothing to show here."}</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
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
              <div key={e.id} className="bg-surface rounded-xl border border-app-border p-4 hover:shadow-sm transition">
                <div className="flex items-start gap-4">
                  <div className="w-14 text-center bg-app-bg rounded-lg py-2 flex-shrink-0">
                    <div className="text-[10px] uppercase font-medium text-text-muted">{start.toLocaleString("en-US", { month: "short" })}</div>
                    <div className="text-xl font-semibold text-text-primary leading-tight">{start.getDate()}</div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-base font-semibold text-text-primary truncate">{e.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: td.bg, color: td.fg }}>{td.name}</span>
                      {pubStatus && <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: pubStatus.bg, color: pubStatus.fg }}>{pubStatus.label}</span>}
                      {isFull && <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-brand text-white">Full</span>}
                      {e.visibility === "MEMBERS_ONLY" && <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">Members only</span>}
                      {e.visibility === "STAFF_ONLY" && <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand text-white">Staff only</span>}
                      {e.purchaseAccess === "STAFF_ONLY" && <span className="text-[10px] px-2 py-0.5 rounded-full border border-app-border text-text-muted">Staff books</span>}
                      {(() => {
                        const b = getPricingBadge(e, memberships);
                        return <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: b.bg, color: b.fg }}>{b.label}</span>;
                      })()}
                    </div>
                    <div className="text-xs text-text-muted flex items-center gap-3 flex-wrap">
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
                      {(e.pricingOptions || []).map((p) => {
                        const membership = memberships.find((m) => m.id === p.membershipId);
                        return membership ? <span key={p.membershipId}>· {membership.name} accepted</span> : null;
                      })}
                      {e.staffAssignments && e.staffAssignments.length > 0 && (
                        <span>· Staff: {e.staffAssignments.map((a) => `${a.user.firstName} ${a.user.lastName}`).join(", ")}</span>
                      )}
                      {e.capacity && <span>· {e._count.bookings}/{e.capacity}</span>}
                      {!e.capacity && e._count.bookings > 0 && <span>· {e._count.bookings} booked</span>}
                    </div>
                    {/* Show sessions if multiple */}
                    {e.sessions.length > 1 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {e.sessions.map((s, i) => (
                          <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-app-bg border border-app-border text-text-muted">
                            {s.name || `Session ${i + 1}`}: {new Date(s.startsAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}–{new Date(s.endsAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-1 flex-shrink-0">
                    {(e.publicRegistration || e.tournamentMode === "HOST" || (e._count.registrations ?? 0) > 0) && (
                      <button onClick={() => setViewingRegistrations(e.id)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                        Registrations{(e._count.registrations ?? 0) > 0 ? ` (${e._count.registrations})` : ""}
                      </button>
                    )}
                    <button onClick={() => setViewingBookings(e.id)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Bookings</button>
                    <button onClick={() => setEditing(e)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
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
          memberships={memberships}
          staffList={staffList}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {viewingBookings && <BookingsModal eventId={viewingBookings} onClose={() => { setViewingBookings(null); load(); }} />}

      {viewingRegistrations && <RegistrationsModal eventId={viewingRegistrations} onClose={() => { setViewingRegistrations(null); load(); }} />}

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
  { bg: "var(--color-primary)", fg: "#fff", name: "Violet" },
  { bg: "var(--color-success)", fg: "var(--color-text)", name: "Lime" },
  { bg: "var(--color-warning)", fg: "#fff", name: "Orange" },
  { bg: "var(--color-bg)", fg: "var(--color-muted)", name: "Neutral" },
];

function toLocalInput(d: Date) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}

function EventModal({ event, clubEventTypes, memberships, staffList, onClose, onSaved }: {
  event: Event | null;
  clubEventTypes: ClubEventType[];
  memberships: Membership[];
  staffList: Staff[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!event;

  const defaultStart = new Date();
  defaultStart.setHours(defaultStart.getHours() + 1, 0, 0, 0);
  const defaultEnd = new Date(defaultStart);
  defaultEnd.setHours(defaultEnd.getHours() + 1);

  // Determine initial type selection. Classes are their OWN thing
  // (/dashboard/classes → RecurringClass) and are intentionally not an event
  // type here, so the default is OTHER.
  const initTypeKey = event?.customEventTypeId
    ? `custom:${event.customEventTypeId}`
    : (event?.type && event.type !== "CLASS" ? event.type : "OTHER");

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
  const [allowedMembershipIds, setAllowedMembershipIds] = useState<string[]>(
    (event?.pricingOptions || []).filter((p) => p.type === "membership").map((p) => p.membershipId)
  );
  const [staffUserIds, setStaffUserIds] = useState<string[]>((event?.staffAssignments || []).map((a) => a.user.id));
  const [sessions, setSessions] = useState<Omit<EventSession, "id">[]>(
    event?.sessions?.length
      ? event.sessions.map((s) => ({ name: s.name, startsAt: toLocalInput(new Date(s.startsAt)), endsAt: toLocalInput(new Date(s.endsAt)), sortOrder: s.sortOrder }))
      : []
  );
  const [imageUrl, setImageUrl] = useState<string>((event as any)?.imageUrl || "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Tournament + public-registration state
  const ev = event as any;
  const [tournamentMode, setTournamentMode] = useState<string>(ev?.tournamentMode || "");
  const [publicRegistration, setPublicRegistration] = useState<boolean>(!!ev?.publicRegistration);
  const [publicFormIntro, setPublicFormIntro] = useState<string>(ev?.publicFormIntro || "");
  const [formFields, setFormFields] = useState<FormFieldDef[]>(
    Array.isArray(ev?.registrationForm) ? ev.registrationForm : []
  );
  const [varCostEnabled, setVarCostEnabled] = useState<boolean>(!!ev?.variableCostEnabled);
  const [varCostMode, setVarCostMode] = useState<string>(ev?.variableCostMode || "ESTIMATED");
  const [varCostTotal, setVarCostTotal] = useState<string>(
    ev?.variableCostTotal != null ? String(ev.variableCostTotal) : ""
  );
  const [varCostEstSignups, setVarCostEstSignups] = useState<string>(
    ev?.variableCostEstimatedSignups != null ? String(ev.variableCostEstimatedSignups) : ""
  );
  const [varCostEstTotal, setVarCostEstTotal] = useState<string>(
    ev?.variableCostEstimatedTotal != null ? String(ev.variableCostEstimatedTotal) : ""
  );

  const isTournament = typeKey === "TOURNAMENT";
  const publicSlug: string | null = ev?.publicSlug || null;

  function addFormField() {
    setFormFields((f) => [
      ...f,
      { id: `f${Date.now().toString(36)}`, label: "", type: "text", required: false },
    ]);
  }
  function updateFormField(i: number, patch: Partial<FormFieldDef>) {
    setFormFields((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeFormField(i: number) {
    setFormFields((f) => f.filter((_, idx) => idx !== i));
  }

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

  function toggleMembership(id: string) {
    setAllowedMembershipIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function toggleStaff(id: string) {
    setStaffUserIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
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
        visibility, purchaseAccess,
        allowMembershipPayment: allowedMembershipIds.length > 0,
        pricingOptions: allowedMembershipIds.map((membershipId) => ({ type: "membership", membershipId })),
        staffUserIds,
        imageUrl: imageUrl || null,
        tournamentMode: type === "TOURNAMENT" ? (tournamentMode || null) : null,
        publicRegistration,
        publicFormIntro: publicFormIntro || null,
        registrationForm: formFields
          .filter((f) => f.label.trim())
          .map((f) => ({ ...f, label: f.label.trim() })),
        variableCostEnabled: type === "TOURNAMENT" && tournamentMode === "ATTEND" ? varCostEnabled : false,
        variableCostMode: varCostEnabled ? varCostMode : null,
        variableCostTotal: varCostEnabled && varCostTotal ? parseFloat(varCostTotal) : null,
        variableCostEstimatedSignups:
          varCostEnabled && varCostMode === "ESTIMATED" && varCostEstSignups
            ? parseInt(varCostEstSignups, 10)
            : null,
        variableCostEstimatedTotal:
          varCostEnabled && varCostMode === "OFFICIAL" && varCostEstTotal
            ? parseFloat(varCostEstTotal)
            : null,
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
      <div className="bg-surface rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit event" : "Create event"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
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
            <label className="block text-sm font-medium text-text-primary mb-1">Event type</label>
            <select value={typeKey} onChange={(e) => setTypeKey(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
              <optgroup label="Built-in types">
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
            <p className="text-[11px] text-text-muted mt-1">
              Recurring classes live on their own <a href="/dashboard/classes" className="text-brand hover:underline">Classes</a> page — they aren't an event type.
            </p>
          </div>

          {/* Tournament setup */}
          {isTournament && (
            <div className="border border-app-border rounded-lg p-4 space-y-4 bg-app-bg/40">
              <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Tournament setup</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTournamentMode("HOST")}
                  className={`text-left px-3 py-2.5 rounded-lg border text-sm ${tournamentMode === "HOST" ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}
                >
                  <span className="font-medium block">Host a tournament</span>
                  <span className="text-[11px] text-text-muted">We're running it — collect registrations</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTournamentMode("ATTEND")}
                  className={`text-left px-3 py-2.5 rounded-lg border text-sm ${tournamentMode === "ATTEND" ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}
                >
                  <span className="font-medium block">Attending a tournament</span>
                  <span className="text-[11px] text-text-muted">Gather signups for a trip & split costs</span>
                </button>
              </div>

              {/* ATTEND → variable cost */}
              {tournamentMode === "ATTEND" && (
                <div className="border-t border-app-border pt-3 space-y-3">
                  <label className="flex items-center justify-between">
                    <span className="text-sm text-text-primary">Split a shared cost across attendees</span>
                    <button
                      type="button"
                      onClick={() => setVarCostEnabled(!varCostEnabled)}
                      className={`relative inline-flex h-5 w-9 rounded-full transition flex-shrink-0 ${varCostEnabled ? "bg-brand" : "bg-app-border"}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${varCostEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </label>

                  {varCostEnabled && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setVarCostMode("ESTIMATED")}
                          className={`text-left px-3 py-2 rounded-lg border text-xs ${varCostMode === "ESTIMATED" ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}
                        >
                          <span className="font-medium block">Estimated (prior)</span>
                          <span className="text-text-muted">Bill before the event, estimated split</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setVarCostMode("OFFICIAL")}
                          className={`text-left px-3 py-2 rounded-lg border text-xs ${varCostMode === "OFFICIAL" ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}
                        >
                          <span className="font-medium block">Official (post)</span>
                          <span className="text-text-muted">Bill after the event, official split</span>
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">
                            {varCostMode === "OFFICIAL" ? "Official total cost" : "Estimated total cost"}
                          </label>
                          <input
                            type="number" min="0" step="0.01" value={varCostTotal}
                            onChange={(e) => setVarCostTotal(e.target.value)}
                            placeholder="500.00"
                            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
                          />
                        </div>
                        {varCostMode === "ESTIMATED" && (
                          <div>
                            <label className="block text-xs font-medium text-text-primary mb-1">Expected # of signups</label>
                            <input
                              type="number" min="1" value={varCostEstSignups}
                              onChange={(e) => setVarCostEstSignups(e.target.value)}
                              placeholder="20"
                              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
                            />
                          </div>
                        )}
                        {varCostMode === "OFFICIAL" && (
                          <div>
                            <label className="block text-xs font-medium text-text-primary mb-1">
                              Estimated total (shown to parents)
                            </label>
                            <input
                              type="number" min="0" step="0.01" value={varCostEstTotal}
                              onChange={(e) => setVarCostEstTotal(e.target.value)}
                              placeholder="500.00"
                              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
                            />
                          </div>
                        )}
                      </div>
                      <p className="text-[11px] text-text-muted">
                        {varCostMode === "ESTIMATED"
                          ? varCostTotal && varCostEstSignups
                            ? `Signups register now (no charge yet). When you're ready, open Registrations → "Invoice all unpaid" to send each registrant a ~$${(Number(varCostTotal) / Number(varCostEstSignups || 1)).toFixed(2)} payment link (estimated total ÷ expected signups).`
                            : "Signups register now (no charge at registration). You choose when to bill — open Registrations and send invoices using the estimated total ÷ expected signups."
                          : varCostEstTotal
                            ? `Signups register now (no charge yet). Parents see an estimate of ~$${Number(varCostEstTotal).toFixed(2)} total. After the event, set the official total and use Registrations → "Invoice all unpaid" to split it across actual registrants.`
                            : "Signups register now (no charge at registration). After the event, set the official total and send invoices from Registrations to split it across actual registrants."}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Public / non-member registration */}
          <div className="border border-app-border rounded-lg p-4 space-y-3 bg-app-bg/40">
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-text-primary block">Public registration link</span>
                <span className="text-[11px] text-text-muted">Let non-members sign up via a shareable link</span>
              </div>
              <button
                type="button"
                onClick={() => setPublicRegistration(!publicRegistration)}
                className={`relative inline-flex h-5 w-9 rounded-full transition flex-shrink-0 ${publicRegistration ? "bg-brand" : "bg-app-border"}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${publicRegistration ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </label>

            {(publicRegistration || (isTournament && tournamentMode === "HOST")) && (
              <>
                {publicSlug && (
                  <div className="text-xs bg-surface border border-app-border rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                    <code className="truncate text-text-primary">{`${typeof window !== "undefined" ? window.location.origin : ""}/e/${publicSlug}`}</code>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/e/${publicSlug}`)}
                      className="text-brand hover:underline flex-shrink-0"
                    >
                      Copy
                    </button>
                  </div>
                )}
                {!publicSlug && (
                  <p className="text-[11px] text-text-muted">The shareable link will be generated when you save.</p>
                )}

                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">Intro shown above the form (optional)</label>
                  <textarea
                    value={publicFormIntro}
                    onChange={(e) => setPublicFormIntro(e.target.value)}
                    rows={2}
                    placeholder="e.g. Register your athlete for the Spring Open. Questions? Email us."
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm resize-none"
                  />
                </div>

                {/* Custom registration form builder */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-text-primary">Registration form fields</label>
                    <button type="button" onClick={addFormField} className="text-xs text-brand hover:underline">+ Add field</button>
                  </div>
                  <p className="text-[11px] text-text-muted mb-2">Name, email, and phone are always collected. Add anything else you need.</p>
                  {formFields.length === 0 ? (
                    <p className="text-[11px] text-text-muted">No extra fields yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {formFields.map((f, i) => (
                        <div key={f.id} className="border border-app-border rounded-lg p-2.5 space-y-2 bg-surface">
                          <div className="flex items-center gap-2">
                            <input
                              type="text" value={f.label}
                              onChange={(e) => updateFormField(i, { label: e.target.value })}
                              placeholder="Field label (e.g. Athlete age, T-shirt size)"
                              className="flex-1 px-2 py-1.5 border border-app-border rounded text-sm"
                            />
                            <button type="button" onClick={() => removeFormField(i)} className="text-text-muted hover:text-red-600 text-lg leading-none">×</button>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={f.type}
                              onChange={(e) => updateFormField(i, { type: e.target.value as FormFieldDef["type"] })}
                              className="px-2 py-1.5 border border-app-border rounded text-sm bg-surface"
                            >
                              <option value="text">Short text</option>
                              <option value="textarea">Long text</option>
                              <option value="email">Email</option>
                              <option value="phone">Phone</option>
                              <option value="select">Dropdown</option>
                              <option value="checkbox">Checkbox</option>
                            </select>
                            <label className="flex items-center gap-1.5 text-xs text-text-muted">
                              <input type="checkbox" checked={f.required} onChange={(e) => updateFormField(i, { required: e.target.checked })} />
                              Required
                            </label>
                          </div>
                          {f.type === "select" && (
                            <input
                              type="text"
                              value={(f.options || []).join(", ")}
                              onChange={(e) => updateFormField(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                              placeholder="Comma-separated options: Small, Medium, Large"
                              className="w-full px-2 py-1.5 border border-app-border rounded text-sm"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
          </div>

          {/* Main time (used when no sessions) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Starts</label>
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Ends</label>
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
            </div>
          </div>

          {/* Sessions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-text-primary">Sessions (optional)</label>
              <button type="button" onClick={addSession} className="text-xs text-text-muted hover:text-text-primary">+ Add session</button>
            </div>
            {sessions.length === 0 ? (
              <p className="text-xs text-text-muted">Add sessions for multi-part events (clinics with breaks, tournaments with multiple rounds, etc.)</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((s, i) => (
                  <div key={i} className="border border-app-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <input
                        type="text"
                        value={s.name || ""}
                        onChange={(e) => updateSession(i, "name", e.target.value || null)}
                        placeholder={`Session ${i + 1} name (optional)`}
                        className="flex-1 px-2 py-1 border border-app-border rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                      <button type="button" onClick={() => removeSession(i)} className="ml-2 text-text-muted hover:text-red-600 text-lg leading-none">×</button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-text-muted mb-0.5 block">Start</label>
                        <input type="datetime-local" value={s.startsAt} onChange={(e) => updateSession(i, "startsAt", e.target.value)} className="w-full px-2 py-1.5 border border-app-border rounded text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-text-muted mb-0.5 block">End</label>
                        <input type="datetime-local" value={s.endsAt} onChange={(e) => updateSession(i, "endsAt", e.target.value)} className="w-full px-2 py-1.5 border border-app-border rounded text-sm" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Capacity</label>
            <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="Leave blank for unlimited" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
          </div>

          {/* Pricing */}
          <div className="border-t border-app-border pt-4">
            <p className="text-xs uppercase tracking-wider text-text-muted mb-3 font-medium">Pricing</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Member price</label>
                <input type="number" min="0" step="0.01" value={memberPrice} onChange={(e) => setMemberPrice(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Non-member</label>
                <input type="number" min="0" step="0.01" value={nonMemberPrice} onChange={(e) => setNonMemberPrice(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Drop-in fee</label>
                <input type="number" min="0" step="0.01" value={dropInFee} onChange={(e) => setDropInFee(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
              </div>
            </div>
          </div>

          {/* Accepted memberships */}
          <div className="border-t border-app-border pt-4">
            <label className="block text-xs font-medium text-text-primary mb-1">
              Accepted Memberships / Purchase Options
            </label>
            <p className="text-[11px] text-text-muted mb-2">
              Members on any selected plan can register at no extra cost. Others pay the prices above.
            </p>
            {memberships.length === 0 ? (
              <div className="border border-dashed border-app-border rounded-lg p-3 text-xs text-text-muted">
                No active memberships yet.{" "}
                <a href="/dashboard/memberships" className="text-brand hover:underline">
                  Create a membership →
                </a>
              </div>
            ) : (
              <div className="border border-app-border rounded-lg p-3 space-y-1.5 max-h-40 overflow-y-auto">
                {memberships.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={allowedMembershipIds.includes(m.id)} onChange={() => toggleMembership(m.id)} />
                    {m.name}
                  </label>
                ))}
              </div>
            )}
            {allowedMembershipIds.length > 0 && (
              <p className="text-[11px] text-text-muted mt-1">
                {allowedMembershipIds.length} membership{allowedMembershipIds.length === 1 ? "" : "s"} selected
              </p>
            )}
          </div>

          {staffList.length > 0 && (
            <div className="border-t border-app-border pt-4">
              <p className="text-xs uppercase tracking-wider text-text-muted mb-3 font-medium">Assigned staff / coaches</p>
              <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                {staffList.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer border border-app-border rounded-lg px-3 py-2">
                    <input type="checkbox" checked={staffUserIds.includes(s.id)} onChange={() => toggleStaff(s.id)} />
                    {s.firstName} {s.lastName}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Visibility & Access */}
          <div className="border-t border-app-border pt-4">
            <p className="text-xs uppercase tracking-wider text-text-muted mb-3 font-medium">Visibility & Access</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Who can see this event?</label>
                <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                  <option value="PUBLIC">Everyone (public)</option>
                  <option value="MEMBERS_ONLY">Active members only</option>
                  <option value="STAFF_ONLY">Staff & owner only</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Who can book/purchase?</label>
                <select value={purchaseAccess} onChange={(e) => setPurchaseAccess(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                  <option value="ANYONE">Members can self-book</option>
                  <option value="STAFF_ONLY">Staff & owner only</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm resize-none" />
          </div>

          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-text-muted hover:text-text-primary">
            {showAdvanced ? "− Hide" : "+ Show"} advanced options
          </button>

          {showAdvanced && (
            <div className="space-y-3 pt-2 border-t border-app-border">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Travel fee</label>
                <input type="number" min="0" step="0.01" value={travelFee} onChange={(e) => setTravelFee(e.target.value)} placeholder="For tournaments / off-site events" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Publish at</label>
                  <input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
                  <p className="text-[10px] text-text-muted mt-1">Hide until this date</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Unpublish at</label>
                  <input type="datetime-local" value={unpublishAt} onChange={(e) => setUnpublishAt(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
                  <p className="text-[10px] text-text-muted mt-1">Hide after this date</p>
                </div>
              </div>
            </div>
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
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
      <div className="bg-surface rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Manage event types</h2>
            <p className="text-xs text-text-muted">Create custom types for your sport (e.g. Game, Match, Scrimmage)</p>
          </div>
          <button onClick={() => { onSaved(); }} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Built-in types */}
          <div>
            <p className="text-xs uppercase tracking-wider text-text-muted mb-2 font-medium">Built-in types</p>
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
            <p className="text-xs uppercase tracking-wider text-text-muted mb-2 font-medium">Your custom types</p>
            {localTypes.length === 0 ? (
              <p className="text-sm text-text-muted">No custom types yet.</p>
            ) : (
              <div className="space-y-1">
                {localTypes.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-app-bg">
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: t.color, color: t.textColor }}>{t.name}</span>
                    <div className="flex-1" />
                    <button onClick={() => deleteType(t.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add new type */}
          <div className="border-t border-app-border pt-4">
            <p className="text-xs uppercase tracking-wider text-text-muted mb-3 font-medium">Add new type</p>
            <div className="space-y-3">
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Type name (e.g. Game, Match, Scrimmage)" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addType())} />
              <div>
                <p className="text-xs text-text-muted mb-2">Badge color:</p>
                <div className="flex flex-wrap gap-2">
                  {COLOR_PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => { setNewColor(p.bg); setNewTextColor(p.fg); }}
                      className={`text-xs px-2.5 py-1 rounded-full font-medium border-2 transition ${newColor === p.bg ? "border-brand" : "border-transparent"}`}
                      style={{ background: p.bg, color: p.fg }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="mt-2">
                  <span className="text-xs text-text-muted mr-2">Preview:</span>
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: newColor, color: newTextColor }}>{newName || "New type"}</span>
                </div>
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
              <button onClick={addType} disabled={!newName.trim() || saving} className="w-full px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
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
// Plain-language banner so the owner always knows whether adding a member
// will charge them, cover them via a membership, bill later, or be free.
function PricingBanner({
  isPaid,
  hasVariableCost,
  variableCostMode,
  acceptedMemberships,
}: {
  isPaid: boolean;
  hasVariableCost: boolean;
  variableCostMode: string | null;
  acceptedMemberships: string[];
}) {
  let tone: "warning" | "primary" | "success" | "muted" = "muted";
  let title = "This event is free";
  let detail = "Members are booked at no charge.";

  if (hasVariableCost) {
    tone = "warning";
    title = "Variable cost — billed later";
    detail =
      variableCostMode === "OFFICIAL"
        ? "Members register now. After the event, send invoices to split the official total across registrants."
        : "Members register now. Send invoices when you're ready, using the estimated split.";
  } else if (acceptedMemberships.length > 0 && isPaid) {
    tone = "primary";
    title = "Covered by selected memberships";
    detail = `Free for members on: ${acceptedMemberships.join(", ")}. Everyone else pays.`;
  } else if (acceptedMemberships.length > 0) {
    tone = "primary";
    title = "Covered by selected memberships";
    detail = `Free for members on: ${acceptedMemberships.join(", ")}.`;
  } else if (isPaid) {
    tone = "warning";
    title = "This event requires payment";
    detail = "Adding a member sends them a checkout link (unless a selected membership covers it).";
  }

  const toneStyles: Record<string, string> = {
    warning: "bg-orange-accent/10 border-orange-accent/30 text-text-primary",
    primary: "bg-brand/10 border-brand/30 text-text-primary",
    success: "bg-lime-accent/10 border-lime-accent/30 text-text-primary",
    muted: "bg-app-bg border-app-border text-text-primary",
  };

  return (
    <div className={`mb-4 rounded-lg border px-3 py-2.5 ${toneStyles[tone]}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-text-muted mt-0.5">{detail}</p>
    </div>
  );
}

function BookingsModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [event, setEvent] = useState<any>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [allMemberships, setAllMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMember, setSelectedMember] = useState("");
  const [pricingType, setPricingType] = useState<"MEMBER" | "NON_MEMBER" | "DROP_IN">("MEMBER");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    const [eRes, mRes, mpRes] = await Promise.all([
      fetch(`/api/events/${eventId}`),
      fetch("/api/members"),
      fetch("/api/memberships"),
    ]);
    if (eRes.ok) setEvent(await eRes.json());
    if (mRes.ok) setMembers(await mRes.json());
    if (mpRes.ok) setAllMemberships(await mpRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, [eventId]);

  const isPaid = !!(event?.memberPrice || event?.nonMemberPrice || event?.dropInFee);
  const varTotalNum =
    event?.variableCostTotal != null
      ? Number(event.variableCostTotal)
      : event?.variableCostEstimatedTotal != null
        ? Number(event.variableCostEstimatedTotal)
        : 0;
  const hasVariableCost = !!event?.variableCostEnabled && varTotalNum > 0;

  async function handleAdd() {
    if (!selectedMember) return;
    setError("");
    setAdding(true);
    if (isPaid || hasVariableCost) {
      const res = await fetch(`/api/events/${eventId}/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: selectedMember, pricingType }),
      });
      const data = await res.json();
      setAdding(false);
      if (!res.ok) { setError(data.error?.toString() || "Failed to start checkout"); return; }
      if (data.coveredByMembership || data.variableCost) {
        setSelectedMember("");
        load();
        return;
      }
      if (!data.url) { setError("Failed to start checkout"); return; }
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
  const acceptedMembershipIds: string[] = ((event?.pricingOptions as any[]) || [])
    .filter((p) => p?.type === "membership" && p.membershipId)
    .map((p) => p.membershipId);
  const acceptedMemberships = allMemberships.filter((m) => acceptedMembershipIds.includes(m.id));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Bookings · {totalBookings}{event?.capacity && `/${event.capacity}`}</h2>
            {event && <p className="text-xs text-text-muted">{event.name}</p>}
            {acceptedMemberships.length > 0 && (
              <p className="text-[11px] text-text-muted mt-1">
                <span className="font-medium text-text-primary">Accepted memberships:</span>{" "}
                {acceptedMemberships.map((m) => m.name).join(", ")}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="text-center text-sm text-text-muted py-4">Loading…</div>
          ) : (
            <>
              <PricingBanner
                isPaid={isPaid}
                hasVariableCost={hasVariableCost}
                variableCostMode={event?.variableCostMode ?? null}
                acceptedMemberships={acceptedMemberships.map((m) => m.name)}
              />
              <div className="mb-4 space-y-2">
                <label className="block text-sm font-medium text-text-primary">Add member</label>
                <select value={selectedMember} onChange={(e) => setSelectedMember(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                  <option value="">Select a member…</option>
                  {availableMembers.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
                </select>
                {isPaid && (
                  <select value={pricingType} onChange={(e) => setPricingType(e.target.value as any)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                    {event?.memberPrice && <option value="MEMBER">Member price — ${Number(event.memberPrice).toFixed(2)}</option>}
                    {event?.nonMemberPrice && <option value="NON_MEMBER">Non-member — ${Number(event.nonMemberPrice).toFixed(2)}</option>}
                    {event?.dropInFee && <option value="DROP_IN">Drop-in — ${Number(event.dropInFee).toFixed(2)}</option>}
                  </select>
                )}
                <button onClick={handleAdd} disabled={!selectedMember || adding} className="w-full px-3 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {adding
                    ? "Processing…"
                    : hasVariableCost
                      ? "Register (invoice later)"
                      : isPaid
                        ? "Send checkout link"
                        : "Book (free)"}
                </button>
                {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>}
              </div>
              {totalBookings === 0 ? (
                <div className="text-sm text-text-muted text-center py-6">No bookings yet.</div>
              ) : (
                <div className="space-y-1">
                  {event?.bookings?.map((b: any) => (
                    <div key={b.id} className="flex items-center justify-between py-2 px-3 rounded hover:bg-app-bg">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-app-border flex items-center justify-center text-[10px] font-medium text-text-primary">
                          {b.member.firstName[0]}{b.member.lastName[0]}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-text-primary">{b.member.firstName} {b.member.lastName}</div>
                          <div className="text-[10px]" style={{ color: b.status === "WAITLISTED" ? "var(--color-warning)" : "var(--color-text)" }}>
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

// ── Registrations Modal ──────────────────────────────────────────────────────
type RegistrationRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  amountDue: number | null;
  amountPaid: number | null;
  paymentUrl: string | null;
  invoicedAt: string | null;
  invoiceCount: number;
  formResponses: Record<string, string | boolean>;
  createdAt: string;
  member: { id: string; firstName: string; lastName: string } | null;
};
type RegFormField = { id: string; label: string };

type RegistrationsData = {
  event: {
    name: string;
    publicSlug: string | null;
    registrationForm: RegFormField[] | null;
    variableCostEnabled: boolean;
    variableCostMode: string | null;
    variableCostTotal: number | null;
    variableCostEstimatedTotal: number | null;
    variableCostEstimatedSignups: number | null;
    variableCostBilledAt: string | null;
  };
  registrations: RegistrationRow[];
  activeCount: number;
  unpaidCount: number;
  invoicedCount: number;
  mode: "ESTIMATED" | "OFFICIAL";
  perHead: number | null;
};

function RegistrationsModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<RegistrationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function load() {
    setLoading(true);
    fetch(`/api/events/${eventId}/registrations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); setSelected(new Set()); });
  }
  useEffect(() => { load(); }, [eventId]);

  async function invoice(opts: { force?: boolean; registrationIds?: string[] }) {
    setBilling(true);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/bill-registrants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    const d = await res.json().catch(() => ({}));
    setBilling(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not send invoices."); return; }
    const parts = [`Invoiced ${d.billed} registrant(s) at $${Number(d.perHead).toFixed(2)} each`];
    if (d.skipped) parts.push(`${d.skipped} already paid`);
    if (d.errors?.length) parts.push(`${d.errors.length} failed`);
    setMsg(parts.join(" · ") + ".");
    load();
  }

  const ev = data?.event;
  const customFields = ev?.registrationForm ?? [];
  const isVariable = !!ev?.variableCostEnabled;
  const mode = data?.mode ?? "ESTIMATED";

  const selectableIds = (data?.registrations ?? [])
    .filter((r) => r.status !== "PAID" && r.status !== "CANCELED")
    .map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Registrations</h2>
            {ev && <p className="text-xs text-text-muted">{ev.name}{ev.publicSlug ? ` · /e/${ev.publicSlug}` : ""}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading || !data ? (
            <p className="text-sm text-text-muted text-center py-8">Loading…</p>
          ) : (
            <>
              {isVariable && (
                <div className="bg-app-bg border border-app-border rounded-lg p-4 mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm text-text-primary font-semibold">
                      Mass invoice · {mode === "OFFICIAL" ? "Official split (after event)" : "Estimated split (bill when ready)"}
                    </p>
                    <span className="text-[11px] text-text-muted">
                      {data.activeCount} active · {data.unpaidCount} unpaid · {data.invoicedCount} invoiced
                    </span>
                  </div>
                  <p className="text-xs text-text-muted mb-3">
                    {data.perHead != null
                      ? `Each registrant owes about $${data.perHead.toFixed(2)} ${
                          mode === "OFFICIAL"
                            ? `(official total ÷ ${data.activeCount} active)`
                            : ev?.variableCostEstimatedSignups
                              ? `(estimated total ÷ ${ev.variableCostEstimatedSignups} expected)`
                              : `(estimated total ÷ ${data.activeCount} active)`
                        }.`
                      : mode === "OFFICIAL"
                        ? "Set the official total cost on the event before sending invoices."
                        : "Set an estimated total cost on the event before sending invoices."}
                    {ev?.variableCostBilledAt ? ` Last batch sent ${new Date(ev.variableCostBilledAt).toLocaleString()}.` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => invoice({})}
                      disabled={billing || data.perHead == null}
                      className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {billing ? "Sending…" : "Invoice all unpaid"}
                    </button>
                    <button
                      onClick={() => invoice({ registrationIds: [...selected] })}
                      disabled={billing || data.perHead == null || selected.size === 0}
                      className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface disabled:opacity-50"
                    >
                      Invoice selected ({selected.size})
                    </button>
                    <button
                      onClick={() => invoice({ force: true })}
                      disabled={billing || data.perHead == null || data.unpaidCount === 0}
                      className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface disabled:opacity-50"
                    >
                      Re-send to all unpaid
                    </button>
                  </div>
                  {msg && <p className="text-xs text-text-primary mt-2 bg-lime-accent/15 border border-lime-accent/30 rounded px-2 py-1">{msg}</p>}
                  {err && <p className="text-xs text-red-700 mt-2 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</p>}
                </div>
              )}

              {data.registrations.length === 0 ? (
                <p className="text-sm text-text-muted text-center py-8">No registrations yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-app-border">
                        {isVariable && (
                          <th className="pb-2 font-medium w-8">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={toggleAll}
                              disabled={selectableIds.length === 0}
                              aria-label="Select all unpaid"
                            />
                          </th>
                        )}
                        <th className="pb-2 font-medium">Name</th>
                        <th className="pb-2 font-medium">Contact</th>
                        {customFields.map((f) => <th key={f.id} className="pb-2 font-medium">{f.label}</th>)}
                        <th className="pb-2 font-medium">Invoice</th>
                        <th className="pb-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.registrations.map((r) => {
                        const selectable = r.status !== "PAID" && r.status !== "CANCELED";
                        return (
                          <tr key={r.id} className="border-b border-app-border last:border-0 align-top">
                            {isVariable && (
                              <td className="py-2.5">
                                {selectable && (
                                  <input
                                    type="checkbox"
                                    checked={selected.has(r.id)}
                                    onChange={() => toggle(r.id)}
                                    aria-label={`Select ${r.name}`}
                                  />
                                )}
                              </td>
                            )}
                            <td className="py-2.5">
                              <p className="text-text-primary font-medium">{r.name}</p>
                              {r.member && <p className="text-[10px] text-brand">Member</p>}
                            </td>
                            <td className="py-2.5 text-text-muted text-xs">
                              <p>{r.email}</p>
                              {r.phone && <p>{r.phone}</p>}
                            </td>
                            {customFields.map((f) => (
                              <td key={f.id} className="py-2.5 text-text-primary text-xs">
                                {typeof r.formResponses?.[f.id] === "boolean"
                                  ? (r.formResponses[f.id] ? "Yes" : "No")
                                  : (r.formResponses?.[f.id] as string) || "—"}
                              </td>
                            ))}
                            <td className="py-2.5 text-xs">
                              {r.invoiceCount > 0 ? (
                                <span className="text-text-muted">
                                  Sent {r.invoicedAt ? new Date(r.invoicedAt).toLocaleDateString() : ""}
                                  {r.invoiceCount > 1 ? ` · ${r.invoiceCount}×` : ""}
                                </span>
                              ) : (
                                <span className="text-text-muted">Not invoiced</span>
                              )}
                              {r.paymentUrl && r.status !== "PAID" && (
                                <a href={r.paymentUrl} target="_blank" rel="noreferrer" className="block text-[10px] text-brand hover:underline mt-1">Payment link</a>
                              )}
                            </td>
                            <td className="py-2.5">
                              {r.status === "PAID" ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-lime-accent/20 text-text-primary font-medium">Paid{r.amountPaid ? ` $${Number(r.amountPaid).toFixed(2)}` : ""}</span>
                              ) : r.status === "CANCELED" ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted">Canceled</span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-accent/15 text-text-primary font-medium">
                                  {r.amountDue ? `Owes $${Number(r.amountDue).toFixed(2)}` : "Registered"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
