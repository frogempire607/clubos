"use client";

// B21 — the staff profile shell. Sibling of the member profile: same header
// shape, the same ProfileTabs component, one tab rule line, and a leave guard.
// The page is used twice: /dashboard/staff/[id] (managers) and
// /dashboard/my-profile (a staff member's own profile). What each person may
// change comes from `viewer` in the payload; the API enforces the same rules.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Lock } from "lucide-react";
import { ProfileTabs } from "@/components/members/MemberProfileHeader";
import { MemberAvatar } from "@/components/members/MemberTracks";
import Sheet from "@/components/Sheet";
import { SkeletonCard } from "@/components/LoadingSkeleton";
import { useLeaveGuard } from "@/components/staff/useLeaveGuard";
import { STAFF_TABS, TAB_RULE, type StaffProfileData, type StaffTabKey, type StaffTabProps } from "@/components/staff/types";
import OverviewTab from "@/components/staff/tabs/OverviewTab";
import ProfileTab from "@/components/staff/tabs/ProfileTab";
import ScheduleTab from "@/components/staff/tabs/ScheduleTab";
import AccessTab from "@/components/staff/tabs/AccessTab";
import PayTab from "@/components/staff/tabs/PayTab";
import LessonsTab from "@/components/staff/tabs/LessonsTab";
import DocumentsTab from "@/components/staff/tabs/DocumentsTab";

const TAB_COMPONENT: Record<StaffTabKey, (p: StaffTabProps) => JSX.Element> = {
  overview: OverviewTab,
  profile: ProfileTab,
  schedule: ScheduleTab,
  access: AccessTab,
  pay: PayTab,
  lessons: LessonsTab,
  documents: DocumentsTab,
};

function isTab(v: string | null): v is StaffTabKey {
  return !!v && STAFF_TABS.some((t) => t.key === v);
}

// Tabs that were merged away. Old links, bookmarks and emails still land on
// the tab that now holds their content.
const LEGACY_TAB: Record<string, StaffTabKey> = { personal: "profile", portal: "profile" };

function tabFromParam(v: string | null): StaffTabKey {
  if (isTab(v)) return v;
  if (v && LEGACY_TAB[v]) return LEGACY_TAB[v];
  return "overview";
}

