"use client";

import { useEffect, useState } from "react";

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

export default function MemberStaffPage() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/member/staff")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { setStaff(Array.isArray(d) ? d : []); setLoading(false); });
  }, []);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Our team</h1>
        <p className="text-sm text-stone-500">Coaches, owners, and staff at your club.</p>
      </div>

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : staff.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">◎</p>
          <p className="text-base font-medium text-stone-900 mb-1">No staff profiles yet</p>
          <p className="text-sm text-stone-500">When your club adds team bios, they'll show here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {staff.map((s) => {
            const profile = s.staffProfile;
            return (
              <div key={s.id} className="bg-white rounded-xl border border-stone-200 p-5">
                <div className="flex items-start gap-4">
                  <div className="w-16 h-16 rounded-full bg-stone-200 flex-shrink-0 overflow-hidden flex items-center justify-center text-base font-bold text-stone-700">
                    {profile?.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={profile.photoUrl} alt={`${s.firstName} ${s.lastName}`} className="w-full h-full object-cover" />
                    ) : (
                      <>{s.firstName[0]}{s.lastName[0]}</>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold text-stone-900">{s.firstName} {s.lastName}</h2>
                    {profile?.title && <p className="text-xs text-stone-500">{profile.title}</p>}
                    {!profile?.title && s.role === "OWNER" && <p className="text-xs text-stone-500">Owner</p>}
                    {profile?.bio && (
                      <p className="text-sm text-stone-600 mt-2 whitespace-pre-wrap">{profile.bio}</p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-stone-500">
                      {profile?.publicEmail && (
                        <a href={`mailto:${profile.publicEmail}`} className="hover:text-stone-900">
                          ✉ {profile.publicEmail}
                        </a>
                      )}
                      {profile?.publicPhone && (
                        <a href={`tel:${profile.publicPhone.replace(/\D/g, "")}`} className="hover:text-stone-900">
                          ☎ {profile.publicPhone}
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
