"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import FamilyAccessCard, { type FamilyPayload } from "@/components/members/FamilyAccessCard";
import TransferMembershipModal from "@/components/members/TransferMembershipModal";
import {
  AccountSecurityCard,
  FamilySwitcher,
  IdentityHeader,
  LockedBirthdayRow,
  OwnershipLegend,
  ProfileTabs,
  type FamilyPerson,
  type ProfileTracks,
} from "@/components/members/MemberProfileHeader";
import { EditMemberDrawer, type EditableMember, type MemberCustomField } from "@/components/members/EditMemberDrawer";
import { MemberActionsMenu } from "@/components/members/MemberActionsMenu";
import { PasswordResetDialog, type ResetState } from "@/components/members/PasswordResetDialog";
import { NextActionBanner, NextActionButton } from "@/components/members/MemberTracks";
import type { NextAction } from "@/lib/memberTracks";
import { ArrowLeft, Pencil } from "lucide-react";
import { feeBreakdown } from "@/lib/fees";
import { hasPermission } from "@/lib/permissions";

type Sub = {
  id: string;
  optionLabel: string;
  price: string;
  billingPeriod: string | null;
  billingType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  startedAt: string | null;
  canceledAt: string | null;
  notes: string | null;
  membership: { name: string } | null;
};

type Relationship = {
  id: string;
  type: string;
  note: string | null;
  other: { id: string; firstName: string; lastName: string; status: string };
};

/** §1c "Waivers & documents". `expired` is why a signed doc can still be missing. */
type MemberDocument = {
  id: string;
  title: string;
  type: string;
  requiredAt: string[];
  requiresGuardianSignature: boolean;
  signedAt: string | null;
  signerName: string | null;
  relationship: string | null;
  expiresAt: string | null;
  expired: boolean;
};

/** §1c "Full migration activity" — MemberMigrationEvent, actor already resolved. */
type MigrationEvent = {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
  actor: string | null;
};

type MemberDetail = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  dateOfBirth: string | null;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  joinedAt: string;
  tags: string;
  notes: string | null;
  profileImageUrl: string | null;
  membership: { name: string } | null;
  subscriptions: Sub[];
  transactions: { id: string; amount: string; type: string; status: string; description: string | null; createdAt: string }[];
  bookings: { id: string; status: string; event: { id: string; name: string; type: string; startsAt: string } | null }[];
  attendanceRecords: { id: string; status: string; createdAt: string; classSession: { startsAt: string; recurringClass: { name: string } | null } | null }[];
  eventRegistrations: { id: string; status: string; amountDue: string | null; amountPaid: string | null; event: { id: string; name: string; startsAt: string } | null }[];
  relationships: Relationship[];
  /** Every club document plus this member's signature state. See the API note. */
  documents?: MemberDocument[];
  migrationEvents?: MigrationEvent[];
  // Session D, D-4 — the rest of what PATCH already accepts, so the drawer can
  // edit everything except birthday and password.
  gender?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  customFieldValues?: string | null;
  guardianRelationship?: string | null;
  // Phase 4B — the access edges the profile never loaded. `relationships`
  // above are descriptive labels and grant nothing; `family` is the real thing.
  family?: FamilyPayload;
  /** Siblings, reached through a shared confirmed guardian — see the API note. */
  familyMembers?: { id: string; name: string; profileImageUrl: string | null; isMinor: boolean; viaGuardian: string; canPay: boolean }[];
  migrationStatus?: string | null;
  legacyMembershipName?: string | null;
  trialEndsAt?: string | null;
  passProcessingFees?: boolean;
  // Phase 4.5.3 — the SAME derived tracks the roster row renders, so the
  // profile can never disagree with the list it was opened from.
  tracks?: ProfileTracks | null;
  nextAction?: NextAction | null;
  sourceLabel?: string | null;
  legacyMemberId?: string | null;
  birthdayLockedAt?: string | null;
  user?: { id: string; email: string; lastLoginAt: string | null } | null;
};

const statusColors: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: "var(--color-success)", fg: "#1F1F23" },
  PROSPECT: { bg: "var(--color-warning)", fg: "#fff" },
  INACTIVE: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  PAUSED: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  MIGRATING: { bg: "#1F1F23", fg: "#fff" },
  PENDING: { bg: "#EDEBFF", fg: "#4F46E5" },
};

const REL_TYPES = ["SIBLING", "COUSIN", "FRIEND", "TEAMMATE", "PARENT", "CHILD", "SPOUSE", "OTHER"];

function fmtDate(d: string | null) {
  return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}
