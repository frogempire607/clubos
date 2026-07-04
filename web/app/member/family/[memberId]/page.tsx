"use client";

// Controls — per-child parental-controls editor (design 2b / 1d).
// Permissions render as a scannable toggle grid with Co-Guardians promoted
// beside them; every legacy section (athlete details, billing, own login,
// move-a-purchase) is preserved, low-frequency ones collapsed behind rows.
// Guardian-only — the API enforces the link check; co-guardians see
// everything read-only (only the primary guardian saves changes).

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { setActiveProfileId } from "@/lib/activeProfile";
import { Pill } from "@/components/member/ui";
import AthleteRail, { useAthleteProfiles } from "@/components/member/AthleteRail";
import PermissionToggleGrid, { ToggleRow } from "@/components/member/PermissionToggleGrid";
import GuardianList, { type GuardianEntry } from "@/components/member/GuardianList";
import InvoiceSplit from "@/components/member/InvoiceSplit";

type Controls = {
  requirePaymentApproval?: boolean;
  monitoredMessaging?: boolean;
  allowPackagePurchase?: boolean;
  allowOwnMessaging?: boolean;
  dailySpendLimit?: number;
};

type Data = {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    isMinor: boolean;
    dateOfBirth: string | null;
    email: string | null;
    phone: string | null;
  };
  birthdayLockedAt: string | null;
  parentControls: Controls | null;
  hasBilling?: boolean;
  ownLogin?: { hasLogin: boolean; email: string | null };
  // Co-guardians can view but only the primary guardian saves changes here.
  isPrimaryGuardian?: boolean;
  guardians?: GuardianEntry[];
};

type Purchase = { type: "subscription" | "sale"; id: string; label: string; status: string };
type Target = { id: string; firstName: string; lastName: string; kind: string };

