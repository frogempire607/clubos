"use client";

// Account (was "My Profile") — one calm place for identity, the family,
// billing, and documents (design 2a / 1c). Information hierarchy:
// Identity → People → Documents → Billing. Every pre-redesign capability is
// preserved: profile editing, billing portal / add-card / cancellation
// request, pending approvals, guardian info, family linking, add-self,
// invites, sign-out and account deletion.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import ImageUpload from "@/components/ImageUpload";
import { getActiveProfileId, setActiveProfileId } from "@/lib/activeProfile";
import { Avatar, Pill, GhostButton } from "@/components/member/ui";
import AthleteRail, { useAthleteProfiles, invalidateAthleteProfiles } from "@/components/member/AthleteRail";
import GuardianAvatars from "@/components/member/GuardianAvatars";

type MeProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianRelationship: string | null;
  profileImageUrl: string | null;
  status: string;
  stripeCustomerId: string | null;
  // Migrated members store their saved card on stripeSetupCustomerId; older
  // flows on stripeCustomerId. Either means a Stripe billing portal exists.
  stripeSetupCustomerId?: string | null;
  // Parental controls (P4). Server enforces; UI uses these to disable
  // the DOB input and explain why.
  birthdayLockedAt?: string | null;
  parentControls?: {
    requirePaymentApproval?: boolean;
    monitoredMessaging?: boolean;
    allowPackagePurchase?: boolean;
    dailySpendLimit?: number;
  } | null;
};

type MeUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  memberProfile: MeProfile | null;
};

type PortalSubscription = {
  id: string;
  status: string;
  currentPeriodEnd?: string | null;
  // Snapshot fields on the subscription itself — the source of truth for what
  // was actually purchased and the migrated first-charge date.
  price?: number | string | null;
  billingPeriod?: string | null;
  billingType?: string | null;
  billingAnchorDate?: string | null;
  endDate?: string | null;
  autoRenew?: boolean | null;
  membership: { name: string; price: number; billingPeriod?: string | null } | null;
};

type GuardianLink = {
  userId: string;
  user: { id: string; firstName: string; lastName: string };
};

type PortalExtras = {
  user: {
    memberProfile: {
      id: string;
      firstName: string;
      lastName: string;
      status: string;
      dateOfBirth?: string | null;
      isMinor?: boolean;
      stripeCustomerId?: string | null;
      stripeSetupCustomerId?: string | null;
      subscriptions?: PortalSubscription[];
    } | null;
    guardianOf: {
      member: {
        id: string;
        firstName: string;
        lastName: string;
        email: string | null;
        status: string;
        dateOfBirth?: string | null;
        isMinor?: boolean;
        stripeCustomerId?: string | null;
        stripeSetupCustomerId?: string | null;
        user?: { id: string } | null;
        guardianLinks?: GuardianLink[];
      };
    }[];
  };
  club?: {
    memberBillingVisibility?: {
      showPlan?: boolean;
      showNextBilling?: boolean;
      showPrice?: boolean;
      showInvoices?: boolean;
    } | null;
  };
  summaries?: Record<
    string,
    {
      attendanceLast30d: number;
      upcomingBookings: number;
      activeMembershipName: string | null;
    }
  >;
};

// Per-person billing from /api/member/billing — the account holder plus every
// managed child, each with their own plan, status, price, next-billing date and
// saved card. Powers the Payment & billing card so a guardian on mobile sees
// full billing for each athlete, not just a bare "Card on file".
type PersonBilling = {
  memberId: string;
  name: string;
  fullName: string;
  isSelf: boolean;
  isMinor: boolean;
  memberStatus: string;
  plan: string | null;
  status: string | null;
  statusLabel: string | null;
  price: number | null;
  period: string | null;
  nextBilling: string | null;
  subscriptionId: string | null;
  hasCard: boolean;
  card: { brand: string; last4: string; cardholder: string | null } | null;
};
type BillingResponse = {
  people: PersonBilling[];
  visibility: {
    showPlan?: boolean;
    showNextBilling?: boolean;
    showPrice?: boolean;
    showInvoices?: boolean;
  } | null;
};