function fmtMoney(v: string | number | null) {
  if (v == null) return "—";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function MemberProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const search = useSearchParams();
  const [m, setM] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSub, setEditingSub] = useState<Sub | null>(null);
  const [addingRel, setAddingRel] = useState(false);

  // ── Phase 4.5.3/4.5.4/4.5.5 wiring ──────────────────────────────────────
  // These components shipped in session 2 and were never mounted anywhere, so
  // the profile still rendered the pre-4.5 layout and there was no way to edit
  // a member at all. Tab and drawer state live in the URL so a tab is
  // linkable and the ⋯ menu's "Edit member" (?edit=1) lands where it says.
  const tab = search.get("tab") ?? "overview";
  const setTab = useCallback(
    (key: string) => {
      const next = new URLSearchParams(search.toString());
      if (key === "overview") next.delete("tab");
      else next.set("tab", key);
      router.replace(next.toString() ? `?${next.toString()}` : "?", { scroll: false });
    },
    [router, search],
  );

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [reset, setReset] = useState<{
    state: ResetState;
    email: string | null;
    isGuardianEmail: boolean;
    sentAt?: Date;
    errorMessage?: string;
  } | null>(null);
  const [me, setMe] = useState<{ role?: string; name?: string; permissions?: Record<string, unknown> | null } | null>(null);

  useEffect(() => {
    if (search.get("edit") === "1") {
      setEditOpen(true);
      const next = new URLSearchParams(search.toString());
      next.delete("edit");
      router.replace(next.toString() ? `?${next.toString()}` : "?", { scroll: false });
    }
    // Only react to the flag itself; `search` churns on every tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.get("edit")]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/members/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setM(d); setLoading(false); });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Session D, D-4 — club-defined fields for the edit drawer. Fetched once and
  // separately: most clubs define none, and a failure here must not stop the
  // profile rendering or the drawer opening (it just has no Club fields group).
  const [customFields, setCustomFields] = useState<MemberCustomField[]>([]);
  useEffect(() => {
    fetch("/api/custom-fields")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCustomFields(Array.isArray(d) ? d : (d?.customFields ?? [])))
      .catch(() => setCustomFields([]));
  }, []);

  // Moving a membership between siblings is its own sub-scope, not billing:full
  // — a front-desk lead may need it without prices, cards and plans.
  const [canTransfer, setCanTransfer] = useState(false);
  const [transferringSubId, setTransferringSubId] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (!me) return;
        setMe(me);
        setCanTransfer(
          me.role === "OWNER" ||
            me.permissions?.billing_subScopes?.transfer_subscription === true,
        );
      })
      .catch(() => {});
  }, []);

  // ── Actions the header, drawer and Account & security card share ────────
  // One implementation each, so the button in the drawer and the button in the
  // card can never do different things.
  const sendReset = useCallback(async () => {
    setReset((r) => (r ? { ...r, state: "sending" } : r));
    try {
      const res = await fetch(`/api/members/${id}/password-reset`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not send the reset email");
      setReset({
        state: "sent",
        email: d.email ?? null,
        isGuardianEmail: !!d.isGuardianEmail,
        sentAt: new Date(d.sentAt ?? Date.now()),
      });
    } catch (e) {
      setReset((r) => ({
        state: "error",
        email: r?.email ?? null,
        isGuardianEmail: !!r?.isGuardianEmail,
        errorMessage: e instanceof Error ? e.message : "Something went wrong",
      }));
    }
  }, [id]);

  const openReset = useCallback(async () => {
    const r = await fetch(`/api/members/${id}/password-reset`);
    const d = await r.json().catch(() => ({}));
    // Same distinction the roster makes: no account is not no address, and the
    // dialog can only say the second one truthfully.
    if (d.reason === "NO_LOGIN") {
      setToast({ kind: "err", text: "No portal account yet — send an invitation instead of a password reset." });
      return;
    }
    setReset({
      state: d.canSend ? "confirm" : "no-email",
      email: d.email ?? null,
      isGuardianEmail: !!d.isGuardianEmail,
    });
  }, [id]);

  const saveEdit = useCallback(
    // `unknown` because customFieldValues travels as an object, not a string.
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch(`/api/members/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof d.error === "string" ? d.error : "Could not save the changes");
        setEditOpen(false);
        setToast({ kind: "ok", text: "Changes saved." });
        load();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : "Could not save the changes");
      } finally {
        setSaving(false);
      }
    },
    [id, load],
  );

  const onMenuAction = useCallback(
    async (key: string, mm: { id: string; fullName: string }) => {
      try {
        switch (key) {
          case "resend": {
            const r = await fetch(`/api/members/${mm.id}/resend-invitation`, { method: "POST" });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || "Could not send the invitation");
            setToast({ kind: "ok", text: `${d.isReminder ? "Reminder" : "Invitation"} sent.` });
            load();
            break;
          }
          case "reset":
            await openReset();
            break;
          case "assign":
            router.push(`/dashboard/members/${mm.id}/billing`);
            break;
          case "relationship":
            setTab("family");
            break;
          case "checkin":
            router.push(`/dashboard/attendance?member=${mm.id}`);
            break;
          case "archive": {
            if (
              !confirm(
                `Archive ${mm.fullName}?\n\nThey stop appearing in the roster, billing and messaging. Nothing is deleted — history, payments and documents are kept, and an owner can restore them.`,
              )
            )
              break;
            const r = await fetch(`/api/members/${mm.id}`, { method: "DELETE" });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not archive");
            router.push("/dashboard/members");
            break;
          }
        }
      } catch (e) {
        setToast({ kind: "err", text: e instanceof Error ? e.message : "Something went wrong" });
      }
    },
    [load, openReset, router, setTab],
  );

  if (loading) return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;
  if (!m) return <div className="p-8 text-center text-text-muted text-sm">Member not found.</div>;

  // Mid-migration members sit as PROSPECT in the DB but are existing members
  // being switched over — show them as "Migrating", not "Prospect".
  const activeSub = m.subscriptions.find((s) => s.status === "active");
  const pendingSub = m.subscriptions.find((s) => s.status === "pending");
  const pastSubs = m.subscriptions.filter((s) => s.status !== "active");
  const inTrial = !!m.trialEndsAt && new Date(m.trialEndsAt) > new Date();
  // An ACTIVE account with no active paid membership (and not on a staff-granted
  // trial) is really a Prospect — that's Kelly's case. If a purchase is mid-flight,
  // surface it as Pending instead so it reads clearly as "not charged yet".
  const displayStatus =
    m.status === "PROSPECT" && m.migrationStatus && m.migrationStatus !== "COMPLETED"
      ? "MIGRATING"
      : m.status === "ACTIVE" && !activeSub && !inTrial
        ? (pendingSub ? "PENDING" : "PROSPECT")
        : m.status;
  const sc = statusColors[displayStatus] ?? statusColors.INACTIVE;
  void sc;

  const isOwner = me?.role === "OWNER";
  const canEdit = isOwner || hasPermission(me?.permissions ?? null, "members", "edit");
  const canBill = isOwner || hasPermission(me?.permissions ?? null, "billing", "full");
  const staffName = me?.name || "you";

  // The header needs tracks. When derivation failed server-side the API sends
  // null, so synthesise the minimum from what the page already computed rather
  // than rendering a profile with no status at all.
  const tracks: ProfileTracks = m.tracks ?? {
    role: [],
    membership: {
      track: displayStatus,
      label: displayStatus === "MIGRATING" ? "Migrating" : displayStatus.charAt(0) + displayStatus.slice(1).toLowerCase(),
      detail: null,
    },
    accountSetup: {
      track: "UNKNOWN",
      label: "Status unavailable",
      dot: "muted",
      meter: { step: 0, total: 0, applicable: false, waitingOn: "NOBODY", steps: [] },
    },
  };

  // ── The one family list ────────────────────────────────────────────────
  // Built from `family` (the real access edges), never from `relationships`
  // (descriptive labels that grant nothing). The annotation says what someone
  // is TO THIS FAMILY — "parent · pays" — not their membership status.
  const familyPeople: FamilyPerson[] = [
    {
      id: m.id,
      name: `${m.firstName} ${m.lastName}`,
      initials: `${m.firstName[0] ?? ""}${m.lastName[0] ?? ""}`.toUpperCase(),
      annotation: m.isMinor ? "athlete" : "member",
      imageUrl: m.profileImageUrl,
    },
    ...(m.familyMembers ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      initials: initialsOf(a.name),
      annotation: [a.isMinor ? "athlete" : "member", a.canPay ? "pays" : null].filter(Boolean).join(" · "),
      imageUrl: a.profileImageUrl,
    })),
    // A guardian appears only when they are themselves a member of the club —
    // a guardian-only account is not a member and must not be offered as a
    // profile to open (there is nothing behind the link).
    ...(m.family?.guardians ?? [])
      .filter((g) => g.memberId && g.memberId !== m.id && !(m.familyMembers ?? []).some((f) => f.id === g.memberId))
      .map((g) => ({
        id: g.memberId as string,
        name: g.name,
        initials: initialsOf(g.name),
        annotation: [g.relationship?.toLowerCase() ?? "guardian", g.canPay ? "pays" : null].filter(Boolean).join(" · "),
        imageUrl: g.profileImageUrl,
      })),
  ];

  // §1c — a required document that is unsigned OR past its validity window.
  // Both block the same things, so both count as missing.
  const missingDocs = (m.documents ?? []).filter(
    (d) => d.requiredAt.length > 0 && (!d.signedAt || d.expired),
  ).length;

  const tabCounts: Partial<Record<string, number>> = {
    memberships: m.subscriptions.length,
    family: (m.family?.guardians.length ?? 0) + (m.family?.managedAthletes.length ?? 0),
    attendance: m.attendanceRecords.length,
    payments: m.transactions.length,
    bookings: m.bookings.length + m.eventRegistrations.length,
    documents: m.documents?.length ?? 0,
    migration: m.migrationEvents?.length ?? 0,
  };
  // A red dot means someone has to do something, not merely that a tab is
  // empty. Pending guardian requests are the case that was invisible before;
  // a missing waiver is the case the handoff names explicitly.
  const tabProblems: string[] = [
    (m.family?.pendingGuardianRequests.length ?? 0) > 0 ? "family" : null,
    missingDocs > 0 ? "documents" : null,
  ].filter(Boolean) as string[];

  /** Show a card only on Overview and its own tab. */
  const on = (key: string) => tab === "overview" || tab === key;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link href="/dashboard/members" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Back to members
      </Link>

      {toast && (
        <div
          role="status"
          className="mt-3 rounded-lg border px-3 py-2 text-[13px]"
          style={
            toast.kind === "ok"
              ? { background: "var(--color-success-surface)", borderColor: "var(--color-success-text)", color: "var(--color-success-text)" }
              : { background: "var(--color-danger-surface)", borderColor: "var(--color-danger-text)", color: "var(--color-danger-text)" }
          }
        >
          {toast.text}
        </div>
      )}

      {/* ── Identity header (4.5.3) ───────────────────────────────────────
          Renders the SAME derived tracks as the roster row. When the API's
          derivation fails it returns tracks:null, and this falls back to the
          status the page already computed — a degraded header beats a blank
          profile. */}
      <div className="mt-3">
        <IdentityHeader
          member={{
            id: m.id,
            fullName: `${m.firstName} ${m.lastName}`,
            initials: `${m.firstName[0] ?? ""}${m.lastName[0] ?? ""}`.toUpperCase(),
            profileImageUrl: m.profileImageUrl,
            dateOfBirth: m.dateOfBirth,
          }}
          tracks={tracks}
          planLine={activeSub?.membership?.name ?? m.legacyMembershipName ?? null}
          joinedAt={m.joinedAt}
          legacyId={m.legacyMemberId ?? null}
          sourceLabel={m.sourceLabel ?? null}
          actions={
            <>
              <button
                onClick={() => setEditOpen(true)}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg"
              >
                <Pencil className="h-4 w-4" /> Edit
              </button>
              <Link
                href={`/dashboard/members/${id}/billing`}
                className="inline-flex min-h-[38px] items-center rounded-lg border border-app-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-app-bg"
              >
                Manage billing
              </Link>
              <MemberActionsMenu
                member={{ id: m.id, fullName: `${m.firstName} ${m.lastName}` }}
                canEdit={canEdit}
                canBill={canBill}
                isOwner={isOwner}
                onAction={onMenuAction}
                size={38}
              />
            </>
          }
        />
      </div>

      {/* The ONE family switcher. Returns null for a one-person family. */}
      {familyPeople.length > 1 && (
        <div className="mt-4">
          <FamilySwitcher familyName={m.lastName} people={familyPeople} currentId={m.id} />
        </div>
      )}

      {/* The next action, stated once, from the same resolver as the list. */}
      {m.nextAction && m.nextAction.kind !== "NONE" && (
        <div className="mt-4">
          <NextActionBanner action={m.nextAction} memberName={m.firstName}>
            <NextActionButton
              action={m.nextAction}
              allowed={m.nextAction.permission?.startsWith("billing") ? canBill : canEdit}
              requiredRoleLabel={m.nextAction.permission?.startsWith("billing") ? "Billing" : "Members"}
              onClick={() =>
                onMenuAction(
                  m.nextAction?.permission?.startsWith("billing") ? "assign" : "resend",
                  { id: m.id, fullName: `${m.firstName} ${m.lastName}` },
                )
              }
            />
          </NextActionBanner>
        </div>
      )}

      <div className="mt-5">
        <ProfileTabs active={tab} onSelect={setTab} counts={tabCounts} problems={tabProblems} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Personal info (4.5.3) ──────────────────────────────────────
            Contact facts plus the two cards the handoff singles out: the
            locked birthday (staff kept "fixing" DOBs to unblock signups,
            silently moving age brackets and waiver requirements) and Account
            & security, which is where a password reset actually belongs. */}
        {on("personal") && (
        <Card title="Personal info">
          <div className="space-y-3">
            <OwnershipLegend />
            <dl className="space-y-2 text-[13px]">
              <InfoRow label="Email" value={m.email} />
              <InfoRow label="Phone" value={m.phone} />
              {m.isMinor && (
                <>
                  <InfoRow label="Guardian" value={m.guardianName} />
                  <InfoRow label="Guardian email" value={m.guardianEmail} />
                  <InfoRow label="Guardian phone" value={m.guardianPhone} />
                </>
              )}
              <InfoRow label="Joined" value={fmtDate(m.joinedAt)} />
            </dl>
            <LockedBirthdayRow
              dateOfBirth={m.dateOfBirth}
              age={m.dateOfBirth ? Math.floor((Date.now() - new Date(m.dateOfBirth).getTime()) / 31557600000) : null}
              guardianName={m.family?.guardians[0]?.name ?? m.guardianName ?? null}
            />
            {m.tags.trim() && (
              <div className="flex flex-wrap gap-1">
                {m.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                  <span key={t} className="rounded-full bg-app-bg px-2 py-0.5 text-xs text-text-primary">{t}</span>
                ))}
              </div>
            )}
            <button
              onClick={() => setEditOpen(true)}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-app-border px-3 text-sm text-text-primary transition-colors hover:bg-app-bg"
            >
              <Pencil className="h-4 w-4" /> Edit details
            </button>
          </div>
        </Card>
        )}

        {on("personal") && (
          <AccountSecurityCard
            hasLogin={!!m.user}
            loginEmail={m.user?.email ?? null}
            lastLoginAt={m.user?.lastLoginAt ?? null}
            resetTargetEmail={m.user?.email ?? m.family?.guardians[0]?.email ?? null}
            resetTargetIsGuardian={!m.user && !!m.family?.guardians.length}
            guardianName={m.family?.guardians[0]?.name ?? null}
            canReset={canEdit && !!(m.user || m.family?.guardians.length)}
            onSendReset={openReset}
          />
        )}

        {on("memberships") && (
        <Card
          title="Current membership"
          action={
            <Link href={`/dashboard/members/${id}/billing`} className="text-xs text-brand hover:underline">
              Manage billing
            </Link>
          }
        >
          {activeSub ? (
            <SubRow sub={activeSub} passFees={m.passProcessingFees} onEdit={() => setEditingSub(activeSub)} onTransfer={canTransfer ? () => setTransferringSubId(activeSub.id) : undefined} />
          ) : pendingSub ? (
            <div className="space-y-2">
              <p className="text-xs text-text-muted">
                Purchase in progress — <strong className="text-text-primary">not charged yet</strong>.
                Activates when payment completes or staff approves.
              </p>
              <SubRow sub={pendingSub} passFees={m.passProcessingFees} onEdit={() => setEditingSub(pendingSub)} onTransfer={canTransfer ? () => setTransferringSubId(pendingSub.id) : undefined} />
            </div>
          ) : (
            <p className="text-sm text-text-muted">No active membership.</p>
          )}
        </Card>
        )}

        {on("family") && (
        <FamilyAccessCard
          memberId={id}
          memberName={m.firstName}
          family={m.family}
          onChanged={load}
          onAssignMembership={(subId) => setTransferringSubId(subId)}
        />
        )}

        {on("family") && (
        <Card
          title="Family labels"
          className="lg:col-span-2"
          action={<button onClick={() => setAddingRel(true)} className="text-xs text-brand hover:underline">+ Add label</button>}
        >
          <p className="text-xs text-text-muted -mt-1 mb-2.5">
            Notes about who is related to whom. These do <strong>not</strong> give anyone access —
            to let a parent manage this athlete, use Family &amp; access above.
          </p>
          {m.relationships.length === 0 ? (
            <p className="text-sm text-text-muted">No family labels.</p>
          ) : (
            <ul className="space-y-1.5">
              {m.relationships.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span>
                    <Link href={`/dashboard/members/${r.other.id}`} className="text-text-primary hover:underline font-medium">
                      {r.other.firstName} {r.other.lastName}
                    </Link>
                    <span className="text-text-muted ml-2 text-xs">
                      {r.type.charAt(0) + r.type.slice(1).toLowerCase()}{r.note ? ` · ${r.note}` : ""}
                    </span>
                  </span>
                  <button
                    onClick={async () => {
                      if (!confirm("Remove this relationship?")) return;
                      await fetch(`/api/members/${id}/relationships?relationshipId=${r.id}`, { method: "DELETE" });
                      load();
                    }}
                    className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}

        {on("memberships") && (
        <Card title="Membership history" className="lg:col-span-2">
          {m.subscriptions.length === 0 ? (
            <p className="text-sm text-text-muted">No membership history.</p>
          ) : (
            <div className="space-y-2">
              {[activeSub, ...pastSubs].filter(Boolean).map((s) => (
                <SubRow key={s!.id} sub={s!} passFees={m.passProcessingFees} onEdit={() => setEditingSub(s!)} onTransfer={canTransfer ? () => setTransferringSubId(s!.id) : undefined} />
              ))}
            </div>
          )}
        </Card>
        )}

        {on("bookings") && (
        <Card title="Event bookings">
          {m.bookings.length === 0 ? (
            <p className="text-sm text-text-muted">No bookings.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {m.bookings.map((b) => (
                <li key={b.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">{b.event?.name ?? "—"}</span>
                  <span className="text-xs text-text-muted">
                    {b.event ? fmtDate(b.event.startsAt) : ""} · {b.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}

        {on("attendance") && (
        <Card title="Attendance">
          {m.attendanceRecords.length === 0 ? (
            <p className="text-sm text-text-muted">No attendance records.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {m.attendanceRecords.map((a) => (
                <li key={a.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">
                    {a.classSession?.recurringClass?.name ?? "Session"}
                  </span>
                  <span className="text-xs text-text-muted">
                    {a.classSession ? fmtDate(a.classSession.startsAt) : fmtDate(a.createdAt)} · {a.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}

        {on("bookings") && (
        <Card title="Tournament / event registrations">
          {m.eventRegistrations.length === 0 ? (
            <p className="text-sm text-text-muted">No registrations.</p>
          ) : (
            <ul className="space-y-1.5">
              {m.eventRegistrations.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">{r.event?.name ?? "—"}</span>
                  <span className="text-xs text-text-muted">
                    {r.status}{r.amountDue ? ` · due ${fmtMoney(r.amountDue)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}

        {on("payments") && (
        <Card title="Recent transactions">
          {m.transactions.length === 0 ? (
            <p className="text-sm text-text-muted">No transactions.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {m.transactions.map((t) => (
                <li key={t.id} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary">{t.description || t.type}</span>
                  <span className="text-xs text-text-muted">{fmtMoney(t.amount)} · {fmtDate(t.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}

        {/* 3G — Communications history for this member. Loads lazily
            because it's PII surface + can be large. Gated at the API
            level on messages.analytics; a coach without the sub-scope
            gets a 403 and the card renders a permissive empty state. */}
        {on("messages") && <CommunicationsCard memberId={id} className="lg:col-span-2" />}

        {/* ── Waivers & documents (4.5.3 right column, §1c) ───────────────
            Was declared in PROFILE_TABS and handled nowhere: selecting
            Documents rendered an empty grid. "N missing" counts unsigned AND
            expired required documents — an expired waiver is exactly as
            missing as one never signed, which is what signatureValidForDays
            is for. */}
        {on("documents") && (
          <DocumentsCard documents={m.documents} memberName={m.firstName} />
        )}

        {/* ── Migration activity (4.5.3 left column footer link target) ──── */}
        {on("migration") && (
          <MigrationActivityCard events={m.migrationEvents} sourceLabel={m.sourceLabel ?? null} />
        )}

        {/* ── Staff notes (4.5.3 right column) — staff-only, attributed ──── */}
        {on("notes") && (
          <StaffNotesCard
            memberId={m.id}
            notes={m.notes}
            canEdit={canEdit}
            onSaved={load}
          />
        )}
      </div>

      {editingSub && (
        <EditSubModal
          sub={editingSub}
          onClose={() => setEditingSub(null)}
          onSaved={() => { setEditingSub(null); load(); }}
        />
      )}

      {transferringSubId && (
        <TransferMembershipModal
          subscriptionId={transferringSubId}
          onClose={() => setTransferringSubId(null)}
          onDone={load}
        />
      )}
      {editOpen && (
        <EditMemberDrawer
          member={{
            id: m.id,
            firstName: m.firstName,
            lastName: m.lastName,
            email: m.email,
            phone: m.phone,
            dateOfBirth: m.dateOfBirth,
            gender: m.gender ?? null,
            streetAddress: m.streetAddress ?? null,
            city: m.city ?? null,
            state: m.state ?? null,
            zipCode: m.zipCode ?? null,
            tags: m.tags ?? null,
            notes: m.notes ?? null,
            profileImageUrl: m.profileImageUrl,
            customFieldValues: m.customFieldValues ?? null,
            guardianName: m.guardianName,
            guardianEmail: m.guardianEmail,
            guardianPhone: m.guardianPhone,
            guardianRelationship: m.guardianRelationship ?? null,
            isMinor: m.isMinor,
            midMigration: !!m.migrationStatus && m.migrationStatus !== "COMPLETED",
            hasPendingInvitation: !!m.migrationStatus && m.migrationStatus === "INVITED",
          }}
          customFields={customFields}
          staffName={staffName}
          saving={saving}
          error={saveError}
          onClose={() => {
            setEditOpen(false);
            setSaveError(null);
          }}
          onSave={saveEdit}
          onSendReset={openReset}
          onCopyPortalLink={() => {
            navigator.clipboard
              ?.writeText(`${window.location.origin}/member`)
              .then(() => setToast({ kind: "ok", text: "Portal link copied." }))
              .catch(() => setToast({ kind: "err", text: "Could not copy the link." }));
          }}
        />
      )}

      {reset && (
        <PasswordResetDialog
          state={reset.state}
          memberName={`${m.firstName} ${m.lastName}`}
          email={reset.email}
          isGuardianEmail={reset.isGuardianEmail}
          staffName={staffName}
          sentAt={reset.sentAt}
          errorMessage={reset.errorMessage}
          onClose={() => setReset(null)}
          onSend={sendReset}
          // Every "wrong address" path leads to the record, never to a field in
          // this dialog — see the note on the password-reset route.
          onUseDifferentEmail={() => {
            setReset(null);
            setEditOpen(true);
          }}
          onAddEmail={() => {
            setReset(null);
            setEditOpen(true);
          }}
          onLinkGuardian={() => {
            setReset(null);
            setTab("family");
          }}
        />
      )}

      {addingRel && (
        <AddRelationshipModal
          memberId={id}
          onClose={() => setAddingRel(false)}
          onSaved={() => { setAddingRel(false); load(); }}
        />
      )}
    </div>
  );
}

function initialsOf(name: string): string {
  return name.split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right text-text-primary">{value || "—"}</dd>
    </div>
  );
}

function Card({ title, action, children, className = "" }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border border-app-border rounded-xl p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── 4.5.3 — the three tabs that selected and showed nothing ────────────
//
// PROFILE_TABS has declared eleven tabs since session 2. The body's `on()`
// helper handled eight of them, so Documents, Migration activity and Notes
// each highlighted correctly and then rendered an empty grid — the failure
// mode that reads as "the page is broken" rather than "this is empty".

/**
 * Waivers & documents (§1c right column).
 *
 * The handoff asks for `<N> missing` in #B91C1C plus a Request action. Missing
 * means "required here and not covered", and a signature past its
 * signatureValidForDays window is not covered — so an expired waiver counts,
 * which is the case that actually blocks a check-in.
 */
function DocumentsCard({ documents, memberName }: { documents?: MemberDocument[]; memberName: string }) {
  const docs = documents ?? [];
  const required = docs.filter((d) => d.requiredAt.length > 0);
  const missing = required.filter((d) => !d.signedAt || d.expired);

  return (
    <Card
      title="Waivers &amp; documents"
      className="lg:col-span-2"
      action={
        missing.length > 0 ? (
          <span className="text-[12px] font-semibold" style={{ color: "#B91C1C" }}>
            {missing.length} missing
          </span>
        ) : required.length > 0 ? (
          <span className="text-[12px] text-text-muted">All required documents signed</span>
        ) : null
      }
    >
      {docs.length === 0 ? (
        <p className="text-sm text-text-muted">
          This club has no documents yet. Add one under Documents and it will appear here for every member.
        </p>
      ) : (
        <div className="space-y-1.5">
          {docs.map((d) => {
            const isMissing = d.requiredAt.length > 0 && (!d.signedAt || d.expired);
            return (
              <div
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px]"
                style={isMissing ? { background: "var(--color-danger-surface)" } : undefined}
              >
                <div className="min-w-0">
                  <span className="text-text-primary">{d.title}</span>
                  {d.requiredAt.length > 0 && (
                    <span className="ml-2 text-[11px] uppercase tracking-wide text-text-muted">
                      required · {d.requiredAt.join(", ").toLowerCase()}
                    </span>
                  )}
                  <div className="text-[11.5px] text-text-muted">
                    {d.signedAt
                      ? d.expired
                        ? `Signed ${fmtDate(d.signedAt)} by ${d.signerName ?? "—"} · expired ${fmtDate(d.expiresAt)}`
                        : `Signed ${fmtDate(d.signedAt)} by ${d.signerName ?? "—"}${
                            d.relationship === "GUARDIAN" ? " (guardian)" : ""
                          }${d.expiresAt ? ` · valid to ${fmtDate(d.expiresAt)}` : ""}`
                      : d.requiresGuardianSignature
                        ? "Not signed — needs a guardian signature"
                        : "Not signed"}
                  </div>
                </div>
                {isMissing && (
                  <Link
                    href={`/dashboard/documents?document=${d.id}`}
                    className="shrink-0 rounded-lg border border-app-border bg-surface px-2.5 py-1 text-[12px] text-text-primary transition-colors hover:bg-app-bg"
                  >
                    Request
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
      {missing.length > 0 && (
        <p className="mt-3 text-[11.5px] text-text-muted">
          {memberName} can sign these from the member portal under Documents. Nothing here changes their membership or
          billing.
        </p>
      )}
    </Card>
  );
}

/**
 * Migration activity (§1c — the "Full migration activity →" destination).
 *
 * Same MemberMigrationEvent rows the 4.5.8 drawer reads. Every write on a
 * migrating member is already attributed; this is the surface that shows it.
 */
function MigrationActivityCard({ events, sourceLabel }: { events?: MigrationEvent[]; sourceLabel: string | null }) {
  const rows = events ?? [];
  return (
    <Card title="Migration activity" className="lg:col-span-2">
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing recorded yet. This log fills in as staff review, invite and activate someone
          {sourceLabel ? ` who came over from ${sourceLabel}` : " who came over from your previous system"}.
        </p>
      ) : (
        <ol className="space-y-2.5">
          {rows.map((e) => (
            <li key={e.id} className="flex gap-2.5 text-[13px]">
              <span
                aria-hidden
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--color-muted)" }}
              />
              <div className="min-w-0">
                <div className="text-text-primary">{e.message || e.type.replace(/_/g, " ").toLowerCase()}</div>
                <div className="text-[11.5px] text-text-muted">
                  {new Date(e.createdAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                  {e.actor ? ` · ${e.actor}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * Staff notes (§1c right column) — staff-only, attributed.
 *
 * `Member.notes` already existed and was writable through PATCH; nothing on
 * the profile ever showed it, so a note typed in the old member modal became
 * invisible the moment the roster cut over.
 */
function StaffNotesCard({
  memberId, notes, canEdit, onSaved,
}: { memberId: string; notes: string | null; canEdit: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = draft !== (notes ?? "");

  // A reload (e.g. after saving) must not strand a stale draft on screen.
  useEffect(() => { setDraft(notes ?? ""); }, [notes]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/members/${memberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: draft }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Staff notes" className="lg:col-span-2">
      <p className="mb-2 text-[11.5px] text-text-muted">
        Only staff can see this. Members and guardians never do.
      </p>
      {canEdit ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            placeholder="Anything the next person at the desk should know."
            className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          />
          {err && <p className="mt-1.5 text-[12px] text-red-600">{err}</p>}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="inline-flex min-h-[38px] items-center rounded-lg bg-brand px-3 text-sm text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save notes"}
            </button>
            {dirty && !saving && <span className="text-[12px] text-text-muted">Unsaved changes</span>}
          </div>
        </>
      ) : notes?.trim() ? (
        <p className="whitespace-pre-wrap text-[14px] text-text-primary">{notes}</p>
      ) : (
        <p className="text-sm text-text-muted">No notes. You need Members · edit to add one.</p>
      )}
    </Card>
  );
}

// ── 3G — Communications tab (per-member email history) ─────────────────

interface CommSend {
  id: string;
  kind: string;
  status: string;
  subject: string;
  recipientEmail: string;
  fromName: string | null;
  fromEmail: string | null;
  sentByName: string | null;
  relatedEventName: string | null;
  relatedMembershipName: string | null;
  announcementId: string | null;
  providerMessageId: string | null;
  trackingCapable: boolean;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  openedAt: string | null;
  openCount: number;
  clickedAt: string | null;
  clickCount: number;
  skippedReason: string | null;
  error: string | null;
  bodyPreview: string;
}

function CommunicationsCard({ memberId, className }: { memberId: string; className?: string }) {
  const [rows, setRows] = useState<CommSend[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reader, setReader] = useState<CommSend | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/members/${memberId}/communications`)
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 403) {
          setErr(null);
          setRows([]); // hide the list rather than shout at coaches
          return;
        }
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load");
        const data = await r.json();
        setRows(data.sends);
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [memberId]);

  return (
    <Card title="Communications" className={className}>
      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : err ? (
        <p className="text-sm text-red-600">{err}</p>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-text-muted">No emails sent to this member yet.</p>
      ) : (
        <ul className="divide-y divide-app-border max-h-96 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id} className="py-2.5">
              <button
                type="button"
                onClick={() => setReader(r)}
                className="w-full text-left hover:bg-app-bg/50 rounded-md -mx-2 px-2 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-text-primary truncate">{r.subject || "(no subject)"}</div>
                    <div className="text-xs text-text-muted truncate">
                      To {r.recipientEmail}
                      {r.sentByName && <> · by {r.sentByName}</>}
                      {r.relatedEventName && <> · about {r.relatedEventName}</>}
                      {r.relatedMembershipName && <> · membership {r.relatedMembershipName}</>}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <DeliveryBadge row={r} />
                    <div className="text-[11px] text-text-muted mt-0.5">{fmtDate(r.sentAt ?? r.queuedAt)}</div>
                  </div>
                </div>
                {r.bodyPreview && (
                  <div className="text-xs text-text-muted mt-1 line-clamp-1">{r.bodyPreview}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {reader && <SendReaderModal id={reader.id} onClose={() => setReader(null)} />}
    </Card>
  );
}

// Never say "opened" when we can't know. Resend fires tracking pixels
// on delivered mail; recipients whose client blocks images (Apple Mail
// Privacy, corporate Outlook, plain-text mode) leave openedAt null
// forever. We render:
//   status === SENT + no delivery yet   → "Queued"     (grey)
//   deliveredAt set + openedAt set      → "Opened N×"  (lime)
//   deliveredAt set + tracking-capable  → "Delivered"  (blue)
//   deliveredAt set + not tracking-capable → "Delivered · open tracking unavailable"
//   bouncedAt                           → "Bounced"    (red)
//   FAILED / SKIPPED                    → reason       (red / orange)
function DeliveryBadge({ row }: { row: CommSend }) {
  if (row.status === "FAILED") return <Pill tone="red">Failed</Pill>;
  if (row.status === "SKIPPED") return <Pill tone="orange">Skipped · {row.skippedReason ?? "unknown"}</Pill>;
  if (row.bouncedAt) return <Pill tone="red">Bounced</Pill>;
  if (row.clickedAt) return <Pill tone="lime">Clicked {row.clickCount > 1 ? `${row.clickCount}×` : ""}</Pill>;
  if (row.openedAt) return <Pill tone="lime">Opened {row.openCount > 1 ? `${row.openCount}×` : ""}</Pill>;
  if (row.deliveredAt) {
    return row.trackingCapable
      ? <Pill tone="blue">Delivered · not yet opened</Pill>
      : <Pill tone="blue">Delivered · open tracking unavailable</Pill>;
  }
  if (row.status === "SENT") {
    // Provider accepted, no delivery callback yet. Resend may take a
    // few seconds; SMTP-only sends never fire deliveredAt.
    return row.trackingCapable
      ? <Pill tone="grey">Sent · waiting for delivery</Pill>
      : <Pill tone="grey">Sent · delivery tracking unavailable</Pill>;
  }
  return <Pill tone="grey">{row.status}</Pill>;
}

function Pill({ tone, children }: { tone: "grey" | "blue" | "lime" | "orange" | "red"; children: React.ReactNode }) {
  const styles: Record<string, string> = {
    grey: "bg-app-bg text-text-muted",
    blue: "bg-brand/10 text-brand",
    lime: "bg-lime-accent/25 text-charcoal",
    orange: "bg-orange-accent/15 text-orange-accent",
    red: "bg-red-50 text-red-700",
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${styles[tone]}`}>
      {children}
    </span>
  );
}

function SendReaderModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [row, setRow] = useState<null | {
    subject: string; recipientEmail: string; fromName: string | null; fromEmail: string | null;
    replyTo: string | null; bodyHtml: string; bodyText: string | null;
    sentAt: string | null; deliveredAt: string | null; openedAt: string | null; clickedAt: string | null;
    providerMessageId: string | null; status: string;
  }>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/emails/sends/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) { setRow(d); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-text-primary truncate">
            {loading ? "Loading…" : row?.subject || "(no subject)"}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none" aria-label="Close">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-3 text-sm">
          {!loading && row && (
            <>
              <div className="text-xs text-text-muted grid grid-cols-1 sm:grid-cols-2 gap-y-1">
                <div>To: <span className="text-text-primary">{row.recipientEmail}</span></div>
                <div>From: <span className="text-text-primary">{row.fromName ?? "—"} &lt;{row.fromEmail ?? "—"}&gt;</span></div>
                <div>Sent: <span className="text-text-primary">{row.sentAt ? new Date(row.sentAt).toLocaleString() : "—"}</span></div>
                <div>Delivered: <span className="text-text-primary">{row.deliveredAt ? new Date(row.deliveredAt).toLocaleString() : "—"}</span></div>
                <div>Opened: <span className="text-text-primary">{row.openedAt ? new Date(row.openedAt).toLocaleString() : (row.providerMessageId ? "not yet" : "tracking unavailable")}</span></div>
                <div>Provider id: <span className="font-mono text-text-primary">{row.providerMessageId ?? "—"}</span></div>
              </div>
              <div
                className="border border-app-border rounded-lg overflow-hidden bg-white"
                // The bodyHtml is the immutable snapshot delivered to the
                // recipient. sanitizeEmailHtml already ran at send time
                // (lib/emailRender + lib/sendClubEmail), so it's safe to
                // render inside the dashboard. dangerouslySetInnerHTML is
                // the right shape here — we're intentionally displaying
                // exactly what the recipient saw.
                dangerouslySetInnerHTML={{ __html: row.bodyHtml }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SubRow({
  sub,
  passFees = false,
  onEdit,
  onTransfer,
}: {
  sub: Sub;
  passFees?: boolean;
  onEdit: () => void;
  /** Undefined when the viewer may not move memberships. */
  onTransfer?: () => void;
}) {
  // When the club passes the Stripe processing fee, a recurring paid sub is
  // actually charged base + fee — show the full equation so the number always
  // reconciles with Stripe (display only; math lives in lib/fees.ts).
  const showFee = passFees && sub.billingType === "RECURRING" && Number(sub.price) > 0;
  const fb = showFee ? feeBreakdown(Number(sub.price), true) : null;
  return (
    <div className="flex items-center justify-between border border-app-border rounded-lg p-3">
      <div>
        <div className="text-sm font-medium text-text-primary">
          {sub.membership?.name ?? "Membership"} <span className="text-text-muted font-normal">· {sub.optionLabel}</span>
        </div>
        <div className="text-xs text-text-muted">
          {fb
            ? `${fmtMoney(fb.base)} + ${fmtMoney(fb.fee)} processing fee = ${fmtMoney(fb.total)}${sub.billingPeriod ? ` / ${sub.billingPeriod.toLowerCase()}` : ""}`
            : fmtMoney(sub.price)} · {sub.billingType.toLowerCase()} · {sub.status}
        </div>
        <div className="text-xs text-text-muted">
          {fmtDate(sub.startDate)} → {sub.endDate ? fmtDate(sub.endDate) : "open-ended"}
        </div>
        {sub.notes && <div className="text-xs text-text-muted mt-0.5 italic">{sub.notes}</div>}
      </div>
      <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1 sm:gap-2 shrink-0">
        {onTransfer && ["active", "past_due", "pending"].includes(sub.status) && (
          <button
            onClick={onTransfer}
            className="text-xs text-brand hover:underline px-2 py-1 rounded whitespace-nowrap"
            title="Move this membership to another family member — the payer doesn't change"
          >
            Assign to family member
          </button>
        )}
        <button onClick={onEdit} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg whitespace-nowrap">
          Edit dates
        </button>
      </div>
    </div>
  );
}

function EditSubModal({ sub, onClose, onSaved }: { sub: Sub; onClose: () => void; onSaved: () => void }) {
  const [startDate, setStartDate] = useState(sub.startDate ? sub.startDate.slice(0, 10) : "");
  const [endDate, setEndDate] = useState(sub.endDate ? sub.endDate.slice(0, 10) : "");
  const [status, setStatus] = useState(sub.status);
  const [price, setPrice] = useState(sub.price != null ? String(sub.price) : "");
  const [notes, setNotes] = useState(sub.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/members/subscriptions/${sub.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: startDate || null,
        endDate: endDate || null,
        status,
        notes: notes || null,
        ...(price.trim() !== "" ? { price: parseFloat(price) } : {}),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    const d = await res.json().catch(() => ({}));
    if (d.stripeNote) {
      setInfo(d.stripeNote);
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Edit subscription</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-xs text-text-muted">
            Adjusts the AthletixOS record only. Stripe&apos;s billing cycle is unchanged — use the Stripe portal for that.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Start date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">End date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                {["pending", "active", "past_due", "canceled", "expired"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">Price ($)</label>
              <input type="number" min="0" step="0.01" value={price}
                onChange={(e) => setPrice(e.target.value)} placeholder="0.00"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Notes</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          {info && (
            <div className="text-sm text-text-primary bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {info}
            </div>
          )}
          <div className="flex gap-2">
            {info ? (
              <button onClick={onSaved} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
                Done
              </button>
            ) : (
              <>
                <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
                <button onClick={save} disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AddRelationshipModal({ memberId, onClose, onSaved }: { memberId: string; onClose: () => void; onSaved: () => void }) {
  const [members, setMembers] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [relatedMemberId, setRelatedMemberId] = useState("");
  const [type, setType] = useState("SIBLING");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/members")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: { id: string; firstName: string; lastName: string }[]) =>
        setMembers(d.filter((x) => x.id !== memberId)));
  }, [memberId]);

  const filtered = members.filter((x) =>
    `${x.firstName} ${x.lastName}`.toLowerCase().includes(search.toLowerCase())
  ).slice(0, 50);

  async function save() {
    if (!relatedMemberId) { setError("Pick a member."); return; }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/members/${memberId}/relationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relatedMemberId, type, note: note || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Failed to link");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Link a member</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Relationship</label>
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
              {REL_TYPES.map((t) => (
                <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Member</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface mb-2"
            />
            <div className="max-h-48 overflow-y-auto border border-app-border rounded-lg">
              {filtered.map((x) => (
                <button
                  key={x.id}
                  onClick={() => setRelatedMemberId(x.id)}
                  className={`w-full text-left px-3 py-2 text-sm border-b border-app-border last:border-0 ${
                    relatedMemberId === x.id ? "bg-brand/10 text-brand" : "text-text-primary hover:bg-app-bg"
                  }`}
                >
                  {x.firstName} {x.lastName}
                </button>
              ))}
              {filtered.length === 0 && <div className="px-3 py-2 text-sm text-text-muted">No matches.</div>}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-primary mb-1">Note (optional)</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button onClick={save} disabled={saving || !relatedMemberId} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Linking…" : "Link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
