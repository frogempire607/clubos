// B16 — roster reads and writes. The rules are in lib/eventRoster (pure);
// this file only gathers rows and writes them.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  availability,
  buildGrid,
  decidePick,
  rosterActive,
  takenByCell,
  cellKey,
  type RosterColumn,
  type RosterRow,
  type RosterDef,
  type SpotPick,
  type PickDecision,
} from "@/lib/eventRoster";

type Db = Prisma.TransactionClient | typeof prisma;

export async function loadRosterDef(eventId: string, db: Db = prisma): Promise<{ rosters: RosterColumn[]; positions: RosterRow[] }> {
  const [rosters, positions] = await Promise.all([
    db.eventRoster.findMany({ where: { eventId }, orderBy: { sortOrder: "asc" }, select: { id: true, label: true, sortOrder: true } }),
    db.eventRosterPosition.findMany({ where: { eventId }, orderBy: { sortOrder: "asc" }, select: { id: true, label: true, capacity: true, sortOrder: true, rosterIds: true } }),
  ]);
  return { rosters, positions };
}

async function loadEntries(eventId: string, db: Db = prisma) {
  return db.eventRegistrationEntry.findMany({
    where: { eventId },
    orderBy: [{ createdAt: "asc" }, { sortOrder: "asc" }],
    select: {
      id: true, registrationId: true, rosterId: true, positionId: true, status: true,
      registration: { select: { name: true, memberId: true, confirmationCode: true, status: true, approvalStatus: true, createdAt: true } },
    },
  });
}

/** Spots taken per cell right now, optionally not counting one registration. */
export async function takenNow(eventId: string, holdSpotDuringReview: boolean, excludeRegistrationId?: string | null, db: Db = prisma) {
  const entries = await loadEntries(eventId, db);
  return takenByCell(entries, { holdSpotDuringReview, now: new Date(), excludeRegistrationId });
}

/** What the public page and the portal show: the grid's labels and open counts. Never names. */
export async function rosterForSignup(eventId: string, holdSpotDuringReview: boolean) {
  const def = await loadRosterDef(eventId);
  if (!rosterActive(def.rosters, def.positions)) return null;
  const taken = await takenNow(eventId, holdSpotDuringReview);
  return {
    rosters: def.rosters.map((r) => ({ id: r.id, label: r.label })),
    positions: def.positions.map((p) => ({ id: p.id, label: p.label, capacity: p.capacity, rosterIds: p.rosterIds })),
    cells: availability(def.rosters, def.positions, taken),
  };
}

/** The coach's grid, with names. Staff-only callers. */
export async function rosterGrid(eventId: string, holdSpotDuringReview: boolean) {
  const def = await loadRosterDef(eventId);
  const entries = await loadEntries(eventId);
  // Signed up before the roster existed (or through a path that doesn't pick):
  // listed under the grid so nobody silently drops off it.
  const withoutSpot = await prisma.eventRegistration.findMany({
    where: { eventId, status: { notIn: ["CANCELED", "PENDING_PAYMENT"] }, NOT: { approvalStatus: "DECLINED" }, entries: { none: {} } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, memberId: true, approvalStatus: true },
  });
  const grid = buildGrid({
    rosters: def.rosters,
    positions: def.positions,
    entries: entries.map((e) => ({
      ...e,
      name: e.registration.name,
      memberId: e.registration.memberId,
      confirmationCode: e.registration.confirmationCode,
    })),
    holdSpotDuringReview,
    now: new Date(),
  });
  for (const r of withoutSpot) {
    grid.unplaced.push({ entryId: `reg:${r.id}`, registrationId: r.id, name: r.name, memberId: r.memberId, state: r.approvalStatus === "PENDING" ? "pending" : "confirmed" });
  }
  return grid;
}

/**
 * Before any registration row is written: is each pick a real spot, and is it
 * open (or, on an approval-gated event, waitlistable)? A refusal here means
 * nothing was created.
 */
