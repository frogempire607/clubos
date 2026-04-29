"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Booking = {
  id: string;
  status: string;
  event: {
    id: string;
    name: string;
    type: string;
    startsAt: string;
    endsAt: string;
    customEventType: { name: string; color: string; textColor: string } | null;
  };
};

type MemberProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: string;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  bookings: Booking[];
  membership: { name: string } | null;
  subscriptions: { status: string; membership: { name: string } }[];
};

type GuardianOf = {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    bookings: Booking[];
    status: string;
  };
};

type PortalData = {
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    memberProfile: MemberProfile | null;
    guardianOf: GuardianOf[];
  };
  club: {
    name: string;
    slug: string;
    sport: string | null;
    primaryColor: string | null;
  };
};

function getEventLabel(b: Booking): string {
  if (b.event.customEventType) return b.event.customEventType.name;
  return b.event.type.charAt(0) + b.event.type.slice(1).toLowerCase();
}

function getEventColor(b: Booking): { bg: string; fg: string } {
  if (b.event.customEventType) {
    return { bg: b.event.customEventType.color, fg: b.event.customEventType.textColor };
  }
  const map: Record<string, { bg: string; fg: string }> = {
    CLASS: { bg: "var(--color-primary)", fg: "#fff" },
    PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
    CLINIC: { bg: "var(--color-success)", fg: "var(--color-text)" },
    CAMP: { bg: "var(--color-warning)", fg: "#fff" },
    TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
    OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  };
  return map[b.event.type] || map.OTHER;
}

