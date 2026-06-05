"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import ImageUpload from "@/components/ImageUpload";
import { getActiveProfileId, setActiveProfileId } from "@/lib/activeProfile";

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
  membership: { name: string; price: number; billingPeriod?: string | null } | null;
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

export default function MemberProfilePage() {
  const [me, setMe] = useState<MeUser | null>(null);
  const [extras, setExtras] = useState<PortalExtras | null>(null);
  const [loading, setLoading] = useState(true);

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
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(null);
  const [childEmail, setChildEmail] = useState("");
  const [relationship, setRelationship] = useState("");
  const [linkingChild, setLinkingChild] = useState(false);
  const [familyMessage, setFamilyMessage] = useState("");

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
      setLoading(false);
    });
  }
  useEffect(() => { load(); }, []);

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

  async function openBillingPortal() {
    setOpeningPortal(true);
    setError("");
    const res = await fetch("/api/member/billing-portal", { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setOpeningPortal(false);
    if (!res.ok || !d.url) {
      setError(typeof d.error === "string" ? d.error : "Could not open billing portal");
      return;
    }
    window.location.href = d.url;
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
    setFamilyMessage("Athlete linked. You can now switch to that profile across the portal.");
    load();
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (!me) return <div className="text-center py-8 text-stone-400 text-sm">Could not load profile.</div>;

  const member = me.memberProfile;
  const isMinor = !!member?.isMinor;

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">My Profile</h1>
          <p className="text-sm text-stone-500">Your account details and membership info.</p>
        </div>
        <button
          onClick={() => { setEditing(!editing); setError(""); }}
          className="text-sm px-3 py-1.5 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50"
        >
          {editing ? "Cancel" : "Edit"}
        </button>
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

      {/* Account info */}
      <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
        <h2 className="text-sm font-semibold text-stone-900 mb-4">Account</h2>

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
              className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
              {saving ? "Saving…" : "Save changes"}
            </button>
          </form>
        ) : (
          <dl className="space-y-2">
            <ProfileRow label="Name" value={`${me.firstName} ${me.lastName}`} />
            <ProfileRow label="Email" value={me.email} />
            {member?.phone && <ProfileRow label="Phone" value={member.phone} />}
            {member?.dateOfBirth && (
              <ProfileRow
                label="Date of birth"
                value={new Date(member.dateOfBirth).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
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
      </div>

      {/* Billing — owner controls what members see via
          club.memberBillingVisibility. null/undefined = show everything.
          Members can't change their own plan / card / cancellation; they
          contact their club. */}
      {!isMinor && (() => {
        const vis = extras?.club?.memberBillingVisibility ?? null;
        const showPlan         = vis?.showPlan         ?? true;
        const showNextBilling  = vis?.showNextBilling  ?? true;
        const showPrice        = vis?.showPrice        ?? true;
        const showInvoices     = vis?.showInvoices     ?? true;
        const subs = extras?.user?.memberProfile?.subscriptions ?? [];
        const active = subs.find((s) => s.status === "active") || subs[0];
        const anyVisible = showPlan || showNextBilling || showPrice || showInvoices;
        if (!anyVisible) return null;
        return (
          <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
            <h2 className="text-sm font-semibold text-stone-900 mb-3">Payment &amp; billing</h2>
            {active && (showPlan || showPrice || showNextBilling) ? (
              <dl className="space-y-2 mb-3">
                {showPlan && active.membership?.name && (
                  <ProfileRow label="Plan" value={active.membership.name} />
                )}
                {showPrice && active.membership?.price != null && (
                  <ProfileRow
                    label="Price"
                    value={`$${active.membership.price.toFixed(2)}${
                      active.membership.billingPeriod ? ` / ${active.membership.billingPeriod}` : ""
                    }`}
                  />
                )}
                {showNextBilling && active.currentPeriodEnd && (
                  <ProfileRow
                    label="Next billing"
                    value={new Date(active.currentPeriodEnd).toLocaleDateString("en-US", {
                      month: "long", day: "numeric", year: "numeric",
                    })}
                  />
                )}
              </dl>
            ) : null}
            {showInvoices && me.memberProfile?.stripeCustomerId && (
              <button
                onClick={openBillingPortal}
                disabled={openingPortal}
                className="text-xs px-3 py-1.5 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                {openingPortal ? "Opening…" : "View invoices"}
              </button>
            )}
            <p className="text-xs text-stone-500 mt-3">
              Your club manages billing. To update your card, change plans,
              pause, or cancel, message your club and they&apos;ll take care of
              it from your account.
            </p>
          </div>
        );
      })()}

      {/* Pending approvals — only renders for guardians of at least one
          linked child (the API returns [] otherwise so the section
          collapses naturally). */}
      <PendingApprovalsCard />

      {/* Guardian info (for minors) */}
      {isMinor && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-6 mb-4">
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

      {/* Family / managed athlete access */}
      {extras && (
        <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
          <h2 className="text-sm font-semibold text-stone-900 mb-1">Family &amp; athlete access</h2>
          <p className="text-xs text-stone-500 mb-4">
            Parents can switch between linked athletes. Each child profile stays scoped to its own schedule, documents, and bookings.
          </p>

          {familyMessage && (
            <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              {familyMessage}
            </div>
          )}

          <div className="space-y-2 mb-4">
            {[
              ...(extras.user.memberProfile
                ? [{ member: { ...extras.user.memberProfile, email: me.email }, kind: "self" as const }]
                : []),
              ...extras.user.guardianOf.map((g) => ({ ...g, kind: "child" as const })),
            ].map((g) => {
              const active = activeProfileId === g.member.id;
              const summary = extras?.summaries?.[g.member.id];
              return (
                <div key={g.member.id} className="py-2 border-b border-stone-100 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-stone-200 flex items-center justify-center text-xs font-bold text-stone-700">
                      {g.member.firstName[0]}{g.member.lastName[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-stone-900">
                        {g.member.firstName} {g.member.lastName}
                        {g.kind === "self" && <span className="ml-2 text-[10px] uppercase tracking-wide text-stone-400">you</span>}
                      </p>
                      <p className="text-xs text-stone-400">
                        {g.member.email || "No email on file"} · {g.member.status}
                        {g.member.dateOfBirth ? (
                          <>
                            {" · DOB "}
                            {new Date(g.member.dateOfBirth).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                            {(() => {
                              const d = new Date(g.member.dateOfBirth);
                              const now = new Date();
                              let age = now.getFullYear() - d.getFullYear();
                              const m = now.getMonth() - d.getMonth();
                              if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
                              return ` (age ${age})`;
                            })()}
                          </>
                        ) : null}
                        {g.member.isMinor ? " · Minor" : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* Parental controls only make sense for linked
                          children — guardians can't set controls on
                          their own (self) profile. */}
                      {g.kind === "child" && (
                        <Link
                          href={`/member/family/${g.member.id}`}
                          className="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50"
                        >
                          Controls
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setActiveProfileId(g.member.id);
                          setActiveProfileIdState(g.member.id);
                        }}
                        className={`text-xs px-3 py-1.5 rounded-lg border ${
                          active
                            ? "border-stone-900 bg-stone-900 text-white"
                            : "border-stone-200 text-stone-600 hover:bg-stone-50"
                        }`}
                      >
                        {active ? "Selected" : "Switch"}
                      </button>
                    </div>
                  </div>
                  {summary && (
                    <div className="mt-2 ml-11 grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded-lg bg-stone-50 px-2 py-1.5">
                        <div className="text-stone-400 text-[10px] uppercase tracking-wide">Attendance (30d)</div>
                        <div className="text-stone-900 font-semibold">{summary.attendanceLast30d}</div>
                      </div>
                      <div className="rounded-lg bg-stone-50 px-2 py-1.5">
                        <div className="text-stone-400 text-[10px] uppercase tracking-wide">Upcoming</div>
                        <div className="text-stone-900 font-semibold">{summary.upcomingBookings}</div>
                      </div>
                      <div className="rounded-lg bg-stone-50 px-2 py-1.5">
                        <div className="text-stone-400 text-[10px] uppercase tracking-wide">Membership</div>
                        <div className="text-stone-900 font-semibold truncate">
                          {summary.activeMembershipName || "—"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!isMinor && (
            <form onSubmit={linkChild} className="rounded-lg border border-stone-200 p-3 space-y-3">
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

      {/* Account actions */}
      <div className="bg-white rounded-xl border border-stone-200 p-6">
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

      {showDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6">
            <h3 className="text-base font-semibold text-stone-900 mb-1">Delete your account?</h3>
            <p className="text-sm text-stone-600 mb-3">
              This removes your access immediately. Your profile is retained by the club for record-keeping but you'll no longer be able to log in.
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
    </>
  );
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
