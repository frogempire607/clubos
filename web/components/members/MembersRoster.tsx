// Phase 4.5.2 — the members list.
//
// Reads GET /api/members?paginated=1 — server-side paging, search, filters and
// segment counts. Nothing here derives status: every track and every action
// arrives already resolved from lib/memberTracks.ts via the serializer, which
// is the whole point of 4.5.1.
//
// Filters, sort, segment and page live in the URL so a view is shareable, per
// the handoff's interaction rules.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  MoreHorizontal,
  Search,
  SearchX,
  SlidersHorizontal,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { SkeletonList } from "@/components/LoadingSkeleton";
import {
  AccountSetupCell,
  MemberAvatar,
  MembershipPill,
  NextActionButton,
  RoleChips,
} from "@/components/members/MemberTracks";
import { MemberActionsMenu } from "@/components/members/MemberActionsMenu";
import type { NextAction } from "@/lib/memberTracks";

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape — mirrors SerializedMember from lib/memberDisplay.ts
// ─────────────────────────────────────────────────────────────────────────────

export type RosterMember = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  profileImageUrl: string | null;
  isMinor: boolean;
  email: string | null;
  guardianEmail: string | null;
  lastSeenAt: string | null;
  balanceOwed: number | null;
  sourceLabel: string | null;
  importedAt: string | null;
  tracks: {
    role: { role: string; label: string }[];
    membership: { track: string; label: string; detail: string | null };
    accountSetup: {
      track: string;
      label: string;
      dot: string;
      meter: {
        step: number;
        total: number;
        applicable: boolean;
        waitingOn: "NOBODY" | "STAFF" | "MEMBER" | "BLOCKED";
        steps: { index: number; label: string; done: boolean; current: boolean }[];
      };
    };
  };
  nextAction: NextAction;
};

type Counts = {
  everyone: number;
  athletes: number;
  parents: number;
  accountHolders: number;
  prospects: number;
  inactive: number;
  midMigration: number;
};

type Payload = {
  members: RosterMember[];
  pagination: { total: number; page: number; pageSize: number; pages: number };
  counts: Counts | null;
  countsCapped: boolean;
};

const PERSON_TYPES: { key: string; label: string; countKey: keyof Counts }[] = [
  { key: "everyone", label: "Everyone", countKey: "everyone" },
  { key: "athletes", label: "Athletes", countKey: "athletes" },
  { key: "parents", label: "Parents", countKey: "parents" },
  { key: "accountHolders", label: "Account holders", countKey: "accountHolders" },
  { key: "prospects", label: "Prospects", countKey: "prospects" },
  { key: "inactive", label: "Inactive", countKey: "inactive" },
];

const MEMBERSHIP_FILTERS = [
  { key: "ACTIVE", label: "Active" },
  { key: "PENDING", label: "Pending · not charged" },
  { key: "PROSPECT", label: "Prospect" },
  { key: "LEAD", label: "Lead" },
  { key: "PAUSED", label: "Paused" },
  { key: "INACTIVE", label: "Inactive" },
];

const SETUP_FILTERS = [
  { key: "NOT_INVITED", label: "Not invited" },
  { key: "INVITED", label: "Invited" },
  { key: "SETTING_UP", label: "Setting up" },
  { key: "PROFILE_CREATED", label: "Profile created" },
  { key: "COMPLETE", label: "Complete" },
  { key: "BLOCKED", label: "Blocked" },
  { key: "PROFILE_INCOMPLETE", label: "Profile incomplete" },
];

const SORTS = [
  { key: "lastSeen", label: "Last seen" },
  { key: "name", label: "Name" },
  { key: "joined", label: "Joined" },
];

