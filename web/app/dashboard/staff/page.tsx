"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { ChevronRight, UserPlus, Users2, KeyRound, Briefcase } from "lucide-react";
import Sheet from "@/components/Sheet";
import AddStaffSheet from "@/components/staff/directory/AddStaffSheet";
import {
  AddContractorSheet,
  ContractorSheet,
  contractorKind,
  money,
  type Contractor,
} from "@/components/staff/directory/ContractorSheets";
import SetupLinkSheet from "@/components/staff/directory/SetupLinkSheet";
import { accessSummary } from "@/components/staff/directory/accessSummary";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { hasPermission, type PermissionLevel } from "@/lib/permissions";

// B21 — the Staff directory. Each row opens the staff profile
// (/dashboard/staff/<id>); the old Edit Staff modal is retired and its
// controls live on the profile's tabs. Add staff stays a quick dialog.
//
// 2026-09-28 — ONE list for everyone who works here. Staff logins and the
// no-login contractors / guest clinicians (formerly their own page at
// /dashboard/staff/contractors, which now redirects to ?type=contractors) sit
// together with a Type chip and a filter: All · Staff · Contractors & guests.
// Contractor rows open a Sheet (details, payments, archive, convert).
//
// Who sees contractors: every /api/contractors route is owner-only
// (requireOwner), so contractor rows, the filter and "Add contractor or guest"
// appear for owners only. A staff manager with Staff: full sees exactly what
// they saw before — the old contractors page's staff:full page rule never got
// them past the owner-only API anyway.

type StaffProfile = {
  title: string | null;
  hourlyRate: string | null;
  salary: string | null;
  appointmentPrice: string | null;
  permissions: Record<string, PermissionLevel>;
  // The member-portal fields. /api/staff has always returned these and the
  // modal has always edited them; the type just did not say so, so every read
  // went through `(staff.staffProfile as any)`. Declaring them removes ten
  // casts and means a renamed field fails the typecheck instead of silently
  // reading undefined and saving a blank over real data.
  bio: string | null;
  publicEmail: string | null;
  publicPhone: string | null;
  photoUrl: string | null;
  showOnPortal: boolean;
};

type StaffUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  createdAt: string;
  lastLoginAt?: string | null;
  /** From GET /api/staff: setup link sent but never used. */
  invitePending?: boolean;
  staffProfile: StaffProfile | null;
};

type TypeFilter = "all" | "staff" | "contractors";
const FILTERS: { v: TypeFilter; label: string }[] = [
  { v: "all", label: "All" },
  { v: "staff", label: "Staff" },
  { v: "contractors", label: "Contractors & guests" },
];

