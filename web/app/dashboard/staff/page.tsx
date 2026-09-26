"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ChevronRight, Shield, UserPlus } from "lucide-react";
import Sheet from "@/components/Sheet";
import AddStaffSheet from "@/components/staff/directory/AddStaffSheet";
import SetupLinkSheet from "@/components/staff/directory/SetupLinkSheet";
import { accessSummary } from "@/components/staff/directory/accessSummary";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { hasPermission, type PermissionLevel } from "@/lib/permissions";

// B21 — the Staff directory. Each row opens the staff profile
// (/dashboard/staff/<id>); the old Edit Staff modal is retired and its
// controls live on the profile's tabs. Add staff stays a quick dialog.

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

export default function StaffPage() {
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

  async function load() {
    setLoading(true);
    // Include owners so a club can see (and resend setup links to) co-owners.
    const res = await fetch("/api/staff?includeOwners=true");
    if (res.ok) setStaff(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    const res = await fetch(`/api/staff/${removing.id}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setRemoveBusy(false);
    const name = removing.firstName;
    setRemoving(null);
    setNotice(res.ok ? `${name} was removed from the staff.` : (typeof d.error === "string" ? d.error : "Couldn't remove this staff member."));
    load();
  }

  const list = staff.filter((s) => s.id !== session?.user?.id);
  const owners = list.filter((s) => s.role === "OWNER").length;
  const countLine = `${list.length} ${list.length === 1 ? "person" : "people"}${owners ? ` · ${owners} ${owners === 1 ? "owner" : "owners"}` : ""} · open anyone to manage their access, pay and schedule`;
  const smallBtn =
    "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3 text-[13px] font-medium md:min-h-[32px]";

  return (
    <div className="max-w-[1192px] p-4 pb-32 sm:p-6 md:pb-8 lg:p-8">
      <PageHeader
        title="Staff directory"
        description={loading ? "Coaches and staff." : countLine}
        actions={
          canManage ? (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="hidden min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover md:inline-flex md:min-h-[38px]"
            >
              + Add staff
            </button>
          ) : undefined
        }
      />

      {notice && (
        <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-app-border bg-surface px-4 py-3 text-[13px] text-text-primary">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="-my-2 inline-flex h-11 w-11 items-center justify-center text-text-muted hover:text-text-primary md:h-6 md:w-6">×</button>
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-app-border bg-surface"><SkeletonList rows={4} /></div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Shield size={26} strokeWidth={1.75} />}
          title="No staff yet"
          description="Add coaches and staff to give them access to the dashboard."
          action={canManage ? { label: "Add your first staff member", onClick: () => setShowAdd(true) } : undefined}
          className="rounded-xl border border-app-border bg-surface"
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
          <div
            className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_110px_auto] gap-4 border-b border-app-border px-5 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted md:grid"
            style={{ background: "var(--color-table-chrome)" }}
          >
            <span>Person</span>
            <span>Access</span>
            <span>Staff login</span>
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
                        {rowIsOwner && (
                          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[12px] font-medium text-brand">Owner</span>
                        )}
                      </span>
                      <span className="block truncate text-[12.5px] text-text-muted">{s.staffProfile?.title || s.email}</span>
                    </span>
                  </Link>
                  <Link href={href} className="min-w-0 text-[12.5px] text-text-muted hover:text-text-primary md:text-text-primary">
                    {accessSummary(s.role, s.staffProfile?.permissions ?? null)}
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
          </ul>
        </div>
      )}

      {/* Phones: pill FAB above the bottom nav. */}
      {canManage && (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="fixed right-4 z-20 inline-flex min-h-[48px] items-center gap-2 rounded-full bg-charcoal px-5 text-[15px] font-semibold text-white shadow-lg md:hidden"
          style={{ bottom: "calc(78px + env(safe-area-inset-bottom, 0px))" }}
        >
          <UserPlus className="h-4 w-4" aria-hidden /> Add staff
        </button>
      )}

      <AddStaffSheet open={showAdd} onClose={() => setShowAdd(false)} onAdded={load} />
      <SetupLinkSheet target={setupFor} onClose={() => setSetupFor(null)} />
      <Sheet
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.firstName ?? ""} from the staff?`}
        description={`${removing?.firstName ?? "They"} won't be able to sign in. Their history (attendance taken, pay records, activity) stays.`}
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
