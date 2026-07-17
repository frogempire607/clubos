"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Clock, MapPin, Users as UsersIcon, MoreVertical, X } from "lucide-react";
import StripeRequiredBanner from "@/components/StripeRequiredBanner";
import ImageUpload from "@/components/ImageUpload";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";
import EventExpenseEditor from "@/components/EventExpenseEditor";

type BuiltInType = "CLASS" | "PRIVATE" | "CLINIC" | "CAMP" | "TOURNAMENT" | "OTHER";

// Reserved registrationForm field id for a tournament's participant category
// (weight class, position, division, belt level…). Storing it inline in
// registrationForm reuses the existing render/validate/store/report pipeline —
// it shows on the signup page, is validated server-side, saved to
// formResponses, and listed in Registrations — with no extra column.
const PARTICIPANT_FIELD_ID = "participant_category";

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
  paymentMethods?: string[] | null;
  autoChargeDate?: string | null;
  requirePaymentBeforeCheckin?: boolean;
};

type Member = { id: string; firstName: string; lastName: string };
type Membership = { id: string; name: string; active: boolean };
type Staff = { id: string; firstName: string; lastName: string };

const BUILT_IN_COLORS: Record<BuiltInType, { bg: string; fg: string }> = {
  CLASS: { bg: "var(--color-primary)", fg: "#fff" },
  PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
  CLINIC: { bg: "var(--color-success)", fg: "#1F1F23" },
  CAMP: { bg: "var(--color-warning)", fg: "#fff" },
  TOURNAMENT: { bg: "var(--color-warning)", fg: "#fff" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};
const BUILT_IN_LABELS: Record<BuiltInType, string> = {
  CLASS: "Class", PRIVATE: "Private", CLINIC: "Clinic", CAMP: "Camp", TOURNAMENT: "Tournament", OTHER: "Other",
};

type BuiltInOverrides = Partial<Record<BuiltInType, { bg: string; fg: string }>> | null;

function getTypeDisplay(
  e: Event,
  overrides?: BuiltInOverrides,
): { name: string; bg: string; fg: string } {
  if (e.customEventType) {
    return { name: e.customEventType.name, bg: e.customEventType.color, fg: e.customEventType.textColor };
  }
  // Owner-set override (Manage Event Types → Built-in colors) wins over
  // the hardcoded defaults.
  const o = overrides?.[e.type];
  const c = o ?? BUILT_IN_COLORS[e.type] ?? BUILT_IN_COLORS.OTHER;
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
  const [viewingComp, setViewingComp] = useState<string | null>(null);
  const [viewingDocs, setViewingDocs] = useState<string | null>(null);
  const [showManageTypes, setShowManageTypes] = useState(false);
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
  const [builtInOverrides, setBuiltInOverrides] = useState<BuiltInOverrides>(null);
  const [clubMeta, setClubMeta] = useState<{ name: string; slug: string } | null>(null);
  const [actionMenuFor, setActionMenuFor] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState<string | null>(null);
  const router = useRouter();

  async function openEventChat(eventId: string) {
    setChatBusy(eventId);
    const res = await fetch(`/api/events/${eventId}/chat`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setChatBusy(null);
    if (!res.ok || !d.groupId) {
      alert(d.error || "Couldn't open the event chat.");
      return;
    }
    router.push(`/dashboard/messages?group=${d.groupId}`);
  }

  async function load() {
    setLoading(true);
    const [eRes, tRes, mRes, sRes, cRes] = await Promise.all([
      fetch("/api/events"),
      fetch("/api/events/types"),
      fetch("/api/memberships"),
      fetch("/api/staff?includeOwners=true"),
      fetch("/api/club/info"),
    ]);
    if (eRes.ok) setEvents(await eRes.json());
    if (tRes.ok) setClubEventTypes(await tRes.json());
    if (mRes.ok) setMemberships((await mRes.json()).filter((m: Membership) => m.active));
    if (sRes.ok) setStaffList(await sRes.json());
    if (cRes.ok) {
      const c = await cRes.json();
      setBuiltInOverrides((c.builtInEventColors as BuiltInOverrides) ?? null);
      setClubMeta({ name: c.name, slug: c.slug });
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Deep links from other surfaces:
  //   ?event=<id> — opens that event's bookings/check-in (attendance QR).
  //   ?edit=<id>  — opens that event's edit modal (calendar day detail).
  useEffect(() => {
    if (loading || events.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get("event");
    if (eventId && events.some((e) => e.id === eventId)) {
      setViewingBookings(eventId);
    }
    const editId = params.get("edit");
    if (editId) {
      const ev = events.find((e) => e.id === editId);
      if (ev) setEditing(ev);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const now = new Date();
  const filtered = events.filter((e) => {
    const end = new Date(e.endsAt);
    if (filter === "upcoming") return end >= now;
    if (filter === "past") return end < now;
    return true;
  });

  async function handleDelete(id: string) {
    if (!confirm("Delete this event? Bookings will be canceled.")) return;
    const res = await fetch(`/api/events/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function handleDuplicate(id: string) {
    const res = await fetch(`/api/events/${id}/duplicate`, { method: "POST" });
    if (res.ok) load();
    else alert("Could not duplicate this event.");
  }

  function getPublishStatus(e: Event): { label: string; bg: string; fg: string } | null {
    const now = new Date();
    if (e.publishAt && new Date(e.publishAt) > now) return { label: "Scheduled", bg: "var(--color-warning)", fg: "#fff" };
    if (e.unpublishAt && new Date(e.unpublishAt) < now) return { label: "Unpublished", bg: "var(--color-bg)", fg: "var(--color-muted)" };
    return null;
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      <StripeRequiredBanner feature="charge for events" />

      <PageHeader
        title="Events"
        description="Classes, privates, clinics, camps, tournaments"
        actions={
          <>
            <a href="/dashboard/events/bundles" className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
              Bundles
            </a>
            <button onClick={() => setShowManageTypes(true)} className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
              Manage event types
            </button>
            <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
              + Add event
            </button>
          </>
        }
      />

      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-4 w-fit">
        {(["upcoming", "past", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`text-xs px-3 py-1.5 rounded-md transition ${filter === f ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonList rows={5} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<CalendarRange size={26} strokeWidth={1.75} />}
          title="No events"
          description={filter === "upcoming" ? "No upcoming events scheduled." : "Nothing to show here."}
          action={{ label: "Schedule your first event", onClick: () => setShowAdd(true) }}
          className="bg-surface rounded-xl border border-app-border"
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => {
            const td = getTypeDisplay(e, builtInOverrides);
            const start = new Date(e.startsAt);
            const end = new Date(e.endsAt);
            const isFull = !!(e.capacity && e._count.bookings >= e.capacity);
            const pubStatus = getPublishStatus(e);
            const pricing = getPricingBadge(e, memberships);
            const acceptedMemberships = (e.pricingOptions || [])
              .map((p) => memberships.find((m) => m.id === p.membershipId)?.name)
              .filter(Boolean) as string[];
            const capacityPct =
              e.capacity && e.capacity > 0
                ? Math.min(100, Math.round((e._count.bookings / e.capacity) * 100))
                : null;
            return (
              <div
                key={e.id}
                className="group bg-surface rounded-xl border border-app-border overflow-hidden hover:shadow-md hover:border-app-border transition relative"
                style={{ borderLeft: `4px solid ${td.bg}` }}
              >
                <div className="flex items-start gap-3 sm:gap-4 p-4">
                  {/* Date pill — jersey-number style */}
                  <div className="w-14 sm:w-16 text-center bg-app-bg rounded-lg py-2 flex-shrink-0">
                    <div className="text-[10px] uppercase font-semibold text-text-muted tracking-wider">
                      {start.toLocaleString("en-US", { month: "short" })}
                    </div>
                    <div className="text-2xl font-bold text-text-primary leading-tight tabular-nums">
                      {start.getDate()}
                    </div>
                    <div className="text-[10px] uppercase font-medium text-text-muted tracking-wider mt-0.5">
                      {start.toLocaleString("en-US", { weekday: "short" })}
                    </div>
                  </div>

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base sm:text-lg font-semibold text-text-primary leading-snug line-clamp-2 mb-1.5">
                      {e.name}
                    </h3>

                    {/* Time + location — primary meta line */}
                    <div className="text-xs sm:text-[13px] text-text-muted flex items-center flex-wrap gap-x-3 gap-y-1 mb-2">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={12} strokeWidth={2} className="text-text-muted flex-shrink-0" />
                        <span className="tabular-nums">
                          {start.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}
                          {" – "}
                          {end.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </span>
                      </span>
                      {e.location && (
                        <span className="inline-flex items-center gap-1 min-w-0">
                          <MapPin size={12} strokeWidth={2} className="flex-shrink-0" />
                          <span className="truncate">{e.location.name}</span>
                        </span>
                      )}
                      {e.staffAssignments && e.staffAssignments.length > 0 && (
                        <span className="inline-flex items-center gap-1 min-w-0">
                          <UsersIcon size={12} strokeWidth={2} className="flex-shrink-0" />
                          <span className="truncate">
                            {e.staffAssignments.map((a) => `${a.user.firstName} ${a.user.lastName}`).join(", ")}
                          </span>
                        </span>
                      )}
                      {e.sessions.length > 1 && (
                        <span className="text-text-muted">{e.sessions.length} sessions</span>
                      )}
                    </div>

                    {/* Pricing line */}
                    {(e.memberPrice != null || e.nonMemberPrice != null || e.dropInFee != null || acceptedMemberships.length > 0) && (
                      <div className="text-[11px] text-text-muted flex items-center flex-wrap gap-x-2 gap-y-1 mb-2">
                        {e.memberPrice != null && <span>Member ${Number(e.memberPrice).toFixed(2)}</span>}
                        {e.nonMemberPrice != null && <span>· Non-mem ${Number(e.nonMemberPrice).toFixed(2)}</span>}
                        {e.dropInFee != null && <span>· Drop-in ${Number(e.dropInFee).toFixed(2)}</span>}
                        {acceptedMemberships.length > 0 && (
                          <span>· {acceptedMemberships.join(" · ")} accepted</span>
                        )}
                      </div>
                    )}

                    {/* Capacity bar — athletic energy when full */}
                    {capacityPct !== null && (
                      <div className="mb-2">
                        <div className="flex items-center justify-between mb-1 text-[11px] text-text-muted">
                          <span>Capacity</span>
                          <span className="tabular-nums font-medium">
                            {e._count.bookings}/{e.capacity}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-app-bg overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${capacityPct}%`,
                              background: isFull
                                ? "#FF6A00"
                                : capacityPct >= 80
                                ? "#FF6A00"
                                : "#A3E635",
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Status pills */}
                    <div className="flex flex-wrap gap-1.5">
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide"
                        style={{ background: td.bg, color: td.fg }}
                      >
                        {td.name}
                      </span>
                      {pubStatus && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide"
                          style={{ background: pubStatus.bg, color: pubStatus.fg }}
                        >
                          {pubStatus.label}
                        </span>
                      )}
                      {isFull && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide bg-[#FF6A00] text-white">
                          Full
                        </span>
                      )}
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide"
                        style={{ background: pricing.bg, color: pricing.fg }}
                      >
                        {pricing.label}
                      </span>
                      {e.visibility === "MEMBERS_ONLY" && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted font-medium">
                          Members only
                        </span>
                      )}
                      {e.visibility === "STAFF_ONLY" && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand text-white font-medium">
                          Staff only
                        </span>
                      )}
                      {e.purchaseAccess === "STAFF_ONLY" && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-app-border text-text-muted font-medium">
                          Staff books
                        </span>
                      )}
                    </div>

                    {/* Sub-session list (only if multi-session) */}
                    {e.sessions.length > 1 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {e.sessions.map((s, i) => (
                          <span
                            key={i}
                            className="text-[10px] px-2 py-0.5 rounded bg-app-bg border border-app-border text-text-muted tabular-nums"
                          >
                            {s.name || `Session ${i + 1}`}: {new Date(s.startsAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}–
                            {new Date(s.endsAt).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Actions: desktop button row */}
                  <div className="hidden sm:flex gap-1 flex-shrink-0">
                    {(e.publicRegistration || e.tournamentMode === "HOST" || (e._count.registrations ?? 0) > 0) && (
                      <button
                        onClick={() => setViewingRegistrations(e.id)}
                        className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                      >
                        Registrations{(e._count.registrations ?? 0) > 0 ? ` (${e._count.registrations})` : ""}
                      </button>
                    )}
                    <button
                      onClick={() => setViewingComp(e.id)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Payroll
                    </button>
                    <button
                      onClick={() => setViewingDocs(e.id)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Documents
                    </button>
                    <button
                      onClick={() => setViewingBookings(e.id)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Bookings
                    </button>
                    <button
                      onClick={() => openEventChat(e.id)}
                      disabled={chatBusy === e.id}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg disabled:opacity-50"
                    >
                      {chatBusy === e.id ? "Opening…" : "Group chat"}
                    </button>
                    <button
                      onClick={() => setEditing(e)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDuplicate(e.id)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() => handleDelete(e.id)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded"
                    >
                      Delete
                    </button>
                  </div>

                  {/* Actions: mobile kebab — opens bottom sheet below */}
                  <button
                    type="button"
                    onClick={() => setActionMenuFor(e.id)}
                    aria-label="Actions"
                    className="sm:hidden flex-shrink-0 w-9 h-9 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted"
                  >
                    <MoreVertical size={18} strokeWidth={2} />
                  </button>
                </div>

                {/* Mobile action sheet */}
                {actionMenuFor === e.id && (
                  <div
                    className="sm:hidden fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
                    onClick={() => setActionMenuFor(null)}
                  >
                    <div
                      className="w-full bg-surface rounded-t-2xl p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-2xl"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border mb-1">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-text-primary truncate">{e.name}</div>
                          <div className="text-[11px] text-text-muted tabular-nums">
                            {start.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setActionMenuFor(null)}
                          aria-label="Close menu"
                          className="text-text-muted hover:text-text-primary w-8 h-8 rounded-lg hover:bg-app-bg flex items-center justify-center"
                        >
                          <X size={18} strokeWidth={2} />
                        </button>
                      </div>
                      {(e.publicRegistration || e.tournamentMode === "HOST" || (e._count.registrations ?? 0) > 0) && (
                        <button
                          onClick={() => { setActionMenuFor(null); setViewingRegistrations(e.id); }}
                          className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                        >
                          Registrations{(e._count.registrations ?? 0) > 0 ? ` (${e._count.registrations})` : ""}
                        </button>
                      )}
                      <button
                        onClick={() => { setActionMenuFor(null); setViewingComp(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Payroll
                      </button>
                      <button
                        onClick={() => { setActionMenuFor(null); setViewingDocs(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Documents
                      </button>
                      <button
                        onClick={() => { setActionMenuFor(null); setViewingBookings(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Bookings
                      </button>
                      <button
                        onClick={() => { setActionMenuFor(null); openEventChat(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Group chat
                      </button>
                      <button
                        onClick={() => { setActionMenuFor(null); setEditing(e); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => { setActionMenuFor(null); handleDuplicate(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={() => { setActionMenuFor(null); handleDelete(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
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
      {viewingComp && <EventCompModal eventId={viewingComp} onClose={() => setViewingComp(null)} />}
      {viewingDocs && <EventDocsModal eventId={viewingDocs} onClose={() => setViewingDocs(null)} />}

      {showManageTypes && clubMeta && (
        <ManageTypesModal
          types={clubEventTypes}
          builtInOverrides={builtInOverrides}
          clubName={clubMeta.name}
          clubSlug={clubMeta.slug}
          onClose={() => setShowManageTypes(false)}
          onSaved={() => { setShowManageTypes(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Event Modal ──────────────────────────────────────────────────────────────
// Expanded palette so owners have real visual differentiation across
// event types. Kept in sync with classes page CLASS_COLOR_PRESETS.
const COLOR_PRESETS = [
  { name: "Violet",   bg: "#6D5DF6", fg: "#ffffff" },
  { name: "Indigo",   bg: "#4F46E5", fg: "#ffffff" },
  { name: "Blue",     bg: "#2563EB", fg: "#ffffff" },
  { name: "Teal",     bg: "#0D9488", fg: "#ffffff" },
  { name: "Lime",     bg: "#A3E635", fg: "#1F1F23" },
  { name: "Yellow",   bg: "#F59E0B", fg: "#1F1F23" },
  { name: "Orange",   bg: "#FF6A00", fg: "#ffffff" },
  { name: "Red",      bg: "#DC2626", fg: "#ffffff" },
  { name: "Pink",     bg: "#DB2777", fg: "#ffffff" },
  { name: "Slate",    bg: "#475569", fg: "#ffffff" },
  { name: "Charcoal", bg: "#1F1F23", fg: "#ffffff" },
  { name: "Neutral",  bg: "#F7F7F9", fg: "#6B7280" },
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
    : (event?.type && event.type !== "CLASS" && event.type !== "PRIVATE" ? event.type : "OTHER");

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
  // Focal point on the uploaded image, in 0–100 percent of width/height.
  // Persisted to Event.imagePositionX/Y and read by /e/[slug] via CSS
  // object-position so the public page crops around what the owner picked.
  const [imagePositionX, setImagePositionX] = useState<number>(
    typeof (event as unknown as { imagePositionX?: number } | null)?.imagePositionX === "number"
      ? (event as unknown as { imagePositionX: number }).imagePositionX
      : 50,
  );
  const [imagePositionY, setImagePositionY] = useState<number>(
    typeof (event as unknown as { imagePositionY?: number } | null)?.imagePositionY === "number"
      ? (event as unknown as { imagePositionY: number }).imagePositionY
      : 50,
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Tournament + public-registration state
  const ev = event as any;
  const [tournamentMode, setTournamentMode] = useState<string>(ev?.tournamentMode || "");
  const [publicRegistration, setPublicRegistration] = useState<boolean>(!!ev?.publicRegistration);
  const [publicFormIntro, setPublicFormIntro] = useState<string>(ev?.publicFormIntro || "");
  const [publicPricingOption, setPublicPricingOption] = useState<string>(
    (ev as { publicPricingOption?: string | null } | null)?.publicPricingOption || "",
  );
  // Split the reserved participant-category field out of the generic field list
  // so it gets its own first-class editor below and isn't shown/edited twice.
  const initialForm: FormFieldDef[] = Array.isArray(ev?.registrationForm) ? ev.registrationForm : [];
  const initialParticipant = initialForm.find((f) => f.id === PARTICIPANT_FIELD_ID);
  const [formFields, setFormFields] = useState<FormFieldDef[]>(
    initialForm.filter((f) => f.id !== PARTICIPANT_FIELD_ID)
  );
  const [participantLabel, setParticipantLabel] = useState<string>(initialParticipant?.label || "");
  const [participantOptions, setParticipantOptions] = useState<string>(
    (initialParticipant?.options || []).join("\n")
  );
  const [participantRequired, setParticipantRequired] = useState<boolean>(
    initialParticipant?.required ?? true
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
  const [invoiceScheduledAt, setInvoiceScheduledAt] = useState<string>(
    ev?.invoiceScheduledAt ? new Date(ev.invoiceScheduledAt).toISOString().slice(0, 10) : ""
  );
  // How registrants may pay. Existing events with nothing stored keep the old
  // behavior (card at registration).
  const [payMethods, setPayMethods] = useState<string[]>(
    Array.isArray(ev?.paymentMethods) && ev.paymentMethods.length > 0 ? ev.paymentMethods : ["CARD"]
  );
  const [autoChargeDate, setAutoChargeDate] = useState<string>(
    ev?.autoChargeDate ? new Date(ev.autoChargeDate).toISOString().slice(0, 10) : ""
  );
  const [requirePaymentBeforeCheckin, setRequirePaymentBeforeCheckin] = useState<boolean>(
    !!ev?.requirePaymentBeforeCheckin
  );
  const togglePayMethod = (m: string) =>
    setPayMethods((prev) => {
      const next = prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m];
      // At least one method must stay on — otherwise nobody could register.
      return next.length > 0 ? next : prev;
    });

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
        imagePositionX,
        imagePositionY,
        tournamentMode: type === "TOURNAMENT" ? (tournamentMode || null) : null,
        publicRegistration,
        publicFormIntro: publicFormIntro || null,
        publicPricingOption: publicPricingOption || null,
        registrationForm: [
          // Reserved participant-category field first (tournaments only).
          ...(type === "TOURNAMENT" && participantLabel.trim()
            ? [{
                id: PARTICIPANT_FIELD_ID,
                label: participantLabel.trim(),
                type: "select" as const,
                required: participantRequired,
                options: participantOptions
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }]
            : []),
          ...formFields
            .filter((f) => f.label.trim() && f.id !== PARTICIPANT_FIELD_ID)
            .map((f) => ({ ...f, label: f.label.trim() })),
        ],
        // Shared-cost / estimated-vs-official invoicing is available for any
        // event type (clinic, camp, host/attend tournament, other). For
        // tournaments only the ATTEND mode uses it.
        variableCostEnabled: (type !== "TOURNAMENT" || tournamentMode === "ATTEND") ? varCostEnabled : false,
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
        invoiceScheduledAt:
          (type !== "TOURNAMENT" || tournamentMode === "ATTEND") && varCostEnabled && invoiceScheduledAt
            ? new Date(invoiceScheduledAt).toISOString()
            : null,
        paymentMethods: payMethods,
        // Date-only input → noon UTC keeps the intended calendar day in every
        // US timezone (the same trap the billing-date rendering hit).
        autoChargeDate:
          payMethods.includes("AUTO_CARD") && autoChargeDate
            ? new Date(`${autoChargeDate}T12:00:00Z`).toISOString()
            : null,
        requirePaymentBeforeCheckin,
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
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

          {imageUrl && (
            <EventImageFocalPicker
              imageUrl={imageUrl}
              x={imagePositionX}
              y={imagePositionY}
              onChange={(nx, ny) => { setImagePositionX(nx); setImagePositionY(ny); }}
            />
          )}

          {/* Event type */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Event type</label>
            <select value={typeKey} onChange={(e) => setTypeKey(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
              <optgroup label="Built-in types">
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

              {/* Participant category — flexible per sport (weight class / position / division…) */}
              <div className="border-t border-app-border pt-3 space-y-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">Participant category</p>
                  <p className="text-[11px] text-text-muted">
                    What does each entrant choose at signup? Use your sport&apos;s term —
                    e.g. <span className="font-medium">Weight Class</span> (wrestling, judo, MMA),{" "}
                    <span className="font-medium">Position</span> (team sports),{" "}
                    <span className="font-medium">Division</span>,{" "}
                    <span className="font-medium">Age Group</span>, or{" "}
                    <span className="font-medium">Belt Level</span>. Leave blank to skip.
                  </p>
                </div>
                <input
                  type="text"
                  value={participantLabel}
                  onChange={(e) => setParticipantLabel(e.target.value)}
                  placeholder="e.g. Weight Class, Position, Division"
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
                />
                {participantLabel.trim() && (
                  <>
                    <textarea
                      value={participantOptions}
                      onChange={(e) => setParticipantOptions(e.target.value)}
                      rows={4}
                      placeholder={"One option per line, e.g.\n106 lb\n113 lb\n120 lb"}
                      className="w-full px-3 py-2 border border-app-border rounded-lg text-sm font-mono"
                    />
                    <p className="text-[10px] text-text-muted">
                      One option per line. Entrants pick one when they register, and it appears on every registration.
                    </p>
                    <label className="flex items-center gap-2 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        checked={participantRequired}
                        onChange={(e) => setParticipantRequired(e.target.checked)}
                        className="w-3.5 h-3.5 accent-stone-900"
                      />
                      Require entrants to choose a {participantLabel.trim().toLowerCase() || "category"}
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Shared cost & invoicing — available for any event type. For ATTEND
              tournaments it's the "split a trip cost" case; for clinics, camps,
              host tournaments & other events it lets you collect signups now and
              post an estimated or official invoice later. */}
          {(!isTournament || tournamentMode === "ATTEND") && (
            <div className="border border-app-border rounded-lg p-4 space-y-3 bg-app-bg/40">
              <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Shared cost &amp; invoicing</p>
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

                      {/* Send-invoice date + itemized expense breakdown (P1) */}
                      <div className="border-t border-app-border pt-3 space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">
                            Send invoices on (optional)
                          </label>
                          <input
                            type="date"
                            value={invoiceScheduledAt}
                            onChange={(e) => setInvoiceScheduledAt(e.target.value)}
                            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
                          />
                          <p className="text-[11px] text-text-muted mt-1">
                            Leave blank to invoice whenever you choose. If set, a reminder appears in
                            your dashboard Action Center on/after this date — it never auto-charges.
                          </p>
                        </div>
                        {isEdit && ev?.id ? (
                          <EventExpenseEditor eventId={ev.id} />
                        ) : (
                          <p className="text-[11px] text-text-muted">
                            Save the event first to add an itemized expense breakdown (entry fee,
                            hotel, travel, etc.) that parents see on their invoice.
                          </p>
                        )}
                      </div>
                    </>
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

                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">
                    Which price does the public link charge?
                  </label>
                  <select
                    value={publicPricingOption}
                    onChange={(e) => setPublicPricingOption(e.target.value)}
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white"
                  >
                    <option value="">Auto — Non-member price (default)</option>
                    <option value="NON_MEMBER">Non-member price</option>
                    <option value="MEMBER">Member price</option>
                    <option value="DROP_IN">Drop-in (single session) price</option>
                  </select>
                  <p className="text-[11px] text-text-muted mt-1">
                    Walk-ins from /e/{publicSlug || "[slug]"} get charged this
                    rate. Default is the non-member / full event price.
                  </p>
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
                            <div>
                              <textarea
                                value={(f.options || []).join("\n")}
                                onChange={(e) =>
                                  updateFormField(i, {
                                    // One option per line — keeps commas
                                    // usable inside an option label.
                                    options: e.target.value
                                      .split("\n")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  })
                                }
                                rows={3}
                                placeholder={"One option per line, e.g.\nSmall\nMedium\nLarge"}
                                className="w-full px-2 py-1.5 border border-app-border rounded text-sm font-mono"
                              />
                              <p className="text-[10px] text-text-muted mt-1">
                                One option per line. Commas inside an option (e.g. &quot;Small, fitted&quot;) are kept exactly.
                              </p>
                            </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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

          {/* How registrants may pay */}
          <div className="border-t border-app-border pt-4">
            <p className="text-xs uppercase tracking-wider text-text-muted mb-1 font-medium">
              How registrants may pay
            </p>
            <p className="text-[11px] text-text-muted mb-3">
              Registrants pick one of these when they sign up. Free and
              membership-covered registrations skip this entirely.
            </p>
            <div className="space-y-2">
              {[
                {
                  key: "CARD",
                  label: "Pay now by card",
                  hint: "Charged at registration. The spot is reserved once payment goes through.",
                },
                {
                  key: "AUTO_CARD",
                  label: "Charge saved card on the event date",
                  hint: "Members only, and only with a card already on file. They authorize the charge when they register.",
                },
                { key: "CASH", label: "Pay cash at the event", hint: "Registered now; staff records the cash at check-in." },
                { key: "CHECK", label: "Pay by check at the event", hint: "Registered now; staff records the check at check-in." },
              ].map((m) => (
                <label
                  key={m.key}
                  className="flex items-start gap-2.5 p-2.5 rounded-lg border border-app-border cursor-pointer hover:bg-app-bg"
                >
                  <input
                    type="checkbox"
                    checked={payMethods.includes(m.key)}
                    onChange={() => togglePayMethod(m.key)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-text-primary font-medium">{m.label}</span>
                    <span className="block text-[11px] text-text-muted">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {payMethods.includes("AUTO_CARD") && (
              <div className="mt-3">
                <label className="block text-xs font-medium text-text-primary mb-1">
                  Charge saved cards on
                </label>
                <input
                  type="date"
                  value={autoChargeDate}
                  onChange={(e) => setAutoChargeDate(e.target.value)}
                  className="w-full sm:w-56 px-3 py-2 border border-app-border rounded-lg text-sm"
                />
                <p className="text-[11px] text-text-muted mt-1">
                  Leave blank to charge on the event date.
                </p>
              </div>
            )}

            {(payMethods.includes("CASH") || payMethods.includes("CHECK") || payMethods.includes("AUTO_CARD")) && (
              <label className="flex items-start gap-2.5 mt-3 p-2.5 rounded-lg border border-app-border cursor-pointer hover:bg-app-bg">
                <input
                  type="checkbox"
                  checked={requirePaymentBeforeCheckin}
                  onChange={(e) => setRequirePaymentBeforeCheckin(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-text-primary font-medium">
                    Require payment before check-in
                  </span>
                  <span className="block text-[11px] text-text-muted">
                    Anyone who still owes money can&apos;t check in until staff records their
                    payment. Scheduled card charges count as paid.
                  </span>
                </span>
              </label>
            )}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
function ManageTypesModal({
  types,
  builtInOverrides,
  clubName,
  clubSlug,
  onClose,
  onSaved,
}: {
  types: ClubEventType[];
  builtInOverrides: BuiltInOverrides;
  clubName: string;
  clubSlug: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [localTypes, setLocalTypes] = useState<ClubEventType[]>(types);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLOR_PRESETS[0].bg);
  const [newTextColor, setNewTextColor] = useState(COLOR_PRESETS[0].fg);
  // Local-edited built-in color overrides (saved together to /api/club/update).
  const [overrides, setOverrides] = useState<BuiltInOverrides>(builtInOverrides ?? {});
  const [savingBuiltIns, setSavingBuiltIns] = useState(false);
  const [savedBuiltIns, setSavedBuiltIns] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setOverrideColor(type: BuiltInType, c: { bg: string; fg: string } | null) {
    setOverrides((prev) => {
      const next: BuiltInOverrides = { ...(prev ?? {}) };
      if (c) next[type] = c;
      else delete next[type];
      return next;
    });
  }

  async function saveBuiltInColors() {
    setSavingBuiltIns(true);
    setError("");
    const res = await fetch("/api/club/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // name+slug are required by the schema — pass them through so this
      // section can save its own subset independently.
      body: JSON.stringify({
        name: clubName,
        slug: clubSlug,
        builtInEventColors: overrides ?? null,
      }),
    });
    setSavingBuiltIns(false);
    if (res.ok) {
      setSavedBuiltIns(true);
      setTimeout(() => setSavedBuiltIns(false), 2000);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not save built-in colors");
    }
  }

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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Manage event types</h2>
            <p className="text-xs text-text-muted">Create custom types for your sport (e.g. Game, Match, Scrimmage)</p>
          </div>
          <button onClick={() => { onSaved(); }} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Built-in types — colors are now editable */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Built-in type colors</p>
              <button
                onClick={saveBuiltInColors}
                disabled={savingBuiltIns}
                className="text-xs px-2.5 py-1 rounded-md bg-brand text-white font-medium hover:bg-brand-hover disabled:opacity-50"
              >
                {savingBuiltIns ? "Saving…" : savedBuiltIns ? "Saved ✓" : "Save colors"}
              </button>
            </div>
            <p className="text-[11px] text-text-muted mb-3">
              Click a swatch to assign that color to the built-in type. Custom
              event types you create below override these.
            </p>
            <div className="space-y-2">
              {(Object.entries(BUILT_IN_LABELS) as [BuiltInType, string][]).map(([key, label]) => {
                const active = overrides?.[key] ?? BUILT_IN_COLORS[key];
                return (
                  <div key={key} className="flex items-center gap-2 flex-wrap">
                    <span
                      className="text-xs px-2.5 py-1 rounded-full font-medium min-w-[88px] text-center"
                      style={{ background: active.bg, color: active.fg }}
                    >
                      {label}
                    </span>
                    <div className="flex-1 flex flex-wrap gap-1">
                      {COLOR_PRESETS.map((p) => {
                        const selected = active.bg === p.bg && active.fg === p.fg;
                        return (
                          <button
                            key={p.name}
                            type="button"
                            onClick={() => setOverrideColor(key, { bg: p.bg, fg: p.fg })}
                            title={p.name}
                            className={`w-6 h-6 rounded-md border ${selected ? "ring-2 ring-text-primary border-text-primary" : "border-app-border"}`}
                            style={{ background: p.bg }}
                          />
                        );
                      })}
                      {overrides?.[key] && (
                        <button
                          type="button"
                          onClick={() => setOverrideColor(key, null)}
                          className="text-[10px] px-2 py-1 rounded-md border border-app-border text-text-muted hover:bg-app-bg"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
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
  const [payMethod, setPayMethod] = useState<"STRIPE" | "CASH" | "TERMINAL">("STRIPE");
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
        body: JSON.stringify({ memberId: selectedMember, pricingType, paymentMethod: payMethod }),
      });
      const data = await res.json();
      setAdding(false);
      if (!res.ok) { setError(data.error?.toString() || "Failed to start checkout"); return; }
      // Covered-by-membership, variable-cost (billed later), and cash/terminal
      // (recordedManually) all confirm the booking server-side with no redirect.
      if (data.coveredByMembership || data.variableCost || data.recordedManually) {
        setSelectedMember("");
        setPayMethod("STRIPE");
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
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
            <div className="py-2"><SkeletonList rows={2} /></div>
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
                {isPaid && !hasVariableCost && (
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-text-muted">Payment method</label>
                    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as any)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                      <option value="STRIPE">Online checkout link (Stripe)</option>
                      <option value="CASH">Cash — paid at the door</option>
                      <option value="TERMINAL">Card terminal / in person</option>
                    </select>
                    {payMethod !== "STRIPE" && (
                      <p className="text-[11px] text-text-muted">Confirms the booking now and logs the payment in Financials. No card is charged.</p>
                    )}
                  </div>
                )}
                <button onClick={handleAdd} disabled={!selectedMember || adding} className="w-full px-3 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {adding
                    ? "Processing…"
                    : hasVariableCost
                      ? "Register (invoice later)"
                      : isPaid
                        ? (payMethod === "STRIPE"
                            ? "Send checkout link"
                            : payMethod === "CASH"
                              ? "Record cash & confirm"
                              : "Record terminal & confirm")
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
  stripeCheckoutSessionId: string | null;
  invoicedAt: string | null;
  invoiceCount: number;
  formResponses: Record<string, string | boolean>;
  createdAt: string;
  member: { id: string; firstName: string; lastName: string } | null;
  paymentMethod: string | null;
  scheduledChargeAt: string | null;
  lastChargeError: string | null;
  paidAt: string | null;
  paidVia: string | null;
  checkReference: string | null;
};
type RegFormField = { id: string; label: string };

// Status → how staff should read it. Mirrors lib/eventPayments.ts.
const REG_STATUS_UI: Record<string, { label: string; tone: "paid" | "owed" | "warn" | "muted" }> = {
  PAID: { label: "Paid", tone: "paid" },
  SCHEDULED: { label: "Card charge scheduled", tone: "muted" },
  AWAITING_CASH: { label: "Awaiting cash", tone: "owed" },
  AWAITING_CHECK: { label: "Awaiting check", tone: "owed" },
  PAYMENT_FAILED: { label: "Payment failed", tone: "warn" },
  PENDING_PAYMENT: { label: "Didn't finish checkout", tone: "warn" },
  CANCELED: { label: "Canceled", tone: "muted" },
  REGISTERED: { label: "Registered", tone: "muted" },
};

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
    paymentMethods?: string[];
    requirePaymentBeforeCheckin?: boolean;
  };
  registrations: RegistrationRow[];
  activeCount: number;
  unpaidCount: number;
  invoicedCount: number;
  awaitingOfflineCount?: number;
  scheduledCount?: number;
  failedCount?: number;
  mode: "ESTIMATED" | "OFFICIAL";
  perHead: number | null;
  publicPrice: number | null;
};

function RegistrationsModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<RegistrationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recording, setRecording] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`/api/events/${eventId}/registrations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); setSelected(new Set()); });
  }
  useEffect(() => { load(); }, [eventId]);

  // Record the cash/check a registrant physically handed over. This is the
  // moment it becomes revenue and the receipt goes out — confirm the amount
  // out loud before flipping it.
  async function recordOffline(r: RegistrationRow) {
    const due = Number(r.amountDue ?? 0);
    const method = r.status === "AWAITING_CHECK" || r.paymentMethod === "CHECK" ? "CHECK" : "CASH";
    const reference =
      method === "CHECK"
        ? window.prompt(`Check number or reference for ${r.name} (optional):`, "") ?? ""
        : "";
    if (!window.confirm(`Record $${due.toFixed(2)} received in ${method.toLowerCase()} from ${r.name}? This sends them a receipt.`)) {
      return;
    }
    setRecording(r.id);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/registrations/${r.id}/offline-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, reference: reference || null, amountReceived: due }),
    });
    const d = await res.json().catch(() => ({}));
    setRecording(null);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not record the payment."); return; }
    setMsg(`Recorded $${due.toFixed(2)} from ${r.name} — receipt sent.`);
    load();
  }

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
    const parts = [
      d.perHead != null
        ? `Emailed ${d.billed} payment link(s) at $${Number(d.perHead).toFixed(2)} each`
        : `Emailed ${d.billed} payment link(s)`,
    ];
    if (d.skipped) parts.push(`${d.skipped} already paid`);
    if (d.errors?.length) parts.push(`${d.errors.length} failed`);
    setMsg(parts.join(" · ") + ".");
    load();
  }

  const ev = data?.event;
  const customFields = ev?.registrationForm ?? [];
  const isVariable = !!ev?.variableCostEnabled;
  const mode = data?.mode ?? "ESTIMATED";

  // Fixed-price events: a registrant is collectable when they owe something
  // (recorded at registration, or the event's current public price).
  // SCHEDULED registrants are excluded — their card is already committed for
  // the event date, so emailing a payment link would collect the same money
  // twice (the server refuses them too).
  const owes = (r: RegistrationRow) =>
    Number(r.amountDue ?? 0) > 0 ? Number(r.amountDue) : (data?.publicPrice ?? 0);
  const collectable = (r: RegistrationRow) =>
    r.status !== "PAID" &&
    r.status !== "CANCELED" &&
    r.status !== "SCHEDULED" &&
    (isVariable || owes(r) > 0);
  const showInvoicing = isVariable || (data?.registrations ?? []).some(collectable);

  const selectableIds = (data?.registrations ?? []).filter(collectable).map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const unpaidOwing = (data?.registrations ?? []).filter(collectable).length;

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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Registrations</h2>
            {ev && <p className="text-xs text-text-muted">{ev.name}{ev.publicSlug ? ` · /e/${ev.publicSlug}` : ""}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading || !data ? (
            <div className="py-2"><SkeletonList rows={3} /></div>
          ) : (
            <>
              {/* At-a-glance money state. Only shows what actually applies. */}
              {((data.awaitingOfflineCount ?? 0) > 0 ||
                (data.scheduledCount ?? 0) > 0 ||
                (data.failedCount ?? 0) > 0) && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {(data.awaitingOfflineCount ?? 0) > 0 && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-orange-accent/15 text-text-primary font-medium">
                      {data.awaitingOfflineCount} to collect at the door
                    </span>
                  )}
                  {(data.scheduledCount ?? 0) > 0 && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-app-bg text-text-muted">
                      {data.scheduledCount} card charge{data.scheduledCount === 1 ? "" : "s"} scheduled
                    </span>
                  )}
                  {(data.failedCount ?? 0) > 0 && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-red-50 text-red-700 font-medium">
                      {data.failedCount} payment{data.failedCount === 1 ? "" : "s"} failed
                    </span>
                  )}
                  {ev?.requirePaymentBeforeCheckin && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-app-bg text-text-muted">
                      Payment required before check-in
                    </span>
                  )}
                </div>
              )}

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

              {!isVariable && showInvoicing && (
                <div className="bg-app-bg border border-app-border rounded-lg p-4 mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm text-text-primary font-semibold">Collect payment</p>
                    <span className="text-[11px] text-text-muted">{unpaidOwing} unpaid</span>
                  </div>
                  <p className="text-xs text-text-muted mb-3">
                    Public signups are recorded before checkout, so someone who closed the payment
                    page stays registered but unpaid. Email each unpaid registrant a fresh Stripe
                    payment link for what they owe.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => invoice({ force: true })}
                      disabled={billing || unpaidOwing === 0}
                      className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {billing ? "Sending…" : `Email payment link to all unpaid (${unpaidOwing})`}
                    </button>
                    <button
                      onClick={() => invoice({ registrationIds: [...selected] })}
                      disabled={billing || selected.size === 0}
                      className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface disabled:opacity-50"
                    >
                      Email selected ({selected.size})
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
                        {showInvoicing && (
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
                        const selectable = collectable(r);
                        return (
                          <tr key={r.id} className="border-b border-app-border last:border-0 align-top">
                            {showInvoicing && (
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
                              {(() => {
                                const ui = REG_STATUS_UI[r.status] ?? REG_STATUS_UI.REGISTERED;
                                const due = Number(r.amountDue ?? 0);
                                const chip =
                                  ui.tone === "paid"
                                    ? "bg-lime-accent/20 text-text-primary"
                                    : ui.tone === "owed"
                                      ? "bg-orange-accent/15 text-text-primary"
                                      : ui.tone === "warn"
                                        ? "bg-red-50 text-red-700"
                                        : "bg-app-bg text-text-muted";
                                const label =
                                  r.status === "PAID"
                                    ? `Paid${r.amountPaid ? ` $${Number(r.amountPaid).toFixed(2)}` : ""}`
                                    : ui.tone === "owed" && due > 0
                                      ? `${ui.label} · $${due.toFixed(2)}`
                                      : r.status === "REGISTERED" && due > 0
                                        ? `Owes $${due.toFixed(2)}`
                                        : ui.label;
                                return (
                                  <span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${chip}`}>
                                      {label}
                                    </span>
                                    {r.status === "PAID" && r.paidVia && r.paidVia !== "STRIPE" && (
                                      <span className="block text-[10px] text-text-muted mt-1">
                                        {r.paidVia === "CHECK" ? "By check" : "In cash"}
                                        {r.checkReference ? ` · ${r.checkReference}` : ""}
                                      </span>
                                    )}
                                    {r.status === "SCHEDULED" && r.scheduledChargeAt && (
                                      <span className="block text-[10px] text-text-muted mt-1">
                                        ${due.toFixed(2)} on{" "}
                                        {new Date(r.scheduledChargeAt).toLocaleDateString(undefined, {
                                          timeZone: "UTC",
                                        })}
                                      </span>
                                    )}
                                    {r.status === "PAYMENT_FAILED" && r.lastChargeError && (
                                      <span className="block text-[10px] text-text-muted mt-1 max-w-[16rem]">
                                        {r.lastChargeError}
                                      </span>
                                    )}
                                    {(r.status === "AWAITING_CASH" || r.status === "AWAITING_CHECK" || r.status === "PAYMENT_FAILED") &&
                                      due > 0 && (
                                        <button
                                          onClick={() => recordOffline(r)}
                                          disabled={recording === r.id}
                                          className="block text-[10px] text-brand hover:underline mt-1 disabled:opacity-50"
                                        >
                                          {recording === r.id ? "Recording…" : "Record payment received"}
                                        </button>
                                      )}
                                    {r.status === "PENDING_PAYMENT" && (
                                      <span className="block text-[10px] text-text-muted mt-1">
                                        Not registered until they pay
                                      </span>
                                    )}
                                  </span>
                                );
                              })()}
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


// Tiny image focal-point picker. The owner clicks/drags inside the preview
// box; we store the chosen point as 0–100% on each axis. The public event
// page applies it via CSS `object-position` so the existing image file is
// reused as-is — no re-encoding, no extra storage. Mirrors the public
// page's aspect ratio (16:9) so what you set is what you see.
function EventImageFocalPicker({
  imageUrl,
  x,
  y,
  onChange,
}: {
  imageUrl: string;
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  function pickFromEvent(e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) {
    const box = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const point =
      "touches" in e && e.touches.length > 0
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
    const nx = Math.max(0, Math.min(100, Math.round(((point.x - box.left) / box.width) * 100)));
    const ny = Math.max(0, Math.min(100, Math.round(((point.y - box.top) / box.height) * 100)));
    onChange(nx, ny);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-text-primary">Adjust image position</label>
        <button
          type="button"
          onClick={() => onChange(50, 50)}
          className="text-xs text-text-muted hover:text-text-primary underline"
        >
          Reset to center
        </button>
      </div>
      <div
        role="button"
        tabIndex={0}
        onMouseDown={(e) => { setDragging(true); pickFromEvent(e); }}
        onMouseMove={(e) => { if (dragging) pickFromEvent(e); }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
        onTouchStart={(e) => { setDragging(true); pickFromEvent(e); }}
        onTouchMove={(e) => { if (dragging) pickFromEvent(e); }}
        onTouchEnd={() => setDragging(false)}
        className="relative w-full overflow-hidden rounded-lg border border-app-border bg-app-bg cursor-crosshair select-none"
        style={{ aspectRatio: "16 / 9" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ objectPosition: `${x}% ${y}%` }}
        />
        {/* Focal point indicator */}
        <div
          className="absolute pointer-events-none w-5 h-5 rounded-full border-2 border-white"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            transform: "translate(-50%, -50%)",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.6)",
          }}
        />
      </div>
      <p className="text-xs text-text-muted">
        Click or drag inside the preview to set the part of the image that should
        stay visible on the public registration page.
      </p>
    </div>
  );
}


// ── Event payroll (staff + guest clinicians) ─────────────────────────────────
// Config + live estimates from /api/events/[id]/comp; "Create payout records"
// turns assignments into PENDING Payout rows reviewed on the payouts page.
type CompAssignmentRow = {
  id?: string;
  payeeType: "STAFF" | "CONTRACTOR";
  userId?: string | null;
  contractorId?: string | null;
  payeeName?: string;
  compMethod: "FLAT" | "PERCENT" | "NONE";
  flatAmount?: number | null;
  percent?: number | null;
  basis: "GROSS_COLLECTED" | "NET_COLLECTED";
  estimatedPayout?: number | null;
  payout?: { id: string; status: string; amount: number } | null;
};

function EventCompModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<{
    event: { name: string; compNoRefunds: boolean; startsAt: string };
    revenue: { gross: number; net: number; refunded: number; fees: number; countedTransactions: number };
    eventOver: boolean;
    assignments: CompAssignmentRow[];
    staff: { id: string; firstName: string; lastName: string }[];
    contractors: { id: string; name: string; role: string | null }[];
  } | null>(null);
  const [rows, setRows] = useState<CompAssignmentRow[]>([]);
  const [noRefunds, setNoRefunds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  function load() {
    fetch(`/api/events/${eventId}/comp`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) { setErr("You need Finances access to manage event pay."); return; }
        setData(d);
        setRows(d.assignments);
        setNoRefunds(!!d.event.compNoRefunds);
      });
  }
  useEffect(() => { load(); }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true); setErr(""); setMsg("");
    const res = await fetch(`/api/events/${eventId}/comp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        compNoRefunds: noRefunds,
        assignments: rows.map((r) => ({
          id: r.id,
          payeeType: r.payeeType,
          userId: r.userId ?? null,
          contractorId: r.contractorId ?? null,
          compMethod: r.compMethod,
          flatAmount: r.compMethod === "FLAT" ? Number(r.flatAmount) || 0 : null,
          percent: r.compMethod === "PERCENT" ? Number(r.percent) || 0 : null,
          basis: r.basis,
        })),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(d.error || "Could not save."); return; }
    setData((prev) => (prev ? { ...prev, ...d } : prev));
    setRows(d.assignments);
    setMsg("Saved.");
  }

  async function generatePayouts() {
    if (!window.confirm("Create pending payout records for everyone below? Amounts are computed from revenue collected so far. Nothing is sent — you review and mark paid on the Payouts page.")) return;
    setBusy(true); setErr(""); setMsg("");
    const res = await fetch(`/api/events/${eventId}/comp/generate-payouts`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(d.error || "Could not create payout records."); return; }
    setMsg(`${d.created} payout record(s) created${d.skippedExisting ? ` · ${d.skippedExisting} already existed` : ""}${d.skippedZero ? ` · ${d.skippedZero} skipped ($0)` : ""}. Review them on Staff → Payroll / Payouts.`);
    load();
  }

  const rev = data?.revenue;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Event payroll</h2>
            {data && <p className="text-xs text-text-muted">{data.event.name}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          {!data && !err && <SkeletonList rows={3} />}
          {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</p>}
          {data && rev && (
            <>
              <div className="bg-app-bg border border-app-border rounded-lg p-4 text-xs text-text-muted space-y-1">
                <p className="text-sm text-text-primary font-semibold">
                  Collected so far: ${rev.gross.toFixed(2)} gross · ${rev.net.toFixed(2)} net
                </p>
                <p>
                  Gross = actually collected (after discounts{noRefunds ? "; refunds ignored — no-refunds policy" : ` and $${rev.refunded.toFixed(2)} of refunds`}), before processing fees.
                  Net = gross − ${rev.fees.toFixed(2)} in known fees. Pending cash/check and unfinished checkouts never count.
                </p>
                <label className="flex items-center gap-2 pt-1 cursor-pointer text-text-primary">
                  <input type="checkbox" checked={noRefunds} onChange={(e) => setNoRefunds(e.target.checked)} />
                  NO REFUNDS policy — pay percentages on everything collected, even if later refunded
                </label>
              </div>

              {rows.map((r, i) => (
                <div key={r.id ?? `new-${i}`} className="border border-app-border rounded-lg p-3 space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select
                      value={`${r.payeeType}:${r.payeeType === "STAFF" ? r.userId ?? "" : r.contractorId ?? ""}`}
                      onChange={(e) => {
                        const [t, pid] = e.target.value.split(":");
                        setRows((prev) => prev.map((x, j) => j === i
                          ? { ...x, payeeType: t as "STAFF" | "CONTRACTOR", userId: t === "STAFF" ? pid : null, contractorId: t === "CONTRACTOR" ? pid : null }
                          : x));
                      }}
                      className="px-3 py-2 border border-app-border rounded-lg text-sm"
                    >
                      <option value={`${r.payeeType}:`}>Choose a person…</option>
                      <optgroup label="Staff">
                        {data.staff.map((u) => (
                          <option key={u.id} value={`STAFF:${u.id}`}>{u.firstName} {u.lastName}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Guest clinicians / contractors">
                        {data.contractors.map((c) => (
                          <option key={c.id} value={`CONTRACTOR:${c.id}`}>{c.name}{c.role ? ` — ${c.role}` : ""}</option>
                        ))}
                      </optgroup>
                    </select>
                    <select
                      value={r.compMethod}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, compMethod: e.target.value as CompAssignmentRow["compMethod"] } : x)))}
                      className="px-3 py-2 border border-app-border rounded-lg text-sm"
                    >
                      <option value="FLAT">Flat payment</option>
                      <option value="PERCENT">% of event revenue</option>
                      <option value="NONE">No compensation (informational)</option>
                    </select>
                  </div>
                  {r.compMethod !== "NONE" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {r.compMethod === "FLAT" ? (
                        <input
                          type="number" min="0" step="0.01" placeholder="Amount ($)"
                          value={r.flatAmount ?? ""}
                          onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, flatAmount: e.target.value === "" ? null : Number(e.target.value) } : x)))}
                          className="px-3 py-2 border border-app-border rounded-lg text-sm"
                        />
                      ) : (
                        <input
                          type="number" min="0" max="100" step="0.1" placeholder="Percent (%)"
                          value={r.percent ?? ""}
                          onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, percent: e.target.value === "" ? null : Number(e.target.value) } : x)))}
                          className="px-3 py-2 border border-app-border rounded-lg text-sm"
                        />
                      )}
                      {r.compMethod === "PERCENT" && (
                        <select
                          value={r.basis}
                          onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, basis: e.target.value as CompAssignmentRow["basis"] } : x)))}
                          className="px-3 py-2 border border-app-border rounded-lg text-sm"
                        >
                          <option value="GROSS_COLLECTED">of gross collected</option>
                          <option value="NET_COLLECTED">of net collected</option>
                        </select>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-muted">
                      {r.payout
                        ? `Payout ${r.payout.status.toLowerCase()} · $${Number(r.payout.amount).toFixed(2)}`
                        : r.estimatedPayout != null
                          ? `${data.eventOver ? "Final" : "Estimated"} payout: $${Number(r.estimatedPayout).toFixed(2)}`
                          : r.compMethod === "NONE"
                            ? "Listed on the event — no pay record"
                            : "Estimate appears after saving"}
                    </span>
                    <button onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))} className="text-red-600 hover:underline">
                      Remove
                    </button>
                  </div>
                </div>
              ))}

              <button
                onClick={() => setRows((prev) => [...prev, { payeeType: "STAFF", compMethod: "FLAT", basis: "GROSS_COLLECTED" }])}
                className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
              >
                + Add staff or guest clinician
              </button>

              {msg && <p className="text-xs text-text-primary bg-lime-accent/15 border border-lime-accent/30 rounded px-2 py-1">{msg}</p>}

              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={save} disabled={busy} className="text-xs px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={generatePayouts}
                  disabled={busy || rows.every((r) => r.compMethod === "NONE" || r.payout)}
                  className="text-xs px-4 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                >
                  Create payout records
                </button>
              </div>
              <p className="text-[11px] text-text-muted">
                Payout records are payables — nothing is charged or sent. Review and mark them paid on Staff → Payroll / Payouts.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Event documents ──────────────────────────────────────────────────────────
