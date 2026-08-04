"use client";

import { Avatar, Pill } from "@/components/member/ui";

// Who can manage this athlete (2b / 1d "Co-Guardians").
//
// ── 4C.4: one vocabulary on both sides ──────────────────────────────────────
// This list used to describe access in prose the data didn't back:
// "Full access · billing manager" for the primary, "Co-guardian · books &
// views" for everyone else. Those strings were hardcoded, so a co-guardian
// whose Pay permission had been turned off by staff still read "books & views",
// and a parent comparing notes with the front desk saw two different
// vocabularies for one thing.
//
// That is precisely the drift that let the Lister family break — staff and
// parent each believing a different control governed access. So the parent side
// now renders the SAME four permissions, with the SAME words, as the staff
// grid: Book · Pay · Waivers · Emails.
//
// Removal stays absent by design: only owner/staff can remove a co-guardian.

export type GuardianEntry = {
  linkId?: string;
  userId: string;
  name: string;
  relationship?: string | null;
  isPrimary: boolean;
  isYou: boolean;
  canBook?: boolean;
  canPay?: boolean;
  canSignWaivers?: boolean;
  canReceiveEmails?: boolean;
};

const PERMS = [
  { key: "canBook", label: "Book" },
  { key: "canPay", label: "Pay" },
  { key: "canSignWaivers", label: "Waivers" },
  { key: "canReceiveEmails", label: "Emails" },
] as const;

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

export default function GuardianList({
  guardians,
  childName,
  /** Only the primary guardian may change what a CO-guardian can do. */
  canEditAccess = false,
  busy = false,
  onToggle,
}: {
  guardians: GuardianEntry[];
  childName?: string;
  canEditAccess?: boolean;
  busy?: boolean;
  onToggle?: (linkId: string, key: string, next: boolean) => void;
}) {
  if (!guardians.length) {
    return <p className="text-xs text-stone-400 py-1">No guardians linked yet.</p>;
  }
  return (
    <div>
      {guardians.map((g) => {
        // Nobody edits their own access — otherwise a co-guardian promoted to
        // primary could quietly restore anything the previous primary removed.
        // The server enforces this too.
        const editable = canEditAccess && !!g.linkId && !g.isYou && !!onToggle;
        return (
          <div key={g.userId} className="py-2.5 border-t border-stone-100 first:border-t-0">
            <div className="flex items-center gap-2.5">
              <Avatar name={g.name} size={32} />
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] font-semibold text-stone-900 flex items-center gap-1.5 flex-wrap">
                  <span className="truncate">{g.name}</span>
                  {/* "Primary", not "Owner" — Owner is the club-role term. */}
                  {(g.isYou || g.isPrimary) && (
                    <Pill tone="accent">
                      {[g.isYou ? "You" : null, g.isPrimary ? "Primary" : null].filter(Boolean).join(" · ")}
                    </Pill>
                  )}
                </p>
                <p className="text-[11.5px] text-stone-500 truncate">
                  {g.isPrimary
                    ? `Sets the controls for ${childName ?? "this athlete"}`
                    : `Co-guardian${g.relationship ? ` · ${g.relationship}` : ""}`}
                </p>
              </div>
              {!g.isYou && (
                <span title="Only owner/staff can remove a guardian">
                  <Pill tone="neutral" className="flex-shrink-0">
                    <LockIcon /> Staff removes
                  </Pill>
                </span>
              )}
            </div>

            {/* The four permissions — same words the club's staff see. */}
            <div className="mt-1.5 pl-[42px] flex flex-wrap items-center gap-1.5">
              {PERMS.map((p) => {
                const on = g[p.key] !== false; // undefined = allowed, matches the column default
                if (!editable) {
                  return (
                    <span
                      key={p.key}
                      title={on ? `Can ${p.label.toLowerCase()}` : `Cannot ${p.label.toLowerCase()}`}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        on ? "bg-lime-100 text-stone-800" : "bg-stone-100 text-stone-400 line-through"
                      }`}
                    >
                      {p.label}
                    </span>
                  );
                }
                return (
                  <label
                    key={p.key}
                    className="inline-flex items-center gap-1 text-[10px] text-stone-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      onChange={(e) => onToggle!(g.linkId!, p.key, e.target.checked)}
                      className="h-3 w-3"
                    />
                    {p.label}
                  </label>
                );
              })}
              {g.isYou && canEditAccess && (
                <span className="text-[10px] text-stone-400">· your own access is set by the club</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
