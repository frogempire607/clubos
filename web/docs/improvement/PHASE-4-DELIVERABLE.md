# Phase 4 — Client & Family Accounts · Deliverable

**Worktree:** `/Users/cubano/Desktop/clubos/web/.claude/worktrees/nifty-pasteur-1ecb47`
**Branch:** `claude/phase-4-account-bugs-5a03fa` · not pushed
**Status:** 4A, 4B, 4C, 4D code-complete. Migration applied. **Two browser-verification items remain, blocked on an authenticated session** (see §8).
**Scope:** plan.md §4 (4A · 4B · 4C · 4D).

---

## 1. What changed, and why

Phase 4 started as two customer bugs. Both turned out to be symptoms of one thing: **the app had three tables that look like "family" and only one of them grants anything, and the dashboard showed the wrong two.**

| Table | What it means | Grants access? | Shown on the staff profile before Phase 4? |
|---|---|---|---|
| `member_guardian_users` | The authorization edge | **YES — only this** | ❌ never |
| `member_relationships` | A descriptive label | no | ✅ as "Relationships" |
| `guardians` (legacy) | Family profile from CSV import | no | ✅ as sibling list |

### 4A — a membership bought under the wrong profile

Michael Lister bought a `$530/quarter` membership while looking at his own profile. He meant it for his son Kellen. Two mechanisms existed to fix that and both were wrong:

- The owner endpoint **409'd on any live Stripe subscription** and told staff to cancel and re-create — which would have ended the billing relationship and destroyed the receipt.
- The guardian endpoint **repointed `memberId` silently** with no preview, no eligibility check, no audit row and no awareness of Stripe, leaving Stripe billing the original customer while the app displayed a different athlete.

**Now:** a transfer moves the *beneficiary* and deliberately leaves the Stripe subscription, customer and card untouched. It stamps `payerUserId` so "the payer stays Michael" survives the move, records a `MembershipTransfer` row with the exact sentence the actor confirmed, notes it on both members' histories, and recomputes both statuses. Usage never blocks (an accidental self-purchase is by definition already billed) but it is surfaced and separately acknowledged.

### 4B — a son who wouldn't appear on his father's account

Diagnosed against production rows, not guessed. Cameron Lister's record had Michael's real email in the **athlete's** `email` field and a different, unused address in `guardianEmail`. Every auto-link path matches on `guardianEmail`, so nothing linked — and migration activation then **created a second "Michael" account** for the unused address, 8 minutes after Michael had signed in as himself. Staff reached for the only linking control the dashboard had (the Relationships card), which writes a label that grants nothing.

Blast radius check: 22 minors share an email with a live login; **21 were correctly linked. Cameron was the only broken one.** Same-email onboarding works — this was one data divergence, not a systemic bug.

**Now:** the profile returns and renders the real access edges; staff have a control that writes the table that is authorization; activation prefers an authenticated session over minting an account from a stale contact string; and the member form warns when an athlete's own email already belongs to another login.

### 4C — relationship visibility and permissions

Every field and action plan.md §4C asks for, with staff authority split so a coach who can edit members cannot silently hand someone the keys to a child's account.

### 4D — regression tests

The §4D matrix as pure fixtures, plus two shapes found in real production data.

---

## 2. Schema changes

**One migration, applied 2026-08-03: `20260803000000_family_accounts`.** Additive only — nothing dropped, nothing renamed, no row lost data. It absorbs the previously-planned M27 so `member_guardian_users` is migrated exactly once.

### `member_guardian_users`

| Column | Type | Default | Why |
|---|---|---|---|
| `clubId` | TEXT NOT NULL | backfilled from `members` | tenant safety + lets staff queries filter without a join |
| `status` | TEXT NOT NULL | `'CONFIRMED'` | CONFIRMED grants; PENDING is a proposal; REVOKED is history |
| `isPrimary` | BOOLEAN NOT NULL | `false` → backfilled | was derived from `guardianEmail` — the field that was wrong for Cameron |
| `canBook` · `canPay` · `canSignWaivers` · `canReceiveEmails` | BOOLEAN NOT NULL | `true` | the §4C grid; all-true preserves today's behavior |
| `source` | TEXT | null → `'BACKFILL'` | provenance; the Lister incident was unreconstructable without it |
| `createdByUserId` | TEXT | null | who linked them |
| `confirmedAt` · `revokedAt` | TIMESTAMP | null | when access began / ended |
| `updatedAt` | TIMESTAMP NOT NULL | `CURRENT_TIMESTAMP` | — |