export async function checkPicks(args: {
  eventId: string;
  picks: SpotPick[];
  approvalGated: boolean;
  holdSpotDuringReview: boolean;
  excludeRegistrationId?: string | null;
}): Promise<{ ok: true; decisions: PickDecision[] } | { ok: false; code: string; message: string }> {
  const def = await loadRosterDef(args.eventId);
  const taken = await takenNow(args.eventId, args.holdSpotDuringReview, args.excludeRegistrationId);
  const decisions: PickDecision[] = [];
  for (const pick of args.picks) {
    const d = decidePick({ pick, rosters: def.rosters, positions: def.positions, taken, approvalGated: args.approvalGated });
    if (!d.ok) return { ok: false, code: d.code, message: d.message };
    decisions.push(d);
    // Two picks for the same cell in one registration count against each other.
    if (d.status === "ACTIVE") taken.set(cellKey(pick.rosterId, pick.positionId), (taken.get(cellKey(pick.rosterId, pick.positionId)) ?? 0) + 1);
  }
  return { ok: true, decisions };
}

/**
 * Write a registration's entries (replacing any it had). Re-decides each pick
 * under a per-cell advisory lock, so two families racing for the last spot
 * can't both get ACTIVE: the loser becomes WAITLIST (approval-gated) or, on a
 * confirm-on-signup event where checkPicks already passed, WAITLIST too — the
 * rare race lands somewhere the coach can see rather than overfilling a cell.
 */
export type EntryWrite = { rosterId: string | null; positionId: string | null; answers?: Record<string, unknown> };

export async function writeEntries(args: {
  eventId: string;
  clubId: string;
  registrationId: string;
  entries: EntryWrite[];
  approvalGated: boolean;
  holdSpotDuringReview: boolean;
}): Promise<void> {
  if (args.entries.length === 0) return;
  await prisma.$transaction(async (db) => {
    const withCell = args.entries.filter((e): e is EntryWrite & SpotPick => !!e.rosterId && !!e.positionId);
    const keys = Array.from(new Set(withCell.map((p) => cellKey(p.rosterId, p.positionId)))).sort();
    for (const k of keys) {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evcell:${args.eventId}:${k}`}, 0))`;
    }
    const def = await loadRosterDef(args.eventId, db);
    const taken = await takenNow(args.eventId, args.holdSpotDuringReview, args.registrationId, db);
    await db.eventRegistrationEntry.deleteMany({ where: { registrationId: args.registrationId } });
    for (const [i, entry] of args.entries.entries()) {
      let status: "ACTIVE" | "WAITLIST" = "ACTIVE";
      if (entry.rosterId && entry.positionId) {
        const pick = { rosterId: entry.rosterId, positionId: entry.positionId };
        const d = decidePick({ pick, rosters: def.rosters, positions: def.positions, taken, approvalGated: true });
        if (!d.ok) continue; // the spot vanished between check and write — nothing to hold
        status = d.status;
        if (d.status === "ACTIVE") taken.set(cellKey(pick.rosterId, pick.positionId), (taken.get(cellKey(pick.rosterId, pick.positionId)) ?? 0) + 1);
      }
      await db.eventRegistrationEntry.create({
        data: {
          registrationId: args.registrationId,
          eventId: args.eventId,
          clubId: args.clubId,
          rosterId: entry.rosterId,
          positionId: entry.positionId,
          answers: (entry.answers ?? {}) as Prisma.InputJsonValue,
          status,
          sortOrder: i,
        },
      });
    }
  });
}

/**
 * Save the owner's roster definition. Rows keep their ids (entries point at
 * them); removing a roster or position that a live registration is using is
 * refused, like removing a paid-for session.
 */