export default function StaffProfile({ staffId, selfRoute = false }: { staffId: string; selfRoute?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab: StaffTabKey = tabFromParam(params.get("tab"));

  const [data, setData] = useState<StaffProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { dirtyTabs, setTabDirty, guard, dialog } = useLeaveGuard();

  const reload = useCallback(async () => {
    const res = await fetch(`/api/staff/${staffId}`, { cache: "no-store" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error || "Couldn't load this profile.");
      return;
    }
    setData(d as StaffProfileData);
    setError(null);
  }, [staffId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const basePath = selfRoute ? "/dashboard/my-profile" : `/dashboard/staff/${staffId}`;
  const goTo = useCallback(
    (next: StaffTabKey) => {
      if (next === tab) return;
      const label = STAFF_TABS.find((t) => t.key === tab)?.label ?? "this tab";
      guard(tab, label, () => router.push(`${basePath}?tab=${next}`, { scroll: false }));
    },
    [tab, guard, router, basePath],
  );

  // Stable per-tab callbacks (identity changes only when the tab changes) and
  // no-op state updates when nothing changed — see useLeaveGuard for why.
  const setDirty = useCallback((d: boolean) => setTabDirty(tab, d), [setTabDirty, tab]);
  const setProblem = useCallback(
    (p: boolean) =>
      setProblems((cur) => {
        const has = cur.includes(tab);
        if (p === has) return cur;
        return p ? [...cur, tab] : cur.filter((k) => k !== tab);
      }),
    [tab],
  );

  const tabProps = useMemo<StaffTabProps | null>(
    () => data && { data, reload, setDirty, goTo, setProblem },
    [data, reload, setDirty, goTo, setProblem],
  );

  if (error) {
    return (
      <div className="p-4 sm:p-8">
        <div className="rounded-xl border border-app-border bg-surface p-6 text-sm text-text-muted">{error}</div>
      </div>
    );
  }
  if (!data || !tabProps) {
    return (
      <div className="mx-auto max-w-[1192px] p-4 sm:px-8 sm:py-7">
        <SkeletonCard />
      </div>
    );
  }

  const { staff, viewer, counts } = data;
  const fullName = `${staff.firstName} ${staff.lastName}`.trim();
  const initials = `${staff.firstName[0] ?? ""}${staff.lastName[0] ?? ""}`.toUpperCase();
  const allProblems = [...problems, ...(counts.w9Missing ? ["documents"] : [])];
  const Tab = TAB_COMPONENT[tab];
  const meta = [
    staff.title,
    staff.email,
    `on staff since ${new Date(staff.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`,
  ].filter(Boolean) as string[];

  async function sendSetupLink() {
    const res = await fetch(`/api/staff/${staffId}/setup-link`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setNotice(d.error || "Couldn't create a setup link.");
    try {
      await navigator.clipboard.writeText(d.setupUrl);
    } catch {}
    setNotice(d.emailed ? `Setup link emailed to ${staff.email} and copied.` : `Email didn't send — the setup link is copied, send it yourself.`);
  }

  async function removeStaff() {
    const res = await fetch(`/api/staff/${staffId}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setConfirmRemove(false);
      return setNotice(d.error || "Couldn't remove this staff member.");
    }
    router.push("/dashboard/staff");
  }

  const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";
  return (
    <div className="mx-auto max-w-[1192px] p-4 pb-32 sm:px-8 sm:py-7 md:pb-8">
      {!viewer.isSelf && (
        <Link href="/dashboard/staff" className="mb-3 inline-flex min-h-[44px] items-center gap-1 text-[13px] text-text-muted hover:text-text-primary md:min-h-0">
          <ChevronLeft className="h-4 w-4" /> All staff
        </Link>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3.5">
          <MemberAvatar initials={initials} imageUrl={staff.photoUrl} size={64} />
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-text-primary sm:text-[25px]">
              {fullName}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {viewer.isSelf && <span className="rounded-full bg-brand px-2 py-0.5 text-[12px] font-medium text-white">You</span>}
              <span className="rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: "var(--color-success-surface)", color: "var(--color-success-text)" }}>
                {staff.invitePending ? "Invited" : "Active"}
              </span>
              {staff.title && <span className="rounded-md bg-app-bg px-2 py-0.5 text-[12px] text-text-muted">{staff.title}</span>}
              <span className="rounded-md bg-app-bg px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
                {staff.role === "OWNER" ? "Owner" : "Staff"}
              </span>
              <span className="text-[12px] text-text-muted">{staff.invitePending ? "Setup link not used yet" : "Login set up"}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-[18px] gap-y-0.5 text-[13px] text-text-muted">
              {meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {viewer.isSelf ? (
            <button type="button" onClick={() => goTo("profile")} className={`${btn} bg-brand text-white hover:opacity-90`}>
              Edit my info
            </button>
          ) : (
            <>
              <a href={`mailto:${staff.email}`} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
                Message
              </a>
              {viewer.canEditRecord && (
                <button type="button" onClick={sendSetupLink} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
                  Setup link
                </button>
              )}
              {viewer.canEditRecord && (
                <button type="button" onClick={() => goTo("profile")} className={`${btn} bg-brand text-white hover:opacity-90`}>
                  Edit staff
                </button>
              )}
              {viewer.canRemove && (
                <button type="button" onClick={() => setConfirmRemove(true)} className={`${btn} border border-app-border text-red-600 hover:bg-app-bg`}>
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {notice && (
        <div role="status" className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-app-border bg-app-bg px-4 py-3 text-[13px] text-text-primary">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-text-muted hover:text-text-primary" aria-label="Dismiss">×</button>
        </div>
      )}

      {viewer.isSelf && !viewer.isOwner && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-4 py-3 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This is your profile. You can change your info, portal profile, weekly hours and time off. Your pay and access
            are set by the owner — you can see them here but not change them.
          </span>
        </div>
      )}

      <div className="mt-5">
        <ProfileTabs
          tabs={viewer.canSeeAccess === false ? STAFF_TABS.filter((t) => t.key !== "access") : STAFF_TABS}
          active={tab}
          counts={{ lessons: counts.lessons }}
          problems={allProblems}
          dirty={dirtyTabs}
          onSelect={(k) => goTo(k as StaffTabKey)}
        />
        <p className="mt-2 text-[12.5px] text-text-muted">{TAB_RULE[tab]}</p>
      </div>

      <div className="mt-4">
        <Tab {...tabProps} />
      </div>

      {dialog}
      <Sheet
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${staff.firstName} from the staff?`}
        description={`${staff.firstName} won't be able to sign in. Their history (attendance taken, pay records, activity) stays.`}
        footer={
          <>
            <button type="button" onClick={() => setConfirmRemove(false)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              Keep {staff.firstName}
            </button>
            <button type="button" onClick={removeStaff} className={`${btn} bg-red-600 text-white hover:bg-red-700`}>
              Remove from staff
            </button>
          </>
        }
      />
    </div>
  );
}
