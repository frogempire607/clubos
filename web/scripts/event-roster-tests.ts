/**
 * B16 — lib/eventRoster. Pure; `npm run test:event-roster`.
 * Worked example: a duals tournament, rosters K4 / K6 / K8, weights as positions.
 */
import {
  validateRosterDef, holdsCell, rostersNamedInLabel, offeredIn, takenByCell, decidePick, availability, buildGrid, gridTable, cellKey, rosterActive,
  type RosterColumn, type RosterRow, type GridEntry,
} from "../lib/eventRoster";
import { checkEntries, entriesTotalCents, entriesPriceLine, maxEntriesFor, type EntryRules } from "../lib/eventEntries";
import { eventFormFields } from "../lib/eventForm";
import { planReprice, grossExpectedAmount } from "../lib/eventRepricing";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const now = new Date("2026-10-01T12:00:00Z");
const rosters: RosterColumn[] = [{ id: "k4", label: "K4", sortOrder: 0 }, { id: "k6", label: "K6", sortOrder: 1 }, { id: "k8", label: "K8", sortOrder: 2 }];
const positions: RosterRow[] = [{ id: "w60", label: "60", capacity: 1, sortOrder: 0 }, { id: "w64", label: "64", capacity: 1, sortOrder: 1 }, { id: "wopen", label: "Open", capacity: null, sortOrder: 2 }];
const reg = (status: string, approvalStatus: string | null, minsAgo = 60) => ({ status, approvalStatus, createdAt: new Date(now.getTime() - minsAgo * 60_000) });
let n = 0;
const entry = (rosterId: string, positionId: string, r: ReturnType<typeof reg>, status = "ACTIVE", name = `A${++n}`): GridEntry => ({
  id: `e${n}`, registrationId: `r${n}`, rosterId, positionId, status, registration: r, name, memberId: null, confirmationCode: null,
});

console.log("definition:");
{
  const ok = validateRosterDef({ rosters: [{ label: " K4 " }, { label: "" }, { label: "K6" }], positions: [{ label: "60", capacity: 1 }, { label: "64", capacity: null }] });
  check("trims, drops blank rows", ok.ok && ok.def.rosters.length === 2 && ok.def.rosters[0].label === "K4");
  check("duplicate roster names refused", !validateRosterDef({ rosters: [{ label: "K4" }, { label: "k4" }], positions: [{ label: "60" }] }).ok);
  check("capacity must be 1+ whole", !validateRosterDef({ rosters: [{ label: "K4" }], positions: [{ label: "60", capacity: 0 }] }).ok);
  check("blank capacity = no limit", (() => { const r = validateRosterDef({ rosters: [{ label: "K4" }], positions: [{ label: "60", capacity: null }] }); return r.ok && r.def.positions[0].capacity === null; })());
  check("rosters without positions refused", !validateRosterDef({ rosters: [{ label: "K4" }], positions: [] }).ok);
  check("both empty = roster off, allowed", validateRosterDef({ rosters: [], positions: [] }).ok);
  check("rosterActive needs both", rosterActive([1], [1]) && !rosterActive([1], []));
}

console.log("\nwho holds a cell:");
{
  const o = { holdSpotDuringReview: false, now };
  check("paid holds", holdsCell(reg("PAID", null), o));
  check("approved holds", holdsCell(reg("SCHEDULED", "APPROVED"), o));
  check("pending coach review does NOT hold (coach chooses)", !holdsCell(reg("PENDING_REVIEW", "PENDING"), o));
  check("pending cash request does NOT hold either", !holdsCell(reg("AWAITING_CASH", "PENDING"), o));
  check("pending holds when holdSpotDuringReview", holdsCell(reg("PENDING_REVIEW", "PENDING"), { ...o, holdSpotDuringReview: true }));
  check("fresh card checkout holds", holdsCell(reg("PENDING_PAYMENT", null, 5), o));
  check("abandoned checkout releases", !holdsCell(reg("PENDING_PAYMENT", null, 45), o));
  check("canceled / declined never hold", !holdsCell(reg("CANCELED", null), o) && !holdsCell(reg("REGISTERED", "DECLINED"), o));
}