export async function saveRosterDef(eventId: string, def: RosterDef): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const current = await loadRosterDef(eventId);
  const keepR = new Set(def.rosters.map((r) => r.id).filter((x): x is string => !!x));
  const keepP = new Set(def.positions.map((p) => p.id).filter((x): x is string => !!x));
  const removedR = current.rosters.filter((r) => !keepR.has(r.id));
  const removedP = current.positions.filter((p) => !keepP.has(p.id));
  if (removedR.length || removedP.length) {
    const used = await prisma.eventRegistrationEntry.findMany({
      where: {
        eventId,
        status: { not: "DROPPED" },
        registration: { status: { not: "CANCELED" } },
        OR: [
          ...(removedR.length ? [{ rosterId: { in: removedR.map((r) => r.id) } }] : []),
          ...(removedP.length ? [{ positionId: { in: removedP.map((p) => p.id) } }] : []),
        ],
      },
      select: { rosterId: true, positionId: true },
    });
    if (used.length > 0) {
      const names = [
        ...removedR.filter((r) => used.some((u) => u.rosterId === r.id)).map((r) => r.label),
        ...removedP.filter((p) => used.some((u) => u.positionId === p.id)).map((p) => p.label),
      ];
      return {
        ok: false,
        status: 409,
        error: `${names.join(", ")} ${names.length === 1 ? "has" : "have"} athletes signed up. Move them to another spot (or decline them) before removing it — nothing was saved.`,
      };
    }
  }
  await prisma.$transaction(async (db) => {
    if (removedR.length) await db.eventRoster.deleteMany({ where: { eventId, id: { in: removedR.map((r) => r.id) } } });
    if (removedP.length) await db.eventRosterPosition.deleteMany({ where: { eventId, id: { in: removedP.map((p) => p.id) } } });
    // Rosters first, so positions can point at them by id (a roster added in
    // this same save only gets its id here).
    const idByLabel = new Map<string, string>();
    for (const [i, r] of def.rosters.entries()) {
      const row =
        r.id && current.rosters.some((x) => x.id === r.id)
          ? await db.eventRoster.update({ where: { id: r.id }, data: { label: r.label, sortOrder: i } })
          : await db.eventRoster.create({ data: { eventId, label: r.label, sortOrder: i } });
      idByLabel.set(r.label.toLowerCase(), row.id);
    }
    for (const [i, p] of def.positions.entries()) {
      const rosterIds = p.rosterLabels.map((l) => idByLabel.get(l.toLowerCase())).filter((x): x is string => !!x);
      const data = { label: p.label, capacity: p.capacity, sortOrder: i, rosterIds };
      if (p.id && current.positions.some((x) => x.id === p.id)) await db.eventRosterPosition.update({ where: { id: p.id }, data });
      else await db.eventRosterPosition.create({ data: { eventId, ...data } });
    }
  });
  return { ok: true };
}

/**
 * Approval re-check (called inside approveRegistration's transaction): every
 * spot this registration asked for must still have room among the spots the
 * coach has already given out. Waitlisted entries that fit become ACTIVE when
 * the caller runs `activate()`.
 */
export async function claimSpotsOnApprove(
  db: Prisma.TransactionClient,
  args: { eventId: string; registrationId: string; holdSpotDuringReview: boolean },
): Promise<{ ok: true; activate: () => Promise<unknown> } | { ok: false; message: string }> {
  const mine = await db.eventRegistrationEntry.findMany({
    where: { registrationId: args.registrationId, status: { in: ["ACTIVE", "WAITLIST"] } },
    select: { id: true, rosterId: true, positionId: true, status: true },
  });
  const nothing = async () => undefined;
  if (mine.length === 0) return { ok: true, activate: nothing };
  for (const k of Array.from(new Set(mine.map((m) => cellKey(m.rosterId ?? "", m.positionId ?? "")))).sort()) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evcell:${args.eventId}:${k}`}, 0))`;
  }
  const def = await loadRosterDef(args.eventId, db);
  // Only spots already given out count against this approval — other pending
  // requests are exactly what the coach is choosing between (unless the owner
  // runs first-come holds, holdSpotDuringReview).
  const taken = await takenNow(args.eventId, args.holdSpotDuringReview, args.registrationId, db);
  const full: string[] = [];
  for (const m of mine) {
    if (!m.rosterId || !m.positionId) continue;
    const d = decidePick({ pick: { rosterId: m.rosterId, positionId: m.positionId }, rosters: def.rosters, positions: def.positions, taken, approvalGated: false });
    if (!d.ok) { full.push(d.message.replace(/ Pick (again|another spot)\.$/, "")); continue; }
    taken.set(cellKey(m.rosterId, m.positionId), (taken.get(cellKey(m.rosterId, m.positionId)) ?? 0) + 1);
  }
  if (full.length > 0) {
    return { ok: false, message: `${full.join("; ")}. Propose another spot, or raise that position's capacity, then approve.` };
  }
  // Deferred: the caller runs this only once the approval itself is certain,
  // so a later refusal in the same transaction leaves the entries untouched.
  return {
    ok: true,
    activate: () =>
      db.eventRegistrationEntry.updateMany({ where: { registrationId: args.registrationId, status: "WAITLIST" }, data: { status: "ACTIVE" } }),
  };
}

