"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  CheckSquare,
  MessageSquare,
  Megaphone,
  FileText,
  UserCircle2,
  Users as UsersIcon,
  Mail,
  Phone,
  ExternalLink,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { resolveActiveProfileId, onActiveProfileChange } from "@/lib/activeProfile";

type Booking = {
  id: string;
  status: string;
  kind?: "event" | "private";
  event: {
    id: string;
    name: string;
    type: string;
    startsAt: string;
    endsAt: string;
    customEventType: { name: string; color: string; textColor: string } | null;
  };
};

type RawPrivateBooking = {
  id: string;
  status: string;
  createdAt: string;
  confirmedStartAt: string | null;
  confirmedEndAt: string | null;
  requestedSlots: unknown;
  lessonType: { id: string; title: string; durationMin: number } | null;
  coach: { id: string; firstName: string; lastName: string } | null;
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
  privateBookings?: RawPrivateBooking[];
  membership: { name: string } | null;
  subscriptions: { status: string; membership: { name: string } }[];
};

type GuardianOf = {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    bookings: Booking[];
    privateBookings?: RawPrivateBooking[];
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

type ClubBannerData = {
  name: string;
  tagline: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  aboutUs: string | null;
  sport: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socialLinks: { label: string; url: string }[] | null;
  hoursOfOperation: Record<string, string> | null;
};

function ClubBanner() {
  const [club, setClub] = useState<ClubBannerData | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/member/club")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setClub(d));
  }, []);

  if (!club) return null;
  if (!club.logoUrl && !club.aboutUs && !club.tagline && !club.coverImageUrl) return null;

  const aboutShort = club.aboutUs && club.aboutUs.length > 280 ? club.aboutUs.slice(0, 280) + "…" : club.aboutUs;
  const hours = club.hoursOfOperation && Object.values(club.hoursOfOperation).some((v) => v?.trim()) ? club.hoursOfOperation : null;
  const socials = (club.socialLinks ?? []).filter((l) => l?.url?.trim());

  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden mb-4">
      {club.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={club.coverImageUrl} alt="" className="w-full aspect-[3/1] object-cover" />
      )}
      <div className="p-5">
        <div className="flex items-start gap-4">
          {club.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={club.logoUrl} alt={club.name} className="w-16 h-16 rounded-lg object-cover flex-shrink-0" />
          ) : (
            <div className="w-16 h-16 rounded-lg bg-stone-100 flex items-center justify-center text-stone-300 flex-shrink-0">
              <UsersIcon size={28} strokeWidth={1.75} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-stone-900">{club.name}</h2>
            {club.tagline && <p className="text-sm text-stone-600 mt-0.5">{club.tagline}</p>}
            {club.aboutUs && (
              <div className="mt-3">
                <p className="text-sm text-stone-700 whitespace-pre-wrap">
                  {expanded ? club.aboutUs : aboutShort}
                </p>
                {club.aboutUs.length > 280 && (
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="text-xs text-stone-500 hover:text-stone-900 mt-1"
                  >
                    {expanded ? "Show less" : "Read more"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {(club.contactEmail || club.contactPhone || club.websiteUrl || socials.length > 0 || hours) && (
          <div className="mt-4 pt-4 border-t border-stone-100 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(club.contactEmail || club.contactPhone || club.websiteUrl || socials.length > 0) && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-1.5">Contact</p>
                <div className="space-y-1.5 text-sm text-stone-700">
                  {club.contactEmail && (
                    <div className="flex items-center gap-2">
                      <Mail size={14} strokeWidth={2} className="text-stone-400 flex-shrink-0" />
                      <a href={`mailto:${club.contactEmail}`} className="hover:underline truncate">{club.contactEmail}</a>
                    </div>
                  )}
                  {club.contactPhone && (
                    <div className="flex items-center gap-2">
                      <Phone size={14} strokeWidth={2} className="text-stone-400 flex-shrink-0" />
                      <a href={`tel:${club.contactPhone.replace(/\D/g, "")}`} className="hover:underline">{club.contactPhone}</a>
                    </div>
                  )}
                  {club.websiteUrl && (
                    <div className="flex items-center gap-2">
                      <ExternalLink size={14} strokeWidth={2} className="text-stone-400 flex-shrink-0" />
                      <a href={club.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:underline truncate">{club.websiteUrl.replace(/^https?:\/\//, "")}</a>
                    </div>
                  )}
                  {socials.length > 0 && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                      {socials.map((s) => (
                        <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{s.label || s.url}</a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {hours && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-1.5">Hours</p>
                <div className="space-y-0.5 text-sm text-stone-700">
                  {["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => {
                    const v = hours[d];
                    if (!v?.trim()) return null;
                    return (
                      <div key={d} className="flex justify-between gap-3">
                        <span className="capitalize text-stone-500">{d}</span>
                        <span>{v}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Shared tile used by both AdultAthleteView and ParentView. Renders a
// lucide SVG icon (replaces the previous unicode glyphs ◷ ✓ ✉ 📣 ▤ ◎
// which rendered as "?" tofu boxes on iOS WebKit because the system
// fallback font doesn't carry those geometric characters).
function TileLink({
  href,
  icon: Icon,
  label,
  desc,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition text-center min-w-0"
    >
      <div className="mx-auto mb-2 w-9 h-9 rounded-full bg-lime-100 text-lime-800 flex items-center justify-center">
        <Icon size={18} strokeWidth={2} />
      </div>
      <p className="text-sm font-medium text-stone-900 truncate">{label}</p>
      <p className="text-xs text-stone-500 line-clamp-2 mt-0.5">{desc}</p>
    </Link>
  );
}

// Convert each PrivateBooking row from /api/member/portal into the unified
// Booking shape used everywhere else on this page. Mirrors the same logic
// in /member/bookings/page.tsx so the home widget and the full bookings
// list stay aligned.
function firstRequestedSlotAt(raw: unknown, fallback: string): string {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const sorted = (raw as Array<{ date?: string; startTime?: string }>)
    .filter((s) => typeof s?.date === "string" && typeof s?.startTime === "string")
    .sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  const first = sorted[0];
  if (!first?.date || !first?.startTime) return fallback;
  const iso = new Date(`${first.date}T${first.startTime}`);
  return Number.isNaN(iso.getTime()) ? fallback : iso.toISOString();
}

function privateBookingsToBookings(records: RawPrivateBooking[] | undefined): Booking[] {
  if (!records) return [];
  return records
    .filter((r) => r.lessonType)
    .map((r) => {
      const startsAt =
        r.confirmedStartAt ?? firstRequestedSlotAt(r.requestedSlots, r.createdAt);
      const endsAt =
        r.confirmedEndAt ??
        new Date(
          new Date(startsAt).getTime() + (r.lessonType!.durationMin || 60) * 60_000,
        ).toISOString();
      return {
        id: `private:${r.id}`,
        status: r.status,
        kind: "private" as const,
        event: {
          id: r.id,
          name: r.lessonType!.title,
          type: "PRIVATE",
          startsAt,
          endsAt,
          customEventType: null,
        },
      };
    });
}

// Merge events + private bookings into one chronologically-sorted list
// that the home page surfaces through UpcomingBookings + the count tile.
function mergeUpcoming(
  events: Booking[] | undefined,
  privates: RawPrivateBooking[] | undefined,
): Booking[] {
  const merged = [
    ...((events ?? []).map((b) => ({ ...b, kind: b.kind ?? ("event" as const) }))),
    ...privateBookingsToBookings(privates),
  ];
  return merged.sort(
    (a, b) => new Date(a.event.startsAt).getTime() - new Date(b.event.startsAt).getTime(),
  );
}

function getEventLabel(b: Booking): string {
  if (b.event.customEventType) return b.event.customEventType.name;
  if (b.kind === "private") return "Private";
  return b.event.type.charAt(0) + b.event.type.slice(1).toLowerCase();
}

function getEventColor(b: Booking): { bg: string; fg: string } {
  if (b.event.customEventType) {
    return { bg: b.event.customEventType.color, fg: b.event.customEventType.textColor };
  }
  const map: Record<string, { bg: string; fg: string }> = {
    CLASS: { bg: "var(--color-primary)", fg: "#fff" },
    PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
    CLINIC: { bg: "var(--color-success)", fg: "#1F1F23" },
    CAMP: { bg: "var(--color-warning)", fg: "#fff" },
    TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
    OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  };
  return map[b.event.type] || map.OTHER;
}

// Statuses that count as "upcoming" for the home widget. Includes
// REQUESTED/PENDING_COACH so a private lesson request the athlete just
// submitted shows up immediately, before the coach has accepted.
const UPCOMING_STATUSES = new Set([
  "CONFIRMED",
  "WAITLISTED",
  "REQUESTED",
  "PENDING_COACH",
]);

function UpcomingBookings({ bookings, label }: { bookings: Booking[]; label?: string }) {
  const upcoming = bookings.filter((b) => UPCOMING_STATUSES.has(b.status));

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <h3 className="text-sm font-semibold text-stone-900 mb-3">{label || "Upcoming Bookings"}</h3>
      {upcoming.length === 0 ? (
        <p className="text-sm text-stone-400">No upcoming bookings.</p>
      ) : (
        <div className="space-y-2">
          {upcoming.slice(0, 5).map((b) => {
            const c = getEventColor(b);
            const isPending = b.status === "REQUESTED" || b.status === "PENDING_COACH";
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
                {isPending && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium flex-shrink-0">
                    Pending
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
  // Merge events + privates once at the top so the stat tile and the
  // UpcomingBookings widget agree on the count + ordering.
  const allBookings = mergeUpcoming(member?.bookings, member?.privateBookings);
  const upcomingCount = allBookings.filter((b) => UPCOMING_STATUSES.has(b.status)).length;

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

      <ClubBanner />

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
            {upcomingCount} upcoming
          </p>
        </div>
      </div>

      {member && <UpcomingBookings bookings={allBookings} />}

      <div className="mt-4">
        <RecentAnnouncements />
      </div>

      <Link
        href="/member/schedule"
        className="block mt-4 bg-stone-900 text-white rounded-xl p-5 hover:bg-stone-800 transition"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold mb-0.5">View the full schedule</p>
            <p className="text-xs text-stone-300">Classes · Events · Private lessons</p>
          </div>
          <ChevronRight size={24} strokeWidth={2} className="flex-shrink-0" />
        </div>
      </Link>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <TileLink href="/member/schedule"      icon={CalendarDays}  label="Schedule"      desc="Browse all classes and events" />
        <TileLink href="/member/bookings"      icon={CheckSquare}   label="My Bookings"   desc="Classes &amp; events you’re registered for" />
        <TileLink href="/member/messages"      icon={MessageSquare} label="Messages"      desc="Conversations with your club" />
        <TileLink href="/member/announcements" icon={Megaphone}     label="Announcements" desc="News and updates from your club" />
        <TileLink href="/member/documents"     icon={FileText}      label="Documents"     desc="Waivers and forms" />
        <TileLink href="/member/staff"         icon={UsersIcon}     label="Our team"      desc="Coaches &amp; staff bios" />
      </div>
    </>
  );
}

/* ─── Recent announcements card ─── */
type RecentAnnouncement = { id: string; title: string; body: string; createdAt: string; publishAt: string | null };

function RecentAnnouncements() {
  const [items, setItems] = useState<RecentAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/member/announcements")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        setItems(Array.isArray(d) ? d.slice(0, 3) : []);
        setLoading(false);
      });
  }, []);

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-stone-900">Latest from your club</h3>
        <Link href="/member/announcements" className="text-xs text-stone-500 hover:text-stone-900">See all →</Link>
      </div>
      <div className="space-y-2">
        {items.map((a) => (
          <Link
            key={a.id}
            href="/member/announcements"
            className="block py-2 border-b border-stone-100 last:border-0 hover:bg-stone-50 -mx-2 px-2 rounded"
          >
            <p className="text-sm font-medium text-stone-900 truncate">{a.title}</p>
            <p className="text-xs text-stone-500 line-clamp-1 whitespace-pre-wrap">{a.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ─── Minor Athlete View ─── */
function MinorAthleteView({ data }: { data: PortalData }) {
  const member = data.user.memberProfile;
  const minorAllBookings = mergeUpcoming(member?.bookings, member?.privateBookings);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">
          Hey {data.user.firstName}!
        </h1>
        <p className="text-sm text-stone-500">{data.club.name}</p>
      </div>

      <ClubBanner />

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
          <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">Upcoming</p>
          <p className="text-sm font-semibold text-stone-900">
            {minorAllBookings.filter((b) => UPCOMING_STATUSES.has(b.status)).length}
          </p>
        </div>
      </div>

      {member && (
        <UpcomingBookings bookings={minorAllBookings} label="My Schedule" />
      )}

      {/* Minor tile grid. Mirrors the Adult/Parent home grids so a minor
          has a direct path to Messages / Announcements / Documents / etc.
          Before this, minors had to know the URL (typing /member/messages)
          to find their conversations — the bottom-nav Messages tab IS
          present but easy to miss on first launch. */}
      <div className="grid grid-cols-2 gap-3 mt-4">
        <TileLink href="/member/schedule"      icon={CalendarDays}  label="Schedule"      desc="Classes and events" />
        <TileLink href="/member/bookings"      icon={CheckSquare}   label="My Bookings"   desc="Sessions you're in" />
        <TileLink href="/member/messages"      icon={MessageSquare} label="Messages"      desc="Talk to your coaches" />
        <TileLink href="/member/announcements" icon={Megaphone}     label="Announcements" desc="News from your club" />
        <TileLink href="/member/documents"     icon={FileText}      label="Documents"     desc="Waivers and forms" />
        <TileLink href="/member/profile"       icon={UserCircle2}   label="My Profile"    desc="Your info" />
      </div>
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
          <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-lime-100 text-lime-700 flex items-center justify-center">
            <CheckSquare size={22} strokeWidth={2.25} />
          </div>
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
  const [showLinkChild, setShowLinkChild] = useState(false);
  const children = data.user.guardianOf;
  const self = data.user.memberProfile;

  // Every athlete this account manages: the account holder's own profile (if
  // they're also a member) plus each linked child. The selected profile is
  // shared with the account-level ProfileSwitcher in the portal layout.
  type ManagedProfile = {
    id: string;
    firstName: string;
    lastName: string;
    status: string;
    kind: "self" | "child";
    bookings: Booking[];
  };
  const profiles: ManagedProfile[] = [
    ...(self
      ? [
          {
            id: self.id,
            firstName: self.firstName,
            lastName: self.lastName,
            status: self.status,
            kind: "self" as const,
            // Merge events + privates so a parent who is also a member sees
            // their own private lesson requests on the parent dashboard.
            bookings: mergeUpcoming(self.bookings, self.privateBookings),
          },
        ]
      : []),
    ...children.map((c) => ({
      id: c.member.id,
      firstName: c.member.firstName,
      lastName: c.member.lastName,
      status: c.member.status,
      kind: "child" as const,
      // Each linked child contributes their own merged event + private list.
      bookings: mergeUpcoming(c.member.bookings, c.member.privateBookings),
    })),
  ];

  const [activeId, setActiveId] = useState<string | null>(() =>
    resolveActiveProfileId(profiles.map((p) => p.id)),
  );
  useEffect(() => onActiveProfileChange((id) => id && setActiveId(id)), []);
  const activeProfile = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
  const activeSub = self && activeProfile?.kind === "self"
    ? self.subscriptions?.find((s) => s.status === "active")
    : null;

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

      <ClubBanner />

      {children.length === 0 && !self ? (
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center mb-4">
          <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-lime-100 text-lime-800 flex items-center justify-center">
            <UsersIcon size={22} strokeWidth={2} />
          </div>
          <h3 className="text-base font-medium text-stone-900 mb-1">No children linked yet</h3>
          <p className="text-sm text-stone-500 mb-4">
            Enter your child's email address to link their account.
          </p>
          <button onClick={() => setShowLinkChild(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700">
            Link a child
          </button>
        </div>
      ) : (
        activeProfile && (
          <>
            <div className="bg-white rounded-xl border border-stone-200 p-4 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-stone-200 flex items-center justify-center text-sm font-bold text-stone-700">
                  {activeProfile.firstName[0]}
                  {activeProfile.lastName[0]}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-stone-900">
                    {activeProfile.firstName} {activeProfile.lastName}
                    {activeProfile.kind === "self" && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-stone-400">
                        you
                      </span>
                    )}
                  </p>
                  <p
                    className={`text-xs ${
                      activeProfile.status === "ACTIVE" ? "text-green-700" : "text-stone-500"
                    }`}
                  >
                    {activeProfile.status}
                    {activeSub ? ` · ${activeSub.membership.name}` : ""}
                  </p>
                </div>
              </div>
            </div>
            <UpcomingBookings
              bookings={activeProfile.bookings}
              label={`${activeProfile.firstName}'s Schedule`}
            />
          </>
        )
      )}

      <div className="grid grid-cols-2 gap-3 mt-4">
        <TileLink href="/member/schedule"      icon={CalendarDays}  label="Schedule"      desc="Browse classes and events" />
        <TileLink href="/member/bookings"      icon={CheckSquare}   label="My Bookings"   desc="Registered sessions" />
        <TileLink href="/member/messages"      icon={MessageSquare} label="Messages"      desc="Conversations with your club" />
        <TileLink href="/member/announcements" icon={Megaphone}     label="Announcements" desc="News from your club" />
        <TileLink href="/member/documents"     icon={FileText}      label="Documents"     desc="Sign waivers and forms" />
        <TileLink href="/member/profile"       icon={UserCircle2}   label="My Profile"    desc="Update your info" />
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
  // Any account that manages at least one linked child gets the multi-athlete
  // ParentView (which now also includes the account holder's own profile when
  // they're a member too), so parents can switch between every athlete.
  const hasChildren = data.user.guardianOf.length > 0;
  const isMinor = member?.isMinor;

  if (hasChildren) return <ParentView data={data} onRefresh={load} />;
  if (isMinor) return <MinorAthleteView data={data} />;
  return <AdultAthleteView data={data} />;
}
