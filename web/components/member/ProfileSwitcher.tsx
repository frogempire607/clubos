"use client";

import { setActiveProfileId } from "@/lib/activeProfile";
import { Avatar } from "@/components/member/ui";
import { useAthleteProfiles, useActiveAthlete } from "@/components/member/AthleteRail";

// Account-level athlete switcher. Renders whenever the account can manage more
// than one profile (a guardian with their own profile + linked children, or a
// guardian managing 2+ children). The selected profile is persisted via
// lib/activeProfile so every portal page reflects it. Profile data comes from
// the shared portal cache in AthleteRail.tsx (one fetch feeds chips + rail);
// the resolution logic is unchanged.
export default function ProfileSwitcher() {
  const { profiles } = useAthleteProfiles();
  const [activeId] = useActiveAthlete(profiles);

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
