"use client";

export type AccessibleProfile = {
  id: string;
  firstName: string;
  lastName: string;
  kind: "self" | "child";
  isMinor?: boolean;
};

/**
 * Family profile switcher for the member portal. Lets a guardian choose which
 * athlete a purchase/booking is for (self or one of their children). Renders
 * nothing when there's only one profile to act on — so a normal member never
 * sees it.
 */
export default function ProfileSwitcher({
  accessible,
  value,
  onChange,
  label = "Who is this for?",
}: {
  accessible: AccessibleProfile[];
  value: string | null;
  onChange: (memberId: string) => void;
  label?: string;
}) {
  if (!accessible || accessible.length <= 1) return null;
  return (
    <div className="mb-4 rounded-xl border border-stone-200 bg-white p-3">
      <p className="text-xs font-medium text-stone-500 mb-2">{label}</p>
      <div className="flex flex-wrap gap-2">
        {accessible.map((m) => {
          const active = value === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange(m.id)}
              className={`px-3 py-1.5 rounded-full text-sm border transition ${
                active
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-300 text-stone-700 hover:border-stone-400"
              }`}
            >
              {m.firstName} {m.lastName}
              {m.kind === "self" ? " (you)" : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}
