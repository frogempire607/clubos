"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, X } from "lucide-react";
import StripeRequiredBanner from "@/components/StripeRequiredBanner";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";
import EventExpenseEditor from "@/components/EventExpenseEditor";
import EventRow, { EVENT_ROW_VIEWS, type EventRowView } from "@/components/events/EventRow";
import AttendeesModal from "@/components/events/AttendeesModal";
import EventEditor, { type EditorEvent } from "@/components/events/EventEditor";
import PublicLinkBox from "@/components/events/PublicLinkBox";
import type { EventMoneySummary } from "@/lib/eventAttendees";
import {
  CATEGORY_PRESETS,
  DEFAULT_EXTRA_ENTRY_LABEL,
  proposalNotePlaceholder,
  labelForChangeKey,
  type CategoryField,
} from "@/lib/eventCategories";

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
  // Phase 5 §5.3.1 — tournament-workflow defaults for every event of this
  // type. null = this type has no policy, which is what keeps the workflow off
  // for clinics and camps.
  defaultPolicy?: EventTypePolicy | null;
};

// The stored shape of ClubEventType.defaultPolicy. Mirrors EventPolicy in
// lib/eventPayments.ts; the resolver validates every field on read, so a blob
// written by an older build degrades rather than breaking the editor.
type EventTypePolicy = {
  requiresCoachApproval?: boolean;
  approvalPaymentIntent?: string;
  allowProposedChanges?: boolean;
  cancellationPolicyText?: string;
  // Defaults for what entrants of this type choose, seeded into new events of
  // this type. The event's own form always wins once it has any.
  categoryFields?: { key: string; label: string; options?: string[]; required?: boolean }[];
  extraEntryLabel?: string;
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
  imageUrl?: string | null;
  // Per-event money summary from the Attendees ledger (lib/eventAttendees),
  // attached by GET /api/events. null when the list route predates it.
  money?: EventMoneySummary | null;
  isTournament?: boolean;
  tournamentMode?: string | null;
  publicSlug?: string | null;
  publicRegistration?: boolean;
  signupAccess?: string | null;
  variableCostEnabled?: boolean;
  variableCostMode?: string | null;
  variableCostBilledAt?: string | null;
  variableCostTotal?: number | string | null;
  variableCostEstimatedSignups?: number | null;
  variableCostEstimatedTotal?: number | string | null;
  paymentMethods?: string[] | null;
  autoChargeDate?: string | null;
  requirePaymentBeforeCheckin?: boolean;
  // Phase 5 §5.3.2 — per-event overrides. null on any of the tri-state flags
  // means "inherit the event type"; false means this event opted out.
  requiresCoachApproval?: boolean | null;
  approvalPaymentIntent?: string | null;
  allowProposedChanges?: boolean | null;
  responsibleCoachUserId?: string | null;
  holdSpotDuringReview?: boolean;
  cancellationPolicyText?: string | null;
  paymentDueBy?: string | null;
  escalationEnabled?: boolean | null;
  escalationAnchor?: string | null;
  escalationSchedule?: string | null;
  escalationCustomDays?: unknown;
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
  const [viewingAttendees, setViewingAttendees] = useState<string | null>(null);
  // Which of the three row treatments (design handoff 1e) the list uses.
  // A per-browser preference, not club config — remembered in localStorage.
  const [rowView, setRowView] = useState<EventRowView>("money");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("events:rowView");
      if (saved === "money" || saved === "compact" || saved === "cover") setRowView(saved);
    } catch {}
  }, []);
  function chooseRowView(v: EventRowView) {
    setRowView(v);
    try { window.localStorage.setItem("events:rowView", v); } catch {}
  }
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

      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex gap-1 bg-app-bg rounded-lg p-1 w-fit">
          {(["upcoming", "past", "all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`text-xs px-3 py-1.5 rounded-md transition ${filter === f ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-app-bg rounded-lg p-1 w-fit" role="group" aria-label="Row layout">
          {EVENT_ROW_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => chooseRowView(v.key)}
              aria-pressed={rowView === v.key}
              className={`text-xs px-3 py-1.5 rounded-md transition ${rowView === v.key ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
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
        <div className={rowView === "cover" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2"}>
          {filtered.map((e) => {
            const td = getTypeDisplay(e, builtInOverrides);
            const start = new Date(e.startsAt);
            const pubStatus = getPublishStatus(e);
            const pricing = getPricingBadge(e, memberships);
            const acceptedMemberships = (e.pricingOptions || [])
              .map((p) => memberships.find((m) => m.id === p.membershipId)?.name)
              .filter(Boolean) as string[];
            const hasRegistrations = e.publicRegistration || e.tournamentMode === "HOST" || (e._count.registrations ?? 0) > 0;
            return (
              <div key={e.id} className="relative">
                <EventRow
                  event={e}
                  view={rowView}
                  type={td}
                  publish={pubStatus}
                  pricing={pricing}
                  acceptedMemberships={acceptedMemberships}
                  onAttendees={() => setViewingAttendees(e.id)}
                  onEdit={() => setEditing(e)}
                  onMenu={() => setActionMenuFor(e.id)}
                />

                {/* Action sheet — the ⋯ menu on every row treatment. Bottom
                    sheet on phones, the same sheet on desktop (the design
                    folds the old button row into ⋯). */}
                {actionMenuFor === e.id && (
                  <div
                    className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center"
                    onClick={() => setActionMenuFor(null)}
                  >
                    <div
                      className="w-full sm:max-w-sm bg-surface rounded-t-2xl sm:rounded-2xl p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:pb-2 shadow-2xl"
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
                      <button
                        onClick={() => { setActionMenuFor(null); setViewingAttendees(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Attendees{e.money ? ` (${e.money.attendees})` : ""}
                      </button>
                      {hasRegistrations && (
                        <button
                          onClick={() => { setActionMenuFor(null); setViewingRegistrations(e.id); }}
                          className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                        >
                          Registrations{(e._count.registrations ?? 0) > 0 ? ` (${e._count.registrations})` : ""} · record &amp; approve
                        </button>
                      )}
                      <button
                        onClick={() => { setActionMenuFor(null); setViewingBookings(e.id); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Bookings · add a member
                      </button>
                      {e.publicSlug && (e.signupAccess === "PUBLIC_LINK" || e.publicRegistration) && (
                        <div className="px-3 py-2">
                          <div className="text-[11px] font-medium text-text-muted mb-1">Public page link</div>
                          <PublicLinkBox slug={e.publicSlug} />
                        </div>
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
                        onClick={() => { setActionMenuFor(null); openEventChat(e.id); }}
                        disabled={chatBusy === e.id}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg disabled:opacity-50"
                      >
                        {chatBusy === e.id ? "Opening…" : "Group chat"}
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
        <EventEditor
          event={editing as unknown as EditorEvent | null}
          clubEventTypes={clubEventTypes}
          memberships={memberships}
          staffList={staffList}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {viewingAttendees && (
        <AttendeesModal
          eventId={viewingAttendees}
          onClose={() => setViewingAttendees(null)}
          onOpenRegistrations={() => { setViewingAttendees(null); setViewingRegistrations(viewingAttendees); }}
          onOpenBookings={() => { setViewingAttendees(null); setViewingBookings(viewingAttendees); }}
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

function TypePolicyEditor({ type, onSaved }: { type: ClubEventType; onSaved: () => void }) {
  const policy = type.defaultPolicy ?? null;
  const [open, setOpen] = useState(false);
  const [requiresApproval, setRequiresApproval] = useState<boolean>(!!policy?.requiresCoachApproval);
  const [intent, setIntent] = useState<string>(policy?.approvalPaymentIntent || "PARENT_CHOOSES");
  const [allowProposals, setAllowProposals] = useState<boolean>(!!policy?.allowProposedChanges);
  const [cancellation, setCancellation] = useState<string>(policy?.cancellationPolicyText || "");
  const [typeCategories, setTypeCategories] = useState<
    { key: string; label: string; optionsText: string }[]
  >(
    (policy?.categoryFields ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      optionsText: (c.options ?? []).join("\n"),
    })),
  );
  const [extraEntryLabel, setExtraEntryLabel] = useState<string>(policy?.extraEntryLabel || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/events/types/${type.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // An all-off blob is stored as null by the server, which is what makes
        // "this type is configured" answerable.
        defaultPolicy:
          requiresApproval || typeCategories.some((c) => c.label.trim())
            ? {
                ...(requiresApproval
                  ? {
                      requiresCoachApproval: true,
                      approvalPaymentIntent: intent,
                      allowProposedChanges: allowProposals,
                      cancellationPolicyText: cancellation.trim() || undefined,
                    }
                  : {}),
                categoryFields: typeCategories
                  .filter((c) => c.label.trim())
                  .map((c) => ({
                    key: c.key,
                    label: c.label.trim(),
                    options: c.optionsText.split("\n").map((x) => x.trim()).filter(Boolean),
                  })),
                extraEntryLabel: extraEntryLabel.trim() || undefined,
              }
            : null,
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } else {
      setErr("Could not save these defaults");
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-text-muted hover:text-text-primary underline"
      >
        {open
          ? "Hide"
          : policy?.requiresCoachApproval
            ? "Coach approval: on"
            : policy?.categoryFields?.length
              ? `${policy.categoryFields.length} entry categor${policy.categoryFields.length === 1 ? "y" : "ies"}`
              : "Coach approval: off"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-app-border p-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={requiresApproval}
              onChange={(e) => setRequiresApproval(e.target.checked)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-text-primary">
                New {type.name} events require coach approval
              </span>
              <span className="block text-[11px] text-text-muted">
                A default for this type. Any single event can still override it.
              </span>
            </span>
          </label>

          {requiresApproval && (
            <>
              <select
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-xs"
              >
                <option value="PARENT_CHOOSES">Let the registrant choose how to pay</option>
                <option value="APPROVAL_CHARGE">Charge their saved card on approval</option>
                <option value="INVOICE">Bill later — no card at registration</option>
                <option value="CASH_CHECK">Cash or check at the event</option>
                <option value="CARD">Require payment up front</option>
              </select>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowProposals}
                  onChange={(e) => setAllowProposals(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-[11px] text-text-primary">
                  Coaches may propose a different entry category, session, or one more
                  entry
                </span>
              </label>
              <textarea
                value={cancellation}
                onChange={(e) => setCancellation(e.target.value)}
                rows={2}
                placeholder="Cancellation policy shown on every confirmation for this type"
                className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-xs"
              />
            </>
          )}

          {/* Entry categories for this type. Seeded into new events of the type
              so a club sets their vocabulary once instead of per event. */}
          <div className="border-t border-app-border pt-2 space-y-2">
            <p className="text-[11px] font-medium text-text-primary">
              What {type.name} entrants choose
            </p>
            {typeCategories.map((c, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <input
                    value={c.label}
                    onChange={(e) =>
                      setTypeCategories((cs) => cs.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))
                    }
                    placeholder="Category name"
                    className="flex-1 px-2.5 py-1.5 border border-app-border rounded-lg text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setTypeCategories((cs) => cs.filter((_, idx) => idx !== i))}
                    className="text-[11px] text-red-600 px-1.5 py-1 rounded hover:bg-red-50"
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  value={c.optionsText}
                  onChange={(e) =>
                    setTypeCategories((cs) => cs.map((x, idx) => (idx === i ? { ...x, optionsText: e.target.value } : x)))
                  }
                  rows={2}
                  placeholder="One value per line — leave blank for free text"
                  className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-[11px] font-mono"
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-1.5 items-center">
              {CATEGORY_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  title={preset.hint}
                  onClick={() =>
                    setTypeCategories((cs) => {
                      const taken = new Set(cs.map((c) => c.key));
                      let key = preset.key;
                      let n = 2;
                      while (taken.has(key)) key = `${preset.key}${n++}`;
                      return [...cs, { key, label: preset.label, optionsText: "" }];
                    })
                  }
                  className="text-[10px] px-2 py-1 rounded-full border border-app-border hover:bg-app-bg"
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() =>
                  setTypeCategories((cs) => [...cs, { key: `category${cs.length + 1}`, label: "", optionsText: "" }])
                }
                className="text-[10px] px-2 py-1 rounded-full border border-app-border text-text-muted hover:bg-app-bg"
              >
                + Custom
              </button>
            </div>
            <input
              value={extraEntryLabel}
              onChange={(e) => setExtraEntryLabel(e.target.value)}
              placeholder={`Extra-entry label (default: "${DEFAULT_EXTRA_ENTRY_LABEL}")`}
              className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-xs"
            />
            <p className="text-[10px] text-text-muted">
              The extra-entry label is what a coach offers when proposing one more of
              something — an extra match, bout, heat, or game.
            </p>
          </div>

          {err && <p className="text-[11px] text-red-600">{err}</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-xs px-2.5 py-1 rounded-md bg-brand text-white font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save defaults"}
          </button>
        </div>
      )}
    </div>
  );
}

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
                  <div key={t.id} className="py-2 px-3 rounded-lg bg-app-bg">
                    <div className="flex items-center gap-3">
                      <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: t.color, color: t.textColor }}>{t.name}</span>
                      <div className="flex-1" />
                      <button onClick={() => deleteType(t.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                    </div>
                    <TypePolicyEditor type={t} onSaved={onSaved} />
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
    // Bookings are the roster. Cancelling one takes them off the attendee
    // list; it does NOT touch what they owe — that's the Registrations screen.
    if (!confirm("Cancel this booking? This removes them from the attendee roster. It does not change what they owe — use the Registrations screen to remove them from billing.")) return;
    const res = await fetch(`/api/events/${eventId}/bookings?memberId=${memberId}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    // Tell staff when the person is still on the billing list, so a removed
    // athlete can't quietly keep receiving invoices.
    if (d?.registrationKept) setError(d.registrationKept);
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
  discountCode: string | null;
  discountAmount: number | null;
  // Present when an offline Transaction is already open against this row —
  // the discount editor stays hidden, matching the server's lock rule.
  transactionId: string | null;
  paymentUrl: string | null;
  stripeCheckoutSessionId: string | null;
  invoicedAt: string | null;
  invoiceCount: number;
  formResponses: Record<string, string | boolean>;
  createdAt: string;
  member: { id: string; firstName: string; lastName: string; isMinor?: boolean; guardianName?: string | null } | null;
  paymentMethod: string | null;
  scheduledChargeAt: string | null;
  lastChargeError: string | null;
  // Phase 5 — the coach decision state. approvalStatus null means this event
  // never required approval, which is why it is not a boolean.
  approvalStatus?: string | null;
  approvalRequestedAt?: string | null;
  declinedReason?: string | null;
  proposedChange?: {
    proposedByUserId?: string | null;
    proposedAt?: string;
    coachNote?: string | null;
    priceDelta?: number;
    changes?: Record<string, unknown>;
  } | null;
  proposedChangeRespondedAt?: string | null;
  proposedChangeAccepted?: boolean | null;
  confirmationCode?: string | null;
  waitingOn?: "COACH" | "PARENT" | "PAYMENT" | "COMPLETE" | "CANCELED";
  paidAt: string | null;
  paidVia: string | null;
  checkReference: string | null;
  // Where an invoice for this row would actually be sent, resolved server-side
  // through the shared family model. Never trust `email` for display — it's a
  // snapshot from row-creation and is blank for minors without their own
  // address.
  recipient: {
    email: string | null;
    source: "REGISTRATION" | "MEMBER_FAMILY" | null;
    displayName: string | null;
    reason: string | null;
    fixMemberId: string | null;
  } | null;
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
  PENDING_REVIEW: { label: "Awaiting coach review", tone: "warn" },
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
    // Resolved policy (event → type → off) + whether THIS user may decide.
    policy?: {
      requiresCoachApproval: boolean;
      allowProposedChanges: boolean;
      approvalPaymentIntent: string;
      holdSpotDuringReview: boolean;
      responsibleCoachUserId: string | null;
    };
    canDecide?: boolean;
    // The club's own entry categories for this event, resolved server-side
    // (event form first, event-type defaults as fallback).
    categoryFields?: CategoryField[];
    extraEntryLabel?: string;
    proposalNotePlaceholder?: string;
  };
  pendingReviewCount?: number;
  awaitingParentCount?: number;
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

// What the server says each registrant will ACTUALLY be charged, straight from
// bill-registrants in preview mode. Nothing is emailed until the owner has
// looked at this and pressed send.
type InvoiceLine = {
  registrationId: string;
  name: string;
  email: string | null;
  emailSource: "REGISTRATION" | "MEMBER_FAMILY" | null;
  emailDisplayName: string | null;
  emailReason: string | null;
  recorded: number | null;
  amount: number;
  expected: number;
  mismatch: boolean;
  processingFee: number;
  chargedTotal: number;
  alreadyInvoiced: boolean;
};
type InvoicePreview = {
  isVariable: boolean;
  expected: number;
  passProcessingFees: boolean;
  lines: InvoiceLine[];
  mismatched: number;
  grandTotal: number;
};
type InvoiceOpts = { force?: boolean; registrationIds?: string[] };

// ── Coach review queue (Phase 5 §5.4.6) ──────────────────────────────────────
// Everything a coach has to decide, at the top of the roster they already open.
// Deliberately NOT a separate page: the decision needs the same context as the
// rest of the roster (who else is in, what they owe, what they answered), and a
// second screen would be a second place to keep in sync.
//
// Three outcomes, and the middle one is the reason this exists: a coach who
// can't take a registration as submitted usually doesn't want to refuse it —
// they want a different weight class, or an extra dual. Proposing hands that
// decision to the parent instead of quietly changing what a family agreed to.
function CoachReviewQueue({
  eventId,
  data,
  onDone,
}: {
  eventId: string;
  data: RegistrationsData;
  onDone: () => void;
}) {
  // What this registrant actually owes, not the raw column. A row created
  // before a price was resolvable carries amountDue null, and printing that as
  // "Nothing owed" on a $1 event is the same lie the confirmation email told
  // (2026-08-12). publicPrice comes from the server's shared resolver.
  const owedBy = (r: RegistrationRow): number => {
    const recorded = Number(r.amountDue ?? 0);
    if (recorded > 0) return recorded;
    return Math.max(0, Number(data.perHead ?? data.publicPrice ?? 0));
  };
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [mode, setMode] = useState<"decline" | "propose" | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // Keyed by category key, because how many there are and what they're called
  // is the club's decision, not the code's.
  const [categoryValues, setCategoryValues] = useState<Record<string, string>>({});
  const [session, setSession] = useState("");
  const [addExtraEntry, setAddExtraEntry] = useState(false);
  const [priceDelta, setPriceDelta] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const ev = data.event;
  const openProposal = (r: RegistrationRow) => !!r.proposedChange && !r.proposedChangeRespondedAt;
  // A registration with a proposal on the table is waiting on the PARENT, not
  // on the coach — the same precedence the render context and the waitingOn
  // resolver apply. Leaving it in the coach's queue would ask them to decide
  // something they have already handed over.
  const pending = data.registrations.filter(
    (r) => r.approvalStatus === "PENDING" && r.status !== "CANCELED" && !openProposal(r),
  );
  const awaitingParent = data.registrations.filter(
    (r) => openProposal(r) && r.status !== "CANCELED",
  );

  if (!ev.policy?.requiresCoachApproval && pending.length === 0 && awaitingParent.length === 0) {
    return null;
  }

  // The event's own categories drive the pickers, so a judo club sees a belt
  // and a weight and a soccer club sees a position — same code, their words.
  const formFields = ev.registrationForm ?? [];
  const categoryFields: CategoryField[] = ev.categoryFields ?? [];
  const extraEntryLabel = ev.extraEntryLabel || DEFAULT_EXTRA_ENTRY_LABEL;
  const notePlaceholder = ev.proposalNotePlaceholder || proposalNotePlaceholder(categoryFields);

  function reset() {
    setOpenFor(null);
    setMode(null);
    setReason("");
    setNote("");
    setCategoryValues({});
    setSession("");
    setAddExtraEntry(false);
    setPriceDelta("");
    setErr("");
  }

  async function post(regId: string, action: string, body: Record<string, unknown>) {
    setBusy(regId);
    setErr("");
    const res = await fetch(`/api/events/${eventId}/registrations/${regId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setErr(d.message || d.error || "That didn't go through.");
      return;
    }
    reset();
    // The decision stands even when the money side didn't — a declined card or
    // an un-connected Stripe account must not un-approve an athlete. But it
    // must not be silent either, or the club never learns nobody was billed.
    if (d.invoiceError) setErr(`Approved — but the payment link didn't send: ${d.invoiceError}`);
    else if (d.chargeError) setErr(`Approved — but the card charge didn't go through: ${d.chargeError}`);
    else if (d.refund?.error) setErr(`Declined — but the refund failed: ${d.refund.error}. Check Stripe.`);
    onDone();
  }

  async function approve(r: RegistrationRow) {
    // The money consequence is named out loud before it happens — approving an
    // APPROVAL_CHARGE registration charges a real card in the same request.
    const amount = owedBy(r) || null;
    const consequence =
      r.paymentMethod === "APPROVAL_CHARGE" && amount
        ? `This charges ${r.name}'s saved card $${amount.toFixed(2)} now.`
        : r.paymentMethod === "INVOICE" && amount
          ? `This emails ${r.name} a payment link for $${amount.toFixed(2)}.`
          : r.paymentMethod === "CASH" || r.paymentMethod === "CHECK"
            ? `${r.name} will be confirmed, and owes $${(amount ?? 0).toFixed(2)} at the event.`
            : `${r.name} will be confirmed for this event.`;
    if (!confirm(`Approve ${r.name}?\n\n${consequence}`)) return;
    await post(r.id, "approve", {});
  }

  function daysWaiting(r: RegistrationRow): number | null {
    const at = r.approvalRequestedAt ?? r.createdAt;
    if (!at) return null;
    return Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
  }

  return (
    <div className="mb-5 rounded-xl border border-orange-accent/40 bg-orange-accent/5 p-4">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            {pending.length > 0
              ? `Waiting on you (${pending.length})`
              : "Coach approval is on for this event"}
          </p>
          <p className="text-xs text-text-muted">
            {pending.length > 0
              ? "Nobody holds a spot until you approve, and nothing is charged until then."
              : "Nothing to review right now."}
            {awaitingParent.length > 0
              ? ` ${awaitingParent.length} proposed change${awaitingParent.length === 1 ? " is" : "s are"} waiting on a parent.`
              : ""}
          </p>
        </div>
        {ev.policy?.holdSpotDuringReview && (
          <span className="text-[11px] px-2 py-1 rounded-full bg-app-bg text-text-muted flex-shrink-0">
            Requests hold a spot
          </span>
        )}
      </div>

      {ev.canDecide === false && pending.length > 0 && (
        <p className="text-xs text-text-muted mt-2">
          You can see this queue but not decide it — ask an owner, or whoever is set as
          this event&apos;s responsible coach.
        </p>
      )}

      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}

      <div className="mt-3 space-y-2">
        {pending.map((r) => {
          const days = daysWaiting(r);
          const answers = Object.entries(r.formResponses ?? {})
            .filter(([k]) => !k.startsWith("__"))
            .map(([k, v]) => {
              // Category answers are keyed by category key, ordinary form
              // answers by field id — check both before falling back to the
              // raw key, or a judo roster reads "category: Yellow".
              const label =
                categoryFields.find((f) => f.key === k)?.label ??
                formFields.find((f) => f.id === k)?.label ??
                labelForChangeKey(k);
              return `${label}: ${String(v)}`;
            });
          return (
            <div key={r.id} className="rounded-lg border border-app-border bg-surface p-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {r.name}
                    {r.confirmationCode && (
                      <span className="ml-2 text-[11px] font-normal text-text-muted">
                        #{r.confirmationCode}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-text-muted">
                    {answers.length > 0 ? answers.join(" · ") : "No form answers"}
                  </p>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    {owedBy(r) > 0
                      ? `$${owedBy(r).toFixed(2)} · ${
                          r.paymentMethod === "APPROVAL_CHARGE"
                            ? "saved card, charged when you approve"
                            : r.paymentMethod === "INVOICE"
                              ? "billed if approved"
                              : r.paymentMethod === "CASH" || r.paymentMethod === "CHECK"
                                ? `${r.paymentMethod.toLowerCase()} at the event`
                                : r.status === "PAID"
                                  ? "paid up front"
                                  : "no way to pay recorded"
                        }`
                      : "Nothing owed"}
                    {days != null && ` · requested ${days === 0 ? "today" : `${days}d ago`}`}
                  </p>
                </div>
                {ev.canDecide !== false && (
                  <div className="flex gap-1.5 flex-shrink-0">
                    {ev.policy?.allowProposedChanges && (
                      <button
                        onClick={() => {
                          setOpenFor(r.id);
                          setMode("propose");
                          setErr("");
                        }}
                        disabled={busy === r.id}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50"
                      >
                        Propose a change
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setOpenFor(r.id);
                        setMode("decline");
                        setErr("");
                      }}
                      disabled={busy === r.id}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Decline
                    </button>
                    <button
                      onClick={() => approve(r)}
                      disabled={busy === r.id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busy === r.id ? "…" : "Approve"}
                    </button>
                  </div>
                )}
              </div>

              {openFor === r.id && mode === "decline" && (
                <div className="mt-3 border-t border-app-border pt-3">
                  <label className="block text-xs font-medium text-text-primary mb-1">
                    Why can&apos;t you take this registration?
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    placeholder="e.g. 126 is full — we already have two at that weight."
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    This goes to the family word for word.
                    {(r.status === "PAID" || Number(r.amountPaid ?? 0) > 0) &&
                      " They already paid, so declining refunds them in full."}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={reset}
                      className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-muted"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => post(r.id, "decline", { reason: reason.trim() })}
                      disabled={!reason.trim() || busy === r.id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50"
                    >
                      {busy === r.id ? "Declining…" : "Decline and notify"}
                    </button>
                  </div>
                </div>
              )}

              {openFor === r.id && mode === "propose" && (
                <div className="mt-3 border-t border-app-border pt-3 space-y-2">
                  <p className="text-xs text-text-muted">
                    Nothing changes until the parent accepts. Leave a field blank to keep
                    what they signed up for.
                  </p>
                  {categoryFields.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {categoryFields.map((f) => (
                        <div key={f.key}>
                          <label className="block text-[11px] font-medium text-text-primary mb-1">
                            {f.label}
                          </label>
                          {/* A value list makes this a picker; without one the
                              club couldn't enumerate its categories up front, so
                              free text is the honest fallback. */}
                          {f.options.length > 0 ? (
                            <select
                              value={categoryValues[f.key] ?? ""}
                              onChange={(e) =>
                                setCategoryValues((v) => ({ ...v, [f.key]: e.target.value }))
                              }
                              className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-sm"
                            >
                              <option value="">No change</option>
                              {f.options.map((o) => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              value={categoryValues[f.key] ?? ""}
                              onChange={(e) =>
                                setCategoryValues((v) => ({ ...v, [f.key]: e.target.value }))
                              }
                              placeholder="No change"
                              className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-sm"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-text-muted">
                      This event has no entry categories set, so there&apos;s nothing to
                      swap — you can still move them to another session, add an entry, or
                      just send a note. Add categories in the event editor.
                    </p>
                  )}
                  <div>
                    <label className="block text-[11px] font-medium text-text-primary mb-1">
                      Session
                    </label>
                    <input
                      value={session}
                      onChange={(e) => setSession(e.target.value)}
                      placeholder="No change"
                      className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-sm"
                    />
                  </div>

                  {/* One more of whatever this club runs — a match, a bout, a
                      heat, a game. It's the proposal that routinely costs more,
                      so the fee is asked for in the same breath and the parent
                      re-consents to that exact amount before anything moves. */}
                  <label className="flex items-start gap-2 p-2.5 rounded-lg border border-app-border cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addExtraEntry}
                      onChange={(e) => {
                        setAddExtraEntry(e.target.checked);
                        if (!e.target.checked) setPriceDelta("");
                      }}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-text-primary">
                        {extraEntryLabel}
                      </span>
                      <span className="block text-[11px] text-text-muted">
                        Usually adds an entry fee — put it below and the parent agrees to
                        that exact amount before it is charged.
                      </span>
                    </span>
                  </label>
                  {addExtraEntry && (
                    <div>
                      <label className="block text-[11px] font-medium text-text-primary mb-1">
                        Additional fee
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={priceDelta}
                        onChange={(e) => setPriceDelta(e.target.value)}
                        placeholder="0.00"
                        className="w-full sm:w-40 px-2.5 py-1.5 border border-app-border rounded-lg text-sm"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-medium text-text-primary mb-1">
                      Note to the parent
                    </label>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      placeholder={notePlaceholder}
                      className="w-full px-2.5 py-1.5 border border-app-border rounded-lg text-sm"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={reset}
                      className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-muted"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        const changes: Record<string, unknown> = {};
                        for (const f of categoryFields) {
                          const v = (categoryValues[f.key] ?? "").trim();
                          if (v) changes[f.key] = v;
                        }
                        if (session.trim()) changes.session = session.trim();
                        if (addExtraEntry) changes.extraEntry = true;
                        if (Object.keys(changes).length === 0) {
                          setErr("Propose at least one change.");
                          return;
                        }
                        post(r.id, "propose-change", {
                          changes,
                          message: note.trim() || undefined,
                          priceDelta: addExtraEntry && priceDelta ? parseFloat(priceDelta) : undefined,
                        });
                      }}
                      disabled={busy === r.id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busy === r.id ? "Sending…" : "Send to the parent"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {awaitingParent.map((r) => (
          <div key={r.id} className="rounded-lg border border-app-border bg-surface p-3">
            <p className="text-sm text-text-primary">
              <span className="font-medium">{r.name}</span> — waiting on the parent
            </p>
            <p className="text-[11px] text-text-muted">
              You proposed{" "}
              {Object.entries(r.proposedChange?.changes ?? {})
                .map(([k, v]) => {
                  const label = labelForChangeKey(
                    k,
                    (r.proposedChange as { labels?: Record<string, string> } | null)?.labels,
                    extraEntryLabel,
                  );
                  return `${label}: ${v === true ? "yes" : String(v)}`;
                })
                .join(", ")}
              {r.proposedChange?.priceDelta
                ? ` · +$${Number(r.proposedChange.priceDelta).toFixed(2)}`
                : ""}
              {r.proposedChange?.proposedAt
                ? ` · sent ${new Date(r.proposedChange.proposedAt).toLocaleDateString()}`
                : ""}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RegistrationsModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<RegistrationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recording, setRecording] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [previewOpts, setPreviewOpts] = useState<InvoiceOpts>({});
  const [repricing, setRepricing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // Which row's discount editor is open, and which row is mid-save.
  const [discountFor, setDiscountFor] = useState<string | null>(null);
  const [discountInput, setDiscountInput] = useState("");
  const [discountBusy, setDiscountBusy] = useState<string | null>(null);
  // Removed registrants keep their row for history but are off the screen by
  // default — a canceled row in the list is what made "who am I actually
  // invoicing?" unanswerable.
  const [showRemoved, setShowRemoved] = useState(false);
  const [fixingEmail, setFixingEmail] = useState<string | null>(null);

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
  // Record cash/check against the REGISTRATION — no booking involved.
  //
  // This used to be reachable only through the Bookings add-flow, which books
  // money on a Transaction and never touches the registration. Staff had to
  // remove and re-add a booking to mark someone paid, and each cycle minted a
  // duplicate SUCCEEDED Transaction while leaving the registration still
  // owing. Money lives on the registration; record it here.
  async function recordOffline(r: RegistrationRow, forceMethod?: "CASH" | "CHECK") {
    // The server settles the registration's OWN amountDue, so that is the
    // figure to confirm out loud — but if it disagrees with the event's
    // current price, say so before cash changes hands rather than after.
    const due = Number(r.amountDue ?? 0);
    const shouldBe = expectedDue;
    if (!(due > 0)) {
      setErr(
        `${r.name} has no recorded amount due. Reprice the registrations to this event's price first, then record the payment.`,
      );
      return;
    }
    const method =
      forceMethod ?? (r.status === "AWAITING_CHECK" || r.paymentMethod === "CHECK" ? "CHECK" : "CASH");
    const reference =
      method === "CHECK"
        ? window.prompt(`Check number or reference for ${r.name} (optional):`, "") ?? ""
        : "";
    const warning =
      shouldBe > 0 && Math.round(due * 100) !== Math.round(shouldBe * 100)
        ? `\n\nHeads up: this event's price is $${shouldBe.toFixed(2)}, but this registration is recorded at $${due.toFixed(2)}. Cancel and reprice if $${due.toFixed(2)} is wrong.`
        : "";
    if (!window.confirm(`Record $${due.toFixed(2)} received in ${method.toLowerCase()} from ${r.name}? This sends them a receipt.${warning}`)) {
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

  // Fix a missing address without leaving the roster. Writes the guardian
  // email on the member record (the club's one contact model), so it fixes
  // every future send for that family, not just this invoice.
  async function addRecipientEmail(r: RegistrationRow) {
    const memberId = r.recipient?.fixMemberId;
    if (!memberId) return;
    const entered = window.prompt(
      `Email address for ${r.name} (a parent/guardian address is fine — it's where their invoice and receipt will go):`,
      "",
    );
    const email = (entered ?? "").trim();
    if (!email) return;
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      setErr(`"${email}" doesn't look like an email address.`);
      return;
    }
    // A minor's address lives on the guardian fields; an adult's on their own.
    // The member PATCH refuses a guardian email with no guardian name, so ask
    // for it rather than inventing one.
    const isMinor = r.member?.isMinor !== false;
    const payload: Record<string, string> = isMinor ? { guardianEmail: email } : { email };
    if (isMinor && !r.member?.guardianName) {
      const who = window.prompt(`Parent/guardian name for ${r.name}:`, "");
      const name = (who ?? "").trim();
      if (!name) {
        setErr(`A parent/guardian name is required to save an email for ${r.name}.`);
        return;
      }
      payload.guardianName = name;
    }

    setFixingEmail(r.id);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setFixingEmail(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setErr(typeof d.error === "string" ? d.error : "Could not save that email.");
      return;
    }
    setPreview(null);
    setMsg(`Saved ${email} for ${r.name}. Their invoice will go there.`);
    load();
  }

  // Re-send the receipt for money already recorded. Never creates a second
  // Transaction — the old workaround (re-record the payment) did, and
  // double-counted the revenue.
  async function resendReceipt(r: RegistrationRow) {
    setRecording(r.id);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/registrations/${r.id}/resend-receipt`, {
      method: "POST",
    });
    const d = await res.json().catch(() => ({}));
    setRecording(null);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not resend the receipt."); return; }
    setMsg(`Receipt for ${r.name} re-sent to ${d.to}.`);
  }

  // Step 1 of sending: ask the server what each registrant would be charged.
  // Creates no Stripe session and sends no email — this is the screen that has
  // to exist so a wrong number is caught by a human instead of 13 families.
  async function invoice(opts: InvoiceOpts) {
    setBilling(true);
    setMsg("");
    setErr("");
    setPreview(null);
    const res = await fetch(`/api/events/${eventId}/bill-registrants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...opts, preview: true }),
    });
    const d = await res.json().catch(() => ({}));
    setBilling(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not build the invoice preview."); return; }
    setPreviewOpts(opts);
    setPreview(d as InvoicePreview);
  }

  // Step 2: actually send what was reviewed. `confirmMismatched` is only ever
  // true because the owner read the mismatched rows on screen first.
  async function confirmSend() {
    if (!preview) return;
    setBilling(true);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/bill-registrants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...previewOpts, confirmMismatched: preview.mismatched > 0 }),
    });
    const d = await res.json().catch(() => ({}));
    setBilling(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not send invoices."); return; }
    setPreview(null);
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

  // Pull every non-committed registration onto the event's current price.
  // Changes what a future invoice says; charges nobody.
  async function repriceAll() {
    if (!confirm("Update every unpaid registration to this event's current pricing? Nobody is charged — this only changes what their next invoice says.")) return;
    setRepricing(true);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/reprice-registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply: true }),
    });
    const d = await res.json().catch(() => ({}));
    setRepricing(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not reprice."); return; }
    setPreview(null);
    setMsg(
      d.updated > 0
        ? `Repriced ${d.updated} registration(s).${d.locked?.length ? ` ${d.locked.length} left alone (money already committed).` : ""}`
        : "Everyone already matches the event's current pricing.",
    );
    load();
  }

  // Take someone off the billing list. The roster's "Cancel" removes a
  // booking; this removes the registration — they are separate tables, and
  // only this one drives invoices.
  async function removeRegistration(r: RegistrationRow) {
    if (!confirm(`Remove ${r.name} from this event's registration and billing list? They'll stop appearing in invoices.`)) return;
    setRemoving(r.id);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/registrations/${r.id}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setRemoving(null);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Could not remove them."); return; }
    setPreview(null);
    setMsg(`${r.name} removed from the registration list.`);
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
  // Same resolution the server uses (lib/eventRepricing.amountToCollect), so a
  // row can never display one number while the invoice sends another.
  // Dollars this row's code takes off the list price. Mirrors the server's
  // lib/eventRepricing — a discounted registrant owes less on purpose.
  const discountOff = (r: RegistrationRow) => Number(r.discountAmount ?? 0);
  // Apply or clear a discount code on someone's behalf. Server re-resolves the
  // code against the event's current price and refuses any row whose money is
  // already committed — the client never computes the new amount.
  async function setRegistrationDiscount(r: RegistrationRow, code: string | null) {
    setDiscountBusy(r.id);
    setMsg("");
    setErr("");
    const res = await fetch(`/api/events/${eventId}/registrations/${r.id}/discount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discountCode: code }),
    });
    const d = await res.json().catch(() => ({}));
    setDiscountBusy(null);
    setDiscountFor(null);
    if (!res.ok) {
      setErr(typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : "Could not apply that code.");
      return;
    }
    setPreview(null);
    setMsg(
      code
        ? `${d.discountCode} applied to ${r.name} — now $${Number(d.amountDue ?? 0).toFixed(2)}.${
            d.reinvoiceNeeded ? " They were already invoiced — re-send their payment link." : ""
          }`
        : `Discount cleared for ${r.name} — now $${Number(d.amountDue ?? 0).toFixed(2)}.`,
    );
    load();
  }

  const owes = (r: RegistrationRow) =>
    isVariable
      ? Math.max(0, Math.round(((data?.perHead ?? 0) - discountOff(r)) * 100) / 100)
      : Number(r.amountDue ?? 0) > 0
        ? Number(r.amountDue)
        : Math.max(0, Math.round(((data?.publicPrice ?? 0) - discountOff(r)) * 100) / 100);
  // What the event's CURRENT pricing says THIS registrant should owe — the
  // list price minus their own discount. Comparing a discounted row against
  // the bare list price flags every one of them as a stale snapshot.
  const expectedFor = (r: RegistrationRow) =>
    Math.max(
      0,
      Math.round(((isVariable ? (data?.perHead ?? 0) : (data?.publicPrice ?? 0)) - discountOff(r)) * 100) / 100,
    );
  // The event-level headline figure (no one person's discount applied).
  const expectedDue = isVariable ? (data?.perHead ?? 0) : (data?.publicPrice ?? 0);
  const collectable = (r: RegistrationRow) =>
    r.status !== "PAID" &&
    r.status !== "CANCELED" &&
    r.status !== "SCHEDULED" &&
    (isVariable || owes(r) > 0);
  const showInvoicing = isVariable || (data?.registrations ?? []).some(collectable);

  const selectableIds = (data?.registrations ?? []).filter(collectable).map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const unpaidOwing = (data?.registrations ?? []).filter(collectable).length;
  const allRows = data?.registrations ?? [];
  const removedRows = allRows.filter((r) => r.status === "CANCELED");
  const visibleRows = showRemoved ? allRows : allRows.filter((r) => r.status !== "CANCELED");
  // Rows carrying an amount the event's own pricing doesn't produce — the
  // Frog Empire failure mode, made visible instead of silently invoiced.
  const mismatchedRows = (data?.registrations ?? []).filter(
    (r) => collectable(r) && expectedDue > 0 && Math.round(owes(r) * 100) !== Math.round(expectedFor(r) * 100),
  );

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
              <CoachReviewQueue eventId={eventId} data={data} onDone={load} />

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

              {/* Stale amounts, surfaced before anything is emailed. */}
              {mismatchedRows.length > 0 && (
                <div className="bg-orange-accent/10 border border-orange-accent/40 rounded-lg p-4 mb-4">
                  <p className="text-sm font-semibold text-text-primary">
                    {mismatchedRows.length} registration{mismatchedRows.length === 1 ? "" : "s"} don&apos;t match this event&apos;s price
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    This event prices at <strong>${expectedDue.toFixed(2)}</strong>, but these rows are
                    carrying a different amount — usually a figure recorded before the pricing changed.
                    They will be invoiced for what they carry unless you reprice them.
                  </p>
                  <ul className="text-xs text-text-primary mt-2 space-y-0.5">
                    {mismatchedRows.slice(0, 8).map((r) => (
                      <li key={r.id}>
                        {r.name}: <strong>${owes(r).toFixed(2)}</strong>{" "}
                        <span className="text-text-muted">→ ${expectedDue.toFixed(2)}</span>
                      </li>
                    ))}
                    {mismatchedRows.length > 8 && (
                      <li className="text-text-muted">…and {mismatchedRows.length - 8} more</li>
                    )}
                  </ul>
                  <button
                    onClick={repriceAll}
                    disabled={repricing}
                    className="mt-3 text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                  >
                    {repricing ? "Repricing…" : `Reprice all unpaid to $${expectedDue.toFixed(2)}`}
                  </button>
                  <p className="text-[11px] text-text-muted mt-2">
                    Nobody is charged. Paid, scheduled, and awaiting-cash/check registrants are left alone.
                  </p>
                </div>
              )}

              {/* Review before sending — the exact amounts, per family. */}
              {preview && (
                <div className="bg-surface border-2 border-brand rounded-lg p-4 mb-4">
                  <p className="text-sm font-semibold text-text-primary">
                    Review before sending · {preview.lines.length} payment link{preview.lines.length === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    Nothing has been sent yet. This is exactly what each family will be emailed and charged.
                  </p>
                  <div className="overflow-x-auto mt-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted border-b border-app-border">
                          <th className="pb-1.5 font-medium">Registrant</th>
                          <th className="pb-1.5 font-medium text-right">Amount</th>
                          {preview.passProcessingFees && <th className="pb-1.5 font-medium text-right">Processing fee</th>}
                          <th className="pb-1.5 font-medium text-right">They pay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.lines.map((l) => (
                          <tr key={l.registrationId} className="border-b border-app-border last:border-0">
                            <td className="py-1.5">
                              <span className="text-text-primary">{l.name}</span>
                              {l.email ? (
                                <span className="block text-[10px] text-text-muted break-all">
                                  → {l.email}
                                </span>
                              ) : (
                                <span className="block text-[10px] text-orange-700">
                                  {l.emailReason ?? "No email on file"} — will be skipped
                                </span>
                              )}
                              {l.mismatch && (
                                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-orange-accent/20 text-text-primary">
                                  not ${l.expected.toFixed(2)}
                                </span>
                              )}
                              {l.alreadyInvoiced && (
                                <span className="ml-1.5 text-[10px] text-text-muted">re-send</span>
                              )}
                            </td>
                            <td className="py-1.5 text-right text-text-primary">${l.amount.toFixed(2)}</td>
                            {preview.passProcessingFees && (
                              <td className="py-1.5 text-right text-text-muted">${l.processingFee.toFixed(2)}</td>
                            )}
                            <td className="py-1.5 text-right text-text-primary font-medium">${l.chargedTotal.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td className="pt-2 text-text-primary font-semibold" colSpan={preview.passProcessingFees ? 3 : 2}>
                            Total across {preview.lines.length}
                          </td>
                          <td className="pt-2 text-right text-text-primary font-semibold">${preview.grandTotal.toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {preview.passProcessingFees && (
                    <p className="text-[11px] text-text-muted mt-2">
                      The club passes processing fees, so the Stripe page totals more than the amount in the
                      email body. Both figures are shown above.
                    </p>
                  )}
                  {preview.mismatched > 0 && (
                    <p className="text-xs text-text-primary mt-2 bg-orange-accent/10 border border-orange-accent/40 rounded px-2 py-1.5">
                      {preview.mismatched} of these don&apos;t match the event&apos;s price of ${preview.expected.toFixed(2)}.
                      Reprice first, or send anyway if the amounts are deliberate.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button
                      onClick={confirmSend}
                      disabled={billing || preview.lines.length === 0}
                      className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {billing
                        ? "Sending…"
                        : `Send ${preview.lines.length} payment link${preview.lines.length === 1 ? "" : "s"} · $${preview.grandTotal.toFixed(2)}`}
                    </button>
                    <button
                      onClick={() => setPreview(null)}
                      disabled={billing}
                      className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
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

              {removedRows.length > 0 && (
                <label className="flex items-center gap-2 mb-2 text-[11px] text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showRemoved}
                    onChange={() => setShowRemoved((v) => !v)}
                  />
                  Show {removedRows.length} removed registrant{removedRows.length === 1 ? "" : "s"}
                </label>
              )}

              {visibleRows.length === 0 ? (
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
                        <th className="pb-2 font-medium w-8"><span className="sr-only">Remove</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((r) => {
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
                              {r.recipient?.email ? (
                                <>
                                  <p className="text-[10px] text-text-muted">
                                    {r.invoiceCount > 0 ? "Sent to" : "Will send to"}
                                  </p>
                                  <p className="text-text-primary break-all">{r.recipient.email}</p>
                                  {r.recipient.source === "MEMBER_FAMILY" && (
                                    <p className="text-[10px] text-text-muted">
                                      {r.recipient.displayName
                                        ? `${r.recipient.displayName} · billing contact`
                                        : "billing contact · from member record"}
                                    </p>
                                  )}
                                  {r.recipient.source === "REGISTRATION" && r.member && (
                                    <p className="text-[10px] text-text-muted">
                                      given at registration
                                    </p>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="text-orange-700">
                                    {r.recipient?.reason ?? "No email on file"}
                                  </p>
                                  {r.recipient?.fixMemberId && (
                                    <button
                                      onClick={() => addRecipientEmail(r)}
                                      disabled={fixingEmail === r.id}
                                      className="text-[10px] text-brand hover:underline disabled:opacity-50"
                                    >
                                      {fixingEmail === r.id ? "Saving…" : "Add an email"}
                                    </button>
                                  )}
                                </>
                              )}
                              {r.phone && <p className="mt-1">{r.phone}</p>}
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
                                    {r.discountCode && (
                                      <span className="block text-[10px] text-text-muted mt-1">
                                        {r.discountCode}
                                        {r.discountAmount != null && r.discountAmount > 0
                                          ? ` · −$${Number(r.discountAmount).toFixed(2)}`
                                          : ""}
                                      </span>
                                    )}
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
                                    {/* Cash/check settlement for ANY unpaid row —
                                        not just the ones that pre-declared an
                                        offline method. Marking someone paid must
                                        never require touching their booking. */}
                                    {r.status !== "PAID" &&
                                      r.status !== "CANCELED" &&
                                      r.status !== "SCHEDULED" &&
                                      due > 0 && (
                                        <span className="block text-[10px] text-text-muted mt-1">
                                          Record payment:{" "}
                                          <button
                                            onClick={() => recordOffline(r, "CASH")}
                                            disabled={recording === r.id}
                                            className="text-brand hover:underline disabled:opacity-50"
                                          >
                                            {recording === r.id ? "Recording…" : "cash"}
                                          </button>
                                          {" · "}
                                          <button
                                            onClick={() => recordOffline(r, "CHECK")}
                                            disabled={recording === r.id}
                                            className="text-brand hover:underline disabled:opacity-50"
                                          >
                                            check
                                          </button>
                                        </span>
                                      )}
                                    {/* Staff applying a code on a registrant's
                                        behalf. Only offered while the row is
                                        still repriceable — the server enforces
                                        the same rule. */}
                                    {r.status !== "PAID" &&
                                      r.status !== "CANCELED" &&
                                      r.status !== "SCHEDULED" &&
                                      !r.transactionId &&
                                      (discountFor === r.id ? (
                                        <span className="mt-1 flex items-center gap-1">
                                          <input
                                            autoFocus
                                            value={discountInput}
                                            onChange={(e) => setDiscountInput(e.target.value.toUpperCase())}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") setRegistrationDiscount(r, discountInput.trim() || null);
                                              if (e.key === "Escape") setDiscountFor(null);
                                            }}
                                            placeholder="CODE"
                                            className="w-24 px-1.5 py-0.5 border border-app-border rounded text-[10px] font-mono uppercase bg-surface text-text-primary"
                                          />
                                          <button
                                            onClick={() => setRegistrationDiscount(r, discountInput.trim() || null)}
                                            disabled={discountBusy === r.id}
                                            className="text-[10px] text-brand hover:underline disabled:opacity-50"
                                          >
                                            {discountBusy === r.id ? "Saving…" : "Apply"}
                                          </button>
                                          <button
                                            onClick={() => setDiscountFor(null)}
                                            className="text-[10px] text-text-muted hover:underline"
                                          >
                                            Cancel
                                          </button>
                                        </span>
                                      ) : (
                                        <span className="block text-[10px] text-text-muted mt-1">
                                          <button
                                            onClick={() => {
                                              setDiscountFor(r.id);
                                              setDiscountInput(r.discountCode ?? "");
                                            }}
                                            className="text-brand hover:underline"
                                          >
                                            {r.discountCode ? "Change discount" : "Apply discount"}
                                          </button>
                                          {r.discountCode && (
                                            <>
                                              {" · "}
                                              <button
                                                onClick={() => setRegistrationDiscount(r, null)}
                                                disabled={discountBusy === r.id}
                                                className="text-brand hover:underline disabled:opacity-50"
                                              >
                                                remove
                                              </button>
                                            </>
                                          )}
                                        </span>
                                      ))}
                                    {r.status === "PAID" && (
                                      <button
                                        onClick={() => resendReceipt(r)}
                                        disabled={recording === r.id}
                                        className="block text-[10px] text-brand hover:underline mt-1 disabled:opacity-50"
                                      >
                                        {recording === r.id ? "Sending…" : "Resend receipt"}
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
                            <td className="py-2.5 text-right">
                              {r.status !== "CANCELED" && (
                                <button
                                  onClick={() => removeRegistration(r)}
                                  disabled={removing === r.id}
                                  title="Remove from this event's registration and billing list"
                                  className="text-[10px] text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-50"
                                >
                                  {removing === r.id ? "Removing…" : "Remove"}
                                </button>
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


// Tiny image focal-point picker. The owner clicks/drags inside the preview
// box; we store the chosen point as 0–100% on each axis. The public event
// page applies it via CSS `object-position` so the existing image file is
// reused as-is — no re-encoding, no extra storage. Mirrors the public
// page's aspect ratio (16:9) so what you set is what you see.
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