export default function FamilyControlsPage() {
  const params = useParams<{ memberId: string }>();
  const router = useRouter();
  const { profiles } = useAthleteProfiles();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Form state
  const [birthdayLocked, setBirthdayLocked] = useState(false);
  const [requirePaymentApproval, setRequirePaymentApproval] = useState(false);
  const [monitoredMessaging, setMonitoredMessaging] = useState(false);
  const [allowPackagePurchase, setAllowPackagePurchase] = useState(true);
  const [allowOwnMessaging, setAllowOwnMessaging] = useState(true);
  const [dailySpendLimit, setDailySpendLimit] = useState<string>("");
  const [capEnabled, setCapEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [openingBilling, setOpeningBilling] = useState(false);
  const [billingMsg, setBillingMsg] = useState("");
  const [ownLogin, setOwnLogin] = useState<{ hasLogin: boolean; email: string | null }>({ hasLogin: false, email: null });
  const [childEmail, setChildEmail] = useState("");
  const [invitingLogin, setInvitingLogin] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const [purchaseMsg, setPurchaseMsg] = useState("");
  // Athlete details (#12) — parent edits name/DOB/contact.
  const [dFirst, setDFirst] = useState("");
  const [dLast, setDLast] = useState("");
  const [dDob, setDDob] = useState("");
  const [dEmail, setDEmail] = useState("");
  const [dPhone, setDPhone] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsSaved, setDetailsSaved] = useState(false);
  const [detailsErr, setDetailsErr] = useState("");
  // Co-guardian invite (#8b)
  const [coEmail, setCoEmail] = useState("");
  const [coName, setCoName] = useState("");
  const [coRel, setCoRel] = useState("");
  const [invitingGuardian, setInvitingGuardian] = useState(false);
  const [guardianMsg, setGuardianMsg] = useState("");

  function loadPurchases() {
    fetch(`/api/member/family/${params.memberId}/purchases`)
      .then((r) => (r.ok ? r.json() : { purchases: [], targets: [] }))
      .then((d) => { setPurchases(d.purchases || []); setTargets(d.targets || []); });
  }
  useEffect(() => { loadPurchases(); }, [params.memberId]);

  async function reassign(p: Purchase) {
    const key = `${p.type}:${p.id}`;
    const target = moveTo[key];
    if (!target) return;
    setMovingKey(key);
    setPurchaseMsg("");
    const res = await fetch(`/api/member/family/${params.memberId}/purchases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: p.type, id: p.id, targetMemberId: target }),
    });
    const d = await res.json().catch(() => ({}));
    setMovingKey(null);
    if (!res.ok) { setPurchaseMsg(typeof d.error === "string" ? d.error : "Could not move purchase."); return; }
    const name = targets.find((t) => t.id === target);
    setPurchaseMsg(`Moved "${p.label}"${name ? ` to ${name.firstName}` : ""}.`);
    loadPurchases();
  }

  useEffect(() => {
    fetch(`/api/member/family/${params.memberId}/controls`).then(async (r) => {
      if (!r.ok) {
        setError(r.status === 403 ? "You don't have access to this athlete." : "Couldn't load.");
        setLoading(false);
        return;
      }
      const d: Data = await r.json();
      setData(d);
      setDFirst(d.member.firstName || "");
      setDLast(d.member.lastName || "");
      setDDob(d.member.dateOfBirth ? new Date(d.member.dateOfBirth).toISOString().slice(0, 10) : "");
      setDEmail(d.member.email || "");
      setDPhone(d.member.phone || "");
      setBirthdayLocked(!!d.birthdayLockedAt);
      const c = d.parentControls ?? {};
      setRequirePaymentApproval(c.requirePaymentApproval === true);
      setMonitoredMessaging(c.monitoredMessaging === true);
      // Default true (no restriction) when never set.
      setAllowPackagePurchase(c.allowPackagePurchase !== false);
      setAllowOwnMessaging(c.allowOwnMessaging !== false);
      setDailySpendLimit(
        typeof c.dailySpendLimit === "number" ? String(c.dailySpendLimit) : "",
      );
      setCapEnabled(typeof c.dailySpendLimit === "number");
      const ol = (d as Data & { ownLogin?: { hasLogin: boolean; email: string | null } }).ownLogin;
      if (ol) { setOwnLogin(ol); setChildEmail(ol.email ?? ""); }
      setLoading(false);
    });
  }, [params.memberId]);

  async function inviteChildLogin() {
    setInvitingLogin(true);
    setLoginMsg("");
    const res = await fetch(`/api/member/family/${params.memberId}/invite-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: childEmail.trim(),
        requirePaymentApproval,
        allowOwnMessaging,
        allowPackagePurchase,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setInvitingLogin(false);
    if (!res.ok) { setLoginMsg(typeof d.error === "string" ? d.error : "Could not send invite."); return; }
    setLoginMsg(d.message || "Invite sent.");
    setOwnLogin({ hasLogin: true, email: childEmail.trim().toLowerCase() });
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    const controls: Controls = {
      requirePaymentApproval,
      monitoredMessaging,
      allowPackagePurchase,
      allowOwnMessaging,
    };
    if (capEnabled) {
      if (dailySpendLimit.trim() === "") {
        setError("Enter a daily limit amount, or turn the cap off.");
        setSaving(false);
        return;
      }
      const n = Number(dailySpendLimit);
      if (!Number.isFinite(n) || n < 0) {
        setError("Daily spend limit must be a non-negative number.");
        setSaving(false);
        return;
      }
      controls.dailySpendLimit = n;
    }
    const res = await fetch(`/api/member/family/${params.memberId}/controls`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ birthdayLocked, parentControls: controls }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  // Invite a co-guardian (#8b) — owner approves before access is granted.
  async function inviteGuardian(e: React.FormEvent) {
    e.preventDefault();
    setInvitingGuardian(true);
    setGuardianMsg("");
    const res = await fetch(`/api/member/family/${params.memberId}/invite-guardian`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: coEmail.trim(),
        name: coName.trim() || null,
        relationship: coRel || null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setInvitingGuardian(false);
    if (!res.ok) {
      setGuardianMsg(typeof d.error === "string" ? d.error : "Could not send the invite.");
      return;
    }
    setGuardianMsg(d.message || "Request sent.");
    if (d.status === "pending" || d.status === "already" || d.status === "invited") {
      setCoEmail("");
      setCoName("");
      setCoRel("");
    }
  }

  // Save parent-editable athlete details (name / DOB / contact). (#12)
  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true);
    setDetailsErr("");
    setDetailsSaved(false);
    const res = await fetch(`/api/member/family/${params.memberId}/controls`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          firstName: dFirst.trim(),
          lastName: dLast.trim(),
          dateOfBirth: dDob || null,
          email: dEmail.trim() || null,
          phone: dPhone.trim() || null,
        },
      }),
    });
    const dd = await res.json().catch(() => ({}));
    setSavingDetails(false);
    if (!res.ok) {
      setDetailsErr(typeof dd.error === "string" ? dd.error : "Could not save details.");
      return;
    }
    setDetailsSaved(true);
    setTimeout(() => setDetailsSaved(false), 2000);
    router.refresh();
  }

  // Open the Stripe billing portal for THIS child (the API authorizes via the
  // guardian link). Lets a parent update the card / view invoices for their
  // child's membership. Cancellation stays gated behind club approval.
  async function openChildBilling() {
    setOpeningBilling(true);
    setBillingMsg("");
    const res = await fetch("/api/member/billing-portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: params.memberId }),
    });
    const d = await res.json().catch(() => ({}));
    setOpeningBilling(false);
    if (!res.ok || !d.url) {
      setBillingMsg(typeof d.error === "string" ? d.error : "Could not open billing.");
      return;
    }
    window.location.href = d.url;
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (error && !data) {
    return (
      <div className="text-center py-8 text-stone-500 text-sm">
        {error}
        <div className="mt-3">
          <Link href="/member/profile" className="text-stone-700 underline">Back to profile</Link>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const first = data.member.firstName;
  const readOnly = data.isPrimaryGuardian === false;
  const lockedReason = "Only the primary guardian can change this athlete's settings and controls.";
  const guardians = data.guardians ?? [];
  const hasRail = profiles.length >= 2;

  // The rail doubles as the athlete switcher here: children open their own
  // Controls page, the self profile goes home to Account.
  const selfId = profiles.find((p) => p.kind === "self")?.id ?? null;
  function railSelect(id: string) {
    setActiveProfileId(id);
    router.push(id === selfId ? "/member/profile" : `/member/family/${id}`);
  }

  const summaryChips = (
    <div className="flex gap-1.5 flex-wrap">
      <Pill tone={requirePaymentApproval ? "accent" : "neutral"}>
        {requirePaymentApproval ? "Approval required" : "No approval needed"}
      </Pill>
      <Pill tone={allowPackagePurchase ? "success" : "danger"}>
        {allowPackagePurchase ? "Package buys on" : "Package buys off"}
      </Pill>
      <Pill tone={birthdayLocked ? "warn" : "neutral"}>
        {birthdayLocked ? "DOB locked" : "DOB unlocked"}
      </Pill>
      <Pill tone={capEnabled && dailySpendLimit ? "accent" : "neutral"}>
        {capEnabled && dailySpendLimit ? `$${dailySpendLimit}/day cap` : "No daily cap"}
      </Pill>
      <Pill tone={allowOwnMessaging ? "success" : "warn"}>
        {allowOwnMessaging ? "Own messaging on" : "Messaging managed"}
      </Pill>
      {monitoredMessaging && <Pill tone="accent">Message copies on</Pill>}
    </div>
  );

  return (
    <div className={hasRail ? "md:grid md:grid-cols-[250px_minmax(0,1fr)] md:gap-6 md:items-start" : ""}>
      {hasRail && (
        <AthleteRail
          activeId={params.memberId}
          onSelect={railSelect}
          footer={
            <>
              <span className="font-bold text-stone-600 block">Editing controls for</span>
              <span className="block mt-1 break-words">
                {first} {data.member.lastName}
                {ownLogin.email ? ` · ${ownLogin.email}` : ""}
              </span>
            </>
          }
        />
      )}

      <div className="min-w-0">
        <div className="mb-5">
          <h1 className="text-[22px] md:text-[25px] font-extrabold tracking-[-0.01em] text-stone-900">
            Controls · {first} {data.member.lastName}
          </h1>
          <p className="text-sm text-stone-500 mt-0.5">
            What {first} can do from their own login. Acting on their behalf from your account bypasses these.
          </p>
          {readOnly && (
            <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              You&apos;re a co-guardian: you can view these settings and book/manage day-to-day, but only
              the primary guardian can change controls, edit details, or invite another guardian.
            </div>
          )}
        </div>

        {/* Permissions at a glance — one line, mobile only (the toggle grid
            below is the desktop glance). */}
        <div className="pcard p-4 mb-4 md:hidden">
          <p className="text-[13px] font-semibold text-stone-900 mb-2">Permissions at a glance</p>
          {summaryChips}
        </div>

        <div className="md:grid md:grid-cols-[1.55fr_1fr] md:gap-4 md:items-start">
          {/* ── Left: permissions + athlete details ── */}
          <div className="space-y-4 min-w-0">
            <form onSubmit={save} className="pcard p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-stone-900">Permissions</h2>
                <span className="text-xs text-stone-400">Applies to {first}&apos;s own portal actions</span>
              </div>
              <PermissionToggleGrid>
                <ToggleRow
                  label="Require approval for paid bookings"
                  description="Paid drop-ins, events, lessons & packs pause for your OK. Free membership-covered bookings go through instantly."
                  checked={requirePaymentApproval}
                  onChange={setRequirePaymentApproval}
                  disabled={readOnly}
                  disabledReason={lockedReason}
                />
                <ToggleRow
                  label="Allow package purchases"
                  description={`Can buy lesson packs${requirePaymentApproval ? " (still needs approval)" : ""}. Off blocks pack purchases entirely.`}
                  checked={allowPackagePurchase}
                  onChange={setAllowPackagePurchase}
                  disabled={readOnly}
                  disabledReason={lockedReason}
                />
                <ToggleRow
                  label="Lock date of birth"
                  description={`${first} can't edit their own DOB. You can still update it under Athlete details.`}
                  checked={birthdayLocked}
                  onChange={setBirthdayLocked}
                  disabled={readOnly}
                  disabledReason={lockedReason}
                />
                <ToggleRow
                  label="Daily spend limit"
                  description={
                    capEnabled
                      ? "Bookings that push today's spend over the cap pause for your approval — even with the approval toggle off."
                      : "No cap set — add one anytime."
                  }
                  checked={capEnabled}
                  onChange={(next) => { setCapEnabled(next); if (!next) setDailySpendLimit(""); }}
                  disabled={readOnly}
                  disabledReason={lockedReason}
                >
                  {capEnabled && (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-stone-500 text-sm">$</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={dailySpendLimit}
                        onChange={(e) => setDailySpendLimit(e.target.value)}
                        placeholder="Amount"
                        disabled={readOnly}
                        aria-label="Daily spend limit in dollars"
                        className="w-24 px-2.5 py-1.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                      />
                      <span className="text-xs text-stone-500">/ day</span>
                    </div>
                  )}
                </ToggleRow>
                <ToggleRow
                  label={`Allow ${first} to message`}
                  description="Off shows a “managed by your guardian” banner on their Messages tab; coach threads still copy to you."
                  checked={allowOwnMessaging}
                  onChange={setAllowOwnMessaging}
                  disabled={readOnly}
                  disabledReason={lockedReason}
                />
                <ToggleRow
                  label="Get a copy of their messages"
                  description={`Adds an email notification each time someone messages ${first} (threads already show on your Messages tab).`}
                  checked={monitoredMessaging}
                  onChange={setMonitoredMessaging}
                  disabled={readOnly}
                  disabledReason={lockedReason}
                />
              </PermissionToggleGrid>

              {error && (
                <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
              {saved && (
                <div className="mt-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  Saved.
                </div>
              )}
              <div className="flex justify-end mt-3">
                <button
                  type="submit"
                  disabled={saving || readOnly}
                  title={readOnly ? lockedReason : undefined}
                  className="pbtn-accent px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save controls"}
                </button>
              </div>
            </form>

            {/* Athlete details — parent edits name / DOB / contact (#12). */}
            <CollapsedSection
              title="Athlete details"
              sub="Name, DOB, contact"
              defaultOpenDesktop
              icon={<PencilIcon />}
            >
              <form onSubmit={saveDetails}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">First name</label>
                    <input
                      value={dFirst}
                      onChange={(e) => setDFirst(e.target.value)}
                      required
                      disabled={readOnly}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">Last name</label>
                    <input
                      value={dLast}
                      onChange={(e) => setDLast(e.target.value)}
                      disabled={readOnly}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">
                      Date of birth
                      {birthdayLocked && <span className="ml-1 text-amber-700">· locked for {first}</span>}
                    </label>
                    <input
                      type="date"
                      value={dDob}
                      onChange={(e) => setDDob(e.target.value)}
                      disabled={readOnly}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                    />
                    {birthdayLocked && (
                      <p className="text-[11px] text-stone-400 mt-1">
                        Locked for {first} — you can still update it here.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">Phone (optional)</label>
                    <input
                      type="tel"
                      value={dPhone}
                      onChange={(e) => setDPhone(e.target.value)}
                      placeholder="(555) 555-5555"
                      disabled={readOnly}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-xs font-medium text-stone-600 mb-1">
                    Email — used for {first}&apos;s login
                  </label>
                  <input
                    type="email"
                    value={dEmail}
                    onChange={(e) => setDEmail(e.target.value)}
                    placeholder={`${first}'s email`}
                    disabled={readOnly}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                  />
                </div>
                {detailsErr && (
                  <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{detailsErr}</div>
                )}
                {detailsSaved && (
                  <div className="mt-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">Saved.</div>
                )}
                <div className="flex justify-end mt-3">
                  <button
                    type="submit"
                    disabled={savingDetails || readOnly}
                    title={readOnly ? lockedReason : undefined}
                    className="pbtn-accent px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                  >
                    {savingDetails ? "Saving…" : "Save details"}
                  </button>
                </div>
              </form>
            </CollapsedSection>
          </div>

          {/* ── Right: co-guardians + collapsed legacy sections ── */}
          <div className="space-y-4 min-w-0 mt-4 md:mt-0">
            <div className="pcard p-4">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h2 className="text-sm font-semibold text-stone-900">Co-Guardians</h2>
                <span className="text-xs text-stone-400">Who can manage {first}</span>
              </div>
              <GuardianList guardians={guardians} />
              {/* Invite a co-parent — owner approves before access is granted. */}
              <form onSubmit={inviteGuardian} className="mt-2 pt-2 border-t border-stone-100 space-y-2">
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={coEmail}
                    onChange={(e) => setCoEmail(e.target.value)}
                    required
                    placeholder="Invite by email…"
                    disabled={readOnly}
                    className="flex-1 min-w-0 px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                  />
                  <button
                    type="submit"
                    disabled={invitingGuardian || !coEmail.trim() || readOnly}
                    title={readOnly ? lockedReason : undefined}
                    className="pbtn-accent text-sm px-4 py-2 rounded-xl font-semibold disabled:opacity-50 whitespace-nowrap"
                  >
                    {invitingGuardian ? "Sending…" : "Invite"}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={coName}
                    onChange={(e) => setCoName(e.target.value)}
                    placeholder="Their name (optional)"
                    disabled={readOnly}
                    className="px-3 py-2 border border-stone-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                  />
                  <select
                    value={coRel}
                    onChange={(e) => setCoRel(e.target.value)}
                    disabled={readOnly}
                    className="px-3 py-2 border border-stone-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 disabled:bg-stone-100"
                  >
                    <option value="">Relationship (optional)</option>
                    <option value="Parent">Parent</option>
                    <option value="Mother">Mother</option>
                    <option value="Father">Father</option>
                    <option value="Legal guardian">Legal guardian</option>
                    <option value="Grandparent">Grandparent</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <p className="text-[11px] text-stone-400">
                  They need their own club account first. Your club approves new guardians before they get access.
                </p>
                {guardianMsg && (
                  <div className="text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                    {guardianMsg}
                  </div>
                )}
              </form>
            </div>

            {/* Invoice split (Phase 7) — renders nothing unless
                FEATURE_INVOICE_SPLIT is on server-side AND a co-guardian
                exists to split with. */}
            <InvoiceSplit memberId={params.memberId} childName={first} />

            <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-stone-400 px-1 !mt-5 -mb-1">
              Everything else — preserved
            </p>

            {/* Billing — parent manages the child's card/invoices via Stripe. */}
            <CollapsedSection
              title="Billing"
              sub={data.hasBilling ? "Card on file · manage in Stripe" : "Cash / check at club"}
              icon={<CardIcon />}
            >
              <p className="text-xs text-stone-500 mb-3">
                Update the card on file and view invoices for {first}&apos;s membership.
                To cancel, your club reviews the request first.
              </p>
              {data.hasBilling ? (
                <button
                  type="button"
                  onClick={openChildBilling}
                  disabled={openingBilling}
                  className="text-sm px-4 py-2 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                >
                  {openingBilling ? "Opening…" : "Manage billing"}
                </button>
              ) : (
                <p className="text-sm text-stone-500 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                  No card on file. {first} is billed at the club (cash or check), so there&apos;s nothing to manage here yet.
                </p>
              )}
              {billingMsg && (
                <div className="mt-3 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                  {billingMsg}
                </div>
              )}
            </CollapsedSection>

            {/* Child's own login — optional. Parent stays guardian + billing manager. */}
            <CollapsedSection
              title={`${first}'s own login`}
              sub={ownLogin.hasLogin ? (ownLogin.email ?? "Has their own login") : "No login yet — invite them"}
              icon={<MailIcon />}
            >
              <p className="text-xs text-stone-500 mb-3">
                Optionally give {first} their own login so they can sign in themselves.
                You stay the guardian and billing manager, and the controls above decide what they can do
                on their own.
              </p>
              {ownLogin.hasLogin ? (
                <div className="text-sm text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 mb-2">
                  Has their own login{ownLogin.email ? <> · <strong>{ownLogin.email}</strong></> : null}.
                </div>
              ) : null}
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="email"
                  value={childEmail}
                  onChange={(e) => setChildEmail(e.target.value)}
                  placeholder={`${first}'s email`}
                  className="flex-1 px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                />
                <button
                  type="button"
                  onClick={inviteChildLogin}
                  disabled={invitingLogin || !childEmail.trim()}
                  className="pbtn-accent text-sm px-4 py-2.5 rounded-xl disabled:opacity-50 whitespace-nowrap"
                >
                  {invitingLogin ? "Sending…" : ownLogin.hasLogin ? "Resend invite" : "Send login invite"}
                </button>
              </div>
              <p className="text-[11px] text-stone-400 mt-2">
                They&apos;ll get an email to set their own password. Save the controls first if you
                changed them — the invite uses your current settings.
              </p>
              {loginMsg && (
                <div className="mt-2 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                  {loginMsg}
                </div>
              )}
            </CollapsedSection>

            {/* Purchases — move one to another profile if it was bought under the wrong athlete. */}
            {purchases.length > 0 && targets.length > 0 && (
              <CollapsedSection
                title="Move a purchase"
                sub={`${purchases.length} purchase${purchases.length === 1 ? "" : "s"} on this profile`}
                icon={<SwapIcon />}
              >
                <p className="text-xs text-stone-500 mb-3">
                  Bought something under the wrong athlete? Move it to the right profile.
                </p>
                <div className="space-y-2">
                  {purchases.map((p) => {
                    const key = `${p.type}:${p.id}`;
                    return (
                      <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-2 border border-stone-200 rounded-lg px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-stone-800 truncate">{p.label}</p>
                          <p className="text-[11px] text-stone-400">{p.type === "subscription" ? "Membership" : "Product"} · {p.status}</p>
                        </div>
                        <select
                          value={moveTo[key] ?? ""}
                          onChange={(e) => setMoveTo((s) => ({ ...s, [key]: e.target.value }))}
                          className="text-sm px-2 py-1.5 border border-stone-300 rounded-lg"
                        >
                          <option value="">Move to…</option>
                          {targets.map((t) => (
                            <option key={t.id} value={t.id}>{t.firstName} {t.lastName}{t.kind === "self" ? " (you)" : ""}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => reassign(p)}
                          disabled={!moveTo[key] || movingKey === key}
                          className="text-xs px-3 py-1.5 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-40 whitespace-nowrap"
                        >
                          {movingKey === key ? "Moving…" : "Move"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {purchaseMsg && (
                  <div className="mt-2 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                    {purchaseMsg}
                  </div>
                )}
              </CollapsedSection>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Collapsible legacy section (1d "Everything else — preserved") ── */
function CollapsedSection({
  title,
  sub,
  icon,
  defaultOpenDesktop = false,
  children,
}: {
  title: string;
  sub: string;
  icon: ReactNode;
  defaultOpenDesktop?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() =>
    defaultOpenDesktop && typeof window !== "undefined"
      ? window.matchMedia("(min-width: 768px)").matches
      : false,
  );
  return (
    <div className="pcard overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-stone-50 transition"
      >
        <span className="w-[30px] h-[30px] rounded-[9px] bg-stone-100 text-stone-600 flex items-center justify-center flex-shrink-0">
          {icon}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-semibold text-stone-900">{title}</span>
          <span className="block text-[11.5px] text-stone-500 truncate">{sub}</span>
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
          className={`text-stone-300 flex-shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

/* ── Row icons (SVG — the native shell renders unicode glyphs as tofu) ── */
function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  );
}
function CardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
      <path fillRule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clipRule="evenodd" />
    </svg>
  );
}
function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
      <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
    </svg>
  );
}
function SwapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" clipRule="evenodd" />
    </svg>
  );
}
