"use client";

import { useEffect, useState } from "react";
import {
  getActiveProfileId,
  setActiveProfileId,
  onActiveProfileChange,
  resolveActiveProfileId,
} from "@/lib/activeProfile";
import { Avatar } from "@/components/member/ui";

type Profile = { id: string; name: string; kind: "self" | "child" };

// Account-level athlete switcher. Renders whenever the account can manage more
// than one profile (a guardian with their own profile + linked children, or a
// guardian managing 2+ children). The selected profile is persisted via
// lib/activeProfile so every portal page reflects it. Visual redesign only —
// the resolution logic is unchanged.
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

  const active = profiles.find((p) => p.id === activeId);

  return (
    <div className="mb-4 pfade">
      <div className="pcard px-3 py-3">
        <div className="flex items-center justify-between mb-2 px-0.5">
          <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">
            Managing
          </span>
          {active && (
            <span className="text-[11px] text-stone-400">
              {active.kind === "self" ? "Your account" : "Child account"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {profiles.map((p) => {
            const isActive = p.id === activeId;
            return (
              <button
                key={p.id}
                onClick={() => setActiveProfileId(p.id)}
                aria-pressed={isActive}
                className={`group flex items-center gap-2 pl-1.5 pr-3.5 py-1.5 rounded-full border transition flex-shrink-0 ${
                  isActive
                    ? "pseg-active border-transparent"
                    : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                }`}
              >
                <Avatar name={p.name} size={26} />
                <span className="text-sm font-semibold whitespace-nowrap">
                  {p.name}
                  {p.kind === "self" && (
                    <span className={`ml-1.5 text-[10px] font-medium ${isActive ? "opacity-70" : "text-stone-400"}`}>
                      You
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