// Attach EXISTING club documents (the same document/waiver system) to this
// event. All-Events docs are managed on /dashboard/documents and shown here.
function EventDocsModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<{
    attached: { id: string; title: string; requirement: string; appliesToAllEvents: boolean; linkedDirectly: boolean }[];
    available: { id: string; title: string; eventRequirement: string; appliesToAllEvents: boolean }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState("");

  function load() {
    fetch(`/api/events/${eventId}/documents`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setData(d); else setErr("Couldn't load documents."); });
  }
  useEffect(() => { load(); }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function setLinks(ids: string[]) {
    setBusy(true); setErr("");
    const res = await fetch(`/api/events/${eventId}/documents`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds: ids }),
    });
    setBusy(false);
    if (!res.ok) { setErr("Couldn't update documents."); return; }
    setPick("");
    load();
  }

  const REQ_LABELS: Record<string, string> = {
    INFO: "Informational",
    ACKNOWLEDGE: "Must acknowledge",
    SIGN_REQUIRED: "Sign before registering / check-in",
  };
  const directIds = (data?.attached ?? []).filter((d) => d.linkedDirectly).map((d) => d.id);
  const attachable = (data?.available ?? []).filter(
    (d) => !d.appliesToAllEvents && !directIds.includes(d.id),
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-base font-semibold text-text-primary">Event documents</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-3">
          {!data && !err && <SkeletonList rows={2} />}
          {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</p>}
          {data && (
            <>
              {(data.attached.length === 0) && (
                <p className="text-sm text-text-muted">No documents attached to this event yet.</p>
              )}
              {data.attached.map((d) => (
                <div key={d.id} className="flex items-center justify-between border border-app-border rounded-lg p-3">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary font-medium truncate">{d.title}</p>
                    <p className="text-[11px] text-text-muted">
                      {REQ_LABELS[d.requirement] ?? d.requirement}
                      {d.appliesToAllEvents ? " · All events" : ""}
                    </p>
                  </div>
                  {d.linkedDirectly ? (
                    <button
                      onClick={() => setLinks(directIds.filter((x) => x !== d.id))}
                      disabled={busy}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="text-[11px] text-text-muted">Managed in Documents</span>
                  )}
                </div>
              ))}

              <div className="flex gap-2 pt-1">
                <select value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm">
                  <option value="">Attach an existing document…</option>
                  {attachable.map((d) => (
                    <option key={d.id} value={d.id}>{d.title} ({REQ_LABELS[d.eventRequirement] ?? d.eventRequirement})</option>
                  ))}
                </select>
                <button
                  onClick={() => pick && setLinks([...directIds, pick])}
                  disabled={busy || !pick}
                  className="text-xs px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                >
                  Attach
                </button>
              </div>
              <p className="text-[11px] text-text-muted">
                What attachment means (informational / acknowledge / sign-required) and the
                &quot;All events&quot; setting are configured on each document in Documents.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