function fmtDate(v: string | null): string {
  if (!v) return "—";
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MembersRoster({ canEdit, canBill }: { canEdit: boolean; canBill: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection is query-scoped, not page-scoped. `allMatching` carries the
  // intent; the server re-resolves it. Sending the loaded ids would silently
  // cap every bulk action at one page — the exact bug the handoff calls out.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");

  // URL is the source of truth for every view parameter.
  const q = useMemo(
    () => ({
      search: params.get("search") ?? "",
      personType: params.get("personType") ?? "everyone",
      membership: params.get("membership") ?? "",
      setupState: params.get("setupState") ?? "",
      queue: params.get("queue") ?? "",
      sort: params.get("sort") ?? "lastSeen",
      page: Number(params.get("page") ?? 1),
    }),
    [params],
  );

  const setQuery = useCallback(
    (patch: Record<string, string | number | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === "everyone") next.delete(k);
        else next.set(k, String(v));
      }
      // Any filter change resets to page 1 — staying on page 7 of a result set
      // that now has 2 pages shows an empty table and reads as a bug.
      if (!("page" in patch)) next.delete("page");
      router.replace(`?${next.toString()}`, { scroll: false });
      setSelected(new Set());
      setSelectAllMatching(false);
    },
    [params, router],
  );

  // Debounce only the search box; every other control is a discrete choice and
  // should feel instant.
  const [searchDraft, setSearchDraft] = useState(q.search);
  useEffect(() => setSearchDraft(q.search), [q.search]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onSearchChange(v: string) {
    setSearchDraft(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setQuery({ search: v }), 250);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams({ paginated: "1" });
    for (const [k, v] of Object.entries(q)) if (v) sp.set(k, String(v));
    fetch(`/api/members?${sp.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Failed (${r.status})`);
        return r.json();
      })
      .then((d: Payload) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load members");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q]);

  const members = data?.members ?? [];
  const counts = data?.counts ?? null;
  const total = data?.pagination.total ?? 0;

  const activeFilterChips = useMemo(() => {
    const chips: { key: string; label: string }[] = [];
    if (q.search) chips.push({ key: "search", label: `“${q.search}”` });
    if (q.personType !== "everyone") {
      chips.push({ key: "personType", label: PERSON_TYPES.find((p) => p.key === q.personType)?.label ?? q.personType });
    }
    if (q.membership) {
      chips.push({ key: "membership", label: MEMBERSHIP_FILTERS.find((m) => m.key === q.membership)?.label ?? q.membership });
    }
    if (q.setupState) {
      chips.push({ key: "setupState", label: SETUP_FILTERS.find((s) => s.key === q.setupState)?.label ?? q.setupState });
    }
    if (q.queue) chips.push({ key: "queue", label: QUEUE_LABELS[q.queue] ?? q.queue });
    return chips;
  }, [q]);

  const filterCount = activeFilterChips.length;
  const selectedCount = selectAllMatching ? total : selected.size;

  function toggleRow(id: string) {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const allOnPageSelected = members.length > 0 && members.every((m) => selected.has(m.id));

  return (
    <div className="flex flex-col gap-[18px] px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      <PageHeader
        title="Members"
        description={
          counts
            ? `${counts.everyone.toLocaleString()} ${counts.everyone === 1 ? "person" : "people"} · ${counts.midMigration.toLocaleString()} mid-migration · ${counts.prospects.toLocaleString()} prospects`
            : `${total.toLocaleString()} ${total === 1 ? "person" : "people"}`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <Link
              href="/api/export/members"
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg"
            >
              <Download className="h-4 w-4" /> Export
            </Link>
            <Link
              href="/dashboard/members/migration"
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg"
            >
              <Upload className="h-4 w-4" /> Import / Migrate
            </Link>
            <Link
              href="/dashboard/members?add=1"
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
            >
              <UserPlus className="h-4 w-4" /> Add member
            </Link>
          </div>
        }
      />

      <WorkQueueStrip counts={counts} active={q.queue} onPick={(k) => setQuery({ queue: k === q.queue ? null : k })} />

      <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 border-b border-app-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <div
              role="tablist"
              aria-label="Person type"
              className="-mx-1 flex gap-1 overflow-x-auto rounded-lg bg-app-bg p-[3px] sm:mx-0"
            >
              {PERSON_TYPES.map((p) => {
                const active = q.personType === p.key;
                return (
                  <button
                    key={p.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setQuery({ personType: p.key })}
                    className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors ${
                      active ? "bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {p.label}
                    {counts && <span className="ml-1 tabular-nums opacity-70">{counts[p.countKey].toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>

            <label className="relative block w-full max-w-[300px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={searchDraft}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Name, email, phone, guardian, legacy ID"
                aria-label="Search members"
                className="h-[34px] w-full rounded-lg border border-app-border bg-surface pl-8 pr-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setFiltersOpen(true)}
              className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors ${
                filterCount ? "border-brand text-brand" : "border-app-border text-text-primary hover:bg-app-bg"
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" /> Filters
              {filterCount > 0 && (
                <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">{filterCount}</span>
              )}
            </button>
            <select
              value={q.sort}
              onChange={(e) => setQuery({ sort: e.target.value })}
              aria-label="Sort by"
              className="h-[34px] rounded-lg border border-app-border bg-surface px-2 text-[13px] text-text-primary"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable"))}
              aria-label="Toggle row density"
              title={density === "comfortable" ? "Compact rows" : "Comfortable rows"}
              className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-app-border text-text-muted transition-colors hover:bg-app-bg"
            >
              <Users className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Active filter bar ───────────────────────────────────────── */}
        {filterCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-4 py-2.5" style={{ background: "#FCFCFD" }}>
            <span className="text-[12px] text-text-muted">Filtered by</span>
            {activeFilterChips.map((c) => (
              <button
                key={c.key}
                onClick={() => setQuery({ [c.key]: null })}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-primary transition-colors hover:opacity-80"
                style={{ background: "var(--color-chip-surface)" }}
              >
                {c.label}
                <X className="h-3 w-3" />
              </button>
            ))}
            <button onClick={() => router.replace("?", { scroll: false })} className="text-[12px] text-brand hover:underline">
              Clear all
            </button>
            <button
              className="ml-auto inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary"
              title="Saved views are stored per user (saved_member_views)"
            >
              <Bookmark className="h-3.5 w-3.5" /> Save as view
            </button>
          </div>
        )}

        {/* ── Bulk bar ────────────────────────────────────────────────── */}
        {selectedCount > 0 && (
          <div
            className="flex flex-col gap-2 border-b px-4 py-2.5 md:flex-row md:items-center md:justify-between"
            style={{ background: "rgba(109,93,246,.06)", borderColor: "rgba(109,93,246,.25)" }}
          >
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium text-text-primary">{selectedCount.toLocaleString()} selected</span>
              {!selectAllMatching && total > selected.size && (
                <button onClick={() => setSelectAllMatching(true)} className="text-brand underline">
                  Select all {total.toLocaleString()} matching this filter
                </button>
              )}
              {selectAllMatching && (
                <button
                  onClick={() => {
                    setSelectAllMatching(false);
                    setSelected(new Set());
                  }}
                  className="text-brand underline"
                >
                  Clear selection
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <BulkButton primary disabled={!canEdit} label="Send invitations" />
              <BulkButton disabled={!canEdit} label="Resend" />
              <BulkButton disabled={!canBill} label="Assign membership" />
              <BulkButton disabled={!canEdit} label="Message" />
              <BulkButton disabled={!canEdit} label="Add tag" />
            </div>
          </div>
        )}

        {/* ── Table (md+) ─────────────────────────────────────────────── */}
        {loading ? (
          <div className="p-4">
            <SkeletonList rows={8} />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <AlertTriangle className="h-7 w-7" style={{ color: "var(--color-danger-text)" }} />
            <p className="text-sm text-text-primary">{error}</p>
          </div>
        ) : members.length === 0 ? (
          <EmptyResult hasFilters={filterCount > 0} total={total} onClear={() => router.replace("?", { scroll: false })} />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead>
                  <tr style={{ background: "var(--color-table-chrome)" }}>
                    <th className="w-[42px] px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={allOnPageSelected}
                        onChange={() =>
                          setSelected(allOnPageSelected ? new Set() : new Set(members.map((m) => m.id)))
                        }
                      />
                    </th>
                    <Th>Person</Th>
                    <Th width={190}>Membership</Th>
                    <Th width={210}>Account setup</Th>
                    <Th width={110} align="right">
                      Balance
                    </Th>
                    <Th width={120}>Last seen</Th>
                    <Th width={150} />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr
                      key={m.id}
                      className="border-t transition-colors hover:bg-app-bg"
                      style={{ borderColor: "var(--color-hairline)" }}
                    >
                      <td className="px-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${m.fullName}`}
                          checked={selectAllMatching || selected.has(m.id)}
                          onChange={() => toggleRow(m.id)}
                        />
                      </td>
                      <td className={density === "compact" ? "py-2 pr-3" : "py-3 pr-3"}>
                        <PersonCell m={m} />
                      </td>
                      <td className="py-3 pr-3">
                        <MembershipPill {...m.tracks.membership} />
                      </td>
                      <td className="py-3 pr-3">
                        <AccountSetupCell {...m.tracks.accountSetup} />
                      </td>
                      <td className="py-3 pr-3 text-right">
                        {m.balanceOwed ? (
                          <span className="text-[13px] font-semibold" style={{ color: "var(--color-warn-text)" }}>
                            ${m.balanceOwed.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-[12.5px] text-text-muted">{fmtDate(m.lastSeenAt)}</td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <NextActionButton
                            action={m.nextAction}
                            allowed={permitted(m.nextAction, canEdit, canBill)}
                            requiredRoleLabel={roleLabelFor(m.nextAction)}
                          />
                          <MemberActionsMenu member={m} canEdit={canEdit} canBill={canBill} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Card list (<md) ──────────────────────────────────────── */}
            <ul className="divide-y md:hidden" style={{ borderColor: "var(--color-hairline)" }}>
              {members.map((m) => (
                <li key={m.id} className="flex gap-3 p-3.5">
                  <input
                    type="checkbox"
                    aria-label={`Select ${m.fullName}`}
                    checked={selectAllMatching || selected.has(m.id)}
                    onChange={() => toggleRow(m.id)}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <MemberAvatar initials={m.initials} imageUrl={m.profileImageUrl} size={44} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/dashboard/members/${m.id}`} className="block truncate text-[14.5px] font-semibold text-text-primary">
                      {m.fullName}
                    </Link>
                    <div className="mt-0.5">
                      <RoleChips roles={m.tracks.role} max={2} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <MembershipPill {...m.tracks.membership} />
                      <AccountSetupCell {...m.tracks.accountSetup} showMeter={false} />
                    </div>
                    <div className="mt-2">
                      <NextActionButton
                        action={m.nextAction}
                        allowed={permitted(m.nextAction, canEdit, canBill)}
                        requiredRoleLabel={roleLabelFor(m.nextAction)}
                        className="min-h-[44px]"
                      />
                    </div>
                  </div>
                  <MemberActionsMenu member={m} canEdit={canEdit} canBill={canBill} size={44} />
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ── Footer ──────────────────────────────────────────────────── */}
        {!loading && !error && members.length > 0 && data && (
          <div
            className="flex flex-col gap-2 border-t border-app-border px-4 py-2.5 text-[12.5px] text-text-muted sm:flex-row sm:items-center sm:justify-between"
            style={{ background: "var(--color-table-chrome)" }}
          >
            <span className="tabular-nums">
              Rows {(data.pagination.page - 1) * data.pagination.pageSize + 1}–
              {Math.min(data.pagination.page * data.pagination.pageSize, data.pagination.total)} of{" "}
              {data.pagination.total.toLocaleString()} · sorted by {SORTS.find((s) => s.key === q.sort)?.label.toLowerCase()}
              {data.countsCapped && " · counts unavailable at this roster size"}
            </span>
            <div className="flex items-center gap-1">
              <PageBtn disabled={data.pagination.page <= 1} onClick={() => setQuery({ page: data.pagination.page - 1 })}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </PageBtn>
              <PageBtn
                disabled={data.pagination.page >= data.pagination.pages}
                onClick={() => setQuery({ page: data.pagination.page + 1 })}
              >
                Next <ChevronRight className="h-4 w-4" />
              </PageBtn>
            </div>
          </div>
        )}
      </div>

      {filtersOpen && (
        <FiltersSheet
          q={q}
          onClose={() => setFiltersOpen(false)}
          onApply={(patch) => {
            setQuery(patch);
            setFiltersOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────────────────────

const QUEUE_LABELS: Record<string, string> = {
  neverInvited: "Never invited",
  blocked: "Blocked",
  missingContact: "Missing contact",
};

function Th({
  children,
  width,
  align = "left",
}: {
  children?: React.ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{ width }}
      className={`px-0 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted ${
        align === "right" ? "pr-4 text-right" : "pr-3 text-left"
      }`}
    >
      {children}
    </th>
  );
}

function PersonCell({ m }: { m: RosterMember }) {
  const meta = [
    m.tracks.role.map((r) => r.label).join(" · ") || null,
    m.importedAt ? (m.sourceLabel ? `imported from ${m.sourceLabel}` : `imported ${fmtDate(m.importedAt)}`) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <MemberAvatar initials={m.initials} imageUrl={m.profileImageUrl} size={34} />
      <div className="min-w-0">
        <Link href={`/dashboard/members/${m.id}`} className="block truncate text-sm font-medium text-text-primary hover:text-brand">
          {m.fullName}
        </Link>
        {meta && <div className="truncate text-[12px] text-text-muted">{meta}</div>}
      </div>
    </div>
  );
}

function WorkQueueStrip({
  counts,
  active,
  onPick,
}: {
  counts: Counts | null;
  active: string;
  onPick: (key: string) => void;
}) {
  // Each card is a saved filter that also arms the matching bulk action — not a
  // statistic. The counts shown are the roster's own segment counts; the exact
  // per-queue numbers come from the server when the card is clicked.
  const cards = [
    { key: "neverInvited", label: "never invited", accent: "var(--color-orange-accent)", action: "Send invitations" },
    { key: "blocked", label: "blocked", accent: "#DC2626", action: "Fix contact details" },
    { key: "missingContact", label: "missing contact", accent: "var(--color-warn-text)", action: "Add an address" },
    { key: "duplicates", label: "possible duplicates", accent: "var(--color-brand)", action: "Review duplicates" },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const isActive = active === c.key;
        const href = c.key === "duplicates" ? "/dashboard/members/duplicates" : null;
        const body = (
          <>
            <div className="text-[22px] font-semibold leading-none tabular-nums text-text-primary">
              {counts && c.key === "neverInvited" ? counts.midMigration.toLocaleString() : "—"}
            </div>
            <div className="mt-1 text-[12.5px] text-text-primary">{c.label}</div>
            <div className="mt-1 text-[12px] font-medium" style={{ color: "var(--color-prospect-text)" }}>
              {c.action} →
            </div>
          </>
        );
        const cls = `rounded-[10px] border bg-surface px-[15px] py-[13px] text-left transition-colors hover:bg-app-bg ${
          isActive ? "ring-2 ring-brand" : ""
        }`;
        const style = { borderColor: "var(--color-border)", borderLeft: `3px solid ${c.accent}` };
        return href ? (
          <Link key={c.key} href={href} className={cls} style={style}>
            {body}
          </Link>
        ) : (
          <button key={c.key} onClick={() => onPick(c.key)} className={cls} style={style}>
            {body}
          </button>
        );
      })}
    </div>
  );
}

function BulkButton({ label, primary, disabled }: { label: string; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      title={disabled ? "You do not have permission for this action" : undefined}
      className={`inline-flex min-h-[34px] items-center rounded-lg px-2.5 text-[12.5px] font-medium transition-colors ${
        disabled
          ? "cursor-not-allowed border border-app-border bg-surface text-[#9CA3AF]"
          : primary
            ? "bg-brand text-white hover:bg-brand-hover"
            : "border border-app-border bg-surface text-text-primary hover:bg-app-bg"
      }`}
    >
      {label}
    </button>
  );
}

function PageBtn({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-app-border bg-surface px-2 text-[12.5px] text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** 1k states — empty roster vs empty search say different things. */
function EmptyResult({ hasFilters, total, onClear }: { hasFilters: boolean; total: number; onClear: () => void }) {
  if (hasFilters) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
        <div
          className="inline-flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: "rgba(163,230,53,.12)" }}
        >
          <SearchX className="h-7 w-7" style={{ color: "#5C8C1F" }} />
        </div>
        <p className="text-[15px] font-semibold text-text-primary">No one matches these filters</p>
        <p className="max-w-sm text-[13px] text-text-muted">
          Nothing in the roster matches every filter at once. Clearing one at a time usually finds the person faster than
          clearing them all.
        </p>
        <button onClick={onClear} className="mt-1 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white">
          Clear filters
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="inline-flex h-14 w-14 items-center justify-center rounded-full" style={{ background: "rgba(163,230,53,.12)" }}>
        <Users className="h-7 w-7" style={{ color: "#5C8C1F" }} />
      </div>
      <p className="text-[15px] font-semibold text-text-primary">No members yet</p>
      <p className="max-w-sm text-[13px] text-text-muted">
        Import a roster from your previous system or add one person by hand.{" "}
        <strong className="font-medium text-text-primary">Nobody is charged in AthletixOS until they activate.</strong>
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Link href="/dashboard/members/migration" className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white">
          Import a roster
        </Link>
        <Link href="/dashboard/members?add=1" className="rounded-lg border border-app-border px-3 py-2 text-sm text-text-primary">
          Add one member
        </Link>
      </div>
      {total > 0 && <p className="text-[12px] text-text-muted">({total} hidden by the current view)</p>}
    </div>
  );
}

/** Full-screen sheet below md, panel above. All six legacy selects live here. */
function FiltersSheet({
  q,
  onClose,
  onApply,
}: {
  q: { membership: string; setupState: string };
  onClose: () => void;
  onApply: (patch: Record<string, string | null>) => void;
}) {
  const [membership, setMembership] = useState(q.membership);
  const [setupState, setSetupState] = useState(q.setupState);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-surface p-5 sm:max-w-md sm:rounded-[14px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text-primary">Filters</h2>
          <button onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-app-bg">
            <X className="h-4 w-4" />
          </button>
        </div>

        <FilterGroup label="Membership" value={membership} onChange={setMembership} options={MEMBERSHIP_FILTERS} />
        <FilterGroup label="Account setup" value={setupState} onChange={setSetupState} options={SETUP_FILTERS} />

        <div className="mt-5 flex gap-2">
          <button
            onClick={() => onApply({ membership: membership || null, setupState: setupState || null })}
            className="min-h-[44px] flex-1 rounded-lg bg-brand text-sm font-medium text-white"
          >
            Apply
          </button>
          <button
            onClick={() => {
              setMembership("");
              setSetupState("");
              onApply({ membership: null, setupState: null });
            }}
            className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm text-text-primary"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { key: string; label: string }[];
}) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[12px] font-medium text-text-primary">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = value === o.key;
          return (
            <button
              key={o.key}
              onClick={() => onChange(active ? "" : o.key)}
              className={`min-h-[36px] rounded-lg border px-2.5 text-[12.5px] transition-colors ${
                active ? "border-brand bg-brand text-white" : "border-app-border text-text-primary hover:bg-app-bg"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission helpers — the resolver names the key, the UI resolves the answer
// ─────────────────────────────────────────────────────────────────────────────

export function permitted(a: NextAction, canEdit: boolean, canBill: boolean): boolean {
  if (!a.permission) return true;
  if (a.permission.startsWith("billing")) return canBill;
  return canEdit;
}

export function roleLabelFor(a: NextAction): string | undefined {
  if (!a.permission) return undefined;
  return a.permission.startsWith("billing") ? "Billing" : "Members";
}
