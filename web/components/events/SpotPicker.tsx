"use client";

// B16 — a family picks one spot on the event's roster: a roster (the club's
// column, e.g. a division) then a position (the row, e.g. a weight). Shows
// what's open; never who took it. Used by the public event page and the
// member portal, so both read the same way.

export type SignupRoster = {
  rosters: { id: string; label: string }[];
  positions: { id: string; label: string; capacity: number | null }[];
  cells: { rosterId: string; positionId: string; capacity: number | null; taken: number; open: number | null }[];
};

export type SpotValue = { rosterId: string; positionId: string } | null;

export default function SpotPicker({
  roster,
  value,
  onChange,
  approvalGated,
  accent = "#1C1917",
}: {
  roster: SignupRoster;
  value: SpotValue;
  onChange: (v: SpotValue) => void;
  /** Full spots can still be requested (waitlist) when a coach reviews signups. */
  approvalGated: boolean;
  accent?: string;
}) {
  const rosterId = value?.rosterId ?? (roster.rosters.length === 1 ? roster.rosters[0].id : "");
  const cell = (pid: string) => roster.cells.find((c) => c.rosterId === rosterId && c.positionId === pid);

  return (
    <div className="space-y-3">
      {roster.rosters.length > 1 && (
        <div>
          <p className="block text-sm font-medium text-stone-700 mb-1.5">Roster *</p>
          <div className="flex flex-wrap gap-2">
            {roster.rosters.map((r) => {
              const on = r.id === rosterId;
              return (
                <button
                  key={r.id}
                  type="button"
                  // Switching roster clears the spot: "60" in K4 is a different
                  // spot from "60" in K6. positionId "" = roster chosen, spot not yet.
                  onClick={() => { if (!on) onChange({ rosterId: r.id, positionId: "" }); }}
                  className="min-h-[44px] px-4 rounded-lg border text-sm font-medium"
                  style={on ? { borderColor: accent, background: `${accent}14`, color: accent } : { borderColor: "#D6D3D1", color: "#44403C" }}
                  aria-pressed={on}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {rosterId && (
        <div>
          <p className="block text-sm font-medium text-stone-700 mb-1.5">
            Spot{roster.rosters.length > 1 ? ` in ${roster.rosters.find((r) => r.id === rosterId)?.label ?? ""}` : ""} *
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {roster.positions.map((p) => {
              const c = cell(p.id);
              const full = c?.open === 0;
              const disabled = full && !approvalGated;
              const on = value?.rosterId === rosterId && value?.positionId === p.id;
              const note = c?.open == null ? "Open" : full ? (approvalGated ? "Full — waitlist" : "Full") : `${c.open} left`;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ rosterId, positionId: p.id })}
                  className="min-h-[52px] px-3 py-2 rounded-lg border text-left disabled:opacity-40 disabled:cursor-not-allowed"
                  style={on ? { borderColor: accent, background: `${accent}14` } : { borderColor: "#D6D3D1" }}
                  aria-pressed={on}
                >
                  <span className="block text-sm font-medium text-stone-900">{p.label}</span>
                  <span className={`block text-[11px] ${full ? "text-amber-700" : "text-stone-500"}`}>{note}</span>
                </button>
              );
            })}
          </div>
          {value?.positionId && cell(value.positionId)?.open === 0 && approvalGated && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
              That spot is full. You can still ask for it — you&apos;ll be on the waitlist and the coach decides.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
