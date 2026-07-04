"use client";

import { Avatar, Pill } from "@/components/member/ui";

export type GuardianEntry = {
  userId: string;
  name: string;
  relationship?: string | null;
  isPrimary: boolean;
  isYou: boolean;
};

function LockIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Who can manage this athlete (2b / 1d "Co-Guardians"). Removal is
 * intentionally absent — only owner/staff can remove a co-guardian, so
 * non-primary rows carry a locked "Staff removes" affordance instead.
 */
export default function GuardianList({ guardians }: { guardians: GuardianEntry[] }) {
  if (!guardians.length) {
    return <p className="text-xs text-stone-400 py-1">No guardians linked yet.</p>;
  }
  return (
    <div>
      {guardians.map((g) => (
        <div key={g.userId} className="flex items-center gap-2.5 py-2.5 border-t border-stone-100 first:border-t-0">
          <Avatar name={g.name} size={32} />
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] font-semibold text-stone-900 flex items-center gap-1.5 flex-wrap">
              <span className="truncate">{g.name}</span>
              {(g.isYou || g.isPrimary) && (
                <Pill tone="accent">
                  {[g.isYou ? "You" : null, g.isPrimary ? "Owner" : null].filter(Boolean).join(" · ")}
                </Pill>
              )}
            </p>
            <p className="text-[11.5px] text-stone-500 truncate">
              {g.isPrimary
                ? "Full access · billing manager"
                : `Co-guardian · books & views${g.relationship ? ` · ${g.relationship}` : ""}`}
            </p>
          </div>
          {!g.isYou && (
            <span title="Only owner/staff can remove">
              <Pill tone="neutral" className="flex-shrink-0">
                <LockIcon /> Staff removes
              </Pill>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
