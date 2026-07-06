"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Users, FileText } from "lucide-react";
import StripeRequiredBanner from "@/components/StripeRequiredBanner";
import ImageUpload from "@/components/ImageUpload";
import ExportMenu from "@/components/ExportMenu";
import PageHeader from "@/components/PageHeader";
import MembersTabs from "@/components/MembersTabs";
import { SkeletonList } from "@/components/LoadingSkeleton";
import {
  DEFAULT_MEMBER_FORM_CONFIG,
  isFieldEnabled,
  isFieldRequired,
  type MemberFormConfig,
  type MemberFormFieldKey,
} from "@/lib/memberForm";

type GuardianProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

type Member = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: "ACTIVE" | "PROSPECT" | "INACTIVE" | "PAUSED";
  tags: string;
  dateOfBirth: string | null;
  notes: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  gender: string | null;
  customFieldValues: string;
  joinedAt: string;
  isMinor: boolean;
  guardianId: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianRelationship: string | null;
  guardian?: GuardianProfile | null;
  membership?: { name: string } | null;
  subscriptions?: { id: string; status: string; membership: { name: string }; optionLabel: string }[];
  // P4 parental controls — present on Member after migration 20260610.
  // Owners use these to lock a minor's DOB and (later) gate paid actions.
  birthdayLockedAt?: string | null;
  parentControls?: {
    requirePaymentApproval?: boolean;
    monitoredMessaging?: boolean;
    allowPackagePurchase?: boolean;
    dailySpendLimit?: number;
  } | null;
  // Onboarding / activation tracking (returned by /api/members).
  migrationStatus?: string | null;
  activationKind?: string | null;
  activatedAt?: string | null;
  migrationCompletedAt?: string | null;
  activationEmailSentAt?: string | null;
  legacyMembershipName?: string | null;
  userId?: string | null;
  trialEndsAt?: string | null;
};

type CustomField = { id: string; label: string; fieldType: string; required: boolean; options: string };
type Membership = { id: string; name: string; options: string; active: boolean; autoRenewDefault: boolean };
type Option = { label: string; price: number; billingPeriod: string };

const statusColors: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: "var(--color-success)", fg: "#1F1F23" },
  PROSPECT: { bg: "var(--color-primary)", fg: "#fff" },
  INACTIVE: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  PAUSED: { bg: "var(--color-warning)", fg: "#fff" },
  MIGRATING: { bg: "#1F1F23", fg: "#fff" },
  PENDING: { bg: "#EDEBFF", fg: "#4F46E5" },
};
const statusLabels: Record<string, string> = {
  ACTIVE: "Active",
  PROSPECT: "Prospect",
  INACTIVE: "Inactive",
  PAUSED: "Paused",
  MIGRATING: "Migrating",
  PENDING: "Pending",
};

// Membership status as the owner should read it. Members mid-migration sit as
// PROSPECT in the DB (enum has no extra value) but they are NOT funnel
// prospects — they're existing members being switched over. Surface them as
// their own "Migrating" bucket so Prospect means "never had a membership".
function displayStatusOf(m: Member): string {
  if (m.status === "PROSPECT" && m.migrationStatus && m.migrationStatus !== "COMPLETED") {
    return "MIGRATING";
  }
  // An ACTIVE account with no active paid membership is really a Prospect
  // (Kelly's case). A purchase mid-flight shows as Pending; a live staff-granted
  // trial keeps Active.
  if (m.status === "ACTIVE") {
    const hasActive = m.subscriptions?.some((s) => s.status === "active");
    const inTrial = !!m.trialEndsAt && new Date(m.trialEndsAt) > new Date();
    if (!hasActive && !inTrial) {
      return m.subscriptions?.some((s) => s.status === "pending") ? "PENDING" : "PROSPECT";
    }
  }
  return m.status;
}

// ── Onboarding status (derived from migration/activation fields) ────────────
type OnboardingStatus = "NONE" | "INVITED" | "ACTIVATED" | "COMPLETED";
function onboardingStatusOf(m: Member): OnboardingStatus {
  if (m.migrationCompletedAt || m.migrationStatus === "COMPLETED") return "COMPLETED";
  // A linked portal login means the profile exists even outside the migration
  // wizard (e.g. self-signup members).
  if (m.activatedAt || m.migrationStatus === "ACTIVATED" || m.userId) return "ACTIVATED";
  if (m.migrationStatus === "INVITED" || m.activationEmailSentAt) return "INVITED";
  return "NONE";
}
const onboardingLabels: Record<OnboardingStatus, string> = {
  NONE: "Un-invited",
  INVITED: "Invited",
  ACTIVATED: "Profile completed",
  COMPLETED: "Completed",
};
const onboardingColors: Record<OnboardingStatus, { bg: string; fg: string }> = {
  NONE: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  INVITED: { bg: "var(--color-warning)", fg: "#fff" },
  ACTIVATED: { bg: "var(--color-primary)", fg: "#fff" },
  COMPLETED: { bg: "var(--color-success)", fg: "#1F1F23" },
};

// ── API error formatter ────────────────────────────────────────────────────
// API errors arrive as: a string, a Zod flatten() result ({ formErrors, fieldErrors }),
// a Zod issue array, or some other object. Coerce to a single human-readable line.
function formatApiError(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  if (Array.isArray(err)) {
    const issue = err[0] as { message?: string; path?: string[] } | undefined;
    if (issue?.message) {
      const f = issue.path?.length ? `${issue.path.join(".")}: ` : "";
      return `${f}${issue.message}`;
    }
  }
  if (err && typeof err === "object") {
    const e = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    if (e.formErrors?.length) return e.formErrors[0];
    if (e.fieldErrors) {
      const first = Object.entries(e.fieldErrors)[0];
      if (first) return `${first[0]}: ${first[1]?.[0] ?? "invalid"}`;
    }
    if ((err as { error?: string }).error) return String((err as { error: string }).error);
  }
  return fallback;
}

// ── Simple CSV parser ──────────────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some((f) => f)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some((f) => f)) rows.push(row); }
  return rows;
}

