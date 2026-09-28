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
import Link from "next/link";
import PublicLinkBox from "@/components/events/PublicLinkBox";
import type { EventMoneySummary } from "@/lib/eventAttendees";
import { DEFAULT_EXTRA_ENTRY_LABEL } from "@/lib/eventCategories";

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
  // B11 slice 3 — Attendees is the one roster + money screen. The old
  // Bookings and Registrations modals are gone; `add` opens it with
  // "+ Add attendee" expanded.
  const [viewingAttendees, setViewingAttendees] = useState<{ id: string; add: boolean } | null>(null);
  // B16 — the editor was opened on a fresh duplicate.
  const [editingCopy, setEditingCopy] = useState(false);
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
  //   ?event=<id> — opens that event's Attendees screen.
  //   ?edit=<id>  — opens that event's edit modal (calendar day detail).
  useEffect(() => {
    if (loading || events.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get("event");
    if (eventId && events.some((e) => e.id === eventId)) {
      setViewingAttendees({ id: eventId, add: false });
    }
    const editId = params.get("edit");
    if (editId) {
      const ev = events.find((e) => e.id === editId);
      if (ev) { setEditing(ev); setEditingCopy(params.get("copied") === "1"); }
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
    if (!res.ok) { alert("Could not duplicate this event."); return; }
    // Straight into the editor on the copy, flagged as a copy so the name,
    // dates and charge date are the first thing the owner changes.
    const copy = await res.json().catch(() => null);
    if (copy?.id) window.location.href = `/dashboard/events?edit=${copy.id}&copied=1`;
    else load();
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
            return (
              <div key={e.id} className="relative">
                <EventRow
                  event={e}
                  view={rowView}
                  type={td}
                  publish={pubStatus}
                  pricing={pricing}
                  acceptedMemberships={acceptedMemberships}
                  onAttendees={() => setViewingAttendees({ id: e.id, add: false })}
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
                        onClick={() => { setActionMenuFor(null); setViewingAttendees({ id: e.id, add: false }); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Attendees{e.money ? ` (${e.money.attendees})` : ""}
                      </button>
                      {/* B16 — the roster grid (empty-state explains how to set one up). */}
                      <Link
                        href={`/dashboard/events/${e.id}/roster`}
                        onClick={() => setActionMenuFor(null)}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        Roster grid
                      </Link>
                      <button
                        onClick={() => { setActionMenuFor(null); setViewingAttendees({ id: e.id, add: true }); }}
                        className="block w-full text-left px-3 py-3 text-sm text-text-primary hover:bg-app-bg rounded-lg"
                      >
                        + Add attendee
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
          isCopy={editingCopy}
          onClose={() => { setShowAdd(false); setEditing(null); setEditingCopy(false); }}
          onSaved={() => { setShowAdd(false); setEditing(null); setEditingCopy(false); load(); }}
        />
      )}

      {viewingAttendees && (
        <AttendeesModal
          eventId={viewingAttendees.id}
          initialAdd={viewingAttendees.add}
          onClose={(changed) => { setViewingAttendees(null); if (changed) load(); }}
        />
      )}
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
              <button
                type="button"
                onClick={() =>
                  setTypeCategories((cs) => [...cs, { key: `category${cs.length + 1}`, label: "", optionsText: "" }])
                }
                className="text-[10px] px-2 py-1 rounded-full border border-app-border text-text-muted hover:bg-app-bg"
              >
                + Dropdown
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