Plus **three indexes**. The table previously had only `@@unique([userId, memberId])`, which Postgres cannot use for a `memberId`-first probe — exactly the read the new Family & access card performs on every profile load.

```
member_guardian_users_memberId_idx
member_guardian_users_clubId_idx
member_guardian_users_userId_status_idx
```

### `member_subscriptions`

| Column | Type | Why |
|---|---|---|
| `payerUserId` | TEXT, nullable, indexed, no FK | who pays, as distinct from `memberId` (who uses it) |

**No backfill.** Reads fall back to `Member.responsiblePayerUserId`, then the member's own `userId` — which is exactly what every pre-Phase-4 row resolved to before the column existed.

### New table `membership_transfers`

An executed beneficiary transfer: `clubId`, `subscriptionId`, `fromMemberId`, `toMemberId`, `performedByUserId`, `performedByRole`, `requestedByUserId`, `requestedViaApprovalId`, `reason`, `payerUserIdAtTransfer`, `stripeSubscriptionId`, `stripeBillingUnchanged`, `acknowledgedBillingNote`, `usageSnapshot`, `createdAt`.

`fromMemberId`/`toMemberId` deliberately carry **no foreign key** — members cascade-delete and a transfer record must outlive the athletes it names. Same convention as `Transaction.athleteMemberId`.

### Deliberately NOT added

| Considered | Verdict |
|---|---|
| `MemberSubscription.firstUsedAt` | Derive. A stored column needs a backfill whose correctness can't be verified. |
| `Transaction` payer/athlete columns | Already exist (`memberId` + `athleteMemberId`, M1–M4). |
| Anything for 4B | 4B is a read gap + a data correction. No schema. |
| Changes to `MemberRelationship` | Stays a descriptive label. The fix was to stop presenting it as the linking control. |

---

## 3. Backfills

All four ran **inside** the migration — deterministic, no script, no separate step.

| # | Backfill | Result on production |
|---|---|---|
| 1 | `clubId` from the member, then `SET NOT NULL` | 49/49 rows |
| 2 | `source = 'BACKFILL'`, `confirmedAt = createdAt` | 49/49 rows |
| 3 | `status` → `CONFIRMED` via column default | 49/49 rows |
| 4 | `isPrimary` — froze the old runtime derivation once (guardianEmail match, else earliest link) | 48 rows; **every member has exactly one primary** |

**BF-5 needed no script**: the four permission booleans default to `true`, so existing links keep unrestricted behavior by construction.

**Still outstanding — BF-8, the Lister data correction.** `scripts/fix-family-links.ts`, dry-run by default, allowlist required. **Not run.** See §7.

---

## 4. New permissions

| Permission | Where | Default | Grants |
|---|---|---|---|
| `billing.transfer_subscription` | nested JSON under `billing_subScopes` — **no migration** | **off**, even with `billing:full` | move a membership between family members; approve a client's transfer request |

Family-access authority is **split by level** rather than hanging off one gate (plan.md §4C: *"not every staff role should automatically be able to edit family or financial relationships"*):

| Level | Can |
|---|---|
| `members:view` | see the Family & access card |
| `members:edit` | **propose** a link — lands `PENDING`, grants nothing until confirmed |
| `members:full` | grant, confirm, revoke, edit the permission grid, transfer management |
| `attendance:edit` | Book for This Athlete |
| `billing:view` | see billing links |
| `billing.transfer_subscription` | Assign Membership |

**Financial power is never inherited from `members:*`.** A head coach with `members:full` still cannot move money. Owners bypass everything, as everywhere else.

`GET /api/me` now resolves sub-scopes — they were previously invisible to every UI gate, which also silently affected the existing `messages_subScopes`.

---

## 5. Tests added

| Suite | Command | Count | Needs a DB? |
|---|---|---|---|
| Phase 4 pure functions | `npm run test:family` | 28 | no |
| plan.md §4D matrix | `npm run test:family-fixtures` | 77 across 16 sections | no |
| Both | `npm run test:phase4` | 105 | no |
| **Access-preservation regression** | `npm run verify:family-access` | all 49 links / 40 guardians | **yes — read-only** |

`verify-family-access.ts` is a **standing tool, not a scratch script**. Run it after any change to guardian-link reads or a migration touching `member_guardian_users`. Exit code 1 on failure, so it can gate a deploy. It compares each guardian's live resolution against the raw unfiltered link rows, so it fails if a future read forgets the `ACTIVE_GUARDIAN_LINK` filter.

