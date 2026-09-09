# Phase 6 — Safety, Data Integrity and Verification

Status: **CLOSED 2026-09-09.** Branch `claude/phase-6-safety-integrity-634dea`.

Phase 6 is a **gate**, not a feature. Most of §6A was already satisfied by
Phases 1–5; the value of this phase is finding the parts that were not, and
leaving behind checks that keep them satisfied without anyone remembering to
look.

---

## §6A — Implementation requirements, audited

| # | Requirement | State | Evidence |
|---|---|---|---|
| 1 | Database transactions where related records change together | **Met** | `members/merge` wraps the whole reassign-and-soft-delete in `$transaction`; import rollback checks dependents in one |
| 2 | Idempotency for imports, payments, event confirmations, email | **Met** | webhook `stripeEventId`; `(sendBatchId, dedupeKey)` partial unique; transfer's conditional `updateMany` claim; `aox-eventreg-<id>-a<attempt>` keys; `@@unique([clubId, dedupeHash])` on imported transactions |
| 3 | Audit logs for categorization, transfers, relationships, imports, merges, staff actions | **Was 4/6 — now 6/6** | see "What this phase closed" |
| 4 | Preserve historical transaction records | **Met, now recorded** | Stripe rows are refused by the delete route; manual deletions now leave an audit row |
| 5 | Do not silently delete or merge member records | **Met** | merge is soft-delete + `members:full` + confirmation-gated; import rollback downgrades to `isHistoricalOnly` when dependents exist |
| 6 | Do not double count Stripe payments and bank deposits | **Met** | `PayoutMatch` with `@@unique([clubId, stripePayoutId])`; §2.5.7 owns the rule |
| 7 | Do not expose one family to another | **Met** | guardian links via `lib/familyAccess`; 26 member-portal routes consult them; the DM route scopes recipient AND subject to `clubId` |
| 8 | Respect owner/administrator/staff/coach/client permissions | **Met — 26 → 0** | see below |
| 9 | Loading, empty, success, warning, error states | Pre-existing | `components/EmptyState.tsx`, `LoadingSkeleton.tsx` applied across sections in the 2026-05-30 sweep |
| 10 | Accessibility and keyboard navigation | **Deferred to §2.5.12** | needs a browser; bundled with the Reports mobile audit |
| 11 | Desktop, tablet, mobile layouts | **Deferred to §2.5.12** | same reason |

### The one that is not met: §6A.8

`middleware.ts` matches `["/dashboard/:path*", "/admin/:path*", "/member/:path*"]`.
**It does not match `/api`.** Middleware decides which pages a staffer can
open, and nothing about which requests they can send. For an API route, the
guard in that route is the entire boundary.

26 staff-facing mutating routes check only that the caller is `OWNER || STAFF`.
They admit every staff member of the club regardless of
`StaffProfile.permissions`. The sharpest case: `/api/expenses/[id]` PATCH and
DELETE are ungated while `DEFAULT_PERMISSIONS.finances` is `"none"` — a coach
explicitly denied finances can edit and delete expenses by calling the API.

This is **not fixed in this phase**, deliberately. Each route needs a permission
key *and* level, and a wrong choice locks real staff out mid-season; "do not
break role permissions" is a standing repo guardrail. The proposed mapping is
below and needs owner approval before it ships.

Applied 2026-09-04 and 09-08: 26 → **0**. `scripts/permission-boundary-guard.ts` is now a
WALL at zero, not a ratchet — the next ungated mutating route is a regression, and
it fails the build.

#### The mapping — approved and applied 2026-09-04, except the two noted

| Route | Verbs | Proposed |
|---|---|---|
| `expenses/[id]` | PATCH, DELETE | `finances:full` |
| `products/[id]/sell` | POST | `finances:edit` |
| `products` | POST | `finances:edit` |
| `members` | POST | `members:edit` |
| `members/import`, `members/import/memberships` | POST | `members:full` |
| `members/[id]/relationships` | POST, DELETE | `members:edit` |
| `members/subscribe` | POST | `billing:full` |
| `members/subscriptions/[subId]` | PATCH, DELETE | `billing:full` |
| `memberships` | POST | `finances:edit` |
| `classes`, `classes/[id]/staff` | POST, DELETE | `classes:edit` |
| `classes/[id]/charge` | POST | `billing:full` |
| `events`, `events/[id]/bookings` | POST, DELETE | `events:edit` |
| `events/[id]/charge` | POST | `billing:full` |
| `event-bundles`, `event-bundles/[id]` | POST, PATCH, DELETE | `events:edit` |
| `documents`, `documents/[id]` | POST, PATCH, DELETE | `documents:edit` |
| `announcements`, `announcements/[id]` | POST, PATCH, DELETE | `messages:send` |
| `messages/dm`, `messages/groups`, `messages/[id]` | POST, DELETE | `messages:send` |
| `club/member-form` | PUT | `members:full` |

