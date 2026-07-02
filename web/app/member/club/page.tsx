"use client";

// Member-facing Club Profile: club bio + contact/hours, the staff directory,
// and the club's donation/support links — one clean page for "who we are".
// Data is read-only here: /api/member/club + /api/member/staff.

import { useEffect, useState } from "react";
import { Users, Mail, Phone, Globe, Clock, Heart, ExternalLink } from "lucide-react";

type ClubProfile = {
  name: string;
  sport: string | null;
  tagline: string | null;
  logoUrl: string | null;
  aboutUs: string | null;
  coverImageUrl: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socialLinks: { label: string; url: string }[] | null;
  hoursOfOperation: Record<string, string> | null;
  donationLinks: { id: string; title: string; description: string | null; url: string }[];
};

type StaffMember = {
  id: string;
  firstName: string;
  lastName: string;
  role: "OWNER" | "STAFF" | "MEMBER";
  staffProfile: {
    title: string | null;
    bio: string | null;
    publicEmail: string | null;
    publicPhone: string | null;
    photoUrl: string | null;
  } | null;
};

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export default function MemberClubProfilePage() {
  const [club, setClub] = useState<ClubProfile | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/member/club").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/member/staff").then((r) => (r.ok ? r.json() : [])),
    ]).then(([c, s]) => {
      setClub(c);
      setStaff(Array.isArray(s) ? s : []);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-stone-400 text-sm">Loading club profile…</div>;
  }
  if (!club) {
    return <div className="text-center py-12 text-stone-400 text-sm">Club info is unavailable right now.</div>;
  }

  const hours =
    club.hoursOfOperation && Object.values(club.hoursOfOperation).some((v) => v?.trim())
      ? club.hoursOfOperation
      : null;
  const socials = (club.socialLinks ?? []).filter((l) => l?.url?.trim());
  const hoursEntries = hours
    ? Object.entries(hours)
        .filter(([, v]) => v?.trim())
        .sort(([a], [b]) => DAY_ORDER.indexOf(a.toLowerCase()) - DAY_ORDER.indexOf(b.toLowerCase()))
    : [];

  return (
    <>
      {/* Hero */}
      <div className="pcard overflow-hidden mb-4">
        {club.coverImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={club.coverImageUrl} alt="" className="w-full aspect-[3/1] object-cover" />
        )}
        <div className="p-5">
          <div className="flex items-center gap-4">
            {club.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={club.logoUrl} alt={`${club.name} logo`} className="w-14 h-14 rounded-xl object-contain bg-stone-100 flex-shrink-0" />
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-stone-900 truncate">{club.name}</h1>
              {club.tagline && <p className="text-sm text-stone-500">{club.tagline}</p>}
              {club.sport && (
                <span className="inline-block mt-1 text-[11px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-600">
                  {club.sport}
                </span>
              )}
            </div>
          </div>
          {club.aboutUs && (
            <p className="text-sm text-stone-700 mt-4 whitespace-pre-wrap leading-relaxed">{club.aboutUs}</p>
          )}
        </div>
      </div>

      {/* Contact + hours */}
      {(club.contactEmail || club.contactPhone || club.websiteUrl || socials.length > 0 || hoursEntries.length > 0) && (
        <div className="pcard p-5 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-5">
          {(club.contactEmail || club.contactPhone || club.websiteUrl || socials.length > 0) && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2">Contact</p>
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
                    <Globe size={14} strokeWidth={2} className="text-stone-400 flex-shrink-0" />
                    <a href={club.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:underline truncate">
                      {club.websiteUrl.replace(/^https?:\/\//, "")}
                    </a>
                  </div>
                )}
                {socials.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
                    {socials.map((s) => (
                      <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="text-stone-600 hover:underline">
                        {s.label || s.url}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {hoursEntries.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2 flex items-center gap-1.5">
                <Clock size={12} strokeWidth={2} /> Hours
              </p>
              <div className="space-y-1 text-sm text-stone-700">
                {hoursEntries.map(([day, val]) => (
                  <div key={day} className="flex justify-between gap-3">
                    <span className="capitalize text-stone-500">{day}</span>
                    <span>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Donation / support links */}
      {club.donationLinks.length > 0 && (
        <div className="pcard p-5 mb-4">
          <p className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-3 flex items-center gap-1.5">
            <Heart size={12} strokeWidth={2} /> Support {club.name}
          </p>
          <div className="space-y-2">
            {club.donationLinks.map((d) => (
              <a
                key={d.id}
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 hover:bg-stone-50 transition"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-stone-900 truncate">{d.title}</p>
                  {d.description && <p className="text-xs text-stone-500 truncate">{d.description}</p>}
                </div>
                <ExternalLink size={14} strokeWidth={2} className="text-stone-400 flex-shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Team */}
      <div className="mb-2 flex items-center gap-2">
        <Users size={16} strokeWidth={2} className="text-stone-500" />
        <h2 className="text-base font-semibold text-stone-900">Our team</h2>
      </div>
      {staff.length === 0 ? (
        <div className="pcard p-8 text-center">
          <p className="text-sm text-stone-500">When your club adds team bios, they&apos;ll show here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {staff.map((s) => {
            const profile = s.staffProfile;
            return (
              <div key={s.id} className="pcard p-5">
                <div className="flex items-start gap-4">
                  <div className="w-14 h-14 rounded-full bg-stone-200 flex-shrink-0 overflow-hidden flex items-center justify-center text-base font-bold text-stone-700">
                    {profile?.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={profile.photoUrl} alt={`${s.firstName} ${s.lastName}`} className="w-full h-full object-cover" />
                    ) : (
                      <>{s.firstName[0]}{s.lastName[0]}</>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-semibold text-stone-900">{s.firstName} {s.lastName}</h3>
                    {profile?.title
                      ? <p className="text-xs text-stone-500">{profile.title}</p>
                      : s.role === "OWNER" && <p className="text-xs text-stone-500">Owner</p>}
                    {profile?.bio && (
                      <p className="text-sm text-stone-600 mt-2 whitespace-pre-wrap">{profile.bio}</p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-stone-500">
                      {profile?.publicEmail && (
                        <a href={`mailto:${profile.publicEmail}`} className="inline-flex items-center gap-1 hover:text-stone-900">
                          <Mail className="h-3 w-3" strokeWidth={2} /> {profile.publicEmail}
                        </a>
                      )}
                      {profile?.publicPhone && (
                        <a href={`tel:${profile.publicPhone.replace(/\D/g, "")}`} className="inline-flex items-center gap-1 hover:text-stone-900">
                          <Phone className="h-3 w-3" strokeWidth={2} /> {profile.publicPhone}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