console.log("\npicking a spot:");
{
  const entries = [entry("k6", "w60", reg("SCHEDULED", "APPROVED")), entry("k6", "w64", reg("PENDING_REVIEW", "PENDING"))];
  const taken = takenByCell(entries, { holdSpotDuringReview: false, now });
  check("taken counts the approved one only", taken.get(cellKey("k6", "w60")) === 1 && !taken.get(cellKey("k6", "w64")));
  check("60/K4 is a different spot from 60/K6", decidePick({ pick: { rosterId: "k4", positionId: "w60" }, rosters, positions, taken, approvalGated: false }).ok);
  const gated = decidePick({ pick: { rosterId: "k6", positionId: "w60" }, rosters, positions, taken, approvalGated: true });
  check("full + coach reviews ⇒ waitlist", gated.ok && gated.status === "WAITLIST");
  const open = decidePick({ pick: { rosterId: "k6", positionId: "w60" }, rosters, positions, taken, approvalGated: false });
  check("full + confirm-on-signup ⇒ refused, names the spot", !open.ok && open.code === "SPOT_FULL" && open.message.includes("60 · K6"));
  check("unlimited position never fills", decidePick({ pick: { rosterId: "k6", positionId: "wopen" }, rosters, positions, taken: new Map([[cellKey("k6", "wopen"), 99]]), approvalGated: false }).ok);
  check("unknown spot refused", !decidePick({ pick: { rosterId: "k9", positionId: "w60" }, rosters, positions, taken, approvalGated: true }).ok);
  const excluded = takenByCell(entries, { holdSpotDuringReview: false, now, excludeRegistrationId: entries[0].registrationId });
  check("a registration is re-checked against everyone else", !excluded.get(cellKey("k6", "w60")));
  const av = availability(rosters, positions, taken);
  const cell = av.find((c) => c.rosterId === "k6" && c.positionId === "w60")!;
  check("availability: numbers, no names", cell.open === 0 && cell.taken === 1 && !("people" in cell));
  check("availability: unlimited shows open null", av.find((c) => c.positionId === "wopen")!.open === null);
}

console.log("\nthe coach's grid:");
{
  n = 0;
  const entries = [
    entry("k6", "w60", reg("SCHEDULED", "APPROVED"), "ACTIVE", "Titus Hall"),
    entry("k6", "w60", reg("PENDING_REVIEW", "PENDING"), "ACTIVE", "Bo Adams"),
    entry("k6", "w60", reg("PENDING_REVIEW", "PENDING"), "WAITLIST", "Cy Park"),
    entry("k8", "w64", reg("CANCELED", null), "ACTIVE", "Gone Kid"),
    entry("k4", "w64", reg("PENDING_PAYMENT", null, 45), "ACTIVE", "Abandoned"),
    entry("gone", "w60", reg("PAID", null), "ACTIVE", "Orphan"),
  ];
  const g = buildGrid({ rosters, positions, entries, holdSpotDuringReview: false, now });
  const cell = g.rows[0].cells[1];
  check("columns in roster order", g.columns.map((c) => c.label).join() === "K4,K6,K8");
  check("confirmed first, then pending", cell.people.map((p) => p.name).join() === "Titus Hall,Bo Adams" && cell.people[1].state === "pending");
  check("waitlist listed under the grid, not in the cell", g.waitlist.length === 1 && g.waitlist[0].name === "Cy Park" && g.waitlist[0].positionLabel === "60");
  check("canceled and abandoned checkouts left off", !JSON.stringify(g).includes("Gone Kid") && !JSON.stringify(g).includes("Abandoned"));
  check("removed roster ⇒ unplaced, not lost", g.unplaced.length === 1 && g.unplaced[0].name === "Orphan");
  check("counts", g.counts.confirmed === 1 && g.counts.pending === 1 && g.counts.waitlist === 1);
  const t = gridTable(g);
  check("table: header row is the rosters", t.headers.join("|") === "|K4|K6|K8");
  check("table: capacity shown on the position", t.rows[0][0] === "60 (1)" && t.rows[2][0] === "Open");
  check("table: pending marked", t.rows[0][2] === "Titus Hall\nBo Adams (pending)");
  check("table: waitlist rows", t.waitlistRows[0].join("|") === "60|K6|Cy Park");
}