Both open questions were settled by the owner:

1. **`classes/[id]/charge`, `events/[id]/charge` → `attendance:full`** (2026-09-08).
   At-the-door charging follows whoever runs the door. Gating on `billing` would
   have stopped a coach mid-session; `DEFAULT_PERMISSIONS.attendance` is already
   `full`, so a fresh coach can take a drop-in and nothing regressed. Live-checked
   because it moves money.
2. **`announcements` → `messages:full`** (2026-09-04). "A DM and a broadcast to
   293 families shouldn't be the same bar." Applied to the whole broadcast path,
   send/schedule/cancel included — raising only create would have left a staffer
   who cannot write an announcement able to send one somebody else drafted. The
   `bulk` sub-scope stays on top, so both gates must pass.

---

## §6B — Testing requirements

| Requirement | How it runs | State |
|---|---|---|
| TypeScript checks | `npx tsc --noEmit` | ✓ clean |
| Linting | `npm run lint` | pre-existing debt only; no new errors |
| Production build | `npm run build` | ✓ and now **gated** by two guards |
| Existing automated tests | `test:phase4`, `test:phase45`, `test:phase5`, `test:membership-options` (135), `test:members-guards` | ✓ green |
| Targeted tests for new behavior | `test:phase6` | ✓ new |
| Stripe test-mode flows | manual; `scripts/browser-autopay.ts` and friends drive the local rig | partial — see gaps |
| Plaid sandbox / mocked transactions | — | **not built** |
| CSV imports with duplicate and malformed records | `test:import-integrity` (59) | ✓ — and it found a live bug |
| Mobile and tablet layouts | — | **deferred to §2.5.12** |
| Permission boundaries | `test:permission-boundary` (static) + `test:permission-behaviour` (18 real handler calls) | ✓ |

### `npm run test:phase6`

```
test:subscription-truth    4 source guards, ratcheted
test:permission-boundary   staff-facing mutating routes vs permissions
test:non-renewal           10 cases over planNonRenewal
```

Both guards also gate `npm run build`, which is the only enforcement point that
exists in this repo — there is no CI, and Netlify runs `npm run build` and
nothing else.

### Honest gaps in §6B

These are **not done** and should not be read as done:

- ~~Plaid sandbox flows~~ — **closed 2026-09-08.**
  `scripts/bank-reconciliation-tests.ts`, 30 assertions over the pure
  classifiers. Mocked rows rather than the sandbox: what can go wrong here is
  arithmetic on rows once they arrive, not whether Plaid returns them. It found
  a real bug — `detectTransferPairs` matched one credit against every
  same-size debit, so a genuine expense on a third account was erased.
- ~~CSV import with duplicate and malformed records~~ — **closed 2026-09-08.**
  `scripts/import-integrity-tests.ts`, 59 assertions. It found a real bug on the
  first run: BOTH date parsers rolled over instead of refusing, so `13/01/2026`
  imported as 2027-01-01 and `02/31` as March 2nd. Fixed in the same commit.
- ~~Permission boundaries are checked statically~~ — **closed 2026-09-04.**
  `scripts/permission-behaviour-tests.ts` calls the real exported handlers with
  a stubbed session and asserts the status that comes back. Sal with
  `finances:none` getting a 403 on the expenses DELETE is now a measured fact.
- **Accessibility and mobile/tablet** — moved to §2.5.12 (owner decision,
  2026-09-09). Both need a browser rather than a test file, and §2.5.12 is
  already the Reports mobile + responsive audit. Holding Phase 6 open for them
  would keep a closed gate looking open.

---

## What this phase closed

**The standing checks** (`scripts/subscription-truth-guard.ts`,
`scripts/report-subscription-truth.ts`, `scripts/permission-boundary-guard.ts`)
— documented in the 2026-09-03 and 2026-09-04 PROGRESS entries.

**`planNonRenewal` stopped reading `Member.commitmentEndDate`** — the last live
path where a member-level field decided a subscription-level fact, writing to
Stripe as `cancel_at`.

