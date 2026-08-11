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
import { PasswordResetDialog, type ResetState } from "@/components/members/PasswordResetDialog";
import {
  BulkEmailModal,
  BulkMessageModal,
  ImportCSVModal,
  MemberModal,
  PurchaseMembershipModal,
  type CustomField,
  type Member as FullMember,
} from "@/components/members/MemberModals";
import { DEFAULT_MEMBER_FORM_CONFIG, type MemberFormConfig } from "@/lib/memberForm";
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

/** A per-user saved filter set (§1e). `filters` is the roster's own query string. */
type SavedView = {
  id: string;
  name: string;
  filters: Record<string, string>;
  sort: string | null;
  scope: string;
};

/** The work-queue strip's four numbers. Null past COUNT_CAP. */
type QueueCounts = {
  neverInvited: number;
  blocked: number;
  missingContact: number;
  duplicates: number;
};

type Payload = {
  members: RosterMember[];
  pagination: { total: number; page: number; pageSize: number; pages: number };
  counts: Counts | null;
  countsCapped: boolean;
  /** Rows the roster deliberately never shows — see MemberListResult. */
  excluded?: { archived: number; historical: number };
  queueCounts?: QueueCounts | null;
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

export default function MembersRoster({
  canEdit,
  canBill,
  isOwner = false,
  staffName = "you",
}: {
  canEdit: boolean;
  canBill: boolean;
  isOwner?: boolean;
  staffName?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to force a refetch after any modal writes. */
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // ── What the modals need ────────────────────────────────────────────────
  // Fetched once. The Add/Edit member form is driven by the club's intake-form
  // config and custom fields, exactly as it was on the old page.
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [formConfig, setFormConfig] = useState<MemberFormConfig>(DEFAULT_MEMBER_FORM_CONFIG);
  useEffect(() => {
    fetch("/api/custom-fields")
      .then((r) => (r.ok ? r.json() : []))
      .then(setCustomFields)
      .catch(() => {});
    fetch("/api/club/member-form")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.config && setFormConfig(d.config))
      .catch(() => {});
  }, []);

  // ── Modal + dialog state ────────────────────────────────────────────────
  const [adding, setAdding] = useState(false);
  /** §1a mobile — the header's `⋯` overflow, which only exists below `sm`. */
  const [headerMenu, setHeaderMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<FullMember | null>(null);
  const [purchasing, setPurchasing] = useState<FullMember | null>(null);
  const [bulkMessaging, setBulkMessaging] = useState<string[] | null>(null);
  const [bulkEmailing, setBulkEmailing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [reset, setReset] = useState<{
    member: RosterMember;
    state: ResetState;
    email: string | null;
    isGuardianEmail: boolean;
    sentAt?: Date;
    errorMessage?: string;
  } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

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
  }, [q, reloadKey]);

  // `?add=1` opens the Add-member modal. Several places link here that way —
  // the dashboard quick-action bar, the empty state, the old page's own CTA —
  // so the deep link has to keep working after the cutover.
  useEffect(() => {
    if (params.get("add") === "1") {
      setAdding(true);
      const next = new URLSearchParams(params.toString());
      next.delete("add");
      router.replace(next.toString() ? `?${next.toString()}` : "?", { scroll: false });
    }
    // Only react to the flag appearing; `params` churns on every filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get("add")]);

  /**
   * Load the FULL member record for a modal that needs one.
   *
   * The roster row is a lean projection (lib/memberDisplay.ts), not a Member —
   * it deliberately doesn't carry addresses, custom fields or subscriptions.
   * Edit and Assign-membership need those, so they fetch on open rather than
   * bloating every row of a 200-row page with fields almost nobody opens.
   */
  const loadFull = useCallback(async (id: string): Promise<FullMember | null> => {
    const r = await fetch(`/api/members/${id}`);
    if (!r.ok) return null;
    return (await r.json()) as FullMember;
  }, []);

  /** Resolve the current selection into ids the server agrees with. */
  const resolveIds = useCallback(async (): Promise<string[]> => {
    const body = selectAllMatching
      ? { mode: "allMatching" as const, filter: Object.fromEntries(params.entries()) }
      : { mode: "ids" as const, ids: Array.from(selected) };
    const r = await fetch("/api/members/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not resolve the selection");
    return (await r.json()).ids as string[];
  }, [params, selected, selectAllMatching]);

  // ── Saved views (§1e) ───────────────────────────────────────────────────
  // Per user, not per club — a view is somebody's working set. The filter is
  // stored as the URL carries it, so applying one is just replaying its query
  // string; see app/api/members/views/route.ts for why that shape was chosen.
  const [views, setViews] = useState<SavedView[]>([]);
  const [savingView, setSavingView] = useState(false);
  const loadViews = useCallback(() => {
    fetch("/api/members/views?scope=MEMBERS")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setViews(d?.views ?? []))
      .catch(() => setViews([]));
  }, []);
  useEffect(() => { loadViews(); }, [loadViews]);

  const saveCurrentView = useCallback(async () => {
    const name = window.prompt("Name this view");
    if (!name?.trim()) return;
    setSavingView(true);
    try {
      const r = await fetch("/api/members/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scope: "MEMBERS",
          filters: Object.fromEntries(params.entries()),
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not save the view");
      loadViews();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not save the view");
    } finally {
      setSavingView(false);
    }
  }, [params, loadViews]);

  const applyView = useCallback(
    (v: SavedView) => {
      const next = new URLSearchParams(v.filters as Record<string, string>);
      router.replace(next.toString() ? `?${next.toString()}` : "?", { scroll: false });
    },
    [router],
  );

  const deleteView = useCallback(
    async (v: SavedView) => {
      if (!window.confirm(`Delete the view "${v.name}"? This removes the shortcut, not any member.`)) return;
      await fetch(`/api/members/views?id=${encodeURIComponent(v.id)}`, { method: "DELETE" });
      loadViews();
    },
    [loadViews],
  );

  const members = data?.members ?? [];
  const counts = data?.counts ?? null;
  const queueCounts = data?.queueCounts ?? null;
  const total = data?.pagination.total ?? 0;
  const archived = data?.excluded?.archived ?? 0;
  const historical = data?.excluded?.historical ?? 0;
  // One clause, however many reasons — "and 12 more you can't see" is the thing
  // to avoid, not the word count.
  const hiddenNote = [
    archived ? `${archived.toLocaleString()} archived` : null,
    historical ? `${historical.toLocaleString()} history-only` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  /**
   * The ⋯ menu's non-navigating items.
   *
   * Every key in MEMBER_MENU_ORDER either has an href (the menu routes it
   * itself) or lands here. Nothing falls through silently — that was the
   * complaint. `checkin` is the one item that still navigates, because
   * check-in belongs to the attendance surface and duplicating it here would
   * mean a second roster-shaped thing to keep in sync.
   */
  const onMenuAction = useCallback(
    async (key: string, m: { id: string; fullName: string }) => {
      const row = members.find((x) => x.id === m.id);
      try {
        switch (key) {
          case "resend": {
            setBusy(m.id);
            const r = await fetch(`/api/members/${m.id}/resend-invitation`, { method: "POST" });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || "Could not send the invitation");
            setToast({ kind: "ok", text: `${d.isReminder ? "Reminder" : "Invitation"} sent to ${m.fullName}.` });
            reload();
            break;
          }
          case "reset": {
            if (!row) break;
            // Ask the server who would receive it BEFORE showing the confirm —
            // the dialog's copy names the address, and naming the wrong one
            // (the child instead of the parent) is worse than not naming any.
            const r = await fetch(`/api/members/${m.id}/password-reset`);
            const d = await r.json().catch(() => ({}));
            // "No account yet" is not "no email on file", and the dialog only
            // knows how to say the second one. Sending someone a reset link for
            // an account that doesn't exist is a dead end — the real next step
            // is the invitation, so say that instead of opening a dialog whose
            // copy would be wrong.
            if (d.reason === "NO_LOGIN") {
              setToast({
                kind: "err",
                text: `${m.fullName} has no portal account yet — send an invitation instead of a password reset.`,
              });
              break;
            }
            setReset({
              member: row,
              state: d.canSend ? "confirm" : "no-email",
              email: d.email ?? null,
              isGuardianEmail: !!d.isGuardianEmail,
            });
            break;
          }
          case "assign": {
            const full = await loadFull(m.id);
            if (full) setPurchasing(full);
            break;
          }
          case "relationship":
            // Family labels and access both live on the profile, under the
            // tabs that own them. Opening a third editor here would be a third
            // place the same rules could drift.
            router.push(`/dashboard/members/${m.id}?tab=family`);
            break;
          case "checkin":
            router.push(`/dashboard/attendance?member=${m.id}`);
            break;
          case "archive": {
            if (
              !confirm(
                `Archive ${m.fullName}?\n\nThey stop appearing in the roster, billing and messaging. Nothing is deleted — history, payments and documents are kept, and an owner can restore them.`,
              )
            )
              break;
            setBusy(m.id);
            const r = await fetch(`/api/members/${m.id}`, { method: "DELETE" });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not archive");
            setToast({ kind: "ok", text: `${m.fullName} archived.` });
            reload();
            break;
          }
        }
      } catch (e) {
        setToast({ kind: "err", text: e instanceof Error ? e.message : "Something went wrong" });
      } finally {
        setBusy(null);
      }
    },
    [members, loadFull, reload, router],
  );

  /** Bulk bar. Resolves the selection server-side first, always. */
  const onBulk = useCallback(
    async (kind: "invite" | "resend" | "assign" | "message" | "email" | "tag") => {
      try {
        setBusy(`bulk:${kind}`);
        const ids = await resolveIds();
        if (ids.length === 0) {
          setToast({ kind: "err", text: "Nothing is selected." });
          return;
        }
        if (kind === "message") {
          setBulkMessaging(ids);
          return;
        }
        // REGRESSION FIX. Phase 3A shipped "Email selected" on the members
        // page — composer, recipient preview and household modes, all resolved
        // by lib/emailRecipients.ts. The roster cutover kept BulkEmailModal
        // mounted and dropped the only thing that opened it, so `bulkEmailing`
        // was set to null in three places and to a value in none. The remaining
        // path was Announcements, which can only reach people who have already
        // been emailed.
        //
        // The ids are the QUERY-SCOPED resolution, so "Select all N matching"
        // emails all N, not the page.
        if (kind === "email") {
          setBulkEmailing(ids);
          return;
        }
        if (kind === "assign") {
          // Assigning a plan is a per-person decision (option, price, dates).
          // A bulk version that picked one for everybody would be a billing
          // mistake at scale, so this deliberately routes rather than acts.
          setToast({
            kind: "err",
            text: "Assign a membership from each person's row — plan, price and start date differ per family.",
          });
          return;
        }
        if (kind === "tag") {
          setBulkEmailing(null);
          setToast({ kind: "err", text: "Bulk tagging isn't built yet." });
          return;
        }
        // invite | resend — both go through the existing bulk sender, which
        // caps per request and dedupes by family.
        const r = await fetch("/api/members/migration/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memberIds: ids, scope: "selected", reminder: kind === "resend" }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Could not send");
        setToast({
          kind: "ok",
          text: `${d.sent ?? ids.length} ${kind === "resend" ? "reminder" : "invitation"}${(d.sent ?? ids.length) === 1 ? "" : "s"} sent${d.remaining ? ` · ${d.remaining} queued` : ""}.`,
        });
        setSelected(new Set());
        setSelectAllMatching(false);
        reload();
      } catch (e) {
        setToast({ kind: "err", text: e instanceof Error ? e.message : "Something went wrong" });
      } finally {
        setBusy(null);
      }
    },
    [resolveIds, reload],
  );

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
          // Say what the number counts. A bare "281 people" against 293 rows in
          // the table reads as a bug even when it isn't — so the header names
          // the exclusion instead of leaving it to be discovered.
          counts
            ? `${counts.everyone.toLocaleString()} active ${counts.everyone === 1 ? "record" : "records"} · ${counts.midMigration.toLocaleString()} mid-migration · ${counts.prospects.toLocaleString()} ${counts.prospects === 1 ? "prospect" : "prospects"}${
                hiddenNote ? ` · ${hiddenNote}, not shown` : ""
              }`
            : `${total.toLocaleString()} active ${total === 1 ? "record" : "records"}${
                hiddenNote ? ` · ${hiddenNote}, not shown` : ""
              }`
        }
        actions={
          // §1a mobile: below `sm`, Export / Import / Migrate collapse behind a
          // ⋯ overflow and only Add member — the primary — keeps its own pill.
          // Four wrapped buttons pushed the work-queue strip off the first
          // screen at 390, which is where the actual work is.
          <div className="flex items-center gap-2.5">
            <div className="hidden items-center gap-2.5 sm:flex">
              <Link
                href="/api/export/members"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg lg:min-h-[38px]"
              >
                <Download className="h-4 w-4" /> Export
              </Link>
              <button
                onClick={() => setImporting(true)}
                disabled={!canEdit}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-[38px]"
              >
                <Upload className="h-4 w-4" /> Import CSV
              </button>
              <Link
                href="/dashboard/members/migration"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg lg:min-h-[38px]"
              >
                Migrate
              </Link>
            </div>

            <div className="relative sm:hidden">
              <button
                onClick={() => setHeaderMenu((v) => !v)}
                aria-label="More member actions"
                aria-expanded={headerMenu}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-app-border bg-surface text-text-primary transition-colors hover:bg-app-bg"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {headerMenu && (
                <>
                  {/* Backdrop, so a tap anywhere closes it — a menu you can only
                      dismiss by hitting the same 44px button is a trap on a phone. */}
                  <button
                    aria-hidden
                    tabIndex={-1}
                    onClick={() => setHeaderMenu(false)}
                    className="fixed inset-0 z-40 cursor-default"
                  />
                  <div className="absolute right-0 z-50 mt-1 w-[220px] rounded-[10px] border border-app-border bg-surface p-[5px] shadow-lg">
                    <Link
                      href="/api/export/members"
                      onClick={() => setHeaderMenu(false)}
                      className="flex min-h-[44px] items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text-primary hover:bg-app-bg"
                    >
                      <Download className="h-3.5 w-3.5" /> Export
                    </Link>
                    <button
                      onClick={() => { setHeaderMenu(false); setImporting(true); }}
                      disabled={!canEdit}
                      className="flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      <Upload className="h-3.5 w-3.5" /> Import CSV
                    </button>
                    <Link
                      href="/dashboard/members/migration"
                      onClick={() => setHeaderMenu(false)}
                      className="flex min-h-[44px] items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text-primary hover:bg-app-bg"
                    >
                      Migrate
                    </Link>
                  </div>
                </>
              )}
            </div>

            <button
              onClick={() => setAdding(true)}
              disabled={!canEdit}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-[38px]"
            >
              <UserPlus className="h-4 w-4" /> Add member
            </button>
          </div>
        }
      />

      {toast && (
        <div
          role="status"
          className="rounded-lg border px-3 py-2 text-[13px]"
          style={
            toast.kind === "ok"
              ? { background: "var(--color-success-surface)", borderColor: "var(--color-success-text)", color: "var(--color-success-text)" }
              : { background: "var(--color-danger-surface)", borderColor: "var(--color-danger-text)", color: "var(--color-danger-text)" }
          }
        >
          {toast.text}
        </div>
      )}

      <WorkQueueStrip
        queueCounts={queueCounts}
        active={q.queue}
        onPick={(k) => setQuery({ queue: k === q.queue ? null : k })}
      />

      {/* Saved views. Hidden entirely until the staffer has saved one — an
          empty row labelled "Your views" is noise on every other roster. */}
      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-text-muted">Your views</span>
          {views.map((v) => (
            <span
              key={v.id}
              className="inline-flex items-center rounded-md text-[12px]"
              style={{ background: "var(--color-chip-surface)" }}
            >
              <button
                onClick={() => applyView(v)}
                className="min-h-[44px] rounded-l-md py-1 pl-2.5 pr-1 text-text-primary transition-opacity hover:opacity-80 sm:min-h-[32px]"
              >
                {v.name}
              </button>
              <button
                onClick={() => deleteView(v)}
                aria-label={`Delete the view ${v.name}`}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-r-md text-text-muted transition-colors hover:text-text-primary sm:min-h-[32px] sm:min-w-[28px]"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

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
                    className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors lg:min-h-0 ${
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
              className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] transition-colors lg:min-h-[34px] ${
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
              className="h-11 rounded-lg border border-app-border bg-surface px-2 text-[13px] text-text-primary lg:h-[34px]"
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
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-app-border text-text-muted transition-colors hover:bg-app-bg lg:h-[34px] lg:w-[34px]"
            >
              <Users className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Active filter bar ───────────────────────────────────────── */}
        {filterCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-4 py-2.5" style={{ background: "var(--color-table-chrome)" }}>
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
              onClick={saveCurrentView}
              disabled={savingView}
              className="ml-auto inline-flex items-center gap-1 text-[12px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-60"
              title="Save these filters as a shortcut. Views are yours alone."
            >
              <Bookmark className="h-3.5 w-3.5" /> {savingView ? "Saving…" : "Save as view"}
            </button>
          </div>
        )}

        {/* ── Bulk bar ────────────────────────────────────────────────── */}
        {selectedCount > 0 && (
          <div
            className="flex flex-col gap-2 border-b px-4 py-2.5 md:flex-row md:items-center md:justify-between"
            style={{ background: "var(--color-info-surface)", borderColor: "var(--color-info-border)" }}
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
              <BulkButton primary disabled={!canEdit} busy={busy === "bulk:invite"} label="Send invitations" onClick={() => onBulk("invite")} />
              <BulkButton disabled={!canEdit} busy={busy === "bulk:resend"} label="Resend" onClick={() => onBulk("resend")} />
              <BulkButton disabled={!canBill} busy={busy === "bulk:assign"} label="Assign membership" onClick={() => onBulk("assign")} />
              <BulkButton disabled={!canEdit} busy={busy === "bulk:message"} label="Message" onClick={() => onBulk("message")} />
              <BulkButton disabled={!canEdit} busy={busy === "bulk:email"} label="Email selected" onClick={() => onBulk("email")} />
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
                          <MemberActionsMenu member={m} canEdit={canEdit} canBill={canBill} isOwner={isOwner} onAction={onMenuAction} />
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
                  <MemberActionsMenu member={m} canEdit={canEdit} canBill={canBill} isOwner={isOwner} onAction={onMenuAction} size={44} />
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

      {/* ── Modals, all lifted from the old page in this cutover ───────────── */}
      {(adding || editing) && (
        <MemberModal
          member={editing}
          customFields={customFields}
          formConfig={formConfig}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            reload();
          }}
        />
      )}

      {importing && (
        <ImportCSVModal
          customFields={customFields}
          formConfig={formConfig}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            reload();
          }}
        />
      )}

      {purchasing && <PurchaseMembershipModal member={purchasing} onClose={() => setPurchasing(null)} />}

      {bulkMessaging && (
        <BulkMessageModal
          memberIds={bulkMessaging}
          onClose={() => setBulkMessaging(null)}
          onSent={() => {
            setBulkMessaging(null);
            setSelected(new Set());
            setSelectAllMatching(false);
            setToast({ kind: "ok", text: "Message sent." });
          }}
        />
      )}

      {bulkEmailing && (
        <BulkEmailModal
          memberIds={bulkEmailing}
          onClose={() => setBulkEmailing(null)}
          onSent={() => {
            setBulkEmailing(null);
            setSelected(new Set());
            setSelectAllMatching(false);
            setToast({ kind: "ok", text: "Email queued." });
          }}
        />
      )}

      {reset && (
        <PasswordResetDialog
          state={reset.state}
          memberName={reset.member.fullName}
          email={reset.email}
          isGuardianEmail={reset.isGuardianEmail}
          staffName={staffName}
          sentAt={reset.sentAt}
          errorMessage={reset.errorMessage}
          onClose={() => setReset(null)}
          onSend={async () => {
            setReset((r) => (r ? { ...r, state: "sending" } : r));
            try {
              const res = await fetch(`/api/members/${reset.member.id}/password-reset`, { method: "POST" });
              const d = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(d.error || "Could not send the reset email");
              setReset((r) =>
                r ? { ...r, state: "sent", email: d.email ?? r.email, sentAt: new Date(d.sentAt ?? Date.now()) } : r,
              );
            } catch (e) {
              setReset((r) =>
                r ? { ...r, state: "error", errorMessage: e instanceof Error ? e.message : "Something went wrong" } : r,
              );
            }
          }}
          // Both of these are "the address is wrong" — and the only safe place
          // to change an address is the member record itself, never this dialog.
          onUseDifferentEmail={() => {
            const id = reset.member.id;
            setReset(null);
            router.push(`/dashboard/members/${id}?edit=1`);
          }}
          onAddEmail={() => {
            const id = reset.member.id;
            setReset(null);
            router.push(`/dashboard/members/${id}?edit=1`);
          }}
          onLinkGuardian={() => {
            const id = reset.member.id;
            setReset(null);
            router.push(`/dashboard/members/${id}?tab=family`);
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
  queueCounts,
  active,
  onPick,
}: {
  queueCounts: QueueCounts | null;
  active: string;
  onPick: (key: string) => void;
}) {
  // Each card is a saved filter that also arms the matching bulk action — not a
  // statistic.
  //
  // D-3: three of these rendered a literal em-dash and the fourth borrowed
  // `midMigration` from the segment counts, so the one number on screen was not
  // even a count of never-invited people. All four now come from the server,
  // derived from the SAME predicates the filter uses (`QUEUE_CLAUSES`), so a
  // card and the list it opens cannot disagree. The duplicates count runs the
  // same `groupDuplicates` as the duplicates page and counts GROUPS — nine
  // decisions to make, not eighteen rows.
  //
  // Past COUNT_CAP the server sends null and the cards render an em-dash again.
  // That is deliberate: at that scale the honest answer is "not counted here",
  // never a number that is quietly wrong.
  const cards = [
    { key: "neverInvited", label: "never invited", accent: "var(--color-orange-accent)", action: "Send invitations" },
    { key: "blocked", label: "blocked", accent: "#DC2626", action: "Fix contact details" },
    { key: "missingContact", label: "missing contact", accent: "var(--color-warn-text)", action: "Add an address" },
    { key: "duplicates", label: "possible duplicates", accent: "var(--color-brand)", action: "Review duplicates" },
  ] as const;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const isActive = active === c.key;
        const href = c.key === "duplicates" ? "/dashboard/members/duplicates" : null;
        const body = (
          <>
            <div className="text-[22px] font-semibold leading-none tabular-nums text-text-primary">
              {queueCounts ? queueCounts[c.key as keyof QueueCounts].toLocaleString() : "—"}
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

function BulkButton({
  label,
  primary,
  disabled,
  busy,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled || busy}
      onClick={onClick}
      title={disabled ? "You do not have permission for this action" : undefined}
      className={`inline-flex min-h-[44px] items-center rounded-lg px-2.5 text-[12.5px] font-medium transition-colors lg:min-h-[34px] ${
        disabled
          ? "cursor-not-allowed border border-app-border bg-surface text-[#9CA3AF]"
          : primary
            ? "bg-brand text-white hover:bg-brand-hover"
            : "border border-app-border bg-surface text-text-primary hover:bg-app-bg"
      }`}
    >
      {busy ? "Working…" : label}
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
      className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-app-border bg-surface px-2.5 text-[12.5px] text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-[32px] lg:px-2"
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