function TypeChip({ kind }: { kind: "Owner" | "Staff" | "Contractor" | "Guest" }) {
  const cls =
    kind === "Owner"
      ? "bg-brand/10 text-brand"
      : kind === "Staff"
        ? "bg-app-bg text-text-muted"
        : "border border-app-border text-text-muted";
  return <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${cls}`}>{kind}</span>;
}

export default function StaffPage() {
  return (
    <Suspense fallback={<div className="max-w-[1192px] p-4 sm:p-6 lg:p-8"><div className="rounded-xl border border-app-border bg-surface"><SkeletonList rows={4} /></div></div>}>
      <StaffDirectory />
    </Suspense>
  );
}

function StaffDirectory() {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [setupFor, setSetupFor] = useState<StaffUser | null>(null);
  const [removing, setRemoving] = useState<StaffUser | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { data: session } = useSession();
  const isOwner = session?.user?.role === "OWNER";
  const perms = (session?.user as { permissions?: Record<string, unknown> | null } | undefined)?.permissions ?? null;
  // Same bar the write routes use (POST /api/staff, setup-link, DELETE): Staff & contractors: full.
  const canManage = isOwner || hasPermission(perms, "staff", "full");
  // Mirrors /api/contractors (requireOwner): owners only.
  const showContractors = isOwner;

  const router = useRouter();
  const params = useSearchParams();
  const rawType = params.get("type");
  const typeFilter: TypeFilter =
    showContractors && (rawType === "staff" || rawType === "contractors") ? rawType : "all";
  function setTypeFilter(v: TypeFilter) {
    router.replace(v === "all" ? "/dashboard/staff" : `/dashboard/staff?type=${v}`, { scroll: false });
  }

  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [addChooser, setAddChooser] = useState(false);
  const [showAddContractor, setShowAddContractor] = useState(false);

  async function load() {
    setLoading(true);
    // Include owners so a club can see (and resend setup links to) co-owners.
    const res = await fetch("/api/staff?includeOwners=true");
    if (res.ok) setStaff(await res.json());
    setLoading(false);
  }

  const loadContractors = useCallback(async () => {
    if (!showContractors) return;
    const res = await fetch("/api/contractors");
    const d = res.ok ? await res.json().catch(() => []) : [];
    setContractors(Array.isArray(d) ? d : []);
  }, [showContractors]);

  useEffect(() => { load(); }, []);
  useEffect(() => { loadContractors(); }, [loadContractors]);

  // One Add button. Owners choose staff login vs contractor/guest; anyone who
  // can only do one of the two goes straight to it.
  function startAdd() {
    if (canManage && showContractors) setAddChooser(true);
    else if (showContractors) setShowAddContractor(true);
    else setShowAdd(true);
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    const res = await fetch(`/api/staff/${removing.id}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setRemoveBusy(false);
    const name = removing.firstName;
    setRemoving(null);
    const opened = Number(d?.schedule?.daysOpened ?? 0);
    setNotice(
      !res.ok
        ? (typeof d.error === "string" ? d.error : "Couldn't remove this staff member.")
        : d.scheduleError
          ? `${name} was removed from the staff, but their classes could not be updated — check Staff → Schedule.`
          : opened > 0
            ? `${name} was removed from the staff. ${opened} upcoming class day${opened === 1 ? "" : "s"} now need${opened === 1 ? "s" : ""} coverage — see Staff → Schedule.`
            : `${name} was removed from the staff.`,
    );
    load();
  }

  const allStaff = staff.filter((s) => s.id !== session?.user?.id);
  const owners = allStaff.filter((s) => s.role === "OWNER").length;
  // A converted contractor already has a staff row; their old record (kept for
  // its payment history) shows only under Contractors & guests.
  const contractorRows = !showContractors
    ? []
    : typeFilter === "contractors"
      ? contractors
      : typeFilter === "all"
        ? contractors.filter((c) => !c.convertedUserId)
        : [];
  const list = typeFilter === "contractors" ? [] : allStaff;
  const openContractors = contractors.filter((c) => !c.convertedUserId).length;
  const countLine = [
    `${allStaff.length} staff`,
    owners ? `${owners} ${owners === 1 ? "owner" : "owners"}` : null,
    showContractors ? `${openContractors} ${openContractors === 1 ? "contractor or guest" : "contractors & guests"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const addLabel = showContractors ? "Add" : "Add staff";
  const nothingToShow = list.length === 0 && contractorRows.length === 0;
  const smallBtn =
    "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3 text-[13px] font-medium md:min-h-[32px]";

  return (
    <div className="max-w-[1192px] p-4 pb-32 sm:p-6 md:pb-8 lg:p-8">
      <PageHeader
        title="All staff"
        description={loading ? "Everyone who works here." : countLine}
        actions={
          canManage || showContractors ? (
            <button
              type="button"
              onClick={startAdd}
              className="hidden min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover md:inline-flex md:min-h-[38px]"
            >
              + {addLabel}
            </button>
          ) : undefined
        }
      />

      {showContractors && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="Type" className="flex max-w-full flex-wrap gap-1 rounded-lg border border-app-border bg-app-bg p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.v}
                type="button"
                role="tab"
                aria-selected={typeFilter === f.v}
                onClick={() => setTypeFilter(f.v)}
                className={`inline-flex min-h-[44px] items-center justify-center rounded-md px-3 text-[13px] font-medium md:min-h-[32px] ${
                  typeFilter === f.v ? "bg-surface text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {typeFilter === "contractors" && contractors.length > 0 && (
            <a
              href="/api/contractors/export"
              className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-3 text-[13px] font-medium text-text-primary hover:bg-app-bg md:min-h-[32px]"
            >
              Export contractor payments
            </a>
          )}
        </div>
      )}

      {notice && (
        <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-app-border bg-surface px-4 py-3 text-[13px] text-text-primary">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="-my-2 inline-flex h-11 w-11 items-center justify-center text-text-muted hover:text-text-primary md:h-6 md:w-6">×</button>
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-app-border bg-surface"><SkeletonList rows={4} /></div>
      ) : nothingToShow ? (
        typeFilter === "contractors" ? (
          <EmptyState
            icon={<Briefcase size={26} strokeWidth={1.75} />}
            title="No contractors or guests yet"
            description="Add a guest clinician, referee, photographer or other paid help to start logging payments. No login needed."
            action={{ label: "Add a contractor or guest", onClick: () => setShowAddContractor(true) }}
            className="rounded-xl border border-app-border bg-surface"
          />
        ) : (
          <EmptyState
            icon={<Users2 size={26} strokeWidth={1.75} />}
            title="No staff yet"
            description="Add coaches and staff to give them access to the dashboard."
            action={canManage ? { label: "Add your first staff member", onClick: () => setShowAdd(true) } : undefined}
            className="rounded-xl border border-app-border bg-surface"
          />
        )
      ) : (
        <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
          <div
            className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_110px_auto] gap-4 border-b border-app-border px-5 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted md:grid"
            style={{ background: "var(--color-table-chrome)" }}
          >
            <span>Person</span>
            <span>Access</span>
            <span>Login</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul>
            {list.map((s) => {
              const rowIsOwner = s.role === "OWNER";
              const invited = !!s.invitePending;
              const href = `/dashboard/staff/${s.id}`;
              return (
                <li
                  key={s.id}
                  className="grid grid-cols-1 gap-2 border-b px-4 py-3.5 last:border-b-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_110px_auto] md:items-center md:gap-4 md:px-5"
                  style={{ borderColor: "var(--color-hairline)" }}
                >
                  <Link href={href} className="flex min-h-[44px] min-w-0 items-center gap-3 rounded-lg hover:opacity-90">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-app-border text-[13px] font-semibold text-text-primary">
                      {s.staffProfile?.photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.staffProfile.photoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <>{s.firstName[0]}{s.lastName[0]}</>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[14px] font-semibold text-text-primary">{s.firstName} {s.lastName}</span>
                        <TypeChip kind={rowIsOwner ? "Owner" : "Staff"} />
                      </span>
                      <span className="block truncate text-[12.5px] text-text-muted">{s.staffProfile?.title || s.email}</span>
                    </span>
                  </Link>
                  <Link href={href} className="min-w-0 text-[12.5px] text-text-muted hover:text-text-primary md:text-text-primary">
                    {s.role === "OWNER" || s.staffProfile?.permissions ? accessSummary(s.role, s.staffProfile?.permissions ?? null) : ""}
                  </Link>
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: invited ? "var(--color-warn-text)" : "var(--color-success-icon)" }}
                      aria-hidden
                    />
                    <span className={invited ? "font-medium" : "text-text-muted"} style={invited ? { color: "var(--color-warn-text)" } : undefined}>
                      {invited ? "Invited" : "Set up"}
                    </span>
                  </span>
                  <div className="flex flex-wrap items-center justify-end gap-1 border-t pt-2 md:border-0 md:pt-0" style={{ borderColor: "var(--color-hairline)" }}>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => setSetupFor(s)}
                        className={`${smallBtn} text-text-muted hover:bg-app-bg hover:text-text-primary`}
                        title="Create a fresh 14-day setup link"
                      >
                        Setup link
                      </button>
                    )}
                    {canManage && !rowIsOwner && (
                      <button
                        type="button"
                        onClick={() => setRemoving(s)}
                        className={`${smallBtn} hover:bg-app-bg`}
                        style={{ color: "var(--color-danger-text)" }}
                      >
                        Remove
                      </button>
                    )}
                    <Link href={href} className={`${smallBtn} gap-0.5 text-brand hover:bg-app-bg`}>
                      Open profile <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </div>
                </li>
              );
            })}
            {contractorRows.map((c) => {
              const kind = contractorKind(c.role);
              const initials = c.name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((p) => p[0]?.toUpperCase() ?? "")
                .join("");
              return (
                <li
                  key={`c-${c.id}`}
                  className="grid grid-cols-1 gap-2 border-b px-4 py-3.5 last:border-b-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_110px_auto] md:items-center md:gap-4 md:px-5"
                  style={{ borderColor: "var(--color-hairline)" }}
                >
                  <button
                    type="button"
                    onClick={() => setContractorId(c.id)}
                    className="flex min-h-[44px] min-w-0 items-center gap-3 rounded-lg text-left hover:opacity-90"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-app-border text-[13px] font-semibold text-text-muted">
                      {initials || "?"}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[14px] font-semibold text-text-primary">{c.name}</span>
                        <TypeChip kind={kind} />
                      </span>
                      <span className="block truncate text-[12.5px] text-text-muted">{c.role || c.email || c.phone || "No contact on file"}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setContractorId(c.id)}
                    className="min-w-0 text-left text-[12.5px] text-text-muted hover:text-text-primary md:text-text-primary"
                  >
                    {c.paymentCount > 0
                      ? `Paid ${money(c.totalPaid)} · ${c.paymentCount} ${c.paymentCount === 1 ? "payment" : "payments"}${c.lastPaidAt ? ` · last ${new Date(c.lastPaidAt).toLocaleDateString()}` : ""}`
                      : "No payments logged yet"}
                    {!c.w9Url && !c.convertedUserId && <span className="text-text-muted"> · no W-9</span>}
                  </button>
                  <span className="flex items-center gap-1.5 text-[12.5px] text-text-muted">
                    <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {c.convertedUserId ? "Now on staff" : "No login"}
                  </span>
                  <div className="flex flex-wrap items-center justify-end gap-1 border-t pt-2 md:border-0 md:pt-0" style={{ borderColor: "var(--color-hairline)" }}>
                    <button type="button" onClick={() => setContractorId(c.id)} className={`${smallBtn} gap-0.5 text-brand hover:bg-app-bg`}>
                      {c.convertedUserId ? "Payment history" : "Manage"} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Phones: pill FAB above the bottom nav. */}
      {(canManage || showContractors) && (
        <button
          type="button"
          onClick={startAdd}
          className="fixed right-4 z-20 inline-flex min-h-[48px] items-center gap-2 rounded-full bg-charcoal px-5 text-[15px] font-semibold text-white shadow-lg md:hidden"
          style={{ bottom: "calc(78px + env(safe-area-inset-bottom, 0px))" }}
        >
          <UserPlus className="h-4 w-4" aria-hidden /> {addLabel}
        </button>
      )}

      <AddStaffSheet open={showAdd} onClose={() => setShowAdd(false)} onAdded={load} />
      {showContractors && (
        <>
          <AddContractorSheet
            open={showAddContractor}
            onClose={() => setShowAddContractor(false)}
            onSaved={loadContractors}
          />
          <ContractorSheet
            id={contractorId}
            onClose={() => setContractorId(null)}
            onChanged={() => {
              loadContractors();
              load();
            }}
          />
          <Sheet
            open={addChooser}
            onClose={() => setAddChooser(false)}
            title="Who are you adding?"
          >
            <div className="space-y-2 pb-1">
              {[
                {
                  key: "staff",
                  icon: Users2,
                  title: "Add staff",
                  desc: "A coach or staff member who signs in. You choose their access.",
                  go: () => setShowAdd(true),
                },
                {
                  key: "contractor",
                  icon: Briefcase,
                  title: "Add contractor or guest",
                  desc: "Guest clinicians, referees, photographers. No login — you log what you pay them.",
                  go: () => setShowAddContractor(true),
                },
              ].map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => {
                    setAddChooser(false);
                    o.go();
                  }}
                  className="flex min-h-[64px] w-full items-center gap-3 rounded-lg border border-app-border px-4 py-3 text-left hover:bg-app-bg"
                >
                  <o.icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold text-text-primary">{o.title}</span>
                    <span className="block text-[13px] text-text-muted">{o.desc}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                </button>
              ))}
            </div>
          </Sheet>
        </>
      )}
      <SetupLinkSheet target={setupFor} onClose={() => setSetupFor(null)} />
      <Sheet
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.firstName ?? ""} from the staff?`}
        description={`${removing?.firstName ?? "They"} won't be able to sign in. They come off the recurring schedule, and any upcoming class days they were on will show as needing coverage. Their history (classes already coached, attendance taken, pay records, activity) stays.`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setRemoving(null)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-4 text-[13.5px] font-medium text-text-primary hover:bg-app-bg md:min-h-[36px]"
            >
              Keep {removing?.firstName}
            </button>
            <button
              type="button"
              onClick={confirmRemove}
              disabled={removeBusy}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-red-600 px-4 text-[13.5px] font-medium text-white hover:bg-red-700 disabled:opacity-50 md:min-h-[36px]"
            >
              {removeBusy ? "Removing…" : "Remove from staff"}
            </button>
          </>
        }
      />
    </div>
  );
}
