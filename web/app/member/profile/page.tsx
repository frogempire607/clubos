"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";

type MemberProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  status: string;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianRelationship: string | null;
  membership: { name: string } | null;
  subscriptions: { status: string; optionLabel: string; membership: { name: string } }[];
};

type UserData = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  memberProfile: MemberProfile | null;
  guardianOf: { member: { id: string; firstName: string; lastName: string; email: string | null } }[];
};

export default function MemberProfilePage() {
  const [data, setData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/member/portal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user) {
          setData(d.user);
          setFirstName(d.user.firstName);
          setLastName(d.user.lastName);
          setPhone(d.user.memberProfile?.phone || "");
        }
        setLoading(false);
      });
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!data?.memberProfile) return;
    setSaving(true);
    setError("");
    const res = await fetch(`/api/members/${data.memberProfile.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, phone: phone || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setError(d.error?.toString() || "Save failed");
      return;
    }
    setSuccess(true);
    setEditing(false);
    setTimeout(() => setSuccess(false), 2000);
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (!data) return <div className="text-center py-8 text-stone-400 text-sm">Could not load profile.</div>;

  const member = data.memberProfile;
  const activeSub = member?.subscriptions?.find((s) => s.status === "active");

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">My Profile</h1>
          <p className="text-sm text-stone-500">Your account details and membership info.</p>
        </div>
        <button
          onClick={() => setEditing(!editing)}
          className="text-sm px-3 py-1.5 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50"
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      {success && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          Profile updated!
        </div>
      )}

      {/* Account info */}
      <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
        <h2 className="text-sm font-semibold text-stone-900 mb-4">Account</h2>

        {editing ? (
          <form onSubmit={handleSave} className="space-y-3">
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
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">Phone (optional)</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button type="submit" disabled={saving}
              className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
              {saving ? "Saving…" : "Save changes"}
            </button>
          </form>
        ) : (
          <dl className="space-y-2">
            <ProfileRow label="Name" value={`${data.firstName} ${data.lastName}`} />
            <ProfileRow label="Email" value={data.email} />
            {member?.phone && <ProfileRow label="Phone" value={member.phone} />}
            {member?.dateOfBirth && (
              <ProfileRow
                label="Date of birth"
                value={new Date(member.dateOfBirth).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              />
            )}
          </dl>
        )}
      </div>

      {/* Membership */}
      {member && (
        <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
          <h2 className="text-sm font-semibold text-stone-900 mb-4">Membership</h2>
          {activeSub ? (
            <dl className="space-y-2">
              <ProfileRow label="Plan" value={activeSub.membership.name} />
              <ProfileRow label="Option" value={activeSub.optionLabel} />
              <ProfileRow label="Status" value={activeSub.status.charAt(0).toUpperCase() + activeSub.status.slice(1)} />
            </dl>
          ) : (
            <p className="text-sm text-stone-400">No active membership. Contact your club to sign up.</p>
          )}
        </div>
      )}

      {/* Guardian info (for minors) */}
      {member?.isMinor && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-6 mb-4">
          <h2 className="text-sm font-semibold text-amber-800 mb-3">Guardian on file</h2>
          <dl className="space-y-2">
            {member.guardianName && <ProfileRow label="Name" value={member.guardianName} />}
            {member.guardianRelationship && <ProfileRow label="Relationship" value={member.guardianRelationship} />}
            {member.guardianEmail && <ProfileRow label="Email" value={member.guardianEmail} />}
            {member.guardianPhone && <ProfileRow label="Phone" value={member.guardianPhone} />}
          </dl>
          <p className="text-xs text-amber-600 mt-3">Contact your club to update guardian information.</p>
        </div>
      )}

      {/* Children (for parents) */}
      {data.guardianOf.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
          <h2 className="text-sm font-semibold text-stone-900 mb-3">Your children</h2>
          <div className="space-y-2">
            {data.guardianOf.map((g) => (
              <div key={g.member.id} className="flex items-center gap-3 py-2 border-b border-stone-100 last:border-0">
                <div className="w-8 h-8 rounded-full bg-stone-200 flex items-center justify-center text-xs font-bold text-stone-700">
                  {g.member.firstName[0]}{g.member.lastName[0]}
                </div>
                <div>
                  <p className="text-sm font-medium text-stone-900">{g.member.firstName} {g.member.lastName}</p>
                  {g.member.email && <p className="text-xs text-stone-400">{g.member.email}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sign out */}
      <div className="bg-white rounded-xl border border-stone-200 p-6">
        <h2 className="text-sm font-semibold text-stone-900 mb-3">Account actions</h2>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="text-sm px-4 py-2 border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
        >
          Sign out
        </button>
      </div>
    </>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-4">
      <dt className="text-xs font-medium text-stone-500 w-24 flex-shrink-0 pt-0.5">{label}</dt>
      <dd className="text-sm text-stone-900">{value}</dd>
    </div>
  );
}
