"use client";

// Self-service "My account" — every signed-in dashboard user (owner OR
// staff) can change their own password and update their name. Staff who
// have no other settings access still get this page because every account
// needs a way to manage its own credentials. The route is unguarded in
// PATH_PERMISSIONS so middleware always allows it.

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import ImageUpload from "@/components/ImageUpload";

type Me = {
  role: string;
  title?: string | null;
  permissions: Record<string, string> | null;
};

export default function MyAccountPage() {
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);

  // Profile (name) state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");
  const [nameSaved, setNameSaved] = useState(false);

  // Password change state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSaved, setPwSaved] = useState(false);

  // Member-portal profile (#10) — owner/staff publish a bio + contact + photo.
  const [portalShow, setPortalShow] = useState(false);
  const [portalBio, setPortalBio] = useState("");
  const [portalEmail, setPortalEmail] = useState("");
  const [portalPhone, setPortalPhone] = useState("");
  const [portalPhoto, setPortalPhoto] = useState("");
  const [savingPortal, setSavingPortal] = useState(false);
  const [portalSaved, setPortalSaved] = useState(false);
  const [portalError, setPortalError] = useState("");

  useEffect(() => {
    fetch("/api/me/portal-profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setPortalShow(!!d.showOnPortal);
        setPortalBio(d.bio || "");
        setPortalEmail(d.publicEmail || "");
        setPortalPhone(d.publicPhone || "");
        setPortalPhoto(d.photoUrl || "");
      })
      .catch(() => {});
  }, []);

  async function savePortalProfile(e: React.FormEvent) {
    e.preventDefault();
    setPortalError("");
    setPortalSaved(false);
    setSavingPortal(true);
    const res = await fetch("/api/me/portal-profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        showOnPortal: portalShow,
        bio: portalBio || null,
        publicEmail: portalEmail || null,
        publicPhone: portalPhone || null,
        photoUrl: portalPhoto || null,
      }),
    });
    setSavingPortal(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setPortalError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setPortalSaved(true);
    setTimeout(() => setPortalSaved(false), 2500);
  }

  useEffect(() => {
    fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((d) => setMe(d));
    // Hydrate name + email from /api/auth/session.
    const name = session?.user?.name || "";
    const parts = name.split(" ");
    setFirstName(parts[0] || "");
    setLastName(parts.slice(1).join(" ") || "");
  }, [session?.user?.name]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setNameError("");
    setNameSaved(false);
    setSavingName(true);
    const res = await fetch("/api/me/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName }),
    });
    setSavingName(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setNameError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    setPwSaved(false);
    if (newPw !== confirmPw) {
      setPwError("New passwords don't match.");
      return;
    }
    if (newPw.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    setSavingPw(true);
    const res = await fetch("/api/auth/change-password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
    });
    setSavingPw(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setPwError(typeof d.error === "string" ? d.error : "Password update failed");
      return;
    }
    setPwSaved(true);
    setCurrentPw("");
    setNewPw("");
    setConfirmPw("");
    setTimeout(() => setPwSaved(false), 2500);
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">My account</h1>
        <p className="text-sm text-text-muted">
          Manage your own profile and password. Your{" "}
          {me?.role === "OWNER" ? "owner" : "staff"} access to other club settings
          is controlled by {me?.role === "OWNER" ? "your subscription" : "the club owner"}.
        </p>
      </div>

      <div className="space-y-4">
        {/* Account snapshot */}
        <div className="bg-surface border border-app-border rounded-xl p-5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Signed in as</p>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-text-muted">Email</dt>
            <dd className="text-text-primary">{session?.user?.email || "—"}</dd>
            <dt className="text-text-muted">Role</dt>
            <dd className="text-text-primary">
              {me?.role === "OWNER" ? "Owner" : me?.role === "STAFF" ? `Staff${me?.title ? ` · ${me.title}` : ""}` : me?.role || "—"}
            </dd>
          </dl>
        </div>

        {/* Name */}
        <form onSubmit={saveName} className="bg-surface border border-app-border rounded-xl p-5 space-y-3">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Profile</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">First name</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Last name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>
          {nameError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{nameError}</div>}
          {nameSaved && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Saved.</div>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingName}
              className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {savingName ? "Saving…" : "Save"}
            </button>
          </div>
        </form>

        {/* Password */}
        <form onSubmit={changePassword} className="bg-surface border border-app-border rounded-xl p-5 space-y-3">
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Password</p>
            <p className="text-xs text-text-muted">
              Update your sign-in password. We&apos;ll never email it back to you.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Current password</label>
            <input
              type="password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">New password</label>
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Confirm new password</label>
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>
          {pwError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{pwError}</div>}
          {pwSaved && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Password updated.</div>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingPw}
              className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {savingPw ? "Updating…" : "Update password"}
            </button>
          </div>
        </form>

        {/* Member-portal profile (#10) — owners AND staff publish themselves
            on the portal "Our team" page. Fixes owners having no way to appear. */}
        <form onSubmit={savePortalProfile} className="bg-surface border border-app-border rounded-xl p-5 space-y-3">
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Member portal profile</p>
            <p className="text-xs text-text-muted">
              Show your photo, bio, and contact on the member portal&apos;s &ldquo;Our team&rdquo; page.
              {me?.role === "OWNER" ? " As the owner, this is how members see you." : ""}
            </p>
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={portalShow} onChange={(e) => setPortalShow(e.target.checked)} className="mt-1" />
            <span>
              <span className="block text-sm font-medium text-text-primary">Show me on the member portal</span>
              <span className="block text-xs text-text-muted mt-0.5">
                Members will see your name{me?.role === "OWNER" ? " (Owner)" : ""}, photo, bio, and the contact info below.
              </span>
            </span>
          </label>
          <ImageUpload label="Photo" value={portalPhoto || null} onChange={setPortalPhoto} shape="circle" />
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Bio</label>
            <textarea
              value={portalBio}
              onChange={(e) => setPortalBio(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="A short intro members will see"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Public email (optional)</label>
              <input
                type="email"
                value={portalEmail}
                onChange={(e) => setPortalEmail(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Public phone (optional)</label>
              <input
                type="tel"
                value={portalPhone}
                onChange={(e) => setPortalPhone(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>
          {portalError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{portalError}</div>}
          {portalSaved && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Saved.</div>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingPortal}
              className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {savingPortal ? "Saving…" : "Save portal profile"}
            </button>
          </div>
        </form>

        {me?.role === "STAFF" && (
          <div className="bg-app-bg border border-app-border rounded-xl p-4 text-xs text-text-muted">
            Need access to other club sections? Ask your club owner to grant the relevant
            permission under <Link href="/dashboard/staff" className="underline text-text-primary">Staff</Link>.
          </div>
        )}
      </div>
    </div>
  );
}
