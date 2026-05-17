"use client";

import { useEffect, useState } from "react";
import {
  getActiveProfileId,
  setActiveProfileId,
  onActiveProfileChange,
  resolveActiveProfileId,
} from "@/lib/activeProfile";

type Profile = { id: string; name: string; kind: "self" | "child" };

// Account-level athlete switcher. Renders only when the account can manage
// more than one profile (a guardian with linked children). The selected
// profile is persisted via lib/activeProfile so every portal page reflects it.
export default function ProfileSwitcher() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/member/portal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.user) return;
        const list: Profile[] = [];
        if (d.user.memberProfile) {
          list.push({
            id: d.user.memberProfile.id,
            name: `${d.user.memberProfile.firstName} ${d.user.memberProfile.lastName}`.trim(),
            kind: "self",
          });
        }
        for (const g of d.user.guardianOf ?? []) {
          list.push({
            id: g.member.id,
            name: `${g.member.firstName} ${g.member.lastName}`.trim(),
            kind: "child",
          });
        }
        setProfiles(list);
        const resolved = resolveActiveProfileId(list.map((p) => p.id));
        setActiveId(resolved);
        // Seed the shared store so other pages start on the same profile.
        if (resolved && resolved !== getActiveProfileId()) setActiveProfileId(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onActiveProfileChange(setActiveId), []);

  if (profiles.length < 2) return null;

  return (
    <div className="mb-4 -mt-1">
      <div className="bg-white border border-stone-200 rounded-xl px-3 py-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-stone-500 font-medium mr-1">
            Managing
          </span>
          {profiles.map((p) => {
            const active = p.id === activeId;
            return (
              <button
                key={p.id}
                onClick={() => setActiveProfileId(p.id)}
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  active
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-200 text-stone-600 bg-white hover:bg-stone-50"
                }`}
              >
                {p.name}
                {p.kind === "self" && (
                  <span className={`ml-1.5 text-[10px] ${active ? "text-white/60" : "text-stone-400"}`}>
                    you
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
