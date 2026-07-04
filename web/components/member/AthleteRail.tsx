"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  getActiveProfileId,
  setActiveProfileId,
  onActiveProfileChange,
  resolveActiveProfileId,
} from "@/lib/activeProfile";
import { Avatar, Pill } from "@/components/member/ui";

/* ── Shared portal-profiles cache ─────────────────────────────────────────
 * The switcher (mobile chips) and the rail (desktop) both need the same
 * /api/member/portal payload; a module-level cache keeps that to one fetch
 * per page load, mirroring useClubBrand() in ui.tsx. */
export type AthleteProfile = {
  id: string;
  name: string;
  kind: "self" | "child";
  age: number | null;
  membershipName: string | null;
  upcoming: number;
  hasOwnLogin: boolean;
};

function ageFrom(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProfile(member: any, kind: "self" | "child"): AthleteProfile {
  const upcoming =
    (member?.bookings?.length ?? 0) +
    (member?.attendanceRecords?.length ?? 0) +
    (member?.privateBookings?.filter((b: { status: string }) => b.status === "CONFIRMED").length ?? 0);
  return {
    id: member.id,
    name: `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim(),
    kind,
    age: ageFrom(member.dateOfBirth),
    membershipName:
      member?.subscriptions?.[0]?.membership?.name ?? member?.membership?.name ?? null,
    upcoming,
    hasOwnLogin: kind === "self" ? true : Boolean(member?.user?.id ?? member?.userId),
  };
}

let _profilesCache: AthleteProfile[] | null = null;
let _profilesPromise: Promise<AthleteProfile[]> | null = null;

function fetchProfiles(): Promise<AthleteProfile[]> {
  if (_profilesCache) return Promise.resolve(_profilesCache);
  if (_profilesPromise) return _profilesPromise;
  _profilesPromise = fetch("/api/member/portal")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d?.user) return [];
      const list: AthleteProfile[] = [];
      if (d.user.memberProfile) list.push(toProfile(d.user.memberProfile, "self"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const g of d.user.guardianOf ?? []) list.push(toProfile((g as any).member, "child"));
      _profilesCache = list;
      return list;
    })
    .catch(() => [] as AthleteProfile[]);
  return _profilesPromise;
}

/** All athlete profiles this account manages (self + linked children). */
export function useAthleteProfiles(): { profiles: AthleteProfile[]; loaded: boolean } {
  const [profiles, setProfiles] = useState<AthleteProfile[]>(_profilesCache ?? []);
  const [loaded, setLoaded] = useState(_profilesCache !== null);
  useEffect(() => {
    let alive = true;
    fetchProfiles().then((list) => {
      if (!alive) return;
      setProfiles(list);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { profiles, loaded };
}

/** Active-profile id synced with lib/activeProfile (shared with the chips). */
export function useActiveAthlete(profiles: AthleteProfile[]): [string | null, (id: string) => void] {
  const [activeId, setActiveId] = useState<string | null>(getActiveProfileId());
  useEffect(() => {
    if (!profiles.length) return;
    const resolved = resolveActiveProfileId(profiles.map((p) => p.id));
    setActiveId(resolved);
    if (resolved && resolved !== getActiveProfileId()) setActiveProfileId(resolved);
  }, [profiles]);
  useEffect(() => onActiveProfileChange(setActiveId), []);
  return [activeId, setActiveProfileId];
}

function defaultSub(p: AthleteProfile): string {
  const bits: string[] = [];
  if (p.kind === "self") {
    if (p.membershipName) bits.push(p.membershipName);
  } else {
    if (p.age != null) bits.push(`age ${p.age}`);
    if (p.hasOwnLogin) bits.push("own login");
  }
  bits.push(`${p.upcoming} upcoming`);
  return bits.slice(0, 2).join(" · ");
}

/**
 * Desktop sticky left rail of selectable athletes (2a–2d). Hidden under
 * `md`; the mobile equivalent stays the existing ProfileSwitcher chips.
 * Selection writes to the same active-profile store, so rail + chips +
 * every page stay in sync.
 */
export default function AthleteRail({
  label = "Managing",
  footer,
  sub,
  activeId,
  onSelect,
  className = "",
}: {
  label?: string;
  footer?: ReactNode;
  /** Per-athlete subtitle override; defaults to plan/age/upcoming. */
  sub?: (p: AthleteProfile) => ReactNode;
  activeId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  const { profiles } = useAthleteProfiles();
  const [storeActive, storeSelect] = useActiveAthlete(profiles);
  const active = activeId !== undefined ? activeId : storeActive;
  const select = onSelect ?? storeSelect;

  if (profiles.length < 2) return null;

  return (
    <aside className={`hidden md:flex flex-col gap-1.5 md:sticky md:top-20 self-start w-full ${className}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-stone-400 px-1.5 mb-0.5">{label}</p>
      {profiles.map((p) => {
        const on = p.id === active;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => select(p.id)}
            aria-pressed={on}
            aria-label={`Switch to ${p.name}`}
            className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)] ${
              on ? "" : "border-transparent hover:bg-stone-50"
            }`}
            style={on ? { background: "var(--club-accent-soft)", borderColor: "var(--club-accent-ring)" } : {}}
          >
            <Avatar name={p.name} size={34} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-stone-900 leading-tight">
                <span className="truncate">{p.name}</span>
                {p.kind === "self" && <Pill tone="accent" className="!px-1.5 !py-0">You</Pill>}
              </span>
              <span className="block text-[11px] text-stone-500 mt-0.5 truncate">
                {sub ? sub(p) : defaultSub(p)}
              </span>
            </span>
          </button>
        );
      })}
      {footer && (
        <div className="mt-3 p-3 rounded-xl bg-stone-50 border border-stone-200 text-[11px] text-stone-500">
          {footer}
        </div>
      )}
    </aside>
  );
}