/**
 * B16 slice 3 — "Build the roster from your dropdowns" also places the people
 * who already registered with those dropdowns. Each registration without a
 * spot whose two answers match a roster and a position (case-insensitive,
 * trimmed) gets that spot, oldest first so capacity goes to whoever asked
 * first. No match ⇒ left alone and listed under "signed up without a spot".
 * Their original answers stay on the registration either way.
 */
export async function backfillEntriesFromAnswers(args: {
  eventId: string;
  clubId: string;
  rosterFieldId: string;
  positionFieldId: string;
  approvalGated: boolean;
  holdSpotDuringReview: boolean;
}): Promise<{ placed: number; unmatched: number }> {
  const def = await loadRosterDef(args.eventId);
  if (!rosterActive(def.rosters, def.positions)) return { placed: 0, unmatched: 0 };
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const rosterByLabel = new Map(def.rosters.map((r) => [r.label.trim().toLowerCase(), r.id]));
  const positionByLabel = new Map(def.positions.map((p) => [p.label.trim().toLowerCase(), p.id]));
  const regs = await prisma.eventRegistration.findMany({
    where: { eventId: args.eventId, status: { not: "CANCELED" }, NOT: { approvalStatus: "DECLINED" }, entries: { none: {} } },
    orderBy: { createdAt: "asc" },
    select: { id: true, formResponses: true },
  });
  let placed = 0;
  let unmatched = 0;
  for (const r of regs) {
    const a = (r.formResponses ?? {}) as Record<string, unknown>;
    const rosterId = rosterByLabel.get(norm(a[args.rosterFieldId]));
    const positionId = positionByLabel.get(norm(a[args.positionFieldId]));
    if (!rosterId || !positionId) { unmatched++; continue; }
    await writeEntries({
      eventId: args.eventId,
      clubId: args.clubId,
      registrationId: r.id,
      entries: [{ rosterId, positionId }],
      approvalGated: args.approvalGated,
      holdSpotDuringReview: args.holdSpotDuringReview,
    });
    placed++;
  }
  return { placed, unmatched };
}

/**
 * B16 slice 3 — attach each registration's live entry count, for the pricing
 * resolver (lib/eventRepricing.grossExpectedAmount). Registrations without
 * entries count as 1.
 */
export async function withEntryCounts<T extends { id: string }>(regs: T[]): Promise<(T & { entryCount: number })[]> {
  if (regs.length === 0) return [];
  const rows = await prisma.eventRegistrationEntry.groupBy({
    by: ["registrationId"],
    where: { registrationId: { in: regs.map((r) => r.id) }, status: { not: "DROPPED" } },
    _count: { _all: true },
  });
  const byId = new Map(rows.map((r) => [r.registrationId, r._count._all]));
  return regs.map((r) => ({ ...r, entryCount: Math.max(1, byId.get(r.id) ?? 1) }));
}
