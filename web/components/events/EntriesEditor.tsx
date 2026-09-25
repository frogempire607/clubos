"use client";

// B16 slice 3 — an athlete's entries on the signup form: a roster spot each
// (when the event has a roster) plus the questions the owner marked "ask for
// each entry". "+ Add another entry for {athlete}" always names the athlete,
// so it never reads like adding a different child — siblings are chosen in the
// athlete picker, never here (decided 2026-09-24).

import SpotPicker, { type SignupRoster, type SpotValue } from "@/components/events/SpotPicker";
import type { EventFormField, FormAnswers } from "@/lib/eventForm";
import { entriesPriceLine } from "@/lib/eventEntries";

export type EntryDraft = { spot: SpotValue; answers: FormAnswers };

export const emptyEntry = (): EntryDraft => ({ spot: null, answers: {} });

/** What the server needs, or a message naming the first problem. */
export function entriesPayload(
  drafts: EntryDraft[],
  opts: { roster: SignupRoster | null; perEntryFields: EventFormField[]; allowSameRosterTwice: boolean },
): { ok: true; entries: { rosterId?: string; positionId?: string; answers: FormAnswers }[] } | { ok: false; message: string } {
  if (!opts.roster && opts.perEntryFields.length === 0) return { ok: true, entries: [] };
  const seen = new Set<string>();
  const rostersUsed = new Set<string>();
  const out: { rosterId?: string; positionId?: string; answers: FormAnswers }[] = [];
  for (const [i, d] of drafts.entries()) {
    const label = drafts.length > 1 ? `Entry ${i + 1}: ` : "";
    if (opts.roster) {
      if (!d.spot?.rosterId || !d.spot.positionId) return { ok: false, message: `${label}pick a spot on the roster.` };
      const k = `${d.spot.rosterId}|${d.spot.positionId}`;
      if (seen.has(k)) return { ok: false, message: `${label}that spot is already one of this athlete's entries.` };
      if (rostersUsed.has(d.spot.rosterId) && !opts.allowSameRosterTwice) {
        const name = opts.roster.rosters.find((r) => r.id === d.spot!.rosterId)?.label ?? "That roster";
        return { ok: false, message: `${label}${name} already has an entry — pick a different roster for each entry.` };
      }
      seen.add(k);
      rostersUsed.add(d.spot.rosterId);
    }
    for (const f of opts.perEntryFields) {
      const v = d.answers[f.id];
      if (f.required && (v === undefined || v === "" || v === false)) return { ok: false, message: `${label}"${f.label}" is required.` };
    }
    out.push({ ...(d.spot?.rosterId && d.spot.positionId ? { rosterId: d.spot.rosterId, positionId: d.spot.positionId } : {}), answers: d.answers });
  }
  return { ok: true, entries: out };
}

export default function EntriesEditor({
  value,
  onChange,
  roster,
  perEntryFields,
  maxEntries,
  athleteName,
  approvalGated,
  unitPriceCents,
  additionalCents,
  accent = "#1C1917",
}: {
  value: EntryDraft[];
  onChange: (v: EntryDraft[]) => void;
  roster: SignupRoster | null;
  perEntryFields: EventFormField[];
  maxEntries: number;
  /** "Titus" in the portal; null on the public link ("this athlete"). */
  athleteName: string | null;
  approvalGated: boolean;
  unitPriceCents: number | null;
  additionalCents: number | null;
  accent?: string;
}) {
  const drafts = value.length > 0 ? value : [emptyEntry()];
  const set = (i: number, patch: Partial<EntryDraft>) => onChange(drafts.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const multi = maxEntries > 1;
  const who = athleteName || "this athlete";
  const priceLine = unitPriceCents != null && unitPriceCents > 0 ? entriesPriceLine(unitPriceCents, drafts.length, additionalCents) : null;
  const inputCls = "w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-300";

  if (!roster && perEntryFields.length === 0) return null;

  return (
    <div className="space-y-3">
      {drafts.map((d, i) => (
        <div key={i} className={multi ? "rounded-xl border border-stone-200 p-3 space-y-3" : "space-y-3"}>
          {multi && (
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Entry {i + 1}</span>
              {drafts.length > 1 && (
                <button type="button" onClick={() => onChange(drafts.filter((_, idx) => idx !== i))} className="text-xs text-red-600 min-h-[36px] px-2">
                  Remove
                </button>
              )}
            </div>
          )}
          {roster && <SpotPicker roster={roster} value={d.spot} onChange={(v) => set(i, { spot: v })} approvalGated={approvalGated} accent={accent} />}
          {perEntryFields.map((f) => (
            <div key={f.id}>
              <label className="block text-sm font-medium text-stone-700 mb-1">{f.label}{f.required ? " *" : ""}</label>
              {f.type === "select" ? (
                <select value={(d.answers[f.id] as string) || ""} onChange={(e) => set(i, { answers: { ...d.answers, [f.id]: e.target.value } })} className={inputCls}>
                  <option value="">Select…</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === "checkbox" ? (
                <label className="flex items-center gap-2 text-sm text-stone-700 min-h-[44px]">
                  <input type="checkbox" checked={!!d.answers[f.id]} onChange={(e) => set(i, { answers: { ...d.answers, [f.id]: e.target.checked } })} /> Yes
                </label>
              ) : f.type === "textarea" ? (
                <textarea rows={2} value={(d.answers[f.id] as string) || ""} onChange={(e) => set(i, { answers: { ...d.answers, [f.id]: e.target.value } })} className={inputCls} />
              ) : (
                <input type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"} value={(d.answers[f.id] as string) || ""} onChange={(e) => set(i, { answers: { ...d.answers, [f.id]: e.target.value } })} className={inputCls} />
              )}
            </div>
          ))}
        </div>
      ))}
      {multi && drafts.length < maxEntries && (
        <button
          type="button"
          onClick={() => onChange([...drafts, emptyEntry()])}
          className="w-full min-h-[48px] rounded-xl border-2 border-dashed px-3 py-2 text-left"
          style={{ borderColor: `${accent}55` }}
        >
          <span className="block text-sm font-semibold" style={{ color: accent }}>+ Add another entry for {who}</span>
          <span className="block text-[11px] text-stone-500">Same athlete, another spot (e.g. a second division). Registering a different child is separate.</span>
        </button>
      )}
      {priceLine && <p className="text-sm font-medium text-stone-800 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">{priceLine}</p>}
    </div>
  );
}