console.log("\nmultiple entries (slice 3):");
{
  const off: EntryRules = { allowMultipleEntries: false, maxEntries: null, allowSameRosterTwice: false, entriesOnPublicLink: false };
  const on: EntryRules = { ...off, allowMultipleEntries: true, maxEntries: 3 };
  check("off ⇒ one entry anywhere", maxEntriesFor(off, "PORTAL") === 1 && maxEntriesFor(off, "PUBLIC") === 1);
  check("on ⇒ the max in the portal", maxEntriesFor(on, "PORTAL") === 3);
  check("on, public link not allowed ⇒ one on the link", maxEntriesFor(on, "PUBLIC") === 1);
  check("on + public allowed ⇒ the max on the link", maxEntriesFor({ ...on, entriesOnPublicLink: true }, "PUBLIC") === 3);
  check("no max set ⇒ 5", maxEntriesFor({ ...on, maxEntries: null }, "PORTAL") === 5);

  const perEntry = eventFormFields([{ id: "notes", type: "text", label: "Seed notes", required: true, perEntry: true }]);
  const base = { rules: on, channel: "PORTAL" as const, rosterActive: true, rosterLabel: (id: string) => id.toUpperCase(), perEntryFields: [] as typeof perEntry };
  check("roster event with no entries ⇒ pick a spot", (() => { const r = checkEntries({ ...base, entries: [] }); return !r.ok && r.code === "ENTRIES_REQUIRED"; })());
  check("two entries, two rosters ⇒ ok", checkEntries({ ...base, entries: [{ rosterId: "k6", positionId: "w60" }, { rosterId: "k8", positionId: "w64" }] }).ok);
  const same = checkEntries({ ...base, entries: [{ rosterId: "k6", positionId: "w60" }, { rosterId: "k6", positionId: "w64" }] });
  check("same roster twice refused by default, names it", !same.ok && same.code === "SAME_ROSTER" && same.message.includes("Entry 2") && same.message.includes("K6"));
  check("same roster twice allowed when the owner allows it", checkEntries({ ...base, rules: { ...on, allowSameRosterTwice: true }, entries: [{ rosterId: "k6", positionId: "w60" }, { rosterId: "k6", positionId: "w64" }] }).ok);
  const dup = checkEntries({ ...base, rules: { ...on, allowSameRosterTwice: true }, entries: [{ rosterId: "k6", positionId: "w60" }, { rosterId: "k6", positionId: "w60" }] });
  check("the exact same spot twice is always refused", !dup.ok && dup.code === "SAME_SPOT");
  const tooMany = checkEntries({ ...base, entries: [{ rosterId: "k4", positionId: "w60" }, { rosterId: "k6", positionId: "w60" }, { rosterId: "k8", positionId: "w60" }, { rosterId: "k9", positionId: "w60" }] });
  check("over the max refused", !tooMany.ok && tooMany.code === "TOO_MANY_ENTRIES" && tooMany.message.includes("3"));
  check("public link without extra entries: 2 refused", !checkEntries({ ...base, channel: "PUBLIC", entries: [{ rosterId: "k6", positionId: "w60" }, { rosterId: "k8", positionId: "w64" }] }).ok);
  const q = checkEntries({ ...base, rosterActive: false, perEntryFields: perEntry, entries: [{ answers: { notes: "top seed" } }, { answers: {} }] });
  check("per-entry question required on every entry", !q.ok && q.code === "ENTRY_INVALID" && q.message.startsWith("Entry 2"));
  const q2 = checkEntries({ ...base, rosterActive: false, perEntryFields: perEntry, entries: [{ answers: { notes: " a ", junk: "x" } }] });
  check("per-entry answers trimmed, unknown keys dropped", q2.ok && q2.entries[0].answers.notes === "a" && !("junk" in q2.entries[0].answers));
  check("event with no roster and no per-entry questions needs no entries", (() => { const r = checkEntries({ ...base, rosterActive: false, entries: undefined }); return r.ok && r.entries.length === 0; })());

  check("price: 2 × $85 = $170", entriesTotalCents(8500, 2, null) === 17000);
  check("price: $85 + 2 more at $40 = $165", entriesTotalCents(8500, 3, 4000) === 16500);
  check("price: one entry is the event price", entriesTotalCents(8500, 1, 4000) === 8500);
  check("line: same price", entriesPriceLine(8500, 2, null) === "2 entries × $85.00 = $170.00");
  check("line: extra price", entriesPriceLine(8500, 2, 4000) === "$85.00 + 1 more at $40.00 = $125.00");
  check("line: none for one entry", entriesPriceLine(8500, 1, null) === null);
}