§4D coverage maps 1:1 to the brief: parent with one child · parent with multiple children · multiple children sharing one guardian email · child linked after onboarding · child linked before onboarding · membership purchased by parent and assigned to child · transferred by staff · transferred by client · relationship removed · duplicate relationship attempt · reciprocal profile visibility · guardian permissions · staff permissions · unused vs already-used transfer rules. Plus §15 (the Cameron case) and §16 (the self-referential link).

---

## 6. Known limitations

1. **No runtime or browser testing yet.** Everything is type-check, build, unit-test and read-only production queries. The two UI paths in §8 have never been exercised against a real request.
2. **Usage snapshot is an approximation.** Attendance and bookings are keyed to the member, not the subscription, so usage is scoped by the subscription's date window. It informs a human decision and never gates one automatically — but it can over-count if a member held two memberships in the same window.
3. **Two kinds of "pending" family link now coexist** — a client request (`GUARDIAN_LINK` PendingApproval) and a staff proposal (`status='PENDING'`). Deliberate; see PROGRESS.md Q1.
4. **"Book for This Athlete" is a deep link**, not an in-card booking flow, to avoid duplicating booking logic. PROGRESS.md Q3.
5. **A live Stripe transfer leaves Stripe's own metadata pointing at the original member.** The local beneficiary changes and the payment is untouched by design, but anyone reading Stripe directly will see the original athlete. Acceptable — Stripe is the source of truth for *money*, not for who attends.
6. **`fix-family-links.ts` has not been run.** Cameron is still linked to the duplicate account.
7. **Old-software typos are reported, never corrected** — the club confirms each spelling with the family. 8 near-miss guardian surnames and 3 whitespace defects are catalogued in `PHASE-4-DISCOVERY.md` §8.
8. **The Meyer family has the same shape as the Listers** (both siblings on one `guardianEmail`, a live user named from a typo'd `guardianName`). Currently linked correctly, so nothing is broken — but worth confirming the spelling.

---

## 7. Deployment order

Migration is already applied. Remaining steps, in order:

```bash
# 1. Back up before anything else
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
pg_dump "<session pooler URI>" --no-owner --no-privileges -f ~/clubos-backups/pre-$(date +%Y%m%d-%H%M).sql
```

```bash
# 2. Confirm the schema + no lost access (should already pass)
cd <worktree>/web && npm run verify:family-access
```

```bash
# 3. Merge and deploy the code (Netlify builds from GitHub main)
git checkout main && git merge --no-ff claude/phase-4-account-bugs-5a03fa
```

```bash
# 4. AFTER deploy — dry-run the Lister correction and read the output
cd <worktree>/web && npx tsx scripts/fix-family-links.ts --audit
```

```bash
# 5. Only after reviewing the dry run — allowlist the exact rows
cd <worktree>/web && npx tsx scripts/fix-family-links.ts --apply \
  --members cmr7b5zbj00tj9il7ihvmszcs,cms3tm71u0001u38ttd120yoh --actor <your userId>
```

```bash
# 6. Re-verify
cd <worktree>/web && npm run verify:family-access
```

Expected step-4 output for the Listers: one `LINK_GUARDIAN` (Cameron → Michael), one `REPOINT_GUARDIAN_EMAIL`, one `MERGE_DUPLICATE_LOGIN` with **zero blockers**.

**Order matters at one point only:** the migration must precede the code, because the Prisma client is generated against the new schema and every guardian read would throw on missing columns. That ordering is already satisfied.

---

## 8. Manual testing checklist

Items **B1** and **B2** are the ones blocked on a login.

### B1 — Family & access (Listers)
- [ ] Michael's profile → Family & access shows "manages Kellan"; **Cameron is absent** (still on the duplicate account)
- [ ] Cameron's profile → guardian reads **"Michael Liater"**, not Michael Lister
- [ ] Cameron's profile → "Give someone access" surfaces Michael's real account with *"Matches this athlete's own email — likely the parent's address in the wrong field"*
- [ ] Granting it makes Cameron appear under "Michael can manage" on Michael's profile
- [ ] "Family labels" card renders separately and states it grants nothing
- [ ] Remove → confirms, and the guardian disappears from the card while the member's history shows a REVOKED note

### B2 — Transfer preview (Michael's live sub) — **GET only**
- [ ] "Assign to family member" appears on the membership row (owner, or staff with `billing.transfer_subscription`)
- [ ] Preview shows plan, `$530.00 / quarterly`, active
- [ ] Eligible targets list Kellan (and Cameron once B1 links him)
- [ ] The billing sentence names Michael and says the Stripe subscription is not changed
- [ ] Usage warning renders if any attendance exists
- [ ] **Do not press "Move membership"** — live customer

### Regression (any family, once signed in)
- [ ] Jeremy Bergen's portal shows all three children on Home, Schedule and Documents
- [ ] Jessica Haynes sees both Coville children
- [ ] A member with no guardian links sees only themselves
- [ ] Staff with `members:edit` (not `full`) sees "Propose access" and the result renders as "Proposed — no access yet"
- [ ] Staff with `members:full` but no `billing.transfer_subscription` sees **no** "Assign membership" action

### Mobile (375px)
- [ ] Family & access card action row wraps rather than overflowing
- [ ] Transfer modal renders as a bottom sheet with rounded top corners

---

## 9. Rollback plan

### Code
```bash
git revert --no-commit 020af20..6cdc7d0 && git commit
```
Five commits, no schema dependency in the revert direction — the added columns are nullable or defaulted, so old code ignores them entirely. **`payerUserId` and `membership_transfers` simply stop being written.**

### Migration
**Do not roll it back.** Every change is additive and inert to pre-Phase-4 code:
- The new columns have defaults that reproduce old behavior.
- `status='CONFIRMED'` on every row means the old "row exists ⇔ access" rule and the new "CONFIRMED ⇔ access" rule agree exactly.
- `membership_transfers` is a leaf table nothing else references.

Dropping the columns would lose the `isPrimary` and `source` backfills, which are not reconstructible. If you must:

```sql
-- LAST RESORT. Loses provenance and primary-guardian assignments permanently.
DROP TABLE IF EXISTS "membership_transfers";
ALTER TABLE "member_subscriptions" DROP COLUMN IF EXISTS "payerUserId";
ALTER TABLE "member_guardian_users"
  DROP COLUMN IF EXISTS "clubId", DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "isPrimary", DROP COLUMN IF EXISTS "canBook",
  DROP COLUMN IF EXISTS "canPay", DROP COLUMN IF EXISTS "canSignWaivers",
  DROP COLUMN IF EXISTS "canReceiveEmails", DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "createdByUserId", DROP COLUMN IF EXISTS "confirmedAt",
  DROP COLUMN IF EXISTS "revokedAt", DROP COLUMN IF EXISTS "updatedAt";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260803000000_family_accounts';
```

### Partial rollback — the riskiest change alone
If the CONFIRMED filter causes trouble, you do **not** need to revert the batch. Change one constant:

```ts
// lib/familyAccess.ts — makes every non-revoked link grant again
export const ACTIVE_GUARDIAN_LINK = { status: { not: "REVOKED" } } as const;
```

All 30 read sites pick it up. `npm run verify:family-access` confirms the effect either way.

### Data
`fix-family-links.ts` has not run, so there is nothing to undo. If it does run: it soft-deletes (never hard-deletes), the signature repoint is logged with both old and new `signerUserId`, and reversing means clearing `deletedAt` on the duplicate user and repointing the signature back.

---

## 10. Files

**New:** `lib/familyAccess.ts` · `lib/familyRules.ts` · `lib/membershipTransfer.ts` · `lib/membershipTransferKind.ts` · `app/api/members/[id]/guardians/route.ts` · `app/api/members/lookup-login/route.ts` · `app/api/member-subscriptions/[id]/transfer/route.ts` · `app/api/approvals/membership-transfer/route.ts` · `components/members/FamilyAccessCard.tsx` · `components/members/TransferMembershipModal.tsx` · `scripts/family-accounts-tests.ts` · `scripts/family-fixtures-tests.ts` · `scripts/verify-family-access.ts` · `scripts/fix-family-links.ts` · `prisma/migrations/20260803000000_family_accounts/`

**Modified:** `prisma/schema.prisma` · `lib/permissions.ts` · `lib/guardianLink.ts` · `app/api/members/[id]/route.ts` · `app/api/members/route.ts` · `app/api/members/[id]/relationships/route.ts` · `app/api/members/migration/activate/[token]/route.ts` · `app/api/member/family/[memberId]/purchases/route.ts` · `app/api/members/[id]/billing-admin/actions/route.ts` · `app/api/approvals/route.ts` · `app/api/me/route.ts` · `app/dashboard/members/[id]/page.tsx` · `app/dashboard/members/page.tsx` · `app/dashboard/members/approvals/page.tsx` · `app/dashboard/staff/page.tsx` · `app/member/family/[memberId]/page.tsx` · plus 30 read sites swept for `ACTIVE_GUARDIAN_LINK`