function UpcomingBookings({ bookings, label }: { bookings: Booking[]; label?: string }) {
  const upcoming = bookings.filter(
    (b) => b.status === "CONFIRMED" || b.status === "WAITLISTED"
  );

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <h3 className="text-sm font-semibold text-stone-900 mb-3">{label || "Upcoming Events"}</h3>
      {upcoming.length === 0 ? (
        <p className="text-sm text-stone-400">No upcoming bookings.</p>
      ) : (
        <div className="space-y-2">
          {upcoming.slice(0, 5).map((b) => {
            const c = getEventColor(b);
            return (
              <div key={b.id} className="flex items-center gap-3 py-2 border-b border-stone-100 last:border-0">
                <div className="flex-shrink-0 w-2 h-2 rounded-full" style={{ background: c.fg }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-900 truncate">{b.event.name}</p>
                  <p className="text-xs text-stone-400">
                    {new Date(b.event.startsAt).toLocaleDateString("en-US", {
                      weekday: "short", month: "short", day: "numeric",
                    })}{" · "}
                    {new Date(b.event.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                  </p>
                </div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
                  style={{ background: c.bg, color: c.fg }}
                >
                  {getEventLabel(b)}
                </span>
                {b.status === "WAITLISTED" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium flex-shrink-0">
                    Waitlist
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Adult Athlete View ─── */
function AdultAthleteView({ data }: { data: PortalData }) {
  const member = data.user.memberProfile;
  const activeSub = member?.subscriptions?.find((s) => s.status === "active");

  return (
    <>
      {/* Welcome */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">
          Welcome back, {data.user.firstName}
        </h1>
        <p className="text-sm text-stone-500">
          {data.club.name}{data.club.sport ? ` · ${data.club.sport}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">Status</p>
          <p className={`text-sm font-semibold ${member?.status === "ACTIVE" ? "text-green-700" : "text-stone-600"}`}>
            {member?.status || "No profile"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">Membership</p>
          <p className="text-sm font-semibold text-stone-900">
            {activeSub?.membership.name || member?.membership?.name || "None"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">Bookings</p>
          <p className="text-sm font-semibold text-stone-900">
            {member?.bookings.filter((b) => b.status === "CONFIRMED").length || 0} upcoming
          </p>
        </div>
      </div>

      {member?.bookings && (
        <UpcomingBookings bookings={member.bookings} />
      )}

      <div className="grid grid-cols-2 gap-3 mt-4">
        <Link href="/member/bookings" className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition text-center">
          <p className="text-2xl mb-1">◷</p>
          <p className="text-sm font-medium text-stone-900">My Bookings</p>
          <p className="text-xs text-stone-500">View all upcoming classes</p>
        </Link>
        <Link href="/member/documents" className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition text-center">
          <p className="text-2xl mb-1">▤</p>
          <p className="text-sm font-medium text-stone-900">Documents</p>
          <p className="text-xs text-stone-500">Waivers and forms</p>
        </Link>
      </div>
    </>
  );
}

/* ─── Minor Athlete View ─── */
function MinorAthleteView({ data }: { data: PortalData }) {
  const member = data.user.memberProfile;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">
          Hey {data.user.firstName}! 👋
        </h1>
        <p className="text-sm text-stone-500">{data.club.name}</p>
      </div>

      {member?.guardianName && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <p className="text-sm text-amber-800">
            Your guardian <strong>{member.guardianName}</strong> manages your account. They can sign documents and handle payments on your behalf.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">My Status</p>
          <p className={`text-sm font-semibold ${member?.status === "ACTIVE" ? "text-green-700" : "text-stone-600"}`}>
            {member?.status || "Active"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">Upcoming Classes</p>
          <p className="text-sm font-semibold text-stone-900">
            {member?.bookings.filter((b) => b.status === "CONFIRMED").length || 0}
          </p>
        </div>
      </div>

      {member?.bookings && (
        <UpcomingBookings bookings={member.bookings} label="My Schedule" />
      )}
    </>
  );
}

/* ─── Link Child Modal ─── */
function LinkChildModal({ onClose, onLinked }: { onClose: () => void; onLinked: () => void }) {
  const [childEmail, setChildEmail] = useState("");
  const [relationship, setRelationship] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const res = await fetch("/api/member/portal/link-child", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childEmail, relationship: relationship || undefined }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Failed to link child"); return; }
    setSuccess(true);
    setTimeout(() => { onLinked(); }, 1200);
  }

  if (success) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl w-full max-w-sm p-8 text-center">
          <p className="text-3xl mb-2">✓</p>
          <p className="text-base font-semibold text-stone-900">Child linked!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-sm">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-900">Link another child</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Child's email</label>
            <input type="email" value={childEmail} onChange={(e) => setChildEmail(e.target.value)} required placeholder="athlete@example.com" className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
            <p className="text-xs text-stone-400 mt-1">Must match the email the club has on file</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Your relationship (optional)</label>
            <select value={relationship} onChange={(e) => setRelationship(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900">
              <option value="">Select…</option>
              <option value="Parent">Parent</option>
              <option value="Mother">Mother</option>
              <option value="Father">Father</option>
              <option value="Legal guardian">Legal guardian</option>
              <option value="Grandparent">Grandparent</option>
              <option value="Other">Other</option>
            </select>
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
              {saving ? "Linking…" : "Link child"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Parent View ─── */
function ParentView({ data, onRefresh }: { data: PortalData; onRefresh: () => void }) {
  const [activeChild, setActiveChild] = useState(0);
  const [showLinkChild, setShowLinkChild] = useState(false);
  const children = data.user.guardianOf;

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">
            Welcome, {data.user.firstName}
          </h1>
          <p className="text-sm text-stone-500">
            {data.club.name} · Parent/Guardian dashboard
          </p>
        </div>
        <button onClick={() => setShowLinkChild(true)} className="text-sm px-3 py-2 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 flex-shrink-0">
          + Link child
        </button>
      </div>

      {children.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center mb-4">
          <p className="text-3xl mb-2">👨‍👧</p>
          <h3 className="text-base font-medium text-stone-900 mb-1">No children linked yet</h3>
          <p className="text-sm text-stone-500 mb-4">
            Enter your child's email address to link their account.
          </p>
          <button onClick={() => setShowLinkChild(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700">
            Link a child
          </button>
        </div>
      ) : (
        <>
          {/* Child selector */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {children.map((c, i) => (
              <button
                key={c.member.id}
                onClick={() => setActiveChild(i)}
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  activeChild === i
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-200 text-stone-600"
                }`}
              >
                {c.member.firstName} {c.member.lastName}
              </button>
            ))}
          </div>

          {children[activeChild] && (
            <>
              <div className="bg-white rounded-xl border border-stone-200 p-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-stone-200 flex items-center justify-center text-sm font-bold text-stone-700">
                    {children[activeChild].member.firstName[0]}{children[activeChild].member.lastName[0]}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-stone-900">
                      {children[activeChild].member.firstName} {children[activeChild].member.lastName}
                    </p>
                    <p className={`text-xs ${children[activeChild].member.status === "ACTIVE" ? "text-green-700" : "text-stone-500"}`}>
                      {children[activeChild].member.status}
                    </p>
                  </div>
                </div>
              </div>
              <UpcomingBookings
                bookings={children[activeChild].member.bookings}
                label={`${children[activeChild].member.firstName}'s Schedule`}
              />
            </>
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-3 mt-4">
        <Link href="/member/documents" className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition text-center">
          <p className="text-2xl mb-1">▤</p>
          <p className="text-sm font-medium text-stone-900">Documents</p>
          <p className="text-xs text-stone-500">Sign waivers and forms</p>
        </Link>
        <Link href="/member/profile" className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition text-center">
          <p className="text-2xl mb-1">◎</p>
          <p className="text-sm font-medium text-stone-900">My Profile</p>
          <p className="text-xs text-stone-500">Update your info</p>
        </Link>
      </div>

      {showLinkChild && (
        <LinkChildModal
          onClose={() => setShowLinkChild(false)}
          onLinked={() => { setShowLinkChild(false); onRefresh(); }}
        />
      )}
    </>
  );
}

/* ─── Main ─── */
export default function MemberHome() {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    fetch("/api/member/portal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setData(d); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-center py-16 text-stone-400 text-sm">Loading…</div>;
  if (!data) return <div className="text-center py-16 text-stone-400 text-sm">Could not load your profile.</div>;

  const member = data.user.memberProfile;
  const isParentOnly = !member && data.user.guardianOf.length > 0;
  const isMinor = member?.isMinor;

  if (isParentOnly) return <ParentView data={data} onRefresh={load} />;
  if (isMinor) return <MinorAthleteView data={data} />;
  return <AdultAthleteView data={data} />;
}
