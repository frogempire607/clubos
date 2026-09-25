// B16 — the coach's roster grid. PURE: no prisma, no IO.
//
// Rosters are the grid's COLUMNS (the club's words: divisions, skill levels,
// age groups…). Positions are its ROWS (weights, positions, belts…). A cell is
// one position inside one roster, and a position's capacity applies to each
// cell separately (decided 2026-09-24: 60 in K6 and 60 in K8 are two spots).
//
// A registration asks for spots through ENTRIES. Entries carry no money — the
// registration stays the money spine — and whether an entry holds its cell is
// read off the registration it belongs to, with the same rule event capacity
// already uses (lib/eventPayments.capacityWhere): paid / scheduled / offline /
// registered rows hold; an in-flight card checkout holds for its window; a row
// awaiting a coach holds only when the owner turned on holdSpotDuringReview.
// So on an approval-gated event the coach decides who fills a cell, and
// approving re-checks it.

import { ACTIVE_REGISTRATION_STATUSES, CHECKOUT_HOLD_MS } from "@/lib/eventPayments";

export type RosterColumn = { id: string; label: string; sortOrder: number };
export type RosterRow = {
  id: string;
  label: string;
  capacity: number | null;
  sortOrder: number;
  /** Rosters this position is offered in; empty/absent = every roster. */
  rosterIds?: string[];
};

/** Is this position a spot in that roster? (e.g. "40" only in K4.) */
export function offeredIn(position: Pick<RosterRow, "rosterIds">, rosterId: string): boolean {
  return !position.rosterIds || position.rosterIds.length === 0 || position.rosterIds.includes(rosterId);
}

/**
 * Read the rosters a position name already names, e.g. "40 (K4 only)",
 * "52 (K4/K6)", "80 (K6/K8)". Only when EVERY word in the brackets is one of
 * the rosters (ignoring "only"/"and"): anything else returns [] = every
 * roster, so "Open (anyone)" stays open. The owner can change it after.
 */
export function rostersNamedInLabel(label: string, rosterLabels: string[]): string[] {
  const m = label.match(/\(([^)]*)\)/);
  if (!m) return [];
  const known = new Map(rosterLabels.map((r) => [r.trim().toLowerCase(), r]));
  const tokens = m[1]
    .split(/[\/,&+]|\band\b/i)
    .map((t) => t.replace(/\bonly\b/i, "").trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return [];
  const hit = tokens.map((t) => known.get(t));
  if (hit.some((h) => !h)) return [];
  return Array.from(new Set(hit as string[]));
}

// ── Definition (what the owner edits) ────────────────────────────────────────

export type RosterDefInput = {
  rosters: { id?: string | null; label: string }[];
  /** `rosters`: the roster LABELS this position is offered in; empty/absent = all. */
  positions: { id?: string | null; label: string; capacity?: number | null; rosters?: string[] | null }[];
};

export type RosterDef = {
  rosters: { id: string | null; label: string }[];
  positions: { id: string | null; label: string; capacity: number | null; rosterLabels: string[] }[];
};

export const ROSTER_LIMITS = { rosters: 30, positions: 150, label: 60, capacity: 999 } as const;

export function validateRosterDef(input: RosterDefInput): { ok: true; def: RosterDef } | { ok: false; error: string } {
  const rosters: RosterDef["rosters"] = [];
  const positions: RosterDef["positions"] = [];
  if ((input.rosters?.length ?? 0) > ROSTER_LIMITS.rosters) return { ok: false, error: `At most ${ROSTER_LIMITS.rosters} rosters.` };
  if ((input.positions?.length ?? 0) > ROSTER_LIMITS.positions) return { ok: false, error: `At most ${ROSTER_LIMITS.positions} positions.` };
  const seenR = new Set<string>();
  for (const r of input.rosters ?? []) {
    const label = String(r.label ?? "").trim().slice(0, ROSTER_LIMITS.label);
    if (!label) continue; // an empty row in the editor is not a roster
    const k = label.toLowerCase();
    if (seenR.has(k)) return { ok: false, error: `Two rosters are both called "${label}".` };
    seenR.add(k);
    rosters.push({ id: r.id || null, label });
  }
  const seenP = new Set<string>();
  for (const p of input.positions ?? []) {
    const label = String(p.label ?? "").trim().slice(0, ROSTER_LIMITS.label);
    if (!label) continue;
    const k = label.toLowerCase();
    if (seenP.has(k)) return { ok: false, error: `Two positions are both called "${label}".` };
    seenP.add(k);
    let capacity: number | null = null;
    if (p.capacity != null && String(p.capacity) !== "") {
      const n = Number(p.capacity);
      if (!Number.isInteger(n) || n < 1 || n > ROSTER_LIMITS.capacity) {
        return { ok: false, error: `Capacity for "${label}" must be a whole number from 1 to ${ROSTER_LIMITS.capacity}, or blank for no limit.` };
      }
      capacity = n;
    }
    // Labels, not ids: a roster added in the same save has no id yet. Every
    // roster ticked is the same as none ticked (offered everywhere).
    const byLabel = new Map(rosters.map((r) => [r.label.toLowerCase(), r.label]));
    const picked: string[] = [];
    for (const raw of p.rosters ?? []) {
      const hit = byLabel.get(String(raw ?? "").trim().toLowerCase());
      if (!hit) return { ok: false, error: `"${label}" is set to a roster that isn't on this event (${String(raw)}).` };
      if (!picked.includes(hit)) picked.push(hit);
    }
    if (p.rosters && p.rosters.length > 0 && picked.length === 0) {
      return { ok: false, error: `"${label}" isn't offered in any roster.` };
    }
    positions.push({ id: p.id || null, label, capacity, rosterLabels: picked.length === rosters.length ? [] : picked });
  }
  if ((rosters.length === 0) !== (positions.length === 0)) {
    return {
      ok: false,
      error: rosters.length === 0 ? "Add at least one roster (a column), or remove the positions." : "Add at least one position (a row), or remove the rosters.",
    };
  }
  return { ok: true, def: { rosters, positions } };
}

