# Phase 6 — Safety, Data Integrity and Verification

Status as of 2026-09-04. Branch `claude/phase-6-safety-integrity-634dea`.

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
| 8 | Respect owner/administrator/staff/coach/client permissions | **26 → 4**, and the 4 are held on purpose | see below |
| 9 | Loading, empty, success, warning, error states | Pre-existing | `components/EmptyState.tsx`, `LoadingSkeleton.tsx` applied across sections in the 2026-05-30 sweep |
| 10 | Accessibility and keyboard navigation | **Not verified** | no automated a11y check exists; not claimed |
| 11 | Desktop, tablet, mobile layouts | Pre-existing | 2D sweep; not re-verified this phase |

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

Applied 2026-09-04: 22 route files gated, 26 → 4. `scripts/permission-boundary-guard.ts`
now holds the line at 4 and fails the build on any new ungated route.

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

Two need a decision rather than a default:

1. **`classes/[id]/charge` and `events/[id]/charge`** — these take money at the
   door. `billing:full` is the safe reading, but it would stop a coach who
   currently checks people in and takes a drop-in payment. If that is a real
   workflow, `attendance:full` is the alternative.
2. **`announcements`** — `messages:send` lets anyone who can DM broadcast to the
   whole club. If a broadcast should be a higher bar, it wants `messages:full`.

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
| CSV imports with duplicate and malformed records | — | **not built** |
| Mobile and tablet layouts | manual | not re-verified this phase |
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

- **Plaid sandbox flows** — no fixture, no mock. The double-counting rule
  (§6A.6) is enforced by a unique index rather than by a test.
- **CSV import with duplicate and malformed records** — the import path has
  `@@unique([clubId, dedupeHash])` and a `parseFlexibleDate`, but nothing
  exercises a malformed file end to end.
- ~~Permission boundaries are checked statically~~ — **closed 2026-09-04.**
  `scripts/permission-behaviour-tests.ts` calls the real exported handlers with
  a stubbed session and asserts the status that comes back. Sal with
  `finances:none` getting a 403 on the expenses DELETE is now a measured fact.
- **Accessibility and keyboard navigation** — no automated check. Not claimed.
- **Mobile/tablet** — not re-verified this phase.

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