**Three audit-log gaps in §6A.3**, all previously silent:

- `members/merge` → `MEMBERS_MERGED`. A merge moves bookings, signatures,
  messages and relationships between two people and soft-deletes one. The only
  trace was a sentence appended to `notes`.
- `transactions/[id]` PATCH → `TRANSACTION_RECLASSIFIED` /
  `TRANSACTION_REFUND_RECORDED`, with a real before/after. This route moves a
  row between tax categories and legal entities and records refunds.
- `transactions/[id]` DELETE → `TRANSACTION_DELETED`. The row still goes (it is
  the manual-entry escape hatch) but the fact that it existed does not.
- `members/[id]/relationships` POST/DELETE → `RELATIONSHIP_ADDED` /
  `RELATIONSHIP_REMOVED`. A family link decides who can see and book for whom.

---

## Next

1. **Owner decision on the §6A.8 mapping**, then apply it and lower
   `BASELINE` in the guard.
2. Behavioural permission tests — a seeded staff fixture per level, asserting
   403s. That is what turns §6B's permission row from static to real.
3. CSV duplicate/malformed import fixtures.
4. `onPlanWhere()` still has one caller (carried from 2026-09-03).
5. Kellan Lister's `currentPeriodEnd` is stale on a live Stripe row — a
   `stripeSync` question.

---

## Exit summary — closed 2026-09-09

Phase 6 was a verification gate, and the honest finding is that most of §6A was
already satisfied by Phases 1–5. The value was in the parts that were not, and
in what the checks found once they existed.

### Five bugs, every one found by a check rather than by someone noticing

| | |
|---|---|
| `planNonRenewal` read `Member.commitmentEndDate` and wrote it to Stripe as `cancel_at`. One member held two live subscriptions behind a single date; the second would have stopped five months early. | fixed |
| 26 staff-facing mutating API routes admitted any staff member regardless of permissions. `middleware.ts` does not match `/api`. A coach denied finances could edit and delete expenses. | fixed, 26 → 0 |
| Both CSV date parsers rolled over instead of refusing. `13/01/2026` imported as 2027-01-01; `02/31` as March 2nd. On a DOB that moves an age gate. | fixed |
| `detectTransferPairs` matched one credit against every same-size debit, so a genuine expense on a third account was excluded from the cash-flow statement. | fixed |
| `applyParentalControls` was the last gate reading raw `Member.isMinor`, and its select never fetched `dateOfBirth`. Two live minors — ages 4 and 16 — had no parental controls available at all. | fixed |

Four silent mutations gained audit rows: member merge, transaction
reclassification, transaction deletion, relationship changes.

### What guards the build now

`npm run build` runs two source guards before it compiles. There is no CI in
this repo, so the build is the only enforcement point that exists.

- `subscription-truth-guard` — a member-level field answering a
  subscription-level question. Four guards, ratcheted.
- `permission-boundary-guard` — a **wall at zero**. Every staff-facing mutating
  route consults permissions; the next one that does not is a regression.

`npm run test:phase6` = 136 assertions across permission behaviour (28), CSV
import integrity (59), bank reconciliation (30), the parental gate (9) and
non-renewal (10).

Two read-only reports, neither with an `--apply`: `report:subscription-truth`
and `report:rolled-over-dates`. One dry-run correction: `fix:minor-status`.

### What Phase 6 deliberately did not do

- **Accessibility and mobile/tablet** → §2.5.12, with the Reports responsive audit.
- **Full `isMinor` derivation** → Phase 7 dependency. 32 members have no DOB and
  are flagged minor, so the column cannot be dropped until those are collected.
  The cheap 80% — the one gate that was actually wrong — is done.
- **Phase 7's correction scripts** (SELF_GUARDIAN, CHILD_EMAIL, AJ_DUPLICATE,
  ORPHAN_MINORS) — never run against production, and deliberately not run at the
  tail of this phase. Zachary Lawell and Colin LoGalbo are both in Phase 7
  shapes that a flag does not fix.

### Open, carried forward

1. Zachary Lawell — no guardian on record, own login on what looks like a
   parent's email. Needs the Lawells' details before `isMinor` can be set.
2. Five members aged 0–1 — a DOB column holding a join date.
3. Four rollover candidates to check against the original CSV: Maxim Lazarenko,
   Delos Stone, Mack Munroe, Drew Telesky.
4. `onPlanWhere()` still has one caller.
5. Kellan Lister's `currentPeriodEnd` is stale on a live Stripe row.