/** True when the event asks families to pick a spot. */
export function rosterActive(rosters: unknown[], positions: unknown[]): boolean {
  return rosters.length > 0 && positions.length > 0;
}

// ── Whether an entry holds its cell ──────────────────────────────────────────

export type HoldingRegistration = {
  status: string;
  approvalStatus: string | null;
  createdAt: Date;
};

/**
 * Mirrors capacityWhere, plus the approval rule: a registration still waiting
 * on the coach holds nothing unless holdSpotDuringReview is on. (Cash/check
 * rows under approval carry an AWAITING_* status, which capacityWhere counts —
 * here the approvalStatus decides first, so a pending request never locks a
 * cell the coach hasn't given out.)
 */
export function holdsCell(reg: HoldingRegistration, opts: { holdSpotDuringReview: boolean; now: Date }): boolean {
  if (reg.status === "CANCELED") return false;
  if (reg.approvalStatus === "DECLINED") return false;
  if (reg.approvalStatus === "PENDING") return opts.holdSpotDuringReview;
  if ((ACTIVE_REGISTRATION_STATUSES as string[]).includes(reg.status)) return true;
  if (reg.status === "PENDING_PAYMENT") return reg.createdAt.getTime() >= opts.now.getTime() - CHECKOUT_HOLD_MS;
  if (reg.status === "PENDING_REVIEW") return opts.holdSpotDuringReview;
  return false;
}

export const cellKey = (rosterId: string, positionId: string) => `${rosterId}|${positionId}`;

export type CountableEntry = {
  rosterId: string | null;
  positionId: string | null;
  status: string; // ACTIVE | WAITLIST | DROPPED
  registrationId: string;
  registration: HoldingRegistration;
};

/** Spots taken per cell. `excludeRegistrationId` lets a registration be re-checked against everyone else. */
export function takenByCell(
  entries: CountableEntry[],
  opts: { holdSpotDuringReview: boolean; now: Date; excludeRegistrationId?: string | null },
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.status !== "ACTIVE" || !e.rosterId || !e.positionId) continue;
    if (opts.excludeRegistrationId && e.registrationId === opts.excludeRegistrationId) continue;
    if (!holdsCell(e.registration, opts)) continue;
    const k = cellKey(e.rosterId, e.positionId);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

// ── A family's pick ─────────────────────────────────────────────────────────

export type SpotPick = { rosterId: string; positionId: string };

export type PickDecision =
  | { ok: true; status: "ACTIVE" | "WAITLIST" }
  | { ok: false; code: "UNKNOWN_SPOT" | "SPOT_FULL"; message: string };

/**
 * What happens to a pick. Approval-gated events waitlist a full cell (the
 * coach sees the request and decides — decided 2026-09-24); events that
 * confirm on signup refuse it, because nobody reviews a waitlist there.
 */
export function decidePick(args: {
  pick: SpotPick;
  rosters: RosterColumn[];
  positions: RosterRow[];
  taken: Map<string, number>;
  approvalGated: boolean;
}): PickDecision {
  const roster = args.rosters.find((r) => r.id === args.pick.rosterId);
  const position = args.positions.find((p) => p.id === args.pick.positionId);
  if (!roster || !position) return { ok: false, code: "UNKNOWN_SPOT", message: "That spot isn't on this event's roster any more. Pick again." };
  if (!offeredIn(position, roster.id)) {
    return { ok: false, code: "UNKNOWN_SPOT", message: `${position.label} isn't offered in ${roster.label}. Pick another spot.` };
  }
  const cap = position.capacity;
  const used = args.taken.get(cellKey(roster.id, position.id)) ?? 0;
  if (cap == null || used < cap) return { ok: true, status: "ACTIVE" };
  if (args.approvalGated) return { ok: true, status: "WAITLIST" };
  return { ok: false, code: "SPOT_FULL", message: `${position.label} · ${roster.label} is full. Pick another spot.` };
}

