// Phase 4.5.3 — the member profile's identity header, family switcher, tabs,
// and the two cards the handoff singles out (locked birthday, Account &
// security).
//
// Variant: `1c` TABS, confirmed by the owner 2026-08-04 (J-10). `1d` scroll+rail
// is not being built.
//
// ── The single family switcher ───────────────────────────────────────────────
// The handoff is emphatic: "This replaces every other 'managed member' selector
// on the page — there must be exactly one." The old profile had a switcher in
// the header AND a relationships card AND a guardian list, each with its own
// idea of who the family was, so staff could switch athlete in one and have the
// rest of the page keep showing the previous person.

"use client";

import Link from "next/link";
import { Lock, Pencil, RefreshCw } from "lucide-react";
import { MemberAvatar, MembershipPill, AccountSetupCell, RoleChips } from "@/components/members/MemberTracks";

export type ProfileTracks = {
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

export type FamilyPerson = {
  id: string;
  name: string;
  initials: string;
  /** "parent · pays", "athlete" — what they are TO THIS FAMILY, not their status. */
  annotation: string;
  imageUrl?: string | null;
};

export function IdentityHeader({
  member,
  tracks,
  planLine,
  joinedAt,
  legacyId,
  sourceLabel,
  actions,
}: {
  member: { id: string; fullName: string; initials: string; profileImageUrl: string | null; dateOfBirth: string | null };
  tracks: ProfileTracks;
  planLine: string | null;
  joinedAt: string | null;
  legacyId: string | null;
  sourceLabel: string | null;
  actions?: React.ReactNode;
}) {
  const meta = [
    planLine,
    joinedAt ? `joined ${fmt(joinedAt)}` : null,
    legacyId ? `${sourceLabel ? `${sourceLabel} ID` : "Legacy ID"} ${legacyId}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3.5">
        <span className="hidden sm:block">
          <MemberAvatar initials={member.initials} imageUrl={member.profileImageUrl} size={64} />
        </span>
        <span className="sm:hidden">
          <MemberAvatar initials={member.initials} imageUrl={member.profileImageUrl} size={56} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-text-primary sm:text-[25px]">
            {member.fullName}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <MembershipPill {...tracks.membership} />
            <RoleChips roles={tracks.role} />
            <AccountSetupCell {...tracks.accountSetup} showMeter={false} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-[18px] gap-y-0.5 text-[13px] text-text-muted">
            {meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
            {member.dateOfBirth && (
              <span className="inline-flex items-center gap-1">
                <Lock className="h-[11px] w-[11px]" /> {fmt(member.dateOfBirth)}
              </span>
            )}
          </div>
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** ONE instance per page. See the header comment. */
export function FamilySwitcher({
  familyName,
  people,
  currentId,
}: {
  familyName: string;
  people: FamilyPerson[];
  currentId: string;
}) {
  if (people.length <= 1) return null;
  return (
    <div className="rounded-xl border border-app-border bg-surface px-3 py-[9px]">
      <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-muted">
        {familyName} family
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap gap-1.5">
          {people.map((p) => {
            const current = p.id === currentId;
            return (
              <Link
                key={p.id}
                href={`/dashboard/members/${p.id}`}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-2 py-1 text-[12.5px] transition-colors md:min-h-[36px] ${
                  current ? "border-brand bg-surface font-medium text-text-primary" : "border-transparent text-text-muted hover:bg-app-bg"
                }`}
              >
                <MemberAvatar initials={p.initials} imageUrl={p.imageUrl} size={20} />
                <span className="truncate">{p.name}</span>
                <span className="text-[11px] opacity-70">{current ? "viewing" : p.annotation}</span>
              </Link>
            );
          })}
        </div>
        <Link href={`/dashboard/members/${currentId}?tab=family`} className="shrink-0 text-[12.5px] text-brand hover:underline">
          Manage family &amp; access →
        </Link>
      </div>
    </div>
  );
}

export const PROFILE_TABS = [
  { key: "overview", label: "Overview" },
  { key: "personal", label: "Personal info" },
  { key: "memberships", label: "Memberships" },
  { key: "family", label: "Family & access" },
  { key: "attendance", label: "Attendance" },
  { key: "payments", label: "Payments" },
  { key: "bookings", label: "Bookings" },
  { key: "messages", label: "Messages" },
  { key: "documents", label: "Documents" },
  { key: "migration", label: "Migration activity" },
  { key: "notes", label: "Notes" },
] as const;