const MEMBER_FIELDS = [
  { key: "athleteName",          label: "Athlete name (full)",   required: false },
  { key: "firstName",            label: "First name",            required: false },
  { key: "lastName",             label: "Last name",             required: false },
  { key: "email",                label: "Email",                 required: false },
  { key: "phone",                label: "Phone",                 required: false },
  { key: "dateOfBirth",          label: "Date of birth",         required: false },
  { key: "gender",               label: "Gender",                required: false },
  { key: "streetAddress",        label: "Street address",        required: false },
  { key: "city",                 label: "City",                  required: false },
  { key: "state",                label: "State",                 required: false },
  { key: "zipCode",              label: "Zip code",              required: false },
  { key: "status",               label: "Status",                required: false },
  { key: "tags",                 label: "Tags",                  required: false },
  { key: "notes",                label: "Notes",                 required: false },
  { key: "isMinor",              label: "Minor (yes/no)",        required: false },
  { key: "guardianName",         label: "Guardian name",         required: false },
  { key: "guardianEmail",        label: "Guardian email",        required: false },
  { key: "guardianPhone",        label: "Guardian phone",        required: false },
  { key: "guardianRelationship", label: "Guardian relationship", required: false },
  { key: "skip",                 label: "— Skip column —",       required: false },
];

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [subscribing, setSubscribing] = useState<Member | null>(null);
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [membershipFilter, setMembershipFilter] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [ageFilter, setAgeFilter] = useState("");
  const [customFieldFilter, setCustomFieldFilter] = useState("");
  const [customFieldValue, setCustomFieldValue] = useState("");
  const [onboardingFilter, setOnboardingFilter] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMessaging, setBulkMessaging] = useState(false);
  const [formConfig, setFormConfig] = useState<MemberFormConfig>(DEFAULT_MEMBER_FORM_CONFIG);
  const [formCustomized, setFormCustomized] = useState<boolean>(false);

  async function load() {
    setLoading(true);
    const [mRes, fRes, cRes] = await Promise.all([
      fetch("/api/members"),
      fetch("/api/custom-fields"),
      fetch("/api/club/member-form"),
    ]);
    if (mRes.ok) setMembers(await mRes.json());
    if (fRes.ok) setCustomFields(await fRes.json());
    if (cRes.ok) {
      const d = await cRes.json();
      setFormConfig(d.config);
      setFormCustomized(!!d.isCustomized);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filtered = members.filter((m) => {
    if (filter !== "ALL" && displayStatusOf(m) !== filter) return false;
    if (tagFilter && !m.tags.split(",").map((t) => t.trim()).includes(tagFilter)) return false;
    const activeSub = m.subscriptions?.find((s) => s.status === "active");
    if (membershipFilter && activeSub?.membership.name !== membershipFilter && m.membership?.name !== membershipFilter) return false;
    if (genderFilter && m.gender !== genderFilter) return false;
    if (ageFilter === "minor" && !m.isMinor) return false;
    if (ageFilter === "adult" && m.isMinor) return false;
    if (onboardingFilter && onboardingStatusOf(m) !== onboardingFilter) return false;
    if (customFieldFilter && customFieldValue) {
      let values: Record<string, string> = {};
      try { values = JSON.parse(m.customFieldValues || "{}"); } catch {}
      if ((values[customFieldFilter] || "").toLowerCase() !== customFieldValue.toLowerCase()) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      return [
        m.firstName,
        m.lastName,
        m.email || "",
        m.phone || "",
        m.guardianName || "",
        m.guardianEmail || "",
        m.guardianPhone || "",
        m.tags,
      ].some((v) => v.toLowerCase().includes(q));
    }
    return true;
  });

  const allTags = Array.from(new Set(members.flatMap((m) => m.tags.split(",").map((t) => t.trim()).filter(Boolean)))).sort();
  const allMemberships = Array.from(new Set(members.flatMap((m) => [
    m.membership?.name,
    ...(m.subscriptions || []).filter((s) => s.status === "active").map((s) => s.membership.name),
  ]).filter(Boolean) as string[])).sort();
  const allGenders = Array.from(new Set(members.map((m) => m.gender).filter(Boolean) as string[])).sort();

  const counts = {
    ALL: members.length,
    ACTIVE: members.filter((m) => displayStatusOf(m) === "ACTIVE").length,
    MIGRATING: members.filter((m) => displayStatusOf(m) === "MIGRATING").length,
    PROSPECT: members.filter((m) => displayStatusOf(m) === "PROSPECT").length,
    INACTIVE: members.filter((m) => displayStatusOf(m) === "INACTIVE").length,
    PAUSED: members.filter((m) => displayStatusOf(m) === "PAUSED").length,
  };

  async function handleDelete(id: string) {
    if (!confirm("Remove this member?")) return;
    const res = await fetch(`/api/members/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function bulkDelete() {
    const n = selectedIds.size;
    if (!confirm(`Remove ${n} member${n === 1 ? "" : "s"}? This can't be undone from here.`)) return;
    const res = await fetch("/api/members/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", memberIds: Array.from(selectedIds) }),
    });
    if (res.ok) { setSelectedIds(new Set()); load(); }
    else alert("Bulk delete failed");
  }

  // Send the FREE, no-payment onboarding link (activationKind=JOIN) to the
  // selected members. Reuses the existing /api/members/bulk send_registration_link
  // path so there is a single bulk-onboarding implementation. No membership
  // purchase is forced — this is for existing families verifying/updating info.
  async function bulkSendOnboarding() {
    const n = selectedIds.size;
    if (!confirm(`Send a no-payment onboarding link to ${n} selected ${n === 1 ? "person" : "people"}? They can verify their info and set up a free account — no membership purchase required. Anyone who already has an active membership is skipped.`)) return;
    const res = await fetch("/api/members/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send_registration_link", memberIds: Array.from(selectedIds) }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      const skipped = Array.isArray(d.skipped) ? d.skipped.length : 0;
      alert(`Sent ${d.sent ?? 0} onboarding link${(d.sent ?? 0) === 1 ? "" : "s"}.${skipped ? ` ${skipped} skipped (already a member or no email on file).` : ""}`);
      setSelectedIds(new Set());
      load();
    } else {
      alert(typeof d.error === "string" ? d.error : "Failed to send onboarding links");
    }
  }

  // Quick-select helpers for onboarding outreach: one click selects everyone in
  // a segment so the owner can "Send onboarding link" without hand-picking rows.
  // Both exclude mid-migration members: they get ACTIVATION links from the
  // Migration tool, not the free-join onboarding link — sending both would
  // cross the two flows.
  function selectAllProspects() {
    setFilter("PROSPECT");
    setSelectedIds(new Set(members.filter((m) => displayStatusOf(m) === "PROSPECT").map((m) => m.id)));
  }
  function selectAllNonActive() {
    setFilter("ALL");
    setSelectedIds(new Set(members.filter((m) => m.status !== "ACTIVE" && displayStatusOf(m) !== "MIGRATING").map((m) => m.id)));
  }

  async function acceptDefaults() {
    await fetch("/api/club/member-form", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(DEFAULT_MEMBER_FORM_CONFIG),
    });
    load();
  }

  // First-run gate: no members yet AND form is at default → must set up the intake form first.
  const showSetupGate = !loading && members.length === 0 && !formCustomized;

  if (showSetupGate) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-semibold text-text-primary mb-2">Set up your member intake form</h1>
        <p className="text-sm text-text-muted mb-6">
          Before you add your first athlete, decide what you want to collect. By default we only ask for
          Athlete name and Email — pick any extra fields (phone, address, gender, guardian info, etc.) and
          mark which ones are required for your club. You can change this any time, and CSV imports will
          enforce the same required fields.
        </p>
        <div className="flex gap-2">
          <a
            href="/dashboard/settings/member-form"
            className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
          >
            Set up the form →
          </a>
          <button
            onClick={acceptDefaults}
            className="px-5 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg"
          >
            Keep the defaults
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      <MembersTabs />
      <StripeRequiredBanner feature="charge members for memberships" />

      <PageHeader
        title="Members"
        description={`${members.length} total`}
        actions={
          <>
            <a href="/dashboard/settings/member-form" className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
              Form settings
            </a>
            <a href="/dashboard/custom-fields" className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
              Custom fields
            </a>
            <ExportMenu baseUrl="/api/export/members" label="Export" />
            <Link href="/dashboard/members/migration" className="text-sm px-3 py-2 rounded-lg border border-brand text-brand hover:bg-brand/10">
              Import / Migrate
            </Link>
            <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">
              + Add member
            </button>
          </>
        }
      />

      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 bg-app-bg rounded-lg p-1">
          {(["ALL", "ACTIVE", "MIGRATING", "PROSPECT", "INACTIVE", "PAUSED"] as const).map((s) => (
            <button key={s} onClick={() => setFilter(s)} className={`text-xs px-3 py-1.5 rounded-md transition ${filter === s ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}>
              {s === "ALL" ? "All" : statusLabels[s]} ({counts[s]})
            </button>
          ))}
        </div>
        <input type="text" placeholder="Search name, email, phone, guardian…" value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 max-w-xs px-3 py-1.5 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All tags</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={membershipFilter} onChange={(e) => setMembershipFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All memberships</option>
          {allMemberships.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={genderFilter} onChange={(e) => setGenderFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All genders</option>
          {allGenders.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={ageFilter} onChange={(e) => setAgeFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All ages</option>
          <option value="minor">Minors</option>
          <option value="adult">Adults</option>
        </select>
        <select value={onboardingFilter} onChange={(e) => setOnboardingFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All onboarding</option>
          <option value="NONE">Un-invited</option>
          <option value="INVITED">Invited</option>
          <option value="ACTIVATED">Profile completed</option>
          <option value="COMPLETED">Completed</option>
        </select>
        <select value={customFieldFilter} onChange={(e) => { setCustomFieldFilter(e.target.value); setCustomFieldValue(""); }} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">Custom field</option>
          {customFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        {customFieldFilter && (
          <input value={customFieldValue} onChange={(e) => setCustomFieldValue(e.target.value)} placeholder="Custom field value" className="px-3 py-2 border border-app-border rounded-lg text-sm" />
        )}
      </div>

      {/* Onboarding outreach quick-select — one click selects a whole segment so
          the owner can send the no-payment onboarding link without hand-picking. */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-text-muted">Onboarding outreach:</span>
        <button onClick={selectAllProspects} className="text-xs px-3 py-1.5 rounded-md bg-surface border border-app-border text-text-primary hover:bg-app-bg">
          Select all prospects ({counts.PROSPECT})
        </button>
        <button onClick={selectAllNonActive} className="text-xs px-3 py-1.5 rounded-md bg-surface border border-app-border text-text-primary hover:bg-app-bg">
          Select all non-active ({counts.ALL - counts.ACTIVE})
        </button>
        <span className="text-[11px] text-text-muted">then “Send onboarding link”.</span>
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-4 flex items-center gap-3 bg-app-bg border border-app-border rounded-lg px-3 py-2">
          <span className="text-sm text-text-primary">{selectedIds.size} selected</span>
          <a
            href={`/api/export/members?ids=${encodeURIComponent(Array.from(selectedIds).join(","))}`}
            className="text-sm px-3 py-1.5 rounded-md bg-surface border border-app-border text-text-primary hover:bg-app-bg"
          >
            Export selected
          </a>
          <button
            onClick={() => setBulkMessaging(true)}
            className="text-sm px-3 py-1.5 rounded-md bg-surface border border-app-border text-text-primary hover:bg-app-bg"
          >
            Message selected
          </button>
          <button
            onClick={bulkSendOnboarding}
            className="text-sm px-3 py-1.5 rounded-md bg-surface border border-app-border text-text-primary hover:bg-app-bg"
          >
            Send onboarding link
          </button>
          <button
            onClick={bulkDelete}
            className="text-sm px-3 py-1.5 rounded-md bg-surface border border-red-200 text-red-600 hover:bg-red-50"
          >
            Delete selected
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-sm text-text-muted hover:text-text-primary">Clear</button>
        </div>
      )}

      {/* overflow-x-auto: the members table is wider than a phone/tablet
          viewport — without a scroll container the row actions are unreachable. */}
      <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
        <div className="overflow-x-auto">
        {loading ? (
          <SkeletonList rows={6} />
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
              <Users className="h-7 w-7" strokeWidth={2} />
            </div>
            <h3 className="text-lg font-medium text-text-primary mb-1">No members yet</h3>
            <p className="text-sm text-text-muted mb-4">Add your first member or import your roster from a CSV file.</p>
            <div className="flex gap-2 justify-center">
              <Link href="/dashboard/members/migration" className="px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Import / Migrate</Link>
              <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Add member</button>
            </div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((m) => selectedIds.has(m.id))}
                    onChange={(e) => setSelectedIds(e.target.checked ? new Set(filtered.map((m) => m.id)) : new Set())}
                  />
                </Th>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Onboarding</Th>
                <Th>Tags</Th>
                <Th>Membership</Th>
                <Th>Joined</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const ds = displayStatusOf(m);
                const c = statusColors[ds] ?? statusColors.PROSPECT;
                const activeSub = m.subscriptions?.find((s) => s.status === "active");
                return (
                  <tr key={m.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <Td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(m.id)}
                        onChange={() => setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        })}
                      />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0 overflow-hidden">
                          {(m as any).profileImageUrl
                            ? <img src={(m as any).profileImageUrl} alt="" className="w-full h-full object-cover" />
                            : <>{m.firstName[0]}{m.lastName[0]}</>
                          }
                        </div>
                        <div>
                          <Link href={`/dashboard/members/${m.id}`} className="text-sm font-medium text-text-primary hover:underline">
                            {m.firstName} {m.lastName}
                          </Link>
                          {m.email && <div className="text-xs text-text-muted">{m.email}</div>}
                          {m.isMinor && (
                            <div className="text-xs text-text-muted flex items-center gap-1">
                              <span>Minor</span>
                              {m.guardianName && <span>· Guardian: {m.guardianName}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-flex items-center whitespace-nowrap text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
                          {statusLabels[ds] ?? ds}
                        </span>
                        {/* Purchase mid-flight — make clear nothing has been charged yet.
                            (A true Prospect needs no chip; the pill already says so.) */}
                        {ds === "PENDING" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-accent/20 text-text-primary whitespace-nowrap" title="A membership purchase is in progress — nothing has been charged yet.">
                            not charged
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td>
                      {(() => {
                        const os = onboardingStatusOf(m);
                        const oc = onboardingColors[os];
                        return (
                          <span className="inline-flex items-center whitespace-nowrap text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: oc.bg, color: oc.fg }}>
                            {onboardingLabels[os]}
                          </span>
                        );
                      })()}
                    </Td>
                    <Td>
                      <div className="flex gap-1 flex-wrap">
                        {m.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                          <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-primary">{t}</span>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      {activeSub ? (
                        <div>
                          <div className="text-sm text-text-primary">{activeSub.membership.name}</div>
                          <div className="text-[10px] text-text-muted">{activeSub.optionLabel}</div>
                        </div>
                      ) : ds === "MIGRATING" && m.legacyMembershipName ? (
                        <div title="Imported plan from the previous software — billing starts after activation & approval.">
                          <div className="text-sm text-text-primary">{m.legacyMembershipName}</div>
                          <div className="text-[10px] text-text-muted">migrating from previous software</div>
                        </div>
                      ) : (m as { trialEndsAt?: string | null }).trialEndsAt &&
                        new Date((m as { trialEndsAt?: string | null }).trialEndsAt!) > new Date() ? (
                        <div title="Active free trial — behaves like a membership until it ends.">
                          <div className="text-sm text-text-primary">Free trial</div>
                          <div className="text-[10px] text-text-muted">
                            until {new Date((m as { trialEndsAt?: string | null }).trialEndsAt!).toLocaleDateString()}
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => setSubscribing(m)} className="text-xs px-2 py-1 rounded text-text-muted hover:bg-app-bg">
                          + Purchase membership
                        </button>
                      )}
                    </Td>
                    <Td>
                      <span className="text-sm text-text-muted">{new Date(m.joinedAt).toLocaleDateString()}</span>
                    </Td>
                    <Td>
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => setEditing(m)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                        <button onClick={() => handleDelete(m.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Remove</button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </div>
      </div>

      {(showAdd || editing) && (
        <MemberModal member={editing} customFields={customFields} formConfig={formConfig} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={() => { setShowAdd(false); setEditing(null); load(); }} />
      )}

  {subscribing && <PurchaseMembershipModal member={subscribing} onClose={() => setSubscribing(null)} />}

      {bulkMessaging && (
        <BulkMessageModal
          memberIds={Array.from(selectedIds)}
          onClose={() => setBulkMessaging(false)}
          onSent={() => { setBulkMessaging(false); setSelectedIds(new Set()); }}
        />
      )}
    </div>
  );
}

function BulkMessageModal({ memberIds, onClose, onSent }: { memberIds: string[]; onClose: () => void; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; skipped: { reason: string }[] } | null>(null);
  const [error, setError] = useState("");

  async function send() {
    if (!body.trim()) { setError("Write a message first."); return; }
    setSending(true);
    setError("");
    const res = await fetch("/api/members/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "message", memberIds, body: body.trim() }),
    });
    setSending(false);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setError(typeof d.error === "string" ? d.error : "Send failed"); return; }
    setResult({ sent: d.sent ?? 0, skipped: d.skipped ?? [] });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Message {memberIds.length} member{memberIds.length === 1 ? "" : "s"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          {result ? (
            <>
              <p className="text-sm text-text-primary">
                Sent to {result.sent} member{result.sent === 1 ? "" : "s"}.
                {result.skipped.length > 0 && ` ${result.skipped.length} skipped (no linked portal account).`}
              </p>
              <button onClick={onSent} className="w-full px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Done</button>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted">
                Sends a direct message to each selected member (and the guardian for minors). Members without a portal account are skipped.
              </p>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder="Your message…"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface resize-none"
              />
              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
                <button onClick={send} disabled={sending} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-3">{children}</td>;
}

// ── Member Modal ─────────────────────────────────────────────────────────────
function MemberModal({ member, customFields, formConfig, onClose, onSaved }: { member: Member | null; customFields: CustomField[]; formConfig: MemberFormConfig; onClose: () => void; onSaved: () => void }) {
  const fieldEnabled = (k: MemberFormFieldKey) => isFieldEnabled(formConfig, k);
  const fieldRequired = (k: MemberFormFieldKey) => isFieldRequired(formConfig, k);
  const isEdit = !!member;
  const initialCustomValues = (() => { try { return JSON.parse(member?.customFieldValues || "{}"); } catch { return {}; } })();

  const athleteName = member ? `${member.firstName} ${member.lastName}`.trim() : "";
  const [fullName, setFullName] = useState(athleteName);
  const [email, setEmail] = useState(member?.email || "");
  const [phone, setPhone] = useState(member?.phone || "");
  const [gender, setGender] = useState(member?.gender || "");
  const [streetAddress, setStreetAddress] = useState(member?.streetAddress || "");
  const [city, setCity]                   = useState(member?.city || "");
  const [state, setState]                 = useState(member?.state || "");
  const [zipCode, setZipCode]             = useState(member?.zipCode || "");
  const [status, setStatus] = useState(member?.status || "PROSPECT");
  const [tags, setTags] = useState(member?.tags || "");
  const [dateOfBirth, setDateOfBirth] = useState(member?.dateOfBirth ? new Date(member.dateOfBirth).toISOString().slice(0, 10) : "");
  const [notes, setNotes] = useState(member?.notes || "");
  const [isMinor, setIsMinor] = useState(member?.isMinor || false);
  const [guardianName, setGuardianName] = useState(member?.guardianName || "");
  const [guardianEmail, setGuardianEmail] = useState(member?.guardianEmail || "");
  const [guardianPhone, setGuardianPhone] = useState(member?.guardianPhone || "");
  const [guardianRelationship, setGuardianRelationship] = useState(member?.guardianRelationship || "");
  const [profileImageUrl, setProfileImageUrl] = useState((member as any)?.profileImageUrl || "");
  // P4 — DOB lock is parent-only. Owner cannot toggle it from this
  // modal; the field becomes read-only when set. See render below.
  const [customValues, setCustomValues] = useState<Record<string, string>>(initialCustomValues);
  const [siblings, setSiblings] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Look up siblings when guardian email changes — server matches both
  // legacy inline guardianEmail and the normalized Guardian profile email.
  useEffect(() => {
    if (!isMinor || !guardianEmail) { setSiblings([]); return; }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/members?guardianEmail=${encodeURIComponent(guardianEmail)}`);
      if (res.ok) {
        const all: Member[] = await res.json();
        setSiblings(all.filter((m) => m.id !== member?.id));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [guardianEmail, isMinor, member?.id]);

  function splitName(name: string) {
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ") || parts[0] || "";
    return { firstName, lastName };
  }

  function setCV(id: string, value: string) { setCustomValues({ ...customValues, [id]: value }); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const url = isEdit ? `/api/members/${member!.id}` : "/api/members";
    const method = isEdit ? "PATCH" : "POST";
    const { firstName, lastName } = splitName(fullName);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName, lastName, email: email || null,
        phone: phone || null,
        gender: gender || null,
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        status, tags,
        dateOfBirth: dateOfBirth || undefined,
        notes,
        customFieldValues: customValues,
        profileImageUrl: profileImageUrl || null,
        isMinor,
        guardianName: isMinor ? guardianName : undefined,
        guardianEmail: isMinor ? guardianEmail : undefined,
        guardianPhone: isMinor ? guardianPhone : undefined,
        guardianRelationship: isMinor ? guardianRelationship : undefined,
        // P4 — birthdayLocked intentionally NOT sent. Owner cannot
        // toggle the lock from this modal anymore; only the parent's
        // family-controls page sets it.
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(formatApiError(data.error, "Save failed"));
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit member" : "Add member"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {fieldEnabled("profileImageUrl") && (
            <ImageUpload
              label="Profile photo"
              value={profileImageUrl || null}
              onChange={setProfileImageUrl}
              shape="circle"
            />
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              Athlete name <span className="text-red-500">*</span>
            </label>
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="First Last" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          {fieldEnabled("email") && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">
                Email {fieldRequired("email") && !isMinor && <span className="text-red-500">*</span>}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={fieldRequired("email") && !isMinor}
                placeholder={isMinor ? "Optional for minors" : "athlete@example.com"}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <p className="text-xs text-text-muted mt-1">
                {isMinor ? "Guardian email is used as primary contact for minors" : "Used to link their member portal account"}
              </p>
            </div>
          )}

          {(fieldEnabled("phone") || fieldEnabled("gender")) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {fieldEnabled("phone") && (
                <div className={fieldEnabled("gender") ? "" : "col-span-2"}>
                  <label className="block text-sm font-medium text-text-primary mb-1">Phone {fieldRequired("phone") && !isMinor && <span className="text-red-500">*</span>}</label>
                  <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required={fieldRequired("phone") && !isMinor} placeholder={isMinor ? "Optional for minors" : "(555) 000-0000"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
              )}
              {fieldEnabled("gender") && (
                <div className={fieldEnabled("phone") ? "" : "col-span-2"}>
                  <label className="block text-sm font-medium text-text-primary mb-1">Gender {fieldRequired("gender") && <span className="text-red-500">*</span>}</label>
                  <select value={gender} onChange={(e) => setGender(e.target.value)} required={fieldRequired("gender")} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                    <option value="">Prefer not to say</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Non-binary">Non-binary</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {fieldEnabled("streetAddress") && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Street address {fieldRequired("streetAddress") && <span className="text-red-500">*</span>}</label>
              <input type="text" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} required={fieldRequired("streetAddress")} placeholder="123 Main St" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          )}

          {(fieldEnabled("city") || fieldEnabled("state") || fieldEnabled("zipCode")) && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {fieldEnabled("city") && (
                <div className="col-span-1">
                  <label className="block text-sm font-medium text-text-primary mb-1">City {fieldRequired("city") && <span className="text-red-500">*</span>}</label>
                  <input type="text" value={city} onChange={(e) => setCity(e.target.value)} required={fieldRequired("city")} placeholder="Springfield" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
              )}
              {fieldEnabled("state") && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">State {fieldRequired("state") && <span className="text-red-500">*</span>}</label>
                  <input type="text" value={state} onChange={(e) => setState(e.target.value)} required={fieldRequired("state")} placeholder="IL" maxLength={2} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
              )}
              {fieldEnabled("zipCode") && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Zip code {fieldRequired("zipCode") && <span className="text-red-500">*</span>}</label>
                  <input type="text" value={zipCode} onChange={(e) => setZipCode(e.target.value)} required={fieldRequired("zipCode")} placeholder="62701" maxLength={10} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
              )}
            </div>
          )}

          {fieldEnabled("status") && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                <option value="PROSPECT">Prospect</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="PAUSED">Paused</option>
              </select>
            </div>
          )}

          {fieldEnabled("dateOfBirth") && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">
                Date of birth {fieldRequired("dateOfBirth") && <span className="text-red-500">*</span>}
                {isEdit && member?.birthdayLockedAt && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-700 font-semibold">
                    Locked by parent
                  </span>
                )}
              </label>
              <input
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                required={fieldRequired("dateOfBirth")}
                disabled={isEdit && !!member?.birthdayLockedAt}
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand ${
                  isEdit && member?.birthdayLockedAt
                    ? "bg-app-bg border-app-border text-text-muted cursor-not-allowed"
                    : "border-app-border"
                }`}
              />
              {/* P4 correction — DOB lock is now parent-only. Owners no
                  longer have a toggle here; the lock is set by the
                  guardian from the family-controls page. Owner sees the
                  status only and cannot edit a locked DOB. Copy mirrors
                  what the member sees on /member/profile. */}
              {isEdit && member?.birthdayLockedAt && (
                <p className="text-[11px] text-amber-700 mt-1">
                  Parent-confirmed DOB is locked for athlete safety and
                  eligibility integrity.
                </p>
              )}
            </div>
          )}

          {/* Minor toggle */}
          {fieldEnabled("isMinor") && (
            <div className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
              <input type="checkbox" id="isMinor" checked={isMinor} onChange={(e) => setIsMinor(e.target.checked)} className="rounded" />
              <label htmlFor="isMinor" className="text-sm font-medium text-text-primary cursor-pointer select-none">This member is a minor (under 18)</label>
            </div>
          )}

          {isMinor && (
            <div className="space-y-3 p-4 bg-orange-accent/10 border border-orange-accent/30 rounded-lg">
              <p className="text-xs font-medium text-text-primary uppercase tracking-wider">Guardian / Parent Information</p>
              <p className="text-[11px] text-text-muted -mt-1">For minors we contact the guardian — a guardian name and email are required. The athlete&apos;s own email and phone are optional.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className={fieldEnabled("guardianRelationship") ? "" : "col-span-2"}>
                  <label className="block text-xs font-medium text-text-primary mb-1">Guardian name <span className="text-red-500">*</span></label>
                  <input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required={isMinor} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" placeholder="Full name" />
                </div>
                {fieldEnabled("guardianRelationship") && (
                  <div>
                    <label className="block text-xs font-medium text-text-primary mb-1">Relationship {fieldRequired("guardianRelationship") && <span className="text-red-500">*</span>}</label>
                    <select value={guardianRelationship} onChange={(e) => setGuardianRelationship(e.target.value)} required={fieldRequired("guardianRelationship")} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none">
                      <option value="">Select…</option>
                      <option value="Parent">Parent</option>
                      <option value="Mother">Mother</option>
                      <option value="Father">Father</option>
                      <option value="Legal guardian">Legal guardian</option>
                      <option value="Grandparent">Grandparent</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Guardian email <span className="text-red-500">*</span></label>
                <input type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} required={isMinor} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" placeholder="guardian@email.com" />
                <p className="text-xs text-text-muted mt-1">The minor&apos;s primary contact, and the email used to set up the parent&apos;s portal login.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Guardian phone</label>
                <input type="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" placeholder="(555) 000-0000" />
              </div>

              {siblings.length > 0 && (
                <div className="p-3 bg-surface border border-orange-accent/40 rounded-lg">
                  <p className="text-xs font-medium text-text-primary mb-2">Existing athletes under this guardian:</p>
                  <div className="space-y-1">
                    {siblings.map((s) => (
                      <div key={s.id} className="text-xs text-text-primary flex items-center gap-1.5">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-accent" aria-hidden />
                        {s.firstName} {s.lastName}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted mt-2">This athlete will be linked to the same guardian.</p>
                </div>
              )}
            </div>
          )}

          {fieldEnabled("tags") && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Tags {fieldRequired("tags") && <span className="text-red-500">*</span>}</label>
              <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} required={fieldRequired("tags")} placeholder="Beginner, 14U, Travel team" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              <p className="text-xs text-text-muted mt-1">Comma-separated</p>
            </div>
          )}

          {customFields.length > 0 && (
            <div className="pt-2 border-t border-app-border">
              <p className="text-xs uppercase tracking-wider text-text-muted mb-3 font-medium">Custom fields</p>
              <div className="space-y-3">
                {customFields.map((f) => {
                  const opts = (() => { try { return JSON.parse(f.options); } catch { return []; } })();
                  return (
                    <div key={f.id}>
                      <label className="block text-sm font-medium text-text-primary mb-1">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</label>
                      {f.fieldType === "textarea" ? (
                        <textarea value={customValues[f.id] || ""} onChange={(e) => setCV(f.id, e.target.value)} required={f.required} rows={3} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none" />
                      ) : f.fieldType === "select" ? (
                        <select value={customValues[f.id] || ""} onChange={(e) => setCV(f.id, e.target.value)} required={f.required} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                          <option value="">Select…</option>
                          {opts.map((o: string) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input type={f.fieldType === "number" ? "number" : f.fieldType === "date" ? "date" : f.fieldType === "email" ? "email" : f.fieldType === "phone" ? "tel" : "text"} value={customValues[f.id] || ""} onChange={(e) => setCV(f.id, e.target.value)} required={f.required} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {fieldEnabled("notes") && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Notes {fieldRequired("notes") && <span className="text-red-500">*</span>}</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} required={fieldRequired("notes")} rows={3} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none" />
            </div>
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Purchase Membership Modal ────────────────────────────────────────────────
function PurchaseMembershipModal({ member, onClose }: { member: Member; onClose: () => void }) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedMembership, setSelectedMembership] = useState("");
  const [selectedOption, setSelectedOption] = useState("");
  // Assignment controls
  const [billingType, setBillingType] = useState<"RECURRING" | "ONE_TIME" | "MANUAL">("RECURRING");
  const [autoRenew, setAutoRenew] = useState(true);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [billingDay, setBillingDay] = useState("");
  const [notes, setNotes] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [emailReceipt, setEmailReceipt] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/memberships").then((r) => r.json()).then((d) => {
      setMemberships(Array.isArray(d) ? d : []);
      setLoading(false);
    });
  }, []);

  const currentMembership = memberships.find((m) => m.id === selectedMembership);
  const options: Option[] = (() => { try { return JSON.parse(currentMembership?.options || "[]"); } catch { return []; } })();
  const selectedOptionObj = options.find((o) => o.label === selectedOption);
  const isOneTime = selectedOptionObj?.billingPeriod === "ONE_TIME";

  const periodLabels: Record<string, string> = {
    WEEKLY: "per week", MONTHLY: "per month", QUADRIMESTRAL: "per 4 months",
    QUARTERLY: "per 3 months", SEMI_ANNUAL: "per 6 months", ANNUAL: "per year", ONE_TIME: "one-time",
  };

  // When membership changes, reset billing type to match plan default
  function selectMembership(id: string) {
    setSelectedMembership(id);
    setSelectedOption("");
    const m = memberships.find((x) => x.id === id);
    if (m) setAutoRenew(m.autoRenewDefault);
  }

  async function handleSubmit() {
    setError("");
    setSubmitting(true);

    const resolvedBillingType = isOneTime ? "ONE_TIME" : billingType;

    const res = await fetch("/api/members/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberId: member.id,
        membershipId: selectedMembership,
        optionLabel: selectedOption,
        billingType: resolvedBillingType,
        autoRenew: resolvedBillingType === "MANUAL" ? false : autoRenew,
        startDate: startDate || null,
        endDate: endDate || null,
        billingDay: billingDay ? parseInt(billingDay, 10) : null,
        notes: notes || null,
        discountCode: discountCode.trim() || null,
        emailReceipt,
      }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) { setError(formatApiError(data.error, "Failed")); return; }

    // Manual assignment completes immediately
    if (data.type === "manual") { setDone(true); return; }

    // Stripe checkout
    if (data.url) { window.location.href = data.url; return; }

    setError("Unexpected response from server");
  }

  if (done) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
        <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-sm p-8 text-center">
          <div className="text-3xl mb-2">✓</div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Membership assigned</h3>
          <p className="text-sm text-text-muted mb-6">{member.firstName} {member.lastName} is now enrolled in {currentMembership?.name}.</p>
          <button onClick={onClose} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">Assign membership</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          {/* Member header */}
          <div className="flex items-center gap-2 pb-2 border-b border-app-border">
            <div className="w-9 h-9 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0">
              {member.firstName[0]}{member.lastName[0]}
            </div>
            <div>
              <div className="text-sm font-medium text-text-primary">{member.firstName} {member.lastName}</div>
              {member.email && <div className="text-xs text-text-muted">{member.email}</div>}
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-text-muted text-center py-4">Loading plans…</div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Membership plan</label>
                <select value={selectedMembership} onChange={(e) => selectMembership(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                  <option value="">Select a plan…</option>
                  {memberships.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              {selectedMembership && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Purchase option</label>
                  <select value={selectedOption} onChange={(e) => setSelectedOption(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                    <option value="">Select an option…</option>
                    {options.map((o) => (
                      <option key={o.label} value={o.label}>
                        {o.label} — ${o.price.toFixed(2)} {periodLabels[o.billingPeriod] ? `(${periodLabels[o.billingPeriod]})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {selectedOption && !isOneTime && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Payment method</label>
                  <div className="flex gap-2">
                    {(["RECURRING", "MANUAL"] as const).map((t) => (
                      <button key={t} type="button" onClick={() => setBillingType(t)} className={`flex-1 py-2 rounded-lg text-sm border transition ${billingType === t ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                        {t === "RECURRING" ? "Stripe Checkout" : "Manual / Cash"}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    {billingType === "RECURRING" ? "Sends a Stripe payment link. Auto-bills on the billing cycle." : "Records enrollment immediately. You handle payment outside AthletixOS."}
                  </p>
                </div>
              )}

              {selectedOption && (
                <>
                  {/* Auto-renew — only relevant for recurring */}
                  {billingType === "RECURRING" && !isOneTime && (
                    <div className="flex items-center justify-between py-2 border border-app-border rounded-lg px-3">
                      <div>
                        <p className="text-sm font-medium text-text-primary">Auto-renew</p>
                        <p className="text-xs text-text-muted">Cancel at period end if off</p>
                      </div>
                      <button type="button" onClick={() => setAutoRenew(!autoRenew)} className={`relative inline-flex h-5 w-9 rounded-full transition ${autoRenew ? "bg-brand" : "bg-app-border"}`}>
                        <span className={`inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform mt-0.5 ${autoRenew ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                  )}

                  {/* Advanced: dates + billing day */}
                  <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-text-muted hover:text-text-primary underline">
                    {showAdvanced ? "Hide" : "Show"} advanced options (start/end dates, billing day, discount code)
                  </button>

                  {showAdvanced && (
                    <div className="space-y-3 p-4 bg-app-bg border border-app-border rounded-lg">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">Start date</label>
                          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                          <p className="text-xs text-text-muted mt-0.5">Blank = today</p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">End date</label>
                          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                          <p className="text-xs text-text-muted mt-0.5">Override expiry</p>
                        </div>
                      </div>
                      {billingType === "RECURRING" && !isOneTime && (
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">Bill on day of month <span className="text-text-muted font-normal">(1–28)</span></label>
                          <input type="number" min="1" max="28" value={billingDay} onChange={(e) => setBillingDay(e.target.value)} placeholder="Signup date" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs font-medium text-text-primary mb-1">Internal notes</label>
                        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Migration note, pre-paid months, etc." className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-text-primary mb-1">Discount code</label>
                        <input type="text" value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} placeholder="SUMMER20" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-brand" />
                        <p className="text-xs text-text-muted mt-0.5">Applied to the selected option&apos;s price. Codes are managed on the Memberships page.</p>
                      </div>
                    </div>
                  )}
                </>
              )}

              {selectedOption && billingType === "MANUAL" && (
                <label className="flex items-center gap-2 cursor-pointer text-xs text-text-muted">
                  <input
                    type="checkbox"
                    checked={emailReceipt}
                    onChange={(e) => setEmailReceipt(e.target.checked)}
                    className="w-3.5 h-3.5 accent-brand"
                  />
                  Email a purchase receipt to the member
                </label>
              )}

              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

              <div className="flex gap-2 pt-2">
                <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
                <button onClick={handleSubmit} disabled={!selectedMembership || !selectedOption || submitting} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {submitting ? "Processing…" : billingType === "MANUAL" || isOneTime ? "Assign membership" : "Send Stripe Checkout"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Import CSV Modal ─────────────────────────────────────────────────────────
function ImportCSVModal({ customFields, formConfig, onClose, onImported }: { customFields: CustomField[]; formConfig: MemberFormConfig; onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [importing, setImporting] = useState(false);
  // How dates (e.g. Date of birth) are written in the uploaded file.
  const [dateFormat, setDateFormat] = useState<"auto" | "mdy" | "dmy" | "ymd">("mdy");
  const [result, setResult] = useState<{ created: number; skipped: number; failed: number; errors: string[] } | null>(null);
  const [error, setError] = useState("");

  // Map the synthetic "athleteName" to its underlying CSV columns so we can show
  // First/Last in the dropdown but still honor the owner's enabled/required config.
  const cfgKeyToCsvKeys: Record<MemberFormFieldKey, string[]> = {
    athleteName: ["athleteName", "firstName", "lastName"],
    email: ["email"],
    phone: ["phone"],
    dateOfBirth: ["dateOfBirth"],
    gender: ["gender"],
    streetAddress: ["streetAddress"],
    city: ["city"],
    state: ["state"],
    zipCode: ["zipCode"],
    status: ["status"],
    tags: ["tags"],
    notes: ["notes"],
    isMinor: ["isMinor"],
    profileImageUrl: [], // not importable from CSV
    guardianRelationship: ["guardianRelationship"],
  };
  const allowedCsvKeys = new Set<string>(
    formConfig.enabledFields.flatMap((k) => cfgKeyToCsvKeys[k] ?? [])
  );
  // Guardian name/email/phone are always available — they're conditional on
  // isMinor=true, not toggleable by the form config.
  ["guardianName", "guardianEmail", "guardianPhone"].forEach((k) => allowedCsvKeys.add(k));

  // Import requires only a name. Other member-form required fields apply to
  // manual entry / signup forms — never to bulk CSV import.

  const mappingFields = [
    ...MEMBER_FIELDS.slice(0, -1).filter((f) => allowedCsvKeys.has(f.key)),
    ...customFields.map((f) => ({ key: `custom:${f.id}`, label: `Custom: ${f.label}`, required: f.required })),
    MEMBER_FIELDS[MEMBER_FIELDS.length - 1], // skip
  ];

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length < 2) { setError("CSV must have a header row and at least one data row."); return; }
      const hdrs = parsed[0];
      const dataRows = parsed.slice(1);
      setHeaders(hdrs);
      setRows(dataRows);

      // Auto-map based on common header names
      const autoMap: Record<number, string> = {};
      hdrs.forEach((h, i) => {
        const lh = h.toLowerCase().replace(/\s+/g, "").replace(/_/g, "");
        if (lh.includes("guardian") && lh.includes("name")) autoMap[i] = "guardianName";
        else if (lh.includes("guardian") && lh.includes("email")) autoMap[i] = "guardianEmail";
        else if (lh.includes("guardian") && lh.includes("phone")) autoMap[i] = "guardianPhone";
        else if (lh.includes("guardian") && (lh.includes("relation") || lh.includes("relationship"))) autoMap[i] = "guardianRelationship";
        else if (lh.includes("athletename") || lh.includes("fullname") || lh.includes("membername") || lh === "name" || lh === "athlete" || lh === "player") autoMap[i] = "athleteName";
        else if (lh.includes("first")) autoMap[i] = "firstName";
        else if (lh.includes("last")) autoMap[i] = "lastName";
        else if (lh.includes("email")) autoMap[i] = "email";
        else if (lh.includes("phone") || lh === "mobile" || lh === "cell") autoMap[i] = "phone";
        else if (lh.includes("dob") || lh.includes("birth")) autoMap[i] = "dateOfBirth";
        else if (lh.includes("gender") || lh === "sex") autoMap[i] = "gender";
        else if (lh.includes("street") || lh === "address" || lh.includes("address1") || lh.includes("addressline")) autoMap[i] = "streetAddress";
        else if (lh === "city" || lh.includes("town")) autoMap[i] = "city";
        else if (lh === "state" || lh === "province" || lh === "region") autoMap[i] = "state";
        else if (lh.includes("zip") || lh.includes("postal")) autoMap[i] = "zipCode";
        else if (lh.includes("status")) autoMap[i] = "status";
        else if (lh.includes("tag")) autoMap[i] = "tags";
        else if (lh.includes("note")) autoMap[i] = "notes";
        else if (lh.includes("minor") || lh.includes("adult") || lh.includes("under18")) autoMap[i] = "isMinor";
        else {
          const custom = customFields.find((f) => f.label.toLowerCase().replace(/\s+/g, "").replace(/_/g, "") === lh);
          autoMap[i] = custom ? `custom:${custom.id}` : "skip";
        }
      });
      setMapping(autoMap);
      setStep("map");
    };
    reader.readAsText(file);
  }

  // Convert a date string from the owner-selected format to unambiguous ISO
  // (yyyy-mm-dd) so the server can't misread dd/mm as mm/dd. Unparseable
  // values pass through untouched and surface as server-side warnings.
  function convertDate(raw: string): string {
    const v = (raw || "").trim();
    if (!v || dateFormat === "auto") return v;
    const m = v.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
    if (!m) return v;
    let day: number, month: number, year: number;
    if (dateFormat === "mdy") { month = +m[1]; day = +m[2]; year = +m[3]; }
    else if (dateFormat === "dmy") { day = +m[1]; month = +m[2]; year = +m[3]; }
    else { year = +m[1]; month = +m[2]; day = +m[3]; }
    if (year < 100) year += year > new Date().getFullYear() % 100 ? 1900 : 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return v;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function buildMembers() {
    return rows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((_, i) => {
        const field = mapping[i];
        if (field && field !== "skip") obj[field] = row[i] || "";
      });
      return obj;
    }).filter((m) => m.athleteName || m.firstName || m.lastName);
  }

  async function handleImport() {
    setImporting(true);
    setError("");
    const members = buildMembers().map((m) => ({
      athleteName: m.athleteName || undefined,
      firstName: m.firstName || undefined,
      lastName: m.lastName || undefined,
      email: m.email || undefined,
      phone: m.phone || undefined,
      dateOfBirth: m.dateOfBirth ? convertDate(m.dateOfBirth) : undefined,
      gender: m.gender || undefined,
      streetAddress: m.streetAddress || undefined,
      city: m.city || undefined,
      state: m.state || undefined,
      zipCode: m.zipCode || undefined,
      status: (["ACTIVE","PROSPECT","INACTIVE","PAUSED"].includes((m.status || "").toUpperCase()) ? m.status.toUpperCase() : "ACTIVE") as any,
      tags: m.tags || undefined,
      notes: m.notes || undefined,
      guardianName: m.guardianName || undefined,
      guardianEmail: m.guardianEmail || undefined,
      guardianPhone: m.guardianPhone || undefined,
      guardianRelationship: m.guardianRelationship || undefined,
      customFieldValues: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("custom:")).map(([k, v]) => [k.replace("custom:", ""), v])),
      isMinor: m.isMinor ? ["yes", "true", "minor", "under18", "under 18", "1"].includes(m.isMinor.toLowerCase()) : !!(m.guardianName || m.guardianEmail),
    }));

    const res = await fetch("/api/members/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    });
    const data = await res.json();
    setImporting(false);
    if (!res.ok) { setError(formatApiError(data.error, "Import failed")); return; }
    setResult(data);
    setStep("done");
  }

  const preview = buildMembers().slice(0, 5);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">Import members from CSV</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6">
          {/* Step indicator */}
          <div className="flex gap-2 mb-6">
            {["Upload", "Map columns", "Preview", "Done"].map((s, i) => {
              const stepKeys = ["upload", "map", "preview", "done"];
              const active = stepKeys.indexOf(step) >= i;
              return (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${active ? "bg-brand text-white" : "bg-app-bg text-text-muted"}`}>{i + 1}</div>
                  <span className={`text-xs ${active ? "text-text-primary font-medium" : "text-text-muted"}`}>{s}</span>
                  {i < 3 && <div className="flex-1 h-px bg-app-border" />}
                </div>
              );
            })}
          </div>

          {step === "upload" && (
            <div className="text-center">
              <div className="border-2 border-dashed border-app-border rounded-xl p-10 hover:border-app-border transition cursor-pointer" onClick={() => fileRef.current?.click()}>
                <FileText className="h-10 w-10 mx-auto mb-3 text-text-muted" strokeWidth={1.5} />
                <p className="text-sm font-medium text-text-primary mb-1">Drop a CSV file here or click to browse</p>
                <p className="text-xs text-text-muted">Supports up to 500 members per import</p>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
              </div>
              <div className="mt-4 text-xs text-text-muted text-left bg-app-bg rounded-lg p-3">
                <p className="font-medium mb-1">CSV format tips:</p>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>First row should be column headers</li>
                  <li>Required: a name — either one &quot;Athlete Name&quot; (full name) column, or First Name + Last Name</li>
                  <li>Optional: Email, Phone, Date of Birth, Gender, Address, Status, Tags, Notes</li>
                  <li>One email and one phone per person is enough — for a minor, a single Email/Phone column is treated as the guardian&apos;s automatically</li>
                  <li>For minors: Guardian Name + Guardian Email (Guardian Phone optional)</li>
                  <li>Any custom fields you&apos;ve created are also mappable</li>
                </ul>
                <p className="mt-2 pt-2 border-t border-app-border">
                  Switching from other software? Use{" "}
                  <a href="/dashboard/members/migration" className="text-brand hover:underline font-medium">Import / Migrate</a>{" "}
                  to bring your whole roster and keep everyone&apos;s existing billing dates.
                </p>
              </div>
              {error && <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            </div>
          )}

          {step === "map" && (() => {
            const mappedKeys = new Set(Object.values(mapping).filter((v) => v && v !== "skip"));
            const hasName = mappedKeys.has("athleteName") || mappedKeys.has("firstName") || mappedKeys.has("lastName");
            const missingRequired: string[] = hasName ? [] : ["a name column (Athlete name, or First/Last name)"];
            const hasDateColumn = mappedKeys.has("dateOfBirth");
            return (
              <div>
                <p className="text-sm text-text-muted mb-2">
                  Match your CSV columns to member fields. We auto-detected some mappings — adjust as needed.
                </p>
                <p className="text-xs text-text-muted mb-4">
                  Only a name is required — everything else is optional and can be filled in later.
                </p>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {headers.map((h, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-48 text-sm text-text-primary font-medium truncate flex-shrink-0">{h}</div>
                      <div className="text-text-muted text-xs flex-shrink-0">→</div>
                      <select value={mapping[i] || "skip"} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })} className="flex-1 px-3 py-1.5 border border-app-border rounded-lg text-sm bg-surface">
                        {mappingFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      <div className="text-xs text-text-muted w-20 truncate flex-shrink-0">{rows[0]?.[i] || ""}</div>
                    </div>
                  ))}
                </div>
                {hasDateColumn && (
                  <div className="mt-4 bg-app-bg rounded-lg p-3">
                    <label className="block text-xs font-medium text-text-primary mb-1">Date format in your file</label>
                    <p className="text-xs text-text-muted mb-2">Pick the format that matches your spreadsheet so dates like 03/04/2010 import correctly.</p>
                    <select
                      value={dateFormat}
                      onChange={(e) => setDateFormat(e.target.value as typeof dateFormat)}
                      className="px-3 py-1.5 border border-app-border rounded-lg text-sm bg-surface"
                    >
                      <option value="mdy">US — MM/DD/YYYY (e.g. 08/24/2025)</option>
                      <option value="dmy">International — DD/MM/YYYY (e.g. 24/08/2025)</option>
                      <option value="ymd">ISO — YYYY-MM-DD (e.g. 2025-08-24)</option>
                      <option value="auto">Auto-detect (text dates like "Feb 10 2020")</option>
                    </select>
                  </div>
                )}
                {missingRequired.length > 0 && (
                  <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    Map {missingRequired.join(", ")} before importing.
                  </div>
                )}
                <div className="flex gap-2 pt-4">
                  <button onClick={() => setStep("upload")} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Back</button>
                  <button
                    onClick={() => setStep("preview")}
                    disabled={missingRequired.length > 0}
                    className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
                  >
                    Preview import
                  </button>
                </div>
              </div>
            );
          })()}

          {step === "preview" && (
            <div>
              <p className="text-sm text-text-muted mb-3">
                Importing <strong>{rows.length}</strong> members. Preview of first {Math.min(5, preview.length)}:
              </p>
              <div className="border border-app-border rounded-lg overflow-x-auto mb-4">
                <table className="w-full text-sm">
                  <thead className="bg-app-bg">
                    <tr>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Name</th>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Email</th>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Status</th>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Guardian</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((m, i) => (
                      <tr key={i} className="border-t border-app-border">
                        <td className="px-3 py-2 font-medium">{m.athleteName || `${m.firstName || ""} ${m.lastName || ""}`.trim()}</td>
                        <td className="px-3 py-2 text-text-muted">{m.email || "—"}</td>
                        <td className="px-3 py-2 text-text-muted">{m.status || "ACTIVE"}</td>
                        <td className="px-3 py-2 text-text-muted">{m.guardianName || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 5 && <p className="text-xs text-text-muted mb-4">…and {rows.length - 5} more rows</p>}
              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
              <div className="flex gap-2">
                <button onClick={() => setStep("map")} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Back</button>
                <button onClick={handleImport} disabled={importing} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {importing ? "Importing…" : `Import ${rows.length} members`}
                </button>
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div className="text-center">
              <div className="text-5xl mb-4">{result.failed === 0 ? "✓" : "⚠"}</div>
              <h3 className="text-lg font-semibold text-text-primary mb-2">Import complete</h3>
              <div className="flex justify-center gap-4 mb-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-text-primary">{result.created}</p>
                  <p className="text-xs text-text-muted">imported</p>
                </div>
                {result.skipped > 0 && (
                  <div className="text-center">
                    <p className="text-2xl font-bold text-orange-accent">{result.skipped}</p>
                    <p className="text-xs text-text-muted">skipped</p>
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="text-center">
                    <p className="text-2xl font-bold text-red-600">{result.failed}</p>
                    <p className="text-xs text-text-muted">failed</p>
                  </div>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="text-left bg-app-bg border border-app-border rounded-lg p-3 mb-4 max-h-40 overflow-y-auto">
                  <p className="text-xs font-medium text-text-muted mb-1.5">Notes:</p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-text-muted py-0.5 border-b border-app-border last:border-0">{e}</p>
                  ))}
                </div>
              )}
              <button onClick={onImported} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
