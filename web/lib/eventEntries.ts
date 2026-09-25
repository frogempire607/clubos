// B16 slice 3 — multiple entries per athlete. PURE: no prisma, no IO.
//
// One registration, one payment, one approval — with one or more ENTRIES.
// Each entry is a spot on the roster (when the event has one) plus the
// answers to the questions the owner marked "ask for each entry". Adding an
// entry is never the same as adding an athlete: a sibling is a separate
// registration chosen in the athlete picker (decided 2026-09-24).

import { validateFormResponses, type EventFormField, type FormAnswers } from "@/lib/eventForm";

export type EntryRules = {
  allowMultipleEntries: boolean;
  maxEntries: number | null;
  allowSameRosterTwice: boolean;
  entriesOnPublicLink: boolean;
};

export const DEFAULT_MAX_ENTRIES = 5;

/** How many entries this channel may take. */
export function maxEntriesFor(rules: EntryRules, channel: "PUBLIC" | "PORTAL"): number {
  if (!rules.allowMultipleEntries) return 1;
  if (channel === "PUBLIC" && !rules.entriesOnPublicLink) return 1;
  return Math.max(1, Math.min(rules.maxEntries ?? DEFAULT_MAX_ENTRIES, 20));
}

export type EntryInput = { rosterId?: string | null; positionId?: string | null; answers?: unknown };
export type CheckedEntry = { rosterId: string | null; positionId: string | null; answers: FormAnswers };

export type EntriesCheck =
  | { ok: true; entries: CheckedEntry[] }
  | { ok: false; code: "ENTRIES_REQUIRED" | "TOO_MANY_ENTRIES" | "SAME_SPOT" | "SAME_ROSTER" | "ENTRY_INVALID"; message: string; index?: number };

/**
 * Validate what a family sent. `entries` may be empty only when the event
 * needs none (no roster, no per-entry questions) — then there is nothing to
 * store and [] comes back.
 */
export function checkEntries(args: {
  entries: EntryInput[] | undefined;
  rules: EntryRules;
  channel: "PUBLIC" | "PORTAL";
  rosterActive: boolean;
  rosterLabel?: (rosterId: string) => string;
  perEntryFields: EventFormField[];
}): EntriesCheck {
  const needsEntries = args.rosterActive || args.perEntryFields.length > 0;
  const given = args.entries ?? [];
  if (!needsEntries) return { ok: true, entries: [] };
  if (given.length === 0) {
    return { ok: false, code: "ENTRIES_REQUIRED", message: args.rosterActive ? "Pick a spot on the roster." : "Answer the entry questions." };
  }
  const max = maxEntriesFor(args.rules, args.channel);
  if (given.length > max) {
    return {
      ok: false,
      code: "TOO_MANY_ENTRIES",
      message: max === 1 ? "This event takes one entry per athlete." : `This event takes up to ${max} entries per athlete.`,
    };
  }
  const out: CheckedEntry[] = [];
  const cells = new Set<string>();
  const rostersUsed = new Set<string>();
  for (const [i, e] of given.entries()) {
    const label = given.length > 1 ? `Entry ${i + 1}: ` : "";
    let rosterId: string | null = null;
    let positionId: string | null = null;
    if (args.rosterActive) {
      rosterId = typeof e.rosterId === "string" && e.rosterId ? e.rosterId : null;
      positionId = typeof e.positionId === "string" && e.positionId ? e.positionId : null;
      if (!rosterId || !positionId) return { ok: false, code: "ENTRIES_REQUIRED", message: `${label}pick a spot on the roster.`, index: i };
      const cell = `${rosterId}|${positionId}`;
      if (cells.has(cell)) return { ok: false, code: "SAME_SPOT", message: `${label}that spot is already one of this athlete's entries.`, index: i };
      if (rostersUsed.has(rosterId) && !args.rules.allowSameRosterTwice) {
        const name = args.rosterLabel?.(rosterId) ?? "That roster";
        return { ok: false, code: "SAME_ROSTER", message: `${label}${name} already has an entry — pick a different roster for each entry.`, index: i };
      }
      cells.add(cell);
      rostersUsed.add(rosterId);
    }
    const answers = validateFormResponses(args.perEntryFields, e.answers);
    if (!answers.ok) return { ok: false, code: "ENTRY_INVALID", message: `${label}${answers.message}`, index: i };
    out.push({ rosterId, positionId, answers: answers.answers });
  }
  return { ok: true, entries: out };
}

/**
 * The price of N entries. `additionalCents` null = every entry costs the event
 * price (2 × $85 = $170); set = the first costs the event price and each one
 * after costs this ($85 + $40). The owner picks per event.
 */
export function entriesTotalCents(unitCents: number, count: number, additionalCents: number | null): number {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return unitCents;
  return unitCents + (n - 1) * (additionalCents ?? unitCents);
}

/** "2 entries × $85.00" or "$85.00 + 1 more at $40.00" — the live line under the form. */
export function entriesPriceLine(unitCents: number, count: number, additionalCents: number | null): string | null {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return null;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const total = money(entriesTotalCents(unitCents, n, additionalCents));
  return additionalCents == null
    ? `${n} entries × ${money(unitCents)} = ${total}`
    : `${money(unitCents)} + ${n - 1} more at ${money(additionalCents)} = ${total}`;
}
