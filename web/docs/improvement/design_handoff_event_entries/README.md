# Handoff: Event entries, roster positions, generic questions (B16)

Decided by Julian 2026-09-24, from the Finger Lakes Duals registration (Titus Hall). Nothing built yet.
Read with `lib/eventForm.ts`, `lib/eventCategories.ts`, `lib/eventApproval.ts`, `components/events/EventEditor.tsx`.

## The problem

- Tournament events ask "which division / which weight" as ordinary dropdowns named after one sport
  (Weight Class, Division, Belt Level chips in the editor). The club can't see the result as a lineup.
- An athlete entering two divisions has to register twice, which the portal can't do (one registration per athlete per
  event) and which, where it is possible (public link), makes two money rows for one family and two approvals for one kid.

## What we're building — three layers

### 1. Signup questions become generic
The editor's sport-named chips are replaced by **question types**: Dropdown, Short answer, Long answer, Checkbox, Date.
The club writes the label. Each question has a scope: **once per registration** or **per entry** (asked again for each
entry). `lib/eventForm` stays the one validator; it learns per-entry answers.

### 2. Roster positions (a separate builder; offered on tournaments, available on any event)
- **Rosters = columns** (club's words: divisions, skill levels, age groups — e.g. K4 / K6 / K8).
- **Positions = rows** (club's words — e.g. 40, 44 … 155).
- **Capacity per cell** (roster × position), blank = unlimited. *Decided: per roster cell.*
- **Full cell ⇒ waitlist**, not a block: the family can still request it; the coach sees them under the grid and
  approves or proposes another spot. *Decided.*
- **Same athlete twice in one roster** (60 and 64 both in K6): **a per-event toggle**. *Decided: coach decides.*
- Families pick a spot from the grid (taken / open / waitlist shown); it replaces the old category dropdowns.
- **Coach view:** the grid with names in the cells, waitlist under it, download **PDF** and **CSV**.

### 3. Multiple entries (umbrella over both)
- Event toggle **"Allow multiple entries per athlete"**, optional max.
- Parent sees **"+ Add another entry for {athlete}"** — always naming the athlete. "Register another athlete" lives
  only in the athlete picker, never beside the entry button, so the two are never confused.
- Each entry repeats the roster pick and the per-entry questions (the roster is always per entry).
- **Price per entry — the coach picks either** *(decided: both available)*: same price each (2 × $85 = $170), or a
  separate additional-entry price ($85, then $40 each). The live line shows the math.
- **One registration, one payment, one approval.** Saved-card consent and the charge date use the total.

## Decisions already made

1. **Approval is for the whole registration.** The coach can propose a change to any part — including moving one entry
   to another spot, or dropping one. (Proposals already exist: `proposeRegistrationChange`.)
2. **Event approval requests also appear in the main Approvals inbox** (`/dashboard/approvals`), not only on the event.
3. **Discounts:** not codes. A 2nd/3rd athlete in the same family, or a team/group, gets the club's discount — this is
   B3 (Phase 9 family & group discounts, spec in `docs/improvement/plan.md`), extended to events. The coach can also
   apply a discount when approving. Frog Empire runs sibling + "Group rate" (same school).
4. **Public link:** multiple entries allowed there too when the coach turns it on for the event.

## Data (one additive migration, written in slice 2)

```
event_rosters          id, eventId, label, sortOrder
event_roster_positions id, eventId, label, sortOrder
event_roster_capacity  eventId, rosterId, positionId, capacity   -- only cells with a limit
event_registration_entries
                       id, registrationId, eventId, rosterId NULL, positionId NULL,
                       answers JSONB, status (CONFIRMED | WAITLIST | DROPPED), sortOrder
Event                  + allowMultipleEntries BOOL, maxEntries INT NULL,
                         additionalEntryPrice DECIMAL NULL, allowSameRosterTwice BOOL,
                         entriesOnPublicLink BOOL
```
Cell capacity is enforced in the database write (advisory lock on eventId+rosterId+positionId, same pattern as
`upsertRegistration`), never by the page. EventRegistration stays the money spine: `amountDue` = entries priced by the
rule above; entries carry no money.

Existing events: `participant_category` fields in `registrationForm` convert to a roster + positions only when the
owner clicks "Convert to roster" in the editor — no silent migration of live events (Finger Lakes has registrations).

## Suggested slices

1. **Approvals inbox** shows event PENDING_REVIEW rows (approve / decline / propose from there) + **generic question
   types** in the editor. No migration.
2. **Roster builder + spot picker + coach grid (PDF/CSV)**, single entry. The migration above.
3. **Multiple entries**: toggle, "+ Add another entry", per-entry questions, both pricing rules, public-link toggle,
   proposals that move/drop an entry.
4. **Discounts** via B3 (sibling / group rate), plus "apply a discount" on approve.

## Not in this handoff
Brackets / seeding / results. Team-vs-team dual scoring. Per-entry approval (explicitly not wanted).