console.log("\nrepricing knows about entries:");
{
  const ev = { memberPrice: 85, nonMemberPrice: 85, additionalEntryPrice: null };
  check("expected: 2 entries at $85 = $170", grossExpectedAmount(ev, 1, { memberId: "m", entryCount: 2 }) === 170);
  check("expected: extra entries at $40", grossExpectedAmount({ ...ev, additionalEntryPrice: "40.00" }, 1, { memberId: "m", entryCount: 3 }) === 165);
  const plan = planReprice(ev, [{ id: "r1", memberId: "m", status: "SCHEDULED", amountDue: "170.00", entryCount: 2 }]);
  check("a 2-entry $170 row is NOT flagged as stale", plan.changed.length === 0, plan.rows);
  const plan2 = planReprice({ ...ev, memberPrice: 90, nonMemberPrice: 90 }, [{ id: "r1", memberId: "m", status: "AWAITING_CASH", amountDue: "170.00", entryCount: 2 }]);
  check("price moves to $90 ⇒ expected $180 for 2 entries", plan2.rows[0].expected === 180);
}

console.log("\npositions only in some rosters:");
{
  const labels = ["K4", "K6", "K8"];
  check("'40 (K4 only)' ⇒ K4", JSON.stringify(rostersNamedInLabel("40 (K4 only)", labels)) === '["K4"]');
  check("'52 (K4/K6)' ⇒ K4, K6", JSON.stringify(rostersNamedInLabel("52 (K4/K6)", labels)) === '["K4","K6"]');
  check("'72' ⇒ every roster", rostersNamedInLabel("72", labels).length === 0);
  check("'Open (anyone)' ⇒ every roster (words that aren't rosters)", rostersNamedInLabel("Open (anyone)", labels).length === 0);
  check("case-insensitive", JSON.stringify(rostersNamedInLabel("84 (k8 only)", labels)) === '["K8"]');
  const def = validateRosterDef({ rosters: [{ label: "K4" }, { label: "K6" }], positions: [{ label: "40", rosters: ["k4"] }, { label: "60", rosters: ["K4", "K6"] }] });
  check("definition keeps a restriction, normalizes the label", def.ok && JSON.stringify(def.def.positions[0].rosterLabels) === '["K4"]');
  check("every roster ticked = no restriction", def.ok && def.def.positions[1].rosterLabels.length === 0);
  check("a roster that isn't on the event is refused", !validateRosterDef({ rosters: [{ label: "K4" }], positions: [{ label: "40", rosters: ["K9"] }] }).ok);
  const rs: RosterColumn[] = [{ id: "k4", label: "K4", sortOrder: 0 }, { id: "k6", label: "K6", sortOrder: 1 }];
  const ps: RosterRow[] = [{ id: "w40", label: "40", capacity: null, sortOrder: 0, rosterIds: ["k4"] }, { id: "w60", label: "60", capacity: null, sortOrder: 1 }];
  check("offeredIn", offeredIn(ps[0], "k4") && !offeredIn(ps[0], "k6") && offeredIn(ps[1], "k6"));
  const bad = decidePick({ pick: { rosterId: "k6", positionId: "w40" }, rosters: rs, positions: ps, taken: new Map(), approvalGated: true });
  check("picking 40 in K6 refused, even with a coach", !bad.ok && bad.message.includes("isn't offered in K6"));
  const av = availability(rs, ps, new Map());
  check("families never see 40 under K6", !av.some((c) => c.rosterId === "k6" && c.positionId === "w40") && av.some((c) => c.rosterId === "k4" && c.positionId === "w40"));
  const g = buildGrid({ rosters: rs, positions: ps, entries: [], holdSpotDuringReview: false, now });
  check("grid marks the cell not offered", g.rows[0].cells[1].offered === false && g.rows[0].cells[0].offered === true);
  check("CSV/PDF says n/a there", gridTable(g).rows[0][2] === "n/a");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