// Stripe card brands come lower-cased ("visa", "american_express").
function prettyBrand(brand: string): string {
  return brand
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

type DocSummary = { total: number; needsSignature: number };

export default function MemberAccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);
  const [extras, setExtras] = useState<PortalExtras | null>(null);
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const { profiles } = useAthleteProfiles();

  // Editable fields
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [email,     setEmail]     = useState("");
  const [phone,     setPhone]     = useState("");
  const [dob,       setDob]       = useState("");
  const [gender,    setGender]    = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city,      setCity]      = useState("");
  const [state,     setState]     = useState("");
  const [zipCode,   setZipCode]   = useState("");
  const [profileImageUrl, setProfileImageUrl] = useState<string>("");

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [requestingCancel, setRequestingCancel] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(null);
  const [childEmail, setChildEmail] = useState("");
  const [relationship, setRelationship] = useState("");
  const [linkingChild, setLinkingChild] = useState(false);
  const [familyMessage, setFamilyMessage] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState("");
  // Billing portal feedback is shown inline (soft) next to the billing
  // controls instead of as an alarming page-level red banner.
  const [billingMsg, setBillingMsg] = useState("");
  const [addingSelf, setAddingSelf] = useState(false);
  // Per-person document counts (file total + outstanding signatures) from the
  // existing /api/member/documents endpoint, one call per accessible member.
  const [docsByMember, setDocsByMember] = useState<Record<string, DocSummary>>({});

  function hydrate(data: MeUser) {
    setMe(data);
    setFirstName(data.firstName);
    setLastName(data.lastName);
    setEmail(data.email);
    const m = data.memberProfile;
    setPhone(m?.phone || "");
    setDob(m?.dateOfBirth ? new Date(m.dateOfBirth).toISOString().slice(0, 10) : "");
    setGender(m?.gender || "");
    setStreetAddress(m?.streetAddress || "");
    setCity(m?.city || "");
    setState(m?.state || "");
    setZipCode(m?.zipCode || "");
    setProfileImageUrl(m?.profileImageUrl || "");
  }

  function loadDocs(ids: string[]) {
    ids.forEach((id) => {
      fetch(`/api/member/documents?memberId=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d?.documents) return;
          const docs = d.documents as {
            required: boolean;
            signature: { expired: boolean } | null;
          }[];
          setDocsByMember((prev) => ({
            ...prev,
            [id]: {
              total: docs.length,
              // Same rule as the documents page: a required doc is
              // outstanding when unsigned or its signature expired.
              needsSignature: docs.filter((doc) => doc.required && (!doc.signature || doc.signature.expired)).length,
            },
          }));
        })
        .catch(() => {});
    });
  }

  function load() {
    Promise.all([
      fetch("/api/member/me").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/member/portal").then((r) => (r.ok ? r.json() : null)),
    ]).then(([data, portal]) => {
      if (data) hydrate(data);
      setExtras(portal);
      const ids = [
        ...(portal?.user?.memberProfile ? [portal.user.memberProfile.id] : []),
        ...((portal?.user?.guardianOf ?? []).map((g: { member: { id: string } }) => g.member.id)),
      ];
      const active = getActiveProfileId();
      setActiveProfileIdState(active && ids.includes(active) ? active : ids[0] ?? null);
      loadDocs(ids);
      setLoading(false);
    });
    // Per-person billing (plan/status/price/next-billing + saved card) loads on
    // its own so the Stripe card lookups never block the rest of the page.
    fetch("/api/member/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setBilling(b))
      .catch(() => setBilling(null));
  }
  useEffect(() => { load(); }, []);

  // Returning from the SETUP-mode "Add a card" checkout.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("card_saved") === "1") {
      setBillingMsg("Card saved — nothing was charged. It'll be used for future purchases you approve.");
    } else if (p.get("card_canceled") === "1") {
      setBillingMsg("Card setup canceled — no card was saved and nothing was charged.");
    }
    if (p.has("card_saved") || p.has("card_canceled")) {
      window.history.replaceState({}, "", "/member/profile");
    }
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await fetch("/api/member/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName, lastName, email,
        phone: phone || null,
        dateOfBirth: dob || null,
        gender: gender || null,
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        profileImageUrl: profileImageUrl || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const fieldErr = d.error?.fieldErrors ? Object.entries(d.error.fieldErrors)[0] : null;
      setError(typeof d.error === "string" ? d.error : fieldErr ? `${fieldErr[0]}: ${(fieldErr[1] as string[])[0]}` : "Save failed");
      return;
    }
    setSuccess(true);
    setEditing(false);
    setTimeout(() => setSuccess(false), 2000);
    load();
  }

  // "Add a card for future use" — SETUP-mode Stripe Checkout, saves a card
  // with no charge. For cash/check members (or their kids) who want a card on
  // file for later purchases.
  async function addCard(memberId?: string) {
    setOpeningPortal(true);
    setBillingMsg("");
    const res = await fetch("/api/member/payment-method/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(memberId ? { memberId } : {}),
    });
    const d = await res.json().catch(() => ({}));
    setOpeningPortal(false);
    if (!res.ok || !d.url) {
      setBillingMsg(
        typeof d.error === "string" ? d.error : "Could not open the secure card form. Please contact your club.",
      );
      return;
    }
    window.location.href = d.url;
  }

  async function openBillingPortal(memberId?: string) {
    setOpeningPortal(true);
    setBillingMsg("");
    const res = await fetch("/api/member/billing-portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(memberId ? { memberId } : {}),
    });
    const d = await res.json().catch(() => ({}));
    setOpeningPortal(false);
    if (!res.ok || !d.url) {
      // Soft, contextual message — not the alarming top-of-page red banner.
      setBillingMsg(
        typeof d.error === "string"
          ? d.error
          : "Could not open billing right now. Please contact your club.",
      );
      return;
    }
    window.location.href = d.url;
  }

  // Parent opt-in: create their OWN athlete profile so they can buy adult
  // memberships/products for themselves and appear in the profile switcher.
  // Safe + idempotent server-side (links an existing same-email member or
  // creates a fresh adult profile; never touches billing).
  async function addSelfAsAthlete() {
    setAddingSelf(true);
    setError("");
    const res = await fetch("/api/member/self-profile", { method: "POST" });
    setAddingSelf(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not set up your athlete profile.");
      return;
    }
    invalidateAthleteProfiles();
    load();
  }

  async function requestCancellation(subscriptionId: string) {
    if (!confirm("Request to cancel this membership? Your club has to approve it before billing stops.")) return;
    setRequestingCancel(true);
    setError("");
    setCancelMsg("");
    const res = await fetch("/api/member/subscriptions/request-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId }),
    });
    const d = await res.json().catch(() => ({}));
    setRequestingCancel(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Could not send your request.");
      return;
    }
    setCancelMsg(
      typeof d.message === "string"
        ? d.message
        : "Your cancellation request was sent to your club.",
    );
  }

  async function deleteAccount() {
    if (deleteConfirm.trim().toLowerCase() !== "delete") return;
    setDeleting(true);
    const res = await fetch("/api/member/me", { method: "DELETE" });
    if (res.ok) {
      signOut({ callbackUrl: "/login" });
    } else {
      setDeleting(false);
      setError("Failed to delete account");
    }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteMsg("");
    const res = await fetch("/api/member/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail }),
    });
    const data = await res.json().catch(() => ({}));
    setInviting(false);
    setInviteMsg(res.ok ? data.message || "Invite sent." : data.error || "Could not send invite.");
    if (res.ok) setInviteEmail("");
  }

  async function linkChild(e: React.FormEvent) {
    e.preventDefault();
    setLinkingChild(true);
    setError("");
    setFamilyMessage("");
    const res = await fetch("/api/member/portal/link-child", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childEmail, relationship: relationship || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setLinkingChild(false);
    if (!res.ok) {
      setError(data.error || "Could not link that athlete.");
      return;
    }
    setChildEmail("");
    setRelationship("");
    if (data.linked === false) {
      // Queued for owner approval — no access granted yet.
      setFamilyMessage(
        data.message ||
          "Request sent to your club for approval. You'll get access once they confirm you're the guardian.",
      );
    } else {
      setFamilyMessage("Athlete linked. You can now switch to that profile across the portal.");
      invalidateAthleteProfiles();
      load();
    }
  }

  // Scope the documents page to a person, then open it.
  function openDocumentsFor(memberId: string) {
    setActiveProfileId(memberId);
    router.push("/member/documents");
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (!me) return <div className="text-center py-8 text-stone-400 text-sm">Could not load profile.</div>;

  const member = me.memberProfile;
  const isMinor = !!member?.isMinor;
  const guardianOf = extras?.user?.guardianOf ?? [];
  const isGuardian = guardianOf.length > 0;
  const selfSummary = member ? extras?.summaries?.[member.id] : undefined;

  // Everyone this account manages, self first — drives People / Documents /
  // Billing rows.
  const people = [
    ...(extras?.user?.memberProfile
      ? [{ member: { ...extras.user.memberProfile, email: me.email, guardianLinks: undefined as GuardianLink[] | undefined }, kind: "self" as const }]
      : []),
    ...guardianOf.map((g) => ({ ...g, kind: "child" as const })),
  ];

  // Guardian display names per child (viewer first). Data ships on the same
  // portal payload the page already fetched.
  function guardianNames(links?: GuardianLink[]): string[] {
    if (!links?.length) return [`${me!.firstName} ${me!.lastName}`.trim()];
    const sorted = [...links].sort((a, b) => (a.userId === me!.id ? -1 : b.userId === me!.id ? 1 : 0));
    return sorted.map((l) => `${l.user.firstName} ${l.user.lastName}`.trim());
  }

  const totalToSign = Object.values(docsByMember).reduce((n, d) => n + d.needsSignature, 0);
  const householdGuardians = new Set<string>([me.id]);
  for (const g of guardianOf) for (const l of g.member.guardianLinks ?? []) householdGuardians.add(l.userId);
  const hasRail = profiles.length >= 2;

  const statusPill = member ? (
    member.status === "ACTIVE"
      ? <Pill tone="success">Active</Pill>
      : <Pill tone="neutral">{member.status.charAt(0) + member.status.slice(1).toLowerCase()}</Pill>
  ) : null;

  return (
    <div className={hasRail ? "md:grid md:grid-cols-[250px_minmax(0,1fr)] md:gap-6 md:items-start" : ""}>
      {hasRail && (
        <AthleteRail
          footer={
            <>
              <span className="font-bold text-stone-600 block">This household</span>
              <span className="block mt-1">
                {profiles.length} athlete{profiles.length === 1 ? "" : "s"} · {householdGuardians.size} guardian{householdGuardians.size === 1 ? "" : "s"}
                {totalToSign > 0 ? ` · ${totalToSign} doc${totalToSign === 1 ? "" : "s"} to sign` : ""}
              </span>
            </>
          }
        />
      )}

      <div className="min-w-0">
        <div className="mb-5 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] md:text-[25px] font-extrabold tracking-[-0.01em] text-stone-900">Account</h1>
            <p className="text-sm text-stone-500 mt-0.5">You, your athletes, billing &amp; documents — in one place.</p>
          </div>
          <GhostButton
            className="!px-3 !py-1.5 !text-xs flex-shrink-0"
            onClick={() => { setEditing(!editing); setError(""); }}
          >
            {editing ? "Cancel" : "Edit profile"}
          </GhostButton>
        </div>

        {success && (
          <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            Profile updated.
          </div>
        )}
        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* ── Identity ── */}
        <div className="pcard p-5 mb-4">
          {editing ? (
            <form onSubmit={save} className="space-y-3">
              <ImageUpload
                label="Profile photo"
                value={profileImageUrl || null}
                onChange={setProfileImageUrl}
                shape="circle"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">First name</label>
                  <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Last name</label>
                  <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Phone</label>
                  <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">
                    Date of birth
                    {me?.memberProfile?.birthdayLockedAt && (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-amber-700 font-semibold">
                        Locked
                      </span>
                    )}
                  </label>
                  <input
                    type="date"
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                    disabled={!!me?.memberProfile?.birthdayLockedAt}
                    className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 ${
                      me?.memberProfile?.birthdayLockedAt
                        ? "bg-stone-100 border-stone-200 text-stone-500 cursor-not-allowed"
                        : "border-stone-300"
                    }`}
                  />
                  {me?.memberProfile?.birthdayLockedAt && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      Your guardian has locked your date of birth. Ask them to update it for you.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Gender</label>
                  <select value={gender} onChange={(e) => setGender(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900">
                    <option value="">Prefer not to say</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Non-binary">Non-binary</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">Street address</label>
                <input type="text" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City"
                  className="px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                <input type="text" value={state} onChange={(e) => setState(e.target.value)} placeholder="State" maxLength={2}
                  className="px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                <input type="text" value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="Zip"
                  className="px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
              </div>
              <button type="submit" disabled={saving}
                className="pbtn-accent px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">
                {saving ? "Saving…" : "Save changes"}
              </button>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-3.5">
                <Avatar name={`${me.firstName} ${me.lastName}`} src={member?.profileImageUrl} size={54} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[17px] font-semibold text-stone-900">
                      {me.firstName} {me.lastName}
                    </span>
                    {statusPill}
                  </div>
                  <p className="text-[12.5px] text-stone-500 truncate">{me.email}</p>
                </div>
                <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
                  {selfSummary?.activeMembershipName && (
                    <Pill tone="accent">Plan · {selfSummary.activeMembershipName}</Pill>
                  )}
                  {isGuardian && <Pill tone="neutral">Guardian &amp; billing manager</Pill>}
                </div>
              </div>
              <div className="sm:hidden flex items-center gap-2 flex-wrap mt-3">
                {selfSummary?.activeMembershipName && (
                  <Pill tone="accent">Plan · {selfSummary.activeMembershipName}</Pill>
                )}
                {isGuardian && <Pill tone="neutral">Guardian &amp; billing manager</Pill>}
              </div>
              {/* Compact contact details — everything the old read-only view
                  showed, without the wall of rows. */}
              {(member?.phone || member?.dateOfBirth || member?.gender || member?.streetAddress || member?.city) && (
                <dl className="mt-4 pt-3 border-t border-stone-100 space-y-1.5">
                  {member?.phone && <ProfileRow label="Phone" value={member.phone} />}
                  {member?.dateOfBirth && (
                    <ProfileRow
                      label="Date of birth"
                      // timeZone:"UTC" — DOB is stored as UTC midnight; UTC
                      // lock keeps the displayed day equal to the saved day.
                      value={new Date(member.dateOfBirth).toLocaleDateString("en-US", {
                        month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
                      })}
                    />
                  )}
                  {member?.gender && <ProfileRow label="Gender" value={member.gender} />}
                  {(member?.streetAddress || member?.city) && (
                    <ProfileRow
                      label="Address"
                      value={[member.streetAddress, [member.city, member.state, member.zipCode].filter(Boolean).join(", ")].filter(Boolean).join("\n")}
                    />
                  )}
                </dl>
              )}
            </>
          )}
        </div>

        {/* Pending approvals — only renders for guardians of at least one
            linked child (the API returns [] otherwise so the section
            collapses naturally). */}
        <PendingApprovalsCard />

        {/* Guardian info (for minors) */}
        {isMinor && (
          <div className="bg-amber-50 rounded-xl border border-amber-200 p-5 mb-4">
            <h2 className="text-sm font-semibold text-amber-800 mb-3">Guardian on file</h2>
            <dl className="space-y-2">
              {member?.guardianName && <ProfileRow label="Name" value={member.guardianName} />}
              {member?.guardianRelationship && <ProfileRow label="Relationship" value={member.guardianRelationship} />}
              {member?.guardianEmail && <ProfileRow label="Email" value={member.guardianEmail} />}
              {member?.guardianPhone && <ProfileRow label="Phone" value={member.guardianPhone} />}
            </dl>
            <p className="text-xs text-amber-600 mt-3">Contact your club to update guardian information.</p>
          </div>
        )}

        <div className="md:grid md:grid-cols-[1.55fr_1fr] md:gap-4 md:items-start">
          {/* ── Left column: people ── */}
          <div className="space-y-4 min-w-0">
            {extras && (
              <div className="pcard p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h2 className="text-sm font-semibold text-stone-900">Family &amp; access</h2>
                  {people.length > 1 && (
                    <span className="text-xs text-stone-400">
                      {people.length} athlete{people.length === 1 ? "" : "s"} · switch to scope every page
                    </span>
                  )}
                </div>

                {familyMessage && (
                  <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                    {familyMessage}
                  </div>
                )}

                <div className="mb-1">
                  {people.map((g) => {
                    const active = activeProfileId === g.member.id;
                    const summary = extras?.summaries?.[g.member.id];
                    const names = g.kind === "self"
                      ? [`${me.firstName} ${me.lastName}`.trim()]
                      : guardianNames(g.member.guardianLinks);
                    return (
                      <div key={g.member.id} className="py-2.5 border-t border-stone-100 first:border-t-0 first:pt-1">
                        <div className="flex items-center gap-3">
                          <Avatar name={`${g.member.firstName} ${g.member.lastName}`} size={36} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13.5px] font-semibold text-stone-900 truncate">
                              {g.member.firstName} {g.member.lastName}
                              <span className="ml-1.5 text-xs font-normal text-stone-400">
                                {g.kind === "self"
                                  ? "· You"
                                  : g.member.dateOfBirth
                                    ? `· age ${ageOf(g.member.dateOfBirth)}`
                                    : null}
                              </span>
                            </p>
                            <p className="text-[11.5px] text-stone-500 truncate">
                              {[
                                summary?.activeMembershipName ?? null,
                                g.kind === "child" ? (g.member.user?.id ? "own login" : showsAsMinor(g.member) ? "minor" : null) : null,
                                summary ? `${summary.upcomingBookings} upcoming` : null,
                                summary && summary.attendanceLast30d > 0 ? `${summary.attendanceLast30d} visits (30d)` : null,
                              ].filter(Boolean).join(" · ") || (g.member.email || "No email on file")}
                            </p>
                          </div>
                          <GuardianAvatars names={names} className="hidden sm:inline-flex" />
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {/* Parental controls only make sense for linked
                                children — guardians can't set controls on
                                their own (self) profile. */}
                            {g.kind === "child" && (
                              <Link
                                href={`/member/family/${g.member.id}`}
                                className="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50"
                              >
                                Manage
                              </Link>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setActiveProfileId(g.member.id);
                                setActiveProfileIdState(g.member.id);
                              }}
                              className={`text-xs px-3 py-1.5 rounded-lg border ${
                                active ? "pseg-active border-transparent" : "border-stone-200 text-stone-600 hover:bg-stone-50"
                              }`}
                            >
                              {active ? "Selected" : "Switch"}
                            </button>
                          </div>
                        </div>
                        {g.kind === "child" && names.length > 1 && (
                          <p className="sm:hidden text-[11px] text-stone-400 mt-1 ml-[48px]">
                            Guardians: You +{names.length - 1}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {!isMinor && !extras.user.memberProfile && (
                  <div className="rounded-lg border border-dashed border-stone-300 p-3 mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-900">Add yourself as an athlete</p>
                      <p className="text-xs text-stone-500">
                        Create your own profile so you can book classes or buy adult memberships and products for yourself.
                      </p>
                    </div>
                    <button
                      onClick={addSelfAsAthlete}
                      disabled={addingSelf}
                      className="pbtn-accent text-sm px-4 py-2 rounded-xl font-semibold whitespace-nowrap disabled:opacity-50"
                    >
                      {addingSelf ? "Setting up…" : "Add me"}
                    </button>
                  </div>
                )}

                {!isMinor && (
                  <form onSubmit={linkChild} className="rounded-lg border border-stone-200 p-3 space-y-3 mt-2">
                    <div>
                      <p className="text-sm font-medium text-stone-900">Request/add linked athlete</p>
                      <p className="text-xs text-stone-500">
                        The athlete must already exist in this club with the email entered below.
                      </p>
                    </div>
                    <div className="grid sm:grid-cols-[1fr_160px_auto] gap-2">
                      <input
                        type="email"
                        value={childEmail}
                        onChange={(e) => setChildEmail(e.target.value)}
                        placeholder="athlete@example.com"
                        required
                        className="px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                      />
                      <select
                        value={relationship}
                        onChange={(e) => setRelationship(e.target.value)}
                        className="px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
                      >
                        <option value="">Relationship</option>
                        <option value="Parent">Parent</option>
                        <option value="Legal guardian">Legal guardian</option>
                        <option value="Grandparent">Grandparent</option>
                        <option value="Other">Other</option>
                      </select>
                      <button
                        type="submit"
                        disabled={linkingChild}
                        className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
                      >
                        {linkingChild ? "Linking..." : "Link"}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* Invite someone to the club — any member can share the join link */}
            <div className="pcard p-5">
              <h2 className="text-sm font-semibold text-stone-900 mb-1">Invite someone to the club</h2>
              <p className="text-xs text-stone-500 mb-3">
                Share your club&apos;s join link by email — they&apos;ll set up their own account.
              </p>
              <form onSubmit={sendInvite} className="grid sm:grid-cols-[1fr_auto] gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="friend@example.com"
                  required
                  className="px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                />
                <button
                  type="submit"
                  disabled={inviting}
                  className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
                >
                  {inviting ? "Sending…" : "Send invite"}
                </button>
              </form>
              {inviteMsg && <p className="text-xs text-stone-600 mt-2">{inviteMsg}</p>}
            </div>

            {/* Account actions */}
            <div className="pcard p-5">
              <h2 className="text-sm font-semibold text-stone-900 mb-3">Account actions</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="text-sm px-4 py-2 border border-stone-300 text-stone-700 rounded-lg hover:bg-stone-50"
                >
                  Sign out
                </button>
                <button
                  onClick={() => setShowDelete(true)}
                  className="text-sm px-4 py-2 border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                >
                  Delete account
                </button>
              </div>
            </div>
          </div>

          {/* ── Right column: documents + billing, per person ── */}
          <div className="space-y-4 min-w-0 mt-4 md:mt-0">
            {people.length === 0 && (
              // No athlete rows to scope by — keep Documents reachable anyway.
              <div className="pcard p-5">
                <h2 className="text-sm font-semibold text-stone-900 mb-1">Documents</h2>
                <p className="text-xs text-stone-500 mb-3">Waivers &amp; forms from your club.</p>
                <GhostButton href="/member/documents" className="!px-3 !py-1.5 !text-xs">
                  Open documents
                </GhostButton>
              </div>
            )}
            {people.length > 0 && (
              <div className="pcard p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h2 className="text-sm font-semibold text-stone-900">Documents</h2>
                  {totalToSign > 0 ? (
                    <Pill tone="warn">{totalToSign} to sign</Pill>
                  ) : (
                    <span className="text-xs text-stone-400">All signed</span>
                  )}
                </div>
                {people.map((g) => {
                  const d = docsByMember[g.member.id];
                  const outstanding = d?.needsSignature ?? 0;
                  return (
                    <div key={g.member.id} className="flex items-center gap-2.5 py-2 border-t border-stone-100 first:border-t-0">
                      <Avatar name={`${g.member.firstName} ${g.member.lastName}`} size={28} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12.5px] font-semibold text-stone-900 truncate">
                          {g.kind === "self" ? "You" : `${g.member.firstName} ${g.member.lastName}`}
                        </p>
                        <p className="text-[11.5px] text-stone-500">
                          {d
                            ? `${d.total} file${d.total === 1 ? "" : "s"} · ${outstanding > 0 ? `${outstanding} needs signature` : "all signed"}`
                            : "…"}
                        </p>
                      </div>
                      {d && outstanding === 0 && <Pill tone="success">Done</Pill>}
                      <button
                        type="button"
                        onClick={() => openDocumentsFor(g.member.id)}
                        className="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50"
                      >
                        Open
                      </button>
                    </div>
                  );
                })}
                <p className="text-[11px] text-stone-400 mt-2">
                  Each athlete&apos;s waivers &amp; forms, scoped to them.
                </p>
              </div>
            )}

            {/* Billing — one block PER PERSON (self + each managed child) so a
                guardian on mobile sees plan, status, price, next billing and the
                saved card (brand · last4 · cardholder) for every athlete, not
                just a bare "Card on file". Owner controls visibility via
                club.memberBillingVisibility (null/undefined = show everything).
                Members can't change their own plan / card / cancellation. */}
            {!isMinor && (() => {
              const vis = billing?.visibility ?? extras?.club?.memberBillingVisibility ?? null;
              const showPlan         = vis?.showPlan         ?? true;
              const showNextBilling  = vis?.showNextBilling  ?? true;
              const showPrice        = vis?.showPrice        ?? true;
              const showInvoices     = vis?.showInvoices     ?? true;
              const anyVisible = showPlan || showNextBilling || showPrice || showInvoices;
              if (!anyVisible) return null;
              const people = billing?.people ?? [];
              return (
                <div className="pcard p-5">
                  <h2 className="text-sm font-semibold text-stone-900">Payment &amp; billing</h2>
                  <p className="text-[11.5px] text-stone-500 mt-0.5 mb-1">
                    Each person keeps their own cards — you never spend another guardian&apos;s saved card.
                  </p>

                  {billing === null ? (
                    <p className="text-[11.5px] text-stone-400 py-3">Loading billing…</p>
                  ) : people.length === 0 ? (
                    <p className="text-[11.5px] text-stone-400 py-3">No billing on file yet.</p>
                  ) : (
                    people.map((p) => {
                      const cardLine = p.card
                        ? `${prettyBrand(p.card.brand)} ···· ${p.card.last4}${p.card.cardholder ? ` · ${p.card.cardholder}` : ""}`
                        : "Cash / check at club";
                      const showDetails =
                        (showPlan && (!!p.plan || !!p.statusLabel)) ||
                        (showPrice && p.price != null) ||
                        (showNextBilling && !!p.nextBilling);
                      return (
                        <div key={p.memberId} className="py-3 border-t border-stone-100 first:border-t-0 first:pt-2">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={p.fullName} size={28} />
                            <div className="flex-1 min-w-0">
                              <p className="text-[12.5px] font-semibold text-stone-900 truncate">
                                {p.isSelf ? "You" : p.fullName}
                              </p>
                              <p className="text-[11.5px] text-stone-500 truncate">{cardLine}</p>
                            </div>
                            {p.hasCard ? (
                              showInvoices ? (
                                <button
                                  type="button"
                                  onClick={() => openBillingPortal(p.isSelf ? undefined : p.memberId)}
                                  disabled={openingPortal}
                                  className="shrink-0 text-xs px-3 py-1.5 border border-stone-200 rounded-lg text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                                >
                                  {openingPortal ? "Opening…" : "Manage"}
                                </button>
                              ) : null
                            ) : (
                              <button
                                type="button"
                                onClick={() => addCard(p.isSelf ? undefined : p.memberId)}
                                disabled={openingPortal}
                                title="Save a card securely for future purchases — nothing is charged now."
                                className="shrink-0 text-xs px-3 py-1.5 border border-stone-200 rounded-lg text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                              >
                                {openingPortal ? "Opening…" : "Add card"}
                              </button>
                            )}
                          </div>

                          {showDetails && (
                            <dl className="mt-2 ml-[38px] space-y-1">
                              {showPlan && p.plan && <ProfileRow label="Plan" value={p.plan} />}
                              {showPlan && p.statusLabel && <ProfileRow label="Status" value={p.statusLabel} />}
                              {showPrice && p.price != null && (
                                <ProfileRow
                                  label="Price"
                                  value={`$${p.price.toFixed(2)}${p.period ? ` / ${p.period.toLowerCase()}` : ""}`}
                                />
                              )}
                              {showNextBilling && p.nextBilling && p.status !== "canceled" && p.status !== "expired" && (
                                <ProfileRow
                                  label={p.status === "pending" ? "First billing" : "Next billing"}
                                  value={new Date(p.nextBilling).toLocaleDateString("en-US", {
                                    month: "long", day: "numeric", year: "numeric",
                                  })}
                                />
                              )}
                            </dl>
                          )}

                          {p.subscriptionId && p.status === "active" && (
                            <button
                              type="button"
                              onClick={() => requestCancellation(p.subscriptionId!)}
                              disabled={requestingCancel}
                              className="mt-2 ml-[38px] text-xs px-3 py-1.5 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                            >
                              {requestingCancel ? "Sending…" : "Request cancellation"}
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}

                  {cancelMsg && (
                    <div className="mt-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                      {cancelMsg}
                    </div>
                  )}
                  {billingMsg && (
                    <div className="mt-3 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                      {billingMsg}
                    </div>
                  )}
                  <p className="text-[11px] text-stone-400 mt-3">
                    Update payment methods and view invoices per person. Cancellations are
                    reviewed by your club before billing stops. Athletes paying by cash or
                    check are billed at the club.
                  </p>
                </div>
              );
            })()}
          </div>
        </div>

        {showDelete && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl w-full max-w-sm p-6">
              <h3 className="text-base font-semibold text-stone-900 mb-1">Delete your account?</h3>
              <p className="text-sm text-stone-600 mb-3">
                This removes your access immediately. Your profile is retained by the club for record-keeping but you&apos;ll no longer be able to log in.
                {member?.stripeCustomerId && (
                  <> Active recurring subscriptions are <strong>not</strong> auto-canceled — open the billing portal first if you want to cancel.</>
                )}
              </p>
              <p className="text-xs text-stone-600 mb-2">Type <strong>delete</strong> to confirm:</p>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setShowDelete(false); setDeleteConfirm(""); }}
                  className="text-sm px-4 py-2 border border-stone-300 text-stone-700 rounded-lg hover:bg-stone-50"
                >
                  Cancel
                </button>
                <button
                  onClick={deleteAccount}
                  disabled={deleteConfirm.trim().toLowerCase() !== "delete" || deleting}
                  className="text-sm px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete forever"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// A member can open the Stripe billing portal only if a Stripe customer exists
// (saved card). Cash/check members have neither — gate the button so it never
// 400s. Migrated members keep the card on stripeSetupCustomerId.
function memberHasBilling(
  m?: { stripeCustomerId?: string | null; stripeSetupCustomerId?: string | null } | null,
): boolean {
  return !!(m && (m.stripeCustomerId || m.stripeSetupCustomerId));
}

// UTC-locked age so a viewer west of UTC doesn't tick the age down a day
// around the birthday.
function ageOf(dob: string): number {
  const d = new Date(dob);
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

// Display-honest minor check: trust the DOB age when present (so a 25-year-old
// who was linked as an "athlete" isn't mislabeled "Minor"), else the stored flag.
function showsAsMinor(m: { dateOfBirth?: string | null; isMinor?: boolean }): boolean {
  if (m.dateOfBirth) {
    const d = new Date(m.dateOfBirth);
    if (!Number.isNaN(d.getTime())) return ageOf(m.dateOfBirth) < 18;
  }
  return !!m.isMinor;
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-4">
      <dt className="text-xs font-medium text-stone-500 w-24 flex-shrink-0 pt-0.5">{label}</dt>
      <dd className="text-sm text-stone-900 whitespace-pre-line">{value}</dd>
    </div>
  );
}

// ─── Pending approvals card ───────────────────────────────────────────
// Shown only when the guardian has at least one PENDING approval row
// across their linked children. Empty list → component renders nothing.

type ApprovalRow = {
  id: string;
  kind: "CLASS_BOOK" | "EVENT_REGISTER" | "PRIVATE_REQUEST" | "PACKAGE_BUY";
  amount: number | null;
  requestedAt: string;
  member: { id: string; firstName: string; lastName: string };
};

const APPROVAL_KIND_LABEL: Record<ApprovalRow["kind"], string> = {
  CLASS_BOOK: "Class booking",
  EVENT_REGISTER: "Event registration",
  PRIVATE_REQUEST: "Private lesson request",
  PACKAGE_BUY: "Package purchase",
};

function PendingApprovalsCard() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [acting, setActing] = useState<string | null>(null);

  const load = () => {
    fetch("/api/member/family/approvals")
      .then((r) => (r.ok ? r.json() : { approvals: [] }))
      .then((d) => setRows(Array.isArray(d.approvals) ? d.approvals : []))
      .catch(() => setRows([]));
  };
  useEffect(load, []);

  async function respond(id: string, action: "APPROVE" | "DECLINE") {
    setActing(id);
    const res = await fetch(`/api/member/family/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setActing(null);
    if (res.ok) {
      // Remove the row locally — server has already updated status.
      setRows((r) => r.filter((x) => x.id !== id));
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="bg-amber-50 rounded-xl border border-amber-200 p-5 mb-4">
      <h2 className="text-sm font-semibold text-amber-900 mb-1">
        Approvals waiting on you ({rows.length})
      </h2>
      <p className="text-xs text-amber-700 mb-3">
        These bookings or purchases were paused until you approve. Decline if it
        shouldn&apos;t happen.
      </p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="bg-white border border-amber-200 rounded-lg p-3 flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm text-stone-900 truncate">
                <span className="font-medium">
                  {r.member.firstName} {r.member.lastName}
                </span>
                {" — "}
                {APPROVAL_KIND_LABEL[r.kind] || r.kind}
                {r.amount && r.amount > 0 ? ` · $${r.amount.toFixed(2)}` : ""}
              </p>
              <p className="text-[11px] text-stone-500">
                Requested {new Date(r.requestedAt).toLocaleString("en-US", {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}
              </p>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => respond(r.id, "DECLINE")}
                disabled={acting === r.id}
                className="text-xs px-3 py-1.5 rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => respond(r.id, "APPROVE")}
                disabled={acting === r.id}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-900 text-amber-50 hover:bg-amber-800 disabled:opacity-50"
              >
                {acting === r.id ? "…" : "Approve"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