export function ProfileTabs({
  active,
  counts,
  problems,
  onSelect,
}: {
  active: string;
  counts?: Partial<Record<string, number>>;
  /** Tabs carrying an unresolved problem get a 6px red dot (e.g. missing waiver). */
  problems?: string[];
  onSelect: (key: string) => void;
}) {
  return (
    <div role="tablist" className="-mx-4 overflow-x-auto border-b border-app-border px-4 md:mx-0 md:px-0">
      <div className="flex min-w-max gap-1">
        {PROFILE_TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(t.key)}
              className={`relative inline-flex min-h-[44px] items-center whitespace-nowrap px-2.5 py-2.5 text-[13.5px] transition-colors md:min-h-0 ${
                isActive ? "font-medium text-brand" : "text-text-muted hover:text-text-primary"
              }`}
            >
              {t.label}
              {counts?.[t.key] != null && <span className="ml-1 text-[11px] opacity-70">{counts[t.key]}</span>}
              {problems?.includes(t.key) && (
                <span
                  aria-label="Needs attention"
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                  style={{ background: "#DC2626" }}
                />
              )}
              {isActive && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The locked-birthday row. Copy is from the handoff and does real work: staff
 * repeatedly tried to "fix" a DOB to unblock a signup, which silently changed
 * age brackets, waiver requirements and minor rules. Naming who CAN change it,
 * and where, is what stops the support ticket.
 */
export function LockedBirthdayRow({
  dateOfBirth,
  age,
  guardianName,
}: {
  dateOfBirth: string | null;
  age: number | null;
  guardianName: string | null;
}) {
  return (
    <div
      className="-mx-3 rounded-lg p-3 sm:mx-0"
      style={{ background: "var(--color-table-chrome)", border: "1px solid var(--color-inset-border)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-[12px] font-medium text-text-primary">Birthday</span>
        <span className="text-[13px] font-medium text-text-primary">{dateOfBirth ? fmt(dateOfBirth) : "Not set"}</span>
        {age != null && <span className="text-[12px] text-text-muted">({age})</span>}
        <span
          className="rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase"
          style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}
        >
          Locked
        </span>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">
        Birthdays set age brackets, waivers and minor rules, so staff can&rsquo;t change them.{" "}
        <strong className="font-medium text-text-primary">
          {guardianName ?? "Their guardian"} updates it in the member portal
        </strong>{" "}
        under Profile → Personal details. Wrong date blocking a signup? Ask them to fix it there, then refresh.
      </p>
    </div>
  );
}

/** The 3-icon ownership legend above the contact grid. */
export function OwnershipLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-text-muted">
      <span className="inline-flex items-center gap-1">
        <Pencil className="h-3 w-3" /> you can edit
      </span>
      <span className="inline-flex items-center gap-1">
        <RefreshCw className="h-3 w-3" /> member keeps it current
      </span>
      <span className="inline-flex items-center gap-1">
        <Lock className="h-3 w-3" /> locked
      </span>
    </div>
  );
}

export function AccountSecurityCard({
  hasLogin,
  loginEmail,
  lastLoginAt,
  resetTargetEmail,
  /** Set when the reset would go to a guardian rather than the member. */
  resetTargetIsGuardian,
  guardianName,
  onSendReset,
  canReset,
}: {
  hasLogin: boolean;
  loginEmail: string | null;
  lastLoginAt: string | null;
  resetTargetEmail: string | null;
  resetTargetIsGuardian?: boolean;
  guardianName?: string | null;
  onSendReset: () => void;
  canReset: boolean;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-surface p-[18px]">
      <h3 className="text-[15px] font-semibold text-text-primary">Account &amp; security</h3>
      <dl className="mt-3 space-y-2 text-[13px]">
        {/* A minor usually has no login of their own — the guardian holds the
            family account. Saying only "No account yet" next to a live reset
            button reads as a contradiction, so name who does hold it. */}
        <Row
          label="Portal login"
          value={
            hasLogin
              ? "Active"
              : resetTargetIsGuardian
                ? `Held by ${guardianName ?? "their guardian"}`
                : "No account yet"
          }
        />
        {hasLogin && <Row label="Logs in as" value={loginEmail ?? "—"} />}
        <Row label="Last login" value={lastLoginAt ? fmt(lastLoginAt) : "Never"} />
        <Row label="Password" value="Never visible to staff" muted />
      </dl>

      <div className="mt-3 rounded-lg p-3" style={{ background: "var(--color-info-surface)" }}>
        <div className="text-[12.5px] font-medium text-text-primary">Send password reset link</div>
        <p className="mt-0.5 text-[12px] text-text-muted">
          {resetTargetEmail ? (
            <>
              Goes to the account email{" "}
              <strong className="font-medium text-text-primary">{resetTargetEmail}</strong> — not the contact email on
              the profile, which can differ. Works once, expires in 60 minutes, and is recorded against your name.
            </>
          ) : (
            <>No email on file, so there is nowhere to send a link.</>
          )}
        </p>
        <button
          onClick={onSendReset}
          disabled={!canReset}
          className="mt-2 min-h-[44px] rounded-lg bg-charcoal px-3 text-[13px] font-medium text-white transition-colors hover:bg-charcoal-hover disabled:cursor-not-allowed disabled:opacity-50 md:min-h-[38px]"
        >
          Send reset link
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`text-right ${muted ? "text-text-muted" : "text-text-primary"}`}>{value}</dd>
    </div>
  );
}

function fmt(v: string): string {
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