/** What families see per cell: open count, or null for no limit. Numbers only — never names. */
export function availability(rosters: RosterColumn[], positions: RosterRow[], taken: Map<string, number>) {
  return rosters.flatMap((r) =>
    positions.filter((p) => offeredIn(p, r.id)).map((p) => {
      const used = taken.get(cellKey(r.id, p.id)) ?? 0;
      return { rosterId: r.id, positionId: p.id, capacity: p.capacity, taken: used, open: p.capacity == null ? null : Math.max(0, p.capacity - used) };
    }),
  );
}

// ── The coach's grid ─────────────────────────────────────────────────────────

export type GridEntry = CountableEntry & {
  id: string;
  name: string;
  memberId: string | null;
  confirmationCode: string | null;
};

export type GridPerson = { entryId: string; registrationId: string; name: string; memberId: string | null; state: "confirmed" | "pending" | "waitlist" };

export type Grid = {
  columns: RosterColumn[];
  rows: { position: RosterRow; cells: { rosterId: string; offered: boolean; people: GridPerson[]; taken: number; capacity: number | null }[] }[];
  waitlist: (GridPerson & { rosterLabel: string; positionLabel: string })[];
  /** Entries whose roster or position was removed — shown so nobody silently drops off. */
  unplaced: GridPerson[];
  counts: { confirmed: number; pending: number; waitlist: number };
};

export function buildGrid(args: {
  rosters: RosterColumn[];
  positions: RosterRow[];
  entries: GridEntry[];
  holdSpotDuringReview: boolean;
  now: Date;
}): Grid {
  const rosters = [...args.rosters].sort((a, b) => a.sortOrder - b.sortOrder);
  const positions = [...args.positions].sort((a, b) => a.sortOrder - b.sortOrder);
  const opts = { holdSpotDuringReview: args.holdSpotDuringReview, now: args.now };
  const taken = takenByCell(args.entries, opts);
  const byCell = new Map<string, GridPerson[]>();
  const waitlist: Grid["waitlist"] = [];
  const unplaced: GridPerson[] = [];
  const counts = { confirmed: 0, pending: 0, waitlist: 0 };
  const rosterById = new Map(rosters.map((r) => [r.id, r]));
  const positionById = new Map(positions.map((p) => [p.id, p]));
  for (const e of args.entries) {
    const reg = e.registration;
    if (e.status === "DROPPED" || reg.status === "CANCELED" || reg.approvalStatus === "DECLINED") continue;
    // An abandoned card checkout is not a person on the roster.
    if (reg.status === "PENDING_PAYMENT" && !holdsCell(reg, { holdSpotDuringReview: false, now: args.now })) continue;
    const state: GridPerson["state"] = e.status === "WAITLIST" ? "waitlist" : reg.approvalStatus === "PENDING" ? "pending" : "confirmed";
    const person: GridPerson = { entryId: e.id, registrationId: e.registrationId, name: e.name, memberId: e.memberId, state };
    const r = e.rosterId ? rosterById.get(e.rosterId) : undefined;
    const p = e.positionId ? positionById.get(e.positionId) : undefined;
    if (!r || !p) { unplaced.push(person); continue; }
    counts[state === "waitlist" ? "waitlist" : state]++;
    if (state === "waitlist") { waitlist.push({ ...person, rosterLabel: r.label, positionLabel: p.label }); continue; }
    const k = cellKey(r.id, p.id);
    byCell.set(k, [...(byCell.get(k) ?? []), person]);
  }
  const rank = (x: GridPerson) => (x.state === "confirmed" ? 0 : 1);
  return {
    columns: rosters,
    rows: positions.map((p) => ({
      position: p,
      cells: rosters.map((r) => {
        const k = cellKey(r.id, p.id);
        const people = [...(byCell.get(k) ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
        return { rosterId: r.id, offered: offeredIn(p, r.id), people, taken: taken.get(k) ?? 0, capacity: p.capacity };
      }),
    })),
    waitlist,
    unplaced,
    counts,
  };
}

/** Grid → table rows for CSV / PDF: position down the side, one column per roster. */
export function gridTable(grid: Grid): { headers: string[]; rows: string[][]; waitlistRows: string[][] } {
  const headers = ["", ...grid.columns.map((c) => c.label)];
  const rows = grid.rows.map((row) => [
    row.position.capacity != null ? `${row.position.label} (${row.position.capacity})` : row.position.label,
    ...row.cells.map((c) =>
      !c.offered && c.people.length === 0
        ? "n/a"
        : c.people.map((p) => (p.state === "pending" ? `${p.name} (pending)` : p.name)).join("\n"),
    ),
  ]);
  const waitlistRows = grid.waitlist.map((w) => [w.positionLabel, w.rosterLabel, w.name]);
  return { headers, rows, waitlistRows };
}
