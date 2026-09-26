"use client";

// B21 — pick which classes / events / memberships / private lesson types a
// base rate or bonus applies to. Same behaviour as the Edit Staff modal's
// picker (moved here): none selected = applies to everything.
import type { Scope, ScopeType } from "@/lib/staffCompensationDraft";

export type Opt = { id: string; name: string };
export type CompOptions = { classes: Opt[]; events: Opt[]; memberships: Opt[]; lessonTypes: Opt[] };

const GROUP_LABEL: Record<ScopeType, string> = {
  CLASS: "Classes",
  EVENT: "Events",
  MEMBERSHIP: "Memberships",
  PRIVATE_LESSON_TYPE: "Private lessons",
};

function scopeOptions(opts: CompOptions, t: ScopeType): Opt[] {
  if (t === "CLASS") return opts.classes;
  if (t === "EVENT") return opts.events;
  if (t === "MEMBERSHIP") return opts.memberships;
  return opts.lessonTypes;
}

export default function ScopePicker({
  allowed,
  opts,
  scopes,
  onChange,
  disabled = false,
}: {
  allowed: ScopeType[];
  opts: CompOptions;
  scopes: Scope[];
  onChange: (s: Scope[]) => void;
  disabled?: boolean;
}) {
  function toggle(scopeType: ScopeType, scopeId: string) {
    const has = scopes.some((s) => s.scopeType === scopeType && s.scopeId === scopeId);
    onChange(
      has ? scopes.filter((s) => !(s.scopeType === scopeType && s.scopeId === scopeId)) : [...scopes, { scopeType, scopeId }],
    );
  }
  const groups = allowed.filter((t) => scopeOptions(opts, t).length > 0);
  return (
    <div className="space-y-2">
      {groups.map((t) => (
        <div key={t}>
          <p className="mb-1 text-[12px] font-medium uppercase tracking-wide text-text-muted">{GROUP_LABEL[t]}</p>
          <div className="flex flex-wrap gap-1.5">
            {scopeOptions(opts, t).map((o) => {
              const active = scopes.some((s) => s.scopeType === t && s.scopeId === o.id);
              return (
                <button
                  type="button"
                  key={o.id}
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => toggle(t, o.id)}
                  className={`min-h-[44px] rounded-md border px-2.5 text-[12.5px] md:min-h-[30px] disabled:cursor-not-allowed ${
                    active ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
                  }`}
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[12px] text-text-muted">
        {groups.length === 0 ? "Nothing to pick from yet — applies to everything." : "Leave all unselected to apply club-wide — to everything this staff member is tied to."}
      </p>
    </div>
  );
}
